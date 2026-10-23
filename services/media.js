import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { videoModel, pick1080 } from './api.js';
import { spadeToKey } from './spade.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 打包后：缓存写到可写目录（主进程设 HG_DATA_DIR=userData），ffmpeg 可能是随包二进制
// （主进程设 HG_FFMPEG=resources/ffmpeg）。CLI/dev 不设则回落到仓库目录与 PATH 里的 ffmpeg。
const DATA_DIR = process.env.HG_DATA_DIR || ROOT;
const FFMPEG = process.env.HG_FFMPEG || 'ffmpeg';
const CACHE = path.join(DATA_DIR, 'cache', 'media');
const HLS_CACHE = path.join(DATA_DIR, 'cache', 'hls');
const UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C)';

// 缓存容量上限（LRU 清理），默认 4GB，可用 HG_CACHE_MAX_BYTES 覆盖。
const CACHE_MAX_BYTES = Number(process.env.HG_CACHE_MAX_BYTES) || 4 * 1024 * 1024 * 1024;
const CDN_RETRY = 2; // CDN URL 过期：重取 video_model 再试的次数

// 下载并发 ≤2 的信号量
const DL_MAX = Math.max(1, Number(process.env.HG_DL_MAX) || 3);
let dlActive = 0;
const dlQueue = [];
function acquireDl() {
  if (dlActive < DL_MAX) { dlActive++; return Promise.resolve(); }
  return new Promise((r) => dlQueue.push(r));
}
function releaseDl() {
  const next = dlQueue.shift();
  if (next) next();
  else dlActive--;
}

function mediaError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const locks = new Map();
const hlsLocks = new Map();
const hlsAborts = new Map(); // vid -> AbortController（取消下载/排队中的转码）
const hlsGen = new Map();    // vid -> 当前任务代号，防止旧 ffmpeg 退出时删掉新任务的目录
// 并发转码池：默认 2 路，竖滑可同时准备当前 + 下一部预览。
// 1080p H.264 用 ultrafast + 每路 -threads 4，32 核机器可承受。
const TRANSCODE_MAX = Math.max(1, Number(process.env.HG_TRANSCODE_MAX) || 2);
let activeTranscodes = 0;
const transcodeQueue = [];

function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

function withTranscodeSlot(fn, signal) {
  return new Promise((resolve, reject) => {
    const startNext = () => {
      while (activeTranscodes < TRANSCODE_MAX && transcodeQueue.length) {
        transcodeQueue.shift()();
      }
    };
    const task = () => {
      if (signal?.aborted) { reject(cancelledError()); startNext(); return; }
      activeTranscodes++;
      Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw cancelledError();
          return fn();
        })
        .then(resolve, reject)
        .finally(() => { activeTranscodes--; startNext(); });
    };
    if (activeTranscodes < TRANSCODE_MAX) task();
    else transcodeQueue.push(task);
  });
}

function log(...args) {
  console.log('[media]', ...args);
}

async function run(cmd, args, { timeout = 300000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`${cmd} failed: ${detail.slice(-800)}`);
  }
}

async function download(url, destination, onProgress, signal) {
  const tmp = destination + '.part';
  let last = null;
  let status = 0;
  await acquireDl();
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(180000);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const res = await fetch(url, {
          headers: {
            'user-agent': UA,
            accept: '*/*',
          },
          signal: combined,
        });
        status = res.status;
        if (!res.ok || !res.body) {
          throw new Error(`http=${res.status}`);
        }
        const total = Number(res.headers.get('content-length')) || 0;
        let received = 0;
        const stream = Readable.fromWeb(res.body);
        stream.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        await pipeline(stream, fs.createWriteStream(tmp));
        fs.renameSync(tmp, destination);
        return received;
      } catch (e) {
        last = e;
        try { fs.rmSync(tmp, { force: true }); } catch {}
        if (signal?.aborted) throw cancelledError();
        // 403/410 多为 CDN URL 过期，重试同一 URL 没意义，直接上抛让上层重取。
        if (status === 403 || status === 410) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  } finally {
    releaseDl();
  }
  const cause = last?.cause?.code || last?.cause?.message || '';
  const err = new Error(`download failed: ${last?.message || last} ${cause}`.trim());
  err.httpStatus = status;
  err.expired = status === 403 || status === 410;
  throw err;
}

function deriveKey(spadeA) {
  // 纯 JS（services/spade.js），已用 5 组真值对拍 Python，无 python3 依赖。
  return spadeToKey(spadeA);
}

// ffmpeg stderr 判定是否解密失败（密钥错 / ver2 加密 / 密文损坏）。
function isDecryptFailure(stderr) {
  return /invalid data|decrypt|error while decoding|moov atom not found|header missing/i
    .test(stderr || '');
}

/**
 * Download, decrypt (ffmpeg -decryption_key), and cache one episode.
 * Returns { path, track, key }.
 */
export async function prepare(vid, { onProgress } = {}) {
  const id = String(vid);
  if (locks.has(id)) return locks.get(id);
  const task = (async () => {
    const dir = path.join(CACHE, id);
    fs.mkdirSync(dir, { recursive: true });
    const plain = path.join(dir, 'plain.mp4');
    const trackFile = path.join(dir, 'track.json');

    if (fs.existsSync(plain) && fs.statSync(plain).size > 0) {
      const track = fs.existsSync(trackFile)
        ? JSON.parse(fs.readFileSync(trackFile, 'utf8'))
        : null;
      return { path: plain, track, key: track?.key || null, cached: true };
    }

    const tracks = await videoModel(id);
    const track = pick1080(tracks);
    if (!track) throw new Error('no 1080p track');
    if (!track.mainUrl) throw new Error('no main_url');
    if (!track.spadeA) throw new Error('no spade_a');

    const enc = path.join(dir, 'enc.mp4');
    log(`${id}: download ${track.definition} ${(track.size / 1048576).toFixed(1)}MB`);
    await download(track.mainUrl, enc, onProgress);

    const key = await deriveKey(track.spadeA);
    log(`${id}: key=${key.slice(0, 8)}… decrypt`);
    const tmpPlain = path.join(dir, 'plain.part.mp4');
    try {
      await run(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-decryption_key', key,
        '-i', enc,
        '-c', 'copy',
        '-movflags', '+faststart',
        tmpPlain,
      ]);
      fs.renameSync(tmpPlain, plain);
    } catch (e) {
      fs.rmSync(tmpPlain, { force: true });
      throw e;
    } finally {
      fs.rmSync(enc, { force: true });
    }
    fs.writeFileSync(trackFile, JSON.stringify({ ...track, key }, null, 2));
    return { path: plain, track, key, cached: false };
  })();
  locks.set(id, task);
  try {
    return await task;
  } finally {
    locks.delete(id);
  }
}

// ---------------------------------------------------------------------------
// HLS：解密 + H.264 转码 + fMP4 分片，供 <video> + hls.js 边写边播
// ---------------------------------------------------------------------------

const hlsProcs = new Map(); // vid -> ffmpeg ChildProcess

/** index.m3u8 + init.mp4 + ≥1 个分片就绪即可起播（首屏更快）。 */
function hlsReady(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'index.m3u8'))) return false;
    if (!fs.existsSync(path.join(dir, 'init.mp4'))) return false;
    const segs = fs.readdirSync(dir).filter((f) => /^seg\d+\.m4s$/.test(f));
    return segs.length >= 1;
  } catch { return false; }
}

function spawnFfmpegHls(enc, key, dir) {
  // 不加 scale：源已是 1080p 竖屏(1080x1920)，缩放会毁分辨率。
  return spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-decryption_key', key,
    '-i', enc,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-profile:v', 'high', '-threads', '4',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg%06d.m4s'),
    path.join(dir, 'index.m3u8'),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * 下载 → 解密 → H.264 + fMP4-HLS。≥2 分片就绪即 resolve（ffmpeg 后台继续写完）。
 * 返回 { dir, definition, width, height, cached }。
 */
export async function prepareHls(vid, { onProgress } = {}) {
  const id = String(vid);
  if (hlsLocks.has(id)) return hlsLocks.get(id);

  // 预览还在转码/已经转出一部分时，播放器再次 prepare 同一 vid：
  // 直接复用现有 index.m3u8 + 分片，绝不删目录重来，否则“接着预览进度”会变成从头。
  const existingDir = path.join(HLS_CACHE, id);
  const existingM3u8 = path.join(existingDir, 'index.m3u8');
  const existingMeta = path.join(existingDir, 'meta.json');
  const pendingAbort = hlsAborts.get(id);
  if (!pendingAbort?.signal.aborted
      && fs.existsSync(existingM3u8) && fs.existsSync(existingMeta) && hlsReady(existingDir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(existingMeta, 'utf8'));
      return { ...meta, dir: existingDir, cached: fs.existsSync(path.join(existingDir, '.done')) };
    } catch { /* meta 坏了，走下面的重建 */ }
  }

  const ac = new AbortController();
  const signal = ac.signal;
  hlsAborts.set(id, ac);

  const task = (async () => {
    const gen = (hlsGen.get(id) || 0) + 1;
    hlsGen.set(id, gen);
    // 同一 vid 如果还有旧 ffmpeg 在写，先杀掉；旧任务退出时靠 gen 判断自己已过期。
    const oldProc = hlsProcs.get(id);
    if (oldProc && oldProc.exitCode === null) { try { oldProc.kill('SIGTERM'); } catch {} }

    const dir = path.join(HLS_CACHE, id);
    const m3u8 = path.join(dir, 'index.m3u8');
    const doneFlag = path.join(dir, '.done');
    const metaFile = path.join(dir, 'meta.json');

    if (fs.existsSync(doneFlag) && fs.existsSync(m3u8) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      return { ...meta, dir, cached: true };
    }

    // 清掉可能的半成品后重来
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const enc = path.join(dir, 'enc.mp4');
    let track = null;
    // CDN URL 过期(403/410) 时重取 video_model 再试。
    for (let attempt = 0; attempt <= CDN_RETRY; attempt++) {
      const tracks = await videoModel(id);
      track = pick1080(tracks);
      if (!track) throw mediaError('NO_1080P', '该剧没有 1080p 片源');
      if (!track.mainUrl) throw mediaError('NO_SOURCE', '缺少播放地址');
      if (!track.spadeA) throw mediaError('DECRYPT_UNSUPPORTED', '该集加密格式不支持');
      log(`${id}: hls download ${track.definition} ${(track.size / 1048576).toFixed(1)}MB`);
      try {
        await download(track.mainUrl, enc, onProgress, signal);
        signal.throwIfAborted();
        break;
      } catch (e) {
        if (e.code === 'CANCELLED' || signal.aborted) {
          fs.rmSync(dir, { recursive: true, force: true });
          throw cancelledError();
        }
        if (e.expired && attempt < CDN_RETRY) {
          log(`${id}: CDN 过期，重取 video_model 重试 (${attempt + 1}/${CDN_RETRY})`);
          continue;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        throw mediaError('DOWNLOAD_FAILED', '下载失败，请稍后重试');
      }
    }

    let key;
    try {
      key = deriveKey(track.spadeA);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      throw mediaError('DECRYPT_UNSUPPORTED', '该集加密格式不支持');
    }
    signal.throwIfAborted();
    log(`${id}: key=${key.slice(0, 8)}… transcode h264/hls`);

    const meta = { definition: track.definition, width: track.width, height: track.height };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    let resolveReady, rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

    // transcode slot 持有到 ffmpeg 退出；prepareHls 在分片就绪时提前返回。
    withTranscodeSlot(() => new Promise((slotDone) => {
      const proc = spawnFfmpegHls(enc, key, dir);
      hlsProcs.set(id, proc);
      let stderrTail = '';
      proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-800); });
      const poll = setInterval(() => {
        if (hlsReady(dir)) { clearInterval(poll); resolveReady(); }
      }, 200);
      proc.once('error', (e) => {
        clearInterval(poll);
        if (hlsGen.get(id) !== gen) { slotDone(); return; }
        if (hlsProcs.get(id) === proc) hlsProcs.delete(id);
        rejectReady(e);
        slotDone();
      });
      proc.once('exit', (code, sig) => {
        clearInterval(poll);
        if (hlsGen.get(id) !== gen) { slotDone(); return; }
        if (hlsProcs.get(id) === proc) hlsProcs.delete(id);
        fs.rmSync(enc, { force: true });
        if (hlsAborts.get(id) === ac) hlsAborts.delete(id);
        if (code === 0) {
          try { fs.writeFileSync(doneFlag, ''); } catch {}
          resolveReady(); // 极短视频可能不足 2 分片，退出即放行
        } else if (ac.signal.aborted || sig === 'SIGTERM' || sig === 'SIGKILL') {
          // 主动取消时 ffmpeg 经常返回 code=255 而不是 signal，不能当成转码失败。
          rejectReady(cancelledError());
          fs.rmSync(dir, { recursive: true, force: true });
        } else if (isDecryptFailure(stderrTail)) {
          rejectReady(mediaError('DECRYPT_UNSUPPORTED', '该集加密格式不支持'));
          fs.rmSync(dir, { recursive: true, force: true });
        } else {
          const err = mediaError('TRANSCODE_FAILED', '转码失败，请重试');
          err.detail = stderrTail.slice(-400);
          console.error(`[media] ${id}: ffmpeg hls code=${code}: ${err.detail}`);
          rejectReady(err);
          fs.rmSync(dir, { recursive: true, force: true });
        }
        slotDone();
      });
    }), signal).catch((e) => { try { rejectReady(e); } catch {} }); // 取消/排队失败也要让 ready 结束

    await ready;
    pruneCache().catch(() => {}); // 后台 LRU 清理，不阻塞起播
    return { ...meta, dir, cached: false };
  })();
  hlsLocks.set(id, task);
  try {
    return await task;
  } finally {
    hlsLocks.delete(id);
    // ffmpeg 还在后台写分片时保留 controller，cancelHls 才能把 code=255 识别为取消。
    if (!hlsProcs.has(id) && hlsAborts.get(id) === ac) hlsAborts.delete(id);
    if (signal.aborted) {
      try { fs.rmSync(path.join(HLS_CACHE, id), { recursive: true, force: true }); } catch {}
    }
  }
}

/** 取消某集的转码（切集/关窗时用）。 */
export function cancelHls(vid) {
  const id = String(vid);
  // 正在下载/排队：先 abort，让 prepareHls 立刻结束，而不是等下载完再抢 slot。
  const ac = hlsAborts.get(id);
  if (ac && !ac.signal.aborted) {
    try { ac.abort(); } catch {}
  }
  // 已经在转码：杀 ffmpeg；exit 处理器会清理目录并释放 slot。
  const proc = hlsProcs.get(id);
  if (proc && proc.exitCode === null) {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

export function hlsDir(vid) {
  return path.join(HLS_CACHE, String(vid));
}

/** Optional: H.264 1080p copy for browsers/Electron (HEVC → H.264). */
export async function transcodeH264(vid) {
  const dir = path.join(CACHE, String(vid));
  const plain = path.join(dir, 'plain.mp4');
  const h264 = path.join(dir, 'h264.mp4');
  if (fs.existsSync(h264) && fs.statSync(h264).size > 0) return h264;
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', plain,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    h264,
  ]);
  return h264;
}

function dirSize(p) {
  let total = 0;
  let newest = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let kids = [];
      try { kids = fs.readdirSync(cur); } catch {}
      for (const k of kids) stack.push(path.join(cur, k));
    } else {
      total += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return { total, newest };
}

/** 按总容量做 LRU 清理（最旧先删，跳过正在准备中的条目）。 */
export async function pruneCache(maxBytes = CACHE_MAX_BYTES) {
  const entries = [];
  for (const root of [HLS_CACHE, CACHE]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const full = path.join(root, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      const { total, newest } = dirSize(full);
      entries.push({
        full, size: total, mtime: newest || st.mtimeMs,
        active: locks.has(name) || hlsLocks.has(name),
      });
    }
  }
  let sum = entries.reduce((a, e) => a + e.size, 0);
  if (sum <= maxBytes) return { removed: 0, bytes: sum };
  entries.sort((a, b) => a.mtime - b.mtime); // 最旧先删
  let removed = 0;
  for (const e of entries) {
    if (sum <= maxBytes) break;
    if (e.active) continue;
    try { fs.rmSync(e.full, { recursive: true, force: true }); sum -= e.size; removed++; } catch {}
  }
  if (removed) log(`cache prune: removed ${removed} dirs, now ${(sum / 1048576).toFixed(0)}MB`);
  return { removed, bytes: sum };
}

/** 清空全部缓存（退出可调用）。 */
export function clearCache() {
  for (const root of [HLS_CACHE, CACHE]) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

export function cachePath(vid) {
  return path.join(CACHE, String(vid), 'plain.mp4');
}

export function cacheDir() {
  return CACHE;
}

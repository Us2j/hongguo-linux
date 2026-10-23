import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.HG_DATA_DIR || ROOT;
const FFMPEG = process.env.HG_FFMPEG || 'ffmpeg';
const CACHE = path.join(DATA_DIR, 'cache', 'covers');
// 红果封面是 HEIC（Chromium 不解码），这里由主进程抓回后用 ffmpeg 转成 JPEG 再喂给 <img>。
const UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C)';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

// 同一封面只转一次：key -> 进行中的 Promise。
const locks = new Map();
// ffmpeg 并发上限，避免一屏封面同时触发几十个进程。
const MAX = 4;
let active = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < MAX) task();
    else queue.push(task);
  });
}

// 缓存键用原始 URL 的 path（去掉随签名变化的 query），同一张图稳定命中。
function keyFor(original) {
  let p = original;
  try { p = new URL(original).pathname; } catch { /* 用原串兜底 */ }
  return crypto.createHash('md5').update(p).digest('hex');
}

async function ensureJpeg(original) {
  const key = keyFor(original);
  const out = path.join(CACHE, `${key}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  if (locks.has(key)) return locks.get(key);

  const job = withSlot(async () => {
    fs.mkdirSync(CACHE, { recursive: true });
    const res = await fetch(original, {
      headers: { 'user-agent': UA, accept: 'image/*,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.body) throw new Error(`cover fetch ${res.status}`);
    const tmp = path.join(os.tmpdir(), `hg-cover-${key}-${process.pid}.bin`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    try {
      // -frames:v 1：HEIC/HEIF 只取首帧；输出 baseline JPEG。
      await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-frames:v', '1', out], { timeout: 20000 });
    } finally {
      fs.rm(tmp, () => {});
    }
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('ffmpeg produced empty cover');
    return out;
  }).finally(() => locks.delete(key));

  locks.set(key, job);
  return job;
}

/**
 * 本地封面代理：只 bind 127.0.0.1，带随机 token。
 *   GET /c?token=...&u=<base64url(原始封面URL)>
 * 把 HEIC 等格式转成 JPEG 返回；渲染层 <img src> 指向本服务。
 */
export function createCoverServer() {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/c') { res.writeHead(404).end('not found'); return; }
      if (url.searchParams.get('token') !== token) { res.writeHead(403).end('forbidden'); return; }
      const u = url.searchParams.get('u');
      if (!u) { res.writeHead(400).end('missing u'); return; }
      let original;
      try { original = unb64url(u); } catch { res.writeHead(400).end('bad u'); return; }
      if (!/^https?:\/\//.test(original)) { res.writeHead(400).end('bad url'); return; }

      const file = await ensureJpeg(original);
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502).end(String(e?.message || e));
    }
  });

  let port = null;
  const ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });

  return {
    ready,
    close: () => new Promise((r) => server.close(r)),
    // 原始封面 URL -> 本地代理 URL；空值原样返回。
    urlFor(original) {
      if (!original) return '';
      return `http://127.0.0.1:${port}/c?token=${token}&u=${encodeURIComponent(b64url(original))}`;
    },
  };
}

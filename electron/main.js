import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// 打包后：原生资源在 process.resourcesPath（extraResources），可写数据放 userData，
// java/ffmpeg 用随包二进制。services 读这些 env；必须在动态 import 它们之前设好。
if (app.isPackaged) {
  const res = process.resourcesPath;
  process.env.HG_RES_DIR = res;
  process.env.HG_DATA_DIR = app.getPath('userData');
  // 随包 java/ffmpeg 存在才用，否则回落到系统 PATH（更稳妥）。
  const bundledJava = path.join(res, 'jre', 'bin', 'java');
  const bundledFfmpeg = path.join(res, 'ffmpeg');
  if (!process.env.JAVA_BIN && fs.existsSync(bundledJava)) process.env.JAVA_BIN = bundledJava;
  if (!process.env.HG_FFMPEG && fs.existsSync(bundledFfmpeg)) process.env.HG_FFMPEG = bundledFfmpeg;
  // 首启播种随包身份库（resources/seed/config → userData/config）：device.json + devices 池，
  // 用户之后可自行切换/新增；已存在则不覆盖。
  try {
    const seedCfg = path.join(res, 'seed', 'config');
    const userCfg = path.join(process.env.HG_DATA_DIR, 'config');
    if (fs.existsSync(seedCfg) && !fs.existsSync(path.join(userCfg, 'devices'))) {
      fs.mkdirSync(userCfg, { recursive: true });
      fs.cpSync(seedCfg, userCfg, { recursive: true });
      console.log('[main] 已植入随包身份库到 userData/config');
    }
  } catch (e) { console.error('[main] 身份播种失败:', e?.message || e); }
}

let signer = null;
let hls = null;
let win = null;
// 在 whenReady 里动态 import 后赋值。
let feed; let search; let feedPage; let searchPage; let episodes; let prepareHls; let cancelHls; let pruneCache;
let webSearch; let prewarmWebSearch;
let reloadDevice; let listIdentities; let activateIdentity;
let cover = null;                  // 封面代理（HEIC -> JPEG）
const canceledVids = new Set();    // 用户已切走的 vid，避免重试把旧集又拉起来
const PREPARE_RETRY = Math.max(0, Number(process.env.HG_PREPARE_RETRY) || 2);

// 增量分页游标：page=0 时重置，page>0 时续取（避免每翻一页重抓全量、整表替换导致闪屏）。
// 按 key 存，分类/竖滑/搜索各自独立：key = feed 的 genre（null 即竖滑/默认）或 'search:<query>'。
const feedCursors = new Map();     // key -> cursor
let searchSession = null;          // { query, cursor }

// 把条目里的 HEIC 封面 URL 改写成本地代理 URL，渲染层 <img> 才能显示。
function withCover(items) {
  if (!cover) return items;
  return items.map((it) => (it.cover ? { ...it, cover: cover.urlFor(it.cover) } : it));
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 竖滑历史：持久化到 cache/feed-seen.json，重启后继续排除看过的剧。
const DATA_DIR = process.env.HG_DATA_DIR || ROOT;
const FEED_HISTORY = path.join(DATA_DIR, 'cache', 'feed-seen.json');
const FEED_SEEN_MAX = Math.max(100, Number(process.env.HG_FEED_SEEN_MAX) || 600);

function loadFeedSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(FEED_HISTORY, 'utf8'));
    if (raw && typeof raw === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v)) out[k] = v.map(String).filter(Boolean).slice(-FEED_SEEN_MAX);
      }
      return out;
    }
  } catch { /* 首次运行/文件损坏都从空开始 */ }
  return {};
}

let feedSeen = loadFeedSeen();

function saveFeedSeen() {
  try {
    fs.mkdirSync(path.dirname(FEED_HISTORY), { recursive: true });
    const tmp = `${FEED_HISTORY}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(feedSeen));
    fs.renameSync(tmp, FEED_HISTORY);
  } catch (e) {
    console.error('[feed] save seen failed:', e.message);
  }
}

function rememberFeed(key, items) {
  const arr = feedSeen[key] || [];
  const set = new Set(arr);
  for (const it of items) {
    const sid = String(it.series_id || '');
    if (sid && !set.has(sid)) { set.add(sid); arr.push(sid); }
  }
  if (arr.length > FEED_SEEN_MAX) arr.splice(0, arr.length - FEED_SEEN_MAX);
  feedSeen[key] = arr;
  saveFeedSeen();
}

function isAllowedWebSearchUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:'
      && (u.hostname === 'hongguoduanju.com' || u.hostname.endsWith('.hongguoduanju.com'));
  } catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e11',
    autoHideMenuBar: true,
    title: '红果',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  // 外链用系统浏览器打开，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 网页搜索只允许内嵌红果官网；guest 不允许 preload / Node。
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    if (params.src && params.src !== 'about:blank' && !isAllowedWebSearchUrl(params.src)) {
      event.preventDefault();
    }
  });

  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebSearchUrl(url)) {
        guest.loadURL(url);
      } else {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedWebSearchUrl(url)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(ROOT, 'renderer', 'dist', 'index.html'));
  }

  // 冒烟测试：HG_SMOKE=1 时，页面加载后从渲染层实跑一次 feed，打印结果并退出。
  if (process.env.HG_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const n = await win.webContents.executeJavaScript(
          'window.api.feed(0).then(x => x.items.length)');
        console.log(`[smoke] renderer api.feed -> ${n} items`);
        process.exitCode = n > 0 ? 0 : 2;
        if (process.env.HG_SMOKE === '2' && n > 0) {
          const r = await win.webContents.executeJavaScript(`
            window.api.feed(0).then(async ({ items }) => {
              const vid = items[0].vid;
              const info = await window.api.prepare(vid);
              const res = await fetch(info.hlsUrl);
              const text = await res.text();
              return { def: info.definition, w: info.width, h: info.height,
                       status: res.status, m3u8: text.startsWith('#EXTM3U') };
            })`);
          console.log(`[smoke] prepare -> ${r.def} ${r.w}x${r.h} m3u8=${r.status}/${r.m3u8}`);
          process.exitCode = (r.status === 200 && r.m3u8) ? 0 : 3;
        }
        if (process.env.HG_SMOKE === '4') {
          const r = await win.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              for (const g of ['short_play', 'comic_series', 'ai_series']) {
                const res = await window.api.feed(0, g);
                out[g] = { n: res.items.length, first: res.items[0]?.title || '' };
              }
              return out;
            })()`);
          console.log(`[smoke] genres -> ${JSON.stringify(r)}`);
          process.exitCode = ['short_play', 'comic_series', 'ai_series']
            .every((g) => (r[g]?.n || 0) > 0) ? 0 : 5;
        }
        if (process.env.HG_SMOKE === '3') {
          const r = await win.webContents.executeJavaScript(`
            (async () => {
              const before = await window.api.listIdentities();
              const target = before.identities.find((x) => x.status === 'ok' && !x.active);
              if (!target) return { switched: false, reason: 'no other ok identity' };
              const used = await window.api.useIdentity(target.name);
              const after = await window.api.listIdentities();
              return { switched: true, to: used.active, device_id: used.device_id, active: after.active };
            })()`);
          console.log(`[smoke] identity switch -> ${JSON.stringify(r)}`);
          process.exitCode = (r.switched && r.to === r.active) ? 0 : 4;
        }
      } catch (e) {
        console.log(`[smoke] FAIL ${e?.message || e}`);
        process.exitCode = 2;
      } finally {
        app.quit();
      }
    });
  }
}

// 首启检查：打包后确认 java/ffmpeg 存在；无凭证时自动使用游客模式。
function preflight() {
  if (!app.isPackaged) return;
  const problems = [];
  if (process.env.JAVA_BIN && !fs.existsSync(process.env.JAVA_BIN)) problems.push(`java 缺失: ${process.env.JAVA_BIN}`);
  if (process.env.HG_FFMPEG && !fs.existsSync(process.env.HG_FFMPEG)) problems.push(`ffmpeg 缺失: ${process.env.HG_FFMPEG}`);
  if (problems.length) console.error('[main] 运行环境检查未通过:\n  ' + problems.join('\n  '));
}

// --- IPC ---------------------------------------------------------------------
function registerIpc() {
  // feed 增量分页：page=0 不重置游标，继续往后取，避免每次刷新都推同一批；
  // 每页返回前打乱顺序；filterIds 让服务端排除已看过的剧，客户端再兜底去重。
  ipcMain.handle('feed', async (_e, arg = {}) => {
    const { page = 0, genre = null } = typeof arg === 'object' && arg !== null ? arg : { page: arg };
    const key = genre || '__default__';
    let cursor = feedCursors.get(key);
    if (!cursor || cursor.done) cursor = {};

    const opts = genre ? { genre } : {};
    const seen = new Set([
      ...(feedSeen[key] || []),
      ...(cursor.filterIds || []),
    ].map(String));
    // 把历史也放进 filter_ids，让服务端直接跳过看过的剧。
    cursor = { ...cursor, filterIds: [...seen].slice(-200) };

    const fetched = [];
    let result = await feedPage(signer, cursor, opts);
    fetched.push(...result.items);
    let fresh = result.items.filter((x) => x.vid && !seen.has(String(x.series_id)));
    for (const it of result.items) seen.add(String(it.series_id));

    // 服务端如果没按 filter_ids 排除，继续往后翻，最多多翻 2 页。
    for (let i = 0; i < 2 && fresh.length === 0 && result.hasMore; i++) {
      result = await feedPage(signer, result.cursor, opts);
      fetched.push(...result.items);
      fresh = result.items.filter((x) => x.vid && !seen.has(String(x.series_id)));
      for (const it of result.items) seen.add(String(it.series_id));
    }

    // 这个分类已经全看完了：清掉历史，开始新一轮（仍然随机顺序）。
    if (fresh.length === 0 && !result.hasMore) {
      feedSeen[key] = [];
      fetched.length = 0;
      result = await feedPage(signer, {}, opts);
      fetched.push(...result.items);
      fresh = result.items.filter((x) => x.vid);
    }

    rememberFeed(key, fetched);
    const next = result.cursor;
    next.done = !result.hasMore;
    feedCursors.set(key, next);
    return { items: withCover(shuffled(fresh)), hasMore: result.hasMore };
  });

  ipcMain.handle('search', async (_e, query, page = 0) => {
    const q = String(query || '');
    if (!q) return { items: [], hasMore: false };
    if (Number(page) <= 0 || !searchSession || searchSession.query !== q) {
      searchSession = { query: q, cursor: {} };
    }
    const { items, cursor, hasMore } = await searchPage(signer, q, searchSession.cursor);
    searchSession.cursor = cursor;
    return { items: withCover(items.filter((x) => x.vid)), hasMore };
  });

  // 官方网页公开搜索：不经过设备身份，结果直接进入站内卡片列表。
  ipcMain.handle('websearch', async (_e, query) => {
    const q = String(query || '').trim();
    if (!q) return { items: [], hasMore: false };
    if (typeof webSearch !== 'function') throw new Error('网页搜索模块未加载');
    const r = await webSearch(q);
    return { items: withCover((r.items || []).filter((x) => x.series_id)), hasMore: false };
  });

  // 预热网页搜索隐藏窗（进入游客模式时渲染层调用），首次搜索更快。
  ipcMain.handle('websearch:prewarm', () => { try { return prewarmWebSearch?.(); } catch { return null; } });

  ipcMain.handle('episodes', async (_e, seriesId) => {
    const r = await episodes(signer, String(seriesId));
    return {
      ...r,
      episodes: r.episodes.map((ep) => (ep.cover && cover ? { ...ep, cover: cover.urlFor(ep.cover) } : ep)),
    };
  });

  ipcMain.handle('prepare', async (_e, rawVid) => {
    const vid = String(rawVid);
    canceledVids.delete(vid);
    let last;
    for (let attempt = 0; attempt <= PREPARE_RETRY; attempt++) {
      try {
        const info = await prepareHls(vid);
        return { ...info, hlsUrl: hls.urlFor(vid) };
      } catch (e) {
        last = e;
        if (e.code === 'CANCELLED' || canceledVids.has(vid)) throw e;
        if (['DECRYPT_UNSUPPORTED', 'NO_1080P', 'NO_SOURCE'].includes(e.code)) throw e;
        if (attempt < PREPARE_RETRY) {
          console.log(`[main] prepare ${vid} retry ${attempt + 1}/${PREPARE_RETRY}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          if (canceledVids.has(vid)) throw e;
        }
      }
    }
    throw last;
  });

  ipcMain.handle('cancel', (_e, vid) => {
    canceledVids.add(String(vid));
    cancelHls(vid);
    return true;
  });

  // 应用内身份管理：列出 + 热切换（切 device.json 后立即 reloadDevice，无需重启）。
  ipcMain.handle('identity:list', () => listIdentities());
  ipcMain.handle('identity:use', (_e, name) => {
    const r = activateIdentity(String(name));
    reloadDevice();
    return r;
  });
}

// --- lifecycle ---------------------------------------------------------------
app.whenReady().then(async () => {
  preflight();
  // 动态 import：保证打包时上面的 env 已在 services 模块求值前设好。
  const signerMod = await import('../services/signer.js');
  const apiMod = await import('../services/api.js');
  const mediaMod = await import('../services/media.js');
  const hlsMod = await import('../services/hls_server.js');
  const coverMod = await import('../services/cover_server.js');
  const storeMod = await import('../services/identity-store.js');
  const webSearchMod = await import('../services/websearch.js');
  ({ feed, search, feedPage, searchPage, episodes, reloadDevice } = apiMod);
  ({ prepareHls, cancelHls, pruneCache } = mediaMod);
  ({ listIdentities, activateIdentity } = storeMod);
  ({ webSearch, prewarmWebSearch } = webSearchMod);

  registerIpc();
  signer = new signerMod.Signer();
  await signer.start();
  hls = await hlsMod.createHlsServer();
  cover = coverMod.createCoverServer();
  await cover.ready;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function cleanup() {
  try { signer?.stop(); } catch {}
  try { if (hls) await hls.close(); } catch {}
  try { if (cover) await cover.close(); } catch {}
  try { if (pruneCache) await pruneCache(); } catch {}
}

app.on('window-all-closed', async () => {
  await cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { cleanup(); });

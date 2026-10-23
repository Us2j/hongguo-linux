import { BrowserWindow } from 'electron';

const BASE = 'https://hongguoduanju.com/search';
const CACHE_TTL = 5 * 60 * 1000;
const LOAD_TIMEOUT = 20000;
const DOM_TIMEOUT = 25000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map();  // query -> { at, value }
let win = null;
let creating = null;
let seq = 0;

function log(...a) { console.log('[websearch]', ...a); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ensureWindow() {
  if (win && !win.isDestroyed()) return Promise.resolve(win);
  if (creating) return creating;
  creating = (async () => {
    const w = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      skipTaskbar: true,
      webPreferences: {
        partition: 'persist:hongguo-web',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        webSecurity: true,
      },
    });
    const wc = w.webContents;
    wc.setUserAgent(UA);
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('closed', () => { if (win === w) { win = null; creating = null; } });
    win = w;
    return w;
  })();
  try { return creating; } catch (e) { creating = null; throw e; }
}

function load(w, url) {
  return new Promise((resolve, reject) => {
    const wc = w.webContents;
    let done = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      try { wc.removeListener('did-finish-load', onFinish); } catch { /* noop */ }
      try { wc.removeListener('did-fail-load', onFail); } catch { /* noop */ }
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err); else resolve();
    };
    const onFinish = () => finish();
    const onFail = (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return; // 图片/字体等子资源失败忽略
      finish(new Error(`官方页面加载失败 ${code}: ${desc} ${failedUrl || ''}`));
    };
    wc.on('did-finish-load', onFinish);
    wc.on('did-fail-load', onFail);
    timer = setTimeout(() => finish(new Error(`官方页面加载超时: ${url}`)), LOAD_TIMEOUT);
    w.loadURL(url).catch((e) => finish(e));
  });
}

// 在官方页面上下文里直接读搜索结果卡片。
function extractDomResults() {
  const out = new Map();
  const anchors = document.querySelectorAll('a[href*="detail?series_id="]');
  for (const a of anchors) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    const sid = u.searchParams.get('series_id') || '';
    if (!/^[0-9]{6,}$/.test(sid)) continue;
    const card = a.closest('article, li, [class*="card"], [class*="Card"]') || a.parentElement;
    const text = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
    const prev = out.get(sid) || {};
    const title = (a.innerText || a.textContent || '').trim();
    const img = card?.querySelector('img');
    const ep = text.match(/([0-9]+)\s*集/);
    out.set(sid, {
      series_id: sid,
      title: prev.title || title || text.split(' ')[0] || '',
      episode_cnt: prev.episode_cnt || (ep ? Number(ep[1]) : 0),
      cover: prev.cover || img?.currentSrc || img?.src || img?.getAttribute('data-src') || '',
      intro: '', category: '', score: '', play_cnt: 0, vid: '',
    });
  }
  return [...out.values()];
}

async function waitDom(w, q) {
  const deadline = Date.now() + DOM_TIMEOUT;
  while (Date.now() < deadline) {
    if (w.isDestroyed()) throw new Error('官方搜索窗口已关闭');
    try {
      const items = await w.webContents.executeJavaScript(`(${extractDomResults.toString()})()`, true);
      if (Array.isArray(items) && items.length) {
        log(`DOM hit "${q}" -> ${items.length}`);
        return items;
      }
    } catch { /* 页面尚未就绪 */ }
    await sleep(300);
  }
  throw new Error('官方页面已加载，但没有渲染出搜索结果');
}

/** 预热：只建隐藏窗，不并发加载页面；真正搜索时再统一 loadURL。 */
export async function prewarmWebSearch() {
  try { await ensureWindow(); } catch (e) { log('prewarm failed:', e?.message || e); }
}

/**
 * 官方网页公开搜索：让官网页面自己完成搜索，再读结果卡片。
 * 不需要红果 App 的设备身份，也不需要在本地复刻网页签名。
 */
export async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索关键词为空');
  if (q.length > 80) throw new Error('搜索关键词过长');

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const my = ++seq;
  const w = await ensureWindow();
  if (my !== seq) throw new Error('搜索已被新的搜索替换');

  const url = `${BASE}/${encodeURIComponent(q)}`;
  log(`loadURL "${q}"`);
  try {
    await load(w, url);
  } catch (e) {
    log('load failed:', e?.message || e);
    // 页面可能已部分加载；仍给 DOM 一次机会。
  }
  const items = await waitDom(w, q);
  if (my !== seq) throw new Error('搜索已被新的搜索替换');

  const value = { items, hasMore: false, source: 'web' };
  cache.set(q, { at: Date.now(), value });
  return value;
}

export function clearWebSearchCache() { cache.clear(); }

export function closeWebSearch() {
  if (win) {
    try { win.destroy(); } catch { /* noop */ }
    win = null;
    creating = null;
  }
}

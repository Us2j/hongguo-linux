import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_HOST = 'api5-normal-sinfonlinea.fqnovel.com';
export const PLAYER_HOST = 'api5-normal-sinfonlineb.fqnovel.com';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// HG_DEVICE_CONFIG：指向任意身份文件，供 identity.mjs 的 test 在不动激活身份的前提下复测。
// HG_DATA_DIR：打包后把可写数据（config/、cache/）放到 userData；缺省回落到仓库目录。
const DATA_DIR = process.env.HG_DATA_DIR || ROOT;
const DEVICE_CONFIG = process.env.HG_DEVICE_CONFIG
  ? path.resolve(process.env.HG_DEVICE_CONFIG)
  : path.join(DATA_DIR, 'config', 'device.json');

const FALLBACK_DEVICE = {
  // 公开仓库不内置任何真实设备身份；必须通过 config/device.json 或环境变量提供。
  device_id: '',
  iid: '',
  cdid: '',
  install_id: null,
  session: null,
  openudid: null,
  klink_egdi: '',
  profile: {
    device_type: 'SM-N9860', device_brand: 'Samsung',
    os_api: '28', os_version: '9', resolution: '900*1600', dpi: '320',
    rom_version: 'PQ3A.190705.10241111+release-keys',
    channel: 'oppo_8662_64',
    version_code: '71532', version_name: '7.1.5.32',
    manifest_version_code: '71532', update_version_code: '71532',
    host_abi: 'arm64-v8a', dragon_device_type: 'pad', pv_player: '71532',
    is_android_pad_screen: '0', compliance_status: '0',
    need_personal_recommend: '1', player_so_load: '1',
  },
};

function loadDevice() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICE_CONFIG, 'utf8'));
    return {
      ...FALLBACK_DEVICE,
      ...raw,
      profile: { ...FALLBACK_DEVICE.profile, ...(raw.profile || {}) },
    };
  } catch {
    return FALLBACK_DEVICE;
  }
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s[0] === '0' ? '1' + s.slice(1) : s;
}

// 搜索画像可热重载：use 换身份后，常驻进程（Electron）调用 reloadDevice() 即生效，不必重启。
// CLI 每条命令都是新进程，天然读到最新 device.json，不需要调用。
export let SEARCH_PROFILE = null;

function buildDeviceProfile() {
  const device = loadDevice();
  const randomId = process.env.HG_RANDOM_ID === '1';
  const deviceId = process.env.HG_DEVICE_ID || (randomId ? randomDigits(15) : device.device_id);
  const iid = process.env.HG_IID || (randomId ? randomDigits(16) : device.iid);
  const cdid = process.env.HG_CDID || (randomId ? crypto.randomUUID() : device.cdid);

  const query = {
    aid: '8662', app_name: 'novelread',
    ...device.profile,
    device_platform: 'android', os: 'android', ssmix: 'a', language: 'zh', ac: 'wifi',
    device_id: deviceId, iid, cdid,
    klink_egdi: device.klink_egdi,
  };
  for (const key of ['install_id', 'session', 'openudid']) {
    if (device[key]) query[key] = device[key];
  }
  const ua = `com.phoenix.read/${query.version_code || '71532'} (Linux; U; Android `
    + `${query.os_version || '9'}; ${query.device_type || 'SM-N9860'}; `
    + `Build/${query.rom_version || 'PQ3A.190705.10241111+release-keys'};tt-ok/3.12.13.20)`;

  if (!deviceId || !iid) {
    console.info(`[api] 未找到本地凭证，使用游客模式（推荐/播放可用，搜索不可用）：${DEVICE_CONFIG}`);
  }
  SEARCH_PROFILE = {
    query,
    headers: {
      'user-agent': ua,
      accept: 'application/json',
      'x-xs-from-web': '0',
      'sdk-version': '2',
    },
  };
}

buildDeviceProfile();

/** 重新读 config/device.json 并重建搜索画像（供 Electron 内热切换身份）。 */
export function reloadDevice() {
  buildDeviceProfile();
  return { device_id: SEARCH_PROFILE.query.device_id, iid: SEARCH_PROFILE.query.iid };
}

/** 免签 public guest：P0 验证可直接拿 1080p。 */
export const PUBLIC_PROFILE = {
  query: {
    aid: '8662', app_name: 'novelread',
    version_code: '73532', version_name: '7.3.5.32',
    manifest_version_code: '73532', update_version_code: '73532',
    channel: 'update_64', device_platform: 'android', os: 'android', ssmix: 'a',
    device_type: '25053RT47C', device_brand: 'Redmi', language: 'zh',
    os_api: '36', os_version: '16', resolution: '1280*2772', dpi: '520', ac: 'wifi',
    device_id: randomDigits(19), iid: randomDigits(19),
  },
  headers: {
    'user-agent': 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; '
      + 'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 '
      + 'QuicVersion:c67e9834 2025-09-08)',
    accept: 'application/json',
    'x-xs-from-web': '0',
    'sdk-version': '2',
  },
};

/**
 * 有本地凭证就用凭证；没有就用 public guest（随机 19 位 device_id/iid）。
 * guest 可浏览推荐/分类/剧集和播放，但搜索不可用。
 */
function activeProfile() {
  const hasIdentity = Boolean(SEARCH_PROFILE?.query?.device_id && SEARCH_PROFILE?.query?.iid);
  return hasIdentity ? SEARCH_PROFILE : PUBLIC_PROFILE;
}

function pyQuote(value, safe = '') {
  let s = encodeURIComponent(String(value));
  const map = { '!': '%21', "'": '%27', '(': '%28', ')': '%29', '*': '%2A' };
  for (const [ch, enc] of Object.entries(map)) {
    if (!safe.includes(ch)) s = s.split(ch).join(enc);
  }
  return s;
}

function buildUrl(host, pathname, params, safe = '') {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${pyQuote(v, safe)}`)
    .join('&');
  return `https://${host}${pathname}?${q}`;
}

function md5Upper(buf) {
  return crypto.createHash('md5').update(buf).digest('hex').toUpperCase();
}

// 限速：同一类请求之间至少间隔 MIN_GAP_MS，避免触发风控。
const MIN_GAP_MS = Number(process.env.HG_MIN_GAP_MS) || 1200;
const lastAt = new Map();
async function throttle(key) {
  const prev = lastAt.get(key) || 0;
  const wait = prev + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt.set(key, Date.now());
}

// 身份健康度：连续 2 次搜索空 200 / code=100103 多半是身份被风控/失效。
// 默认开启自动轮换（HG_AUTO_ROTATE=0 关），到阈值时自动切下一个 ok 身份并重试；
// 无可换身份或自动轮换关闭时回落到提示。
const AUTO_ROTATE = process.env.HG_AUTO_ROTATE !== '0';
let emptyStreak = 0;
function noteSearchHealth(suspicious) {
  if (!suspicious) { emptyStreak = 0; return; }
  emptyStreak += 1;
  if (emptyStreak >= 2 && !AUTO_ROTATE) {
    console.error(`[api] 搜索连续 ${emptyStreak} 次空结果/100103，当前身份可能已失效；`
      + '建议切换身份：node tools/identity.mjs rotate（或 new 造一个）');
  }
}

// 自动切下一个 ok 身份并热重载画像。返回是否切换成功。
async function autoRotate() {
  try {
    const store = await import('./identity-store.js');
    const r = store.rotate();
    if (r) {
      reloadDevice();
      console.error(`[api] 身份可能失效，已自动切换 -> ${r.active} (${r.device_id})`);
      return true;
    }
    console.error('[api] 搜索空结果/100103，但没有其它 ok 身份可切换（建议 new 造一个）');
  } catch (e) {
    console.error('[api] 自动切换身份失败:', e?.message || e);
  }
  return false;
}

async function call(signer, { method, url, headers, body, signed }) {
  const h = { ...headers };
  let raw;
  if (body !== undefined && body !== null) {
    raw = JSON.stringify(body);
    h['x-ss-stub'] = md5Upper(Buffer.from(raw, 'utf8'));
  }
  if (signed) {
    Object.assign(h, await signer.sign(url, h));
  }
  // 瞬时故障（网络抖动 / 5xx）退避重试一次；风控类 code!=0 不在此重试。
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { ...h, 'content-type': h['content-type'] || 'application/json; charset=utf-8' },
        body: raw,
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (res.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return { status: res.status, json, text };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error(`request failed: ${lastErr?.message || lastErr}`);
}

// ---------------------------------------------------------------------------
// 推荐 feed
// ---------------------------------------------------------------------------

/**
 * 红果 landpage 的体裁映射。
 * req_scene 与 select_items.genre 必须同时匹配；只改 genre 会被服务端忽略。
 */
export const GENRES = {
  short_play: { scene: 'default', label: '真人剧' },
  comic_series: { scene: 'comic_series', label: '漫剧' },
  ai_series: { scene: 'ai_series', label: 'AI短剧' },
};

function parseFeedItem(it) {
  const cats = [];
  for (const m of String(it.category_schema || '').matchAll(/"name":"([^"]+)"/g)) {
    if (m[1] && !cats.includes(m[1])) cats.push(m[1]);
  }
  return {
    series_id: String(it.series_id || ''),
    title: it.title || '',
    episode_cnt: Number(it.episode_cnt) || 0,
    cover: it.cover || '',
    vid: it.vid || '',
    score: it.score || '',
    play_cnt: it.play_cnt || 0,
    category: cats.join(' / '),
    intro: (it.video_desc || '').slice(0, 60),
  };
}

/**
 * 推荐流：按游标取「一页」。先尝试免签，失败再带签名。
 * cursor = { offset, filterIds }（首页传 {} 或省略）。
 * 返回 { items, cursor: 下一页游标, hasMore }，供增量分页（UI）直接续取。
 */
export async function feedPage(signer, cursor = {}, { limit = 18, genre = 'comic_series' } = {}) {
  const profile = activeProfile();
  const offset = cursor.offset || 0;
  const filterIds = cursor.filterIds || [];
  const code = GENRES[genre] ? genre : 'comic_series';
  const meta = GENRES[code];
  const body = {
    filter_ids: filterIds.join(','),
    req_scene: meta.scene,
    offset,
    need_selector_panel: false,
    limit,
    select_items: {
      category_dim_epoch: [],
      online_time: ['days_7'],
      gender: [],
      category_dim_role: [],
      genre: [code],
      sort: ['hot_score'],
      category_dim_theme: [],
    },
    session_id: '',
    req_type: 'only_content',
    client_req_type: 3,
  };
  const url = buildUrl(API_HOST, '/reading/distribution/category/landpage/v', {
    ...profile.query,
    _rticket: String(Date.now()),
  });

  let r = await call(signer, {
    method: 'POST', url, headers: profile.headers, body, signed: false,
  });
  if (r.json?.code !== 0) {
    r = await call(signer, {
      method: 'POST', url, headers: profile.headers, body, signed: true,
    });
  }
  if (r.json?.code !== 0) {
    throw new Error(`feed failed: http=${r.status} code=${r.json?.code} msg=${r.json?.message || ''}`);
  }

  const data = r.json.data || {};
  const items = (data.video_data || []).map(parseFeedItem).filter((x) => x.series_id);
  const nextCursor = {
    offset: offset + items.length,
    filterIds: [...filterIds, ...items.map((x) => x.series_id)].slice(-200),
  };
  const hasMore = !!data.has_more && items.length > 0;
  return { items, cursor: nextCursor, hasMore };
}

/**
 * 推荐流：landpage + hot_score，累计抓 `pages` 页（CLI / P0 用）。
 */
export async function feed(signer, { pages = 2, limit = 18, genre = 'comic_series', onPage } = {}) {
  const out = [];
  let cursor = {};
  for (let page = 0; page < pages; page++) {
    const { items, cursor: next, hasMore } = await feedPage(signer, cursor, { limit, genre });
    out.push(...items);
    if (onPage) onPage(page, items);
    cursor = next;
    if (!hasMore) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

function parseSearchCell(cell) {
  const vdata = Array.isArray(cell.video_data)
    ? (cell.video_data[0] || {})
    : (cell.video_data || {});
  const vd = cell.video_detail || {};
  const inner = vdata.video_detail || {};
  const sid = cell.book_id || cell.search_result_id;
  const ep = vd.episode_cnt || vdata.episode_cnt || inner.episode_cnt || 0;
  if (!sid || !ep) return null;
  const rawTitle = cell.search_high_light?.title?.text
    || vd.series_title || vdata.title || inner.series_title || '';
  return {
    series_id: String(sid),
    title: String(rawTitle).replace(/<[^>]+>/g, ''),
    episode_cnt: Number(ep) || 0,
    vid: vdata.vid || '',
    cover: vdata.cover || inner.series_cover || '',
    category: '',
  };
}

/**
 * 搜索：按游标取「一页」（无身份健康处理）。
 * cursor = { offset, passback, searchId }（首页传 {} 或省略）。
 * 返回 { items, cursor: 下一页游标, hasMore }。
 */
async function searchPageRaw(signer, query, cursor = {}) {
  if (!SEARCH_PROFILE?.query?.device_id || !SEARCH_PROFILE?.query?.iid) {
    throw new Error('游客模式不支持搜索：推荐和播放无需凭证，搜索需要本地运行凭证。');
  }
  const offset = cursor.offset || 0;
  const passback = cursor.passback || '';
  const searchId = cursor.searchId || '';
  const params = {
    ...SEARCH_PROFILE.query,
    query,
    tab_name: 'feed',
    search_source: '1',
    offset: String(offset),
    count: '0',
    use_correct: 'true',
    _rticket: String(Date.now()),
  };
  if (passback) params.passback = passback;
  if (searchId) params.search_id = searchId;

  const url = buildUrl(API_HOST, '/reading/bookapi/search/tab/v', params);
  await throttle('search');
  const r = await call(signer, {
    method: 'GET', url, headers: SEARCH_PROFILE.headers, signed: true,
  });
  if (r.json?.code !== 0) {
    throw new Error(`search failed: http=${r.status} code=${r.json?.code} msg=${r.json?.message || ''} body=${String(r.text || '').slice(0, 240)}`);
  }
  const tab = (r.json.search_tabs || [])[0];
  if (!tab) return { items: [], cursor, hasMore: false };
  const items = (tab.data || []).map(parseSearchCell).filter(Boolean);
  const nextCursor = {
    offset: tab.next_offset ?? offset + items.length,
    passback: tab.passback || passback,
    searchId: tab.search_id || searchId,
  };
  const hasMore = !!tab.has_more && items.length > 0;
  return { items, cursor: nextCursor, hasMore };
}

/**
 * 搜索：按游标取「一页」，首页带身份健康处理（空结果/失败时按需自动轮换重试一次）。
 * 供 UI 增量分页使用。cursor 同 searchPageRaw。
 */
export async function searchPage(signer, query, cursor = {}) {
  const first = !cursor.passback && !cursor.searchId && !(cursor.offset > 0);
  try {
    const res = await searchPageRaw(signer, query, cursor);
    if (!first) return res;
    if (res.items.length > 0) { noteSearchHealth(false); return res; }
    noteSearchHealth(true); // 首页空 200
    if (AUTO_ROTATE && emptyStreak >= 2 && (await autoRotate())) {
      noteSearchHealth(false);
      return searchPageRaw(signer, query, cursor);
    }
    return res;
  } catch (e) {
    if (first && /^search failed:/.test(String(e?.message || e))) {
      noteSearchHealth(true);
      if (AUTO_ROTATE && emptyStreak >= 2 && (await autoRotate())) {
        noteSearchHealth(false);
        return searchPageRaw(signer, query, cursor);
      }
    }
    throw e;
  }
}

async function searchOnce(signer, query, { pages = 1, onPage } = {}) {
  const out = [];
  let cursor = {};
  for (let page = 0; page < pages; page++) {
    const { items, cursor: next, hasMore } = await searchPageRaw(signer, query, cursor);
    out.push(...items);
    if (onPage) onPage(page, items);
    cursor = next;
    if (!hasMore) break;
  }
  return out;
}

/**
 * 搜索（带身份健康处理）：空 200 / code=100103 视为可疑；连续 2 次且开启自动轮换时，
 * 切下一个 ok 身份并重试一次；否则回落提示。本次调用最多自动轮换一次，防止循环。
 */
export async function search(signer, query, opts = {}) {
  try {
    const out = await searchOnce(signer, query, opts);
    if (out.length > 0) { noteSearchHealth(false); return out; }
    noteSearchHealth(true); // 空 200
    if (AUTO_ROTATE && emptyStreak >= 2 && (await autoRotate())) {
      noteSearchHealth(false);
      return searchOnce(signer, query, opts);
    }
    return out;
  } catch (e) {
    // 服务端级失败（200 但 code!=0 / 空 body / 100103）视为身份可疑；
    // 网络级 "request failed:" 是瞬时抖动，不当作身份问题、不轮换。
    if (/^search failed:/.test(String(e?.message || e))) {
      noteSearchHealth(true);
      if (AUTO_ROTATE && emptyStreak >= 2 && (await autoRotate())) {
        noteSearchHealth(false);
        return searchOnce(signer, query, opts);
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// video_model（免签 public guest）
// ---------------------------------------------------------------------------

function normalizeVideoModel(json, vid) {
  const data = json?.data;
  let item = data?.[String(vid)] ?? null;
  if (!item && Array.isArray(data)) {
    item = data.find((x) => String(x?.vid ?? x?.video_id ?? '') === String(vid)) || null;
  }
  if (!item && data?.video_model) item = data;
  let vm = item?.video_model ?? item;
  if (typeof vm === 'string') {
    try { vm = JSON.parse(vm); } catch {
      try { vm = JSON.parse(Buffer.from(vm, 'base64').toString('utf8')); } catch {}
    }
  }
  return vm && typeof vm === 'object' ? vm : null;
}

export function videoTracks(vm) {
  let list = Array.isArray(vm) ? vm : vm?.video_list;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = list.video_list ?? Object.values(list);
  }
  return Array.isArray(list) ? list.filter((t) => t && typeof t === 'object') : [];
}

function decodeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  } catch {}
  return value;
}

export function trackInfo(t) {
  let nested = t.video_meta;
  if (typeof nested === 'string') {
    try { nested = JSON.parse(nested); } catch { nested = {}; }
  }
  let enc = t.encrypt_info;
  if (typeof enc === 'string') {
    try { enc = JSON.parse(enc); } catch { enc = {}; }
  }
  const m = { ...t, ...(nested && typeof nested === 'object' ? nested : {}) };
  const w = Number(m.vwidth) || 0;
  const h = Number(m.vheight) || 0;
  const mainUrl = decodeUrl(t.main_url || m.main_url || '');
  const spadeA = enc?.spade_a || t.spade_a || m.spade_a || '';
  return {
    definition: m.definition || '',
    width: w,
    height: h,
    short: w && h ? Math.min(w, h) : 0,
    size: Number(m.size) || 0,
    encrypt: Boolean(enc?.encrypt ?? t.encrypt ?? true),
    hasMain: Boolean(mainUrl),
    hasSpade: Boolean(spadeA),
    mainUrl,
    spadeA,
  };
}

const IMAGE_SHRINK = 'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d\n';
const episodesCache = new Map(); // series_id -> { at, value }（6 小时）

/**
 * 某部剧的剧集列表（multi_video_detail）。
 * 返回 { series_id, title, episode_cnt, episodes: [{ index, vid, title, duration, cover }] }。
 * 播放器的“上一集/下一集”用这里的 episodes，而不是 feed 里的“下一部剧”。
 */
export async function episodes(signer, seriesId) {
  const sid = String(seriesId);
  const hit = episodesCache.get(sid);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.value;

  const body = {
    biz_param: {
      detail_page_version: 0, disable_digg_stat: false,
      disable_video_relate_book: false, image_shrink_datas_str: IMAGE_SHRINK,
      need_all_video_definition: false, need_mp4_align: false,
      screen_width_px: '900', source: 7,
      use_os_player: false, use_server_dns: false,
    },
    series_id: sid,
  };
  const profile = activeProfile();
  const url = buildUrl(API_HOST, '/novel/player/multi_video_detail/v1/', {
    ...profile.query,
    _rticket: String(Date.now()),
  });
  await throttle('detail');
  let r = await call(signer, {
    method: 'POST', url, headers: profile.headers, body, signed: true,
  });
  if (r.json?.code !== 0) {
    r = await call(signer, {
      method: 'POST', url, headers: profile.headers, body, signed: false,
    });
  }
  if (r.json?.code !== 0) {
    throw new Error(`episodes failed: http=${r.status} code=${r.json?.code} msg=${r.json?.message || ''}`);
  }
  const data = r.json.data || {};
  const vd = data[sid]?.video_data || Object.values(data)[0]?.video_data || {};
  const rawList = Array.isArray(vd.video_list)
    ? vd.video_list
    : Object.values(vd.video_list || {});
  const list = rawList
    .map((e) => ({
      index: Number(e.vid_index) || 0,
      vid: String(e.vid || e.video_id || ''),
      title: String(e.title || '').slice(0, 40),
      duration: Number(e.duration) || 0,
      cover: e.episode_cover || e.cover || '',
    }))
    .filter((e) => e.vid)
    .sort((a, b) => a.index - b.index);

  const value = {
    series_id: sid,
    title: vd.series_title || '',
    episode_cnt: Number(vd.episode_cnt) || list.length,
    episodes: list,
  };
  episodesCache.set(sid, { at: Date.now(), value });
  return value;
}

export async function videoModel(vid) {
  const url = buildUrl(PLAYER_HOST, '/novel/player/multi_video_model/v1/',
    PUBLIC_PROFILE.query, '*~');
  const body = {
    mixed_video_id_map: { 1: [String(vid)] },
    biz_param: {
      detail_page_version: 0, device_level: 3,
      disable_digg_stat: false, disable_video_relate_book: false,
      need_all_video_definition: true, need_mp4_align: false,
      use_os_player: false, use_server_dns: false, video_platform: 1024,
    },
  };
  const headers = { ...PUBLIC_PROFILE.headers, 'content-type': 'application/json; charset=utf-8' };
  await throttle('player');
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`video_model failed: code=${json.code} msg=${json.message || ''}`);
  const vm = normalizeVideoModel(json, vid);
  return videoTracks(vm).map(trackInfo).sort((a, b) => b.short - a.short);
}

export function pick1080(tracks) {
  return tracks.find((t) => t.short >= 1080) || null;
}

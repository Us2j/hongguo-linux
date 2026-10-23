#!/usr/bin/env node
/**
 * 身份工厂（Phase 0）。管理多套设备身份：列表 / 查看 / 复测 / 切换 / 轮换 / 新建 / 退役。
 *
 *   node tools/device/identity.mjs list
 *   node tools/device/identity.mjs show <name>
 *   node tools/device/identity.mjs test <name>
 *   node tools/device/identity.mjs use <name> [--force]
 *   node tools/device/identity.mjs rotate
 *   node tools/device/identity.mjs new --name <name> [--avd hgx86] [--no-test] [--port 5556]
 *   node tools/device/identity.mjs retire <name>
 *   node tools/device/identity.mjs doctor
 *
 * 存储布局：
 *   config/device.json              当前激活身份（api.js 读取；use 时原子复制）
 *   config/devices/index.json       列表 + active 指针 + 每个身份的元数据
 *   config/devices/<name>.json      一套身份
 *   config/backups/device-<ts>.json use 覆盖前对旧 active 的滚动备份（保留最近 5 个）
 *
 * 安全：所有写盘 0600 + 临时文件 rename；show 脱敏 device_token；new 一次只造 1 个、
 * 同一时间只跑 1 个模拟器；device_id 重复会被拒绝，不写进 index。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DEVICES_DIR = path.join(CONFIG_DIR, 'devices');
const BACKUPS_DIR = path.join(CONFIG_DIR, 'backups');
const INDEX_PATH = path.join(DEVICES_DIR, 'index.json');
const ACTIVE_PATH = path.join(CONFIG_DIR, 'device.json');
const APK = process.env.APK || path.join(ROOT, '..', 'com.phoenix.read_7.4.1.32.apk');
const EMULATOR_SH = path.join(ROOT, 'tools', 'device', 'register_emulator.sh');
const SEARCH_QUERY = process.env.HG_TEST_QUERY || '总裁';

// --- 小工具 ------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const log = (...a) => console.log('[identity]', ...a);
const fail = (msg) => { console.error('[identity] 错误:', msg); process.exit(1); };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 临时文件 + rename 原子写入，权限 0600。 */
function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function deviceFile(name) {
  return path.join(DEVICES_DIR, `${name}.json`);
}

/**
 * 从身份内容猜测来源：模拟器指纹 vs 真机。只认模拟器特有标记
 * （sdk_gphone / x86 / goldfish / ranchu / google sdk），不看 userdebug/test-keys
 * ——那些自编译 ROM（如 LineageOS 真机）也会有，会误判。
 */
function detectSource(cfg) {
  if (cfg.source === 'emulator' || cfg.source === 'real') return cfg.source;
  const p = cfg.profile || {};
  const type = `${p.device_type || ''}`.toLowerCase();
  const brand = `${p.device_brand || ''}`.toLowerCase();
  const abi = `${p.host_abi || ''}`.toLowerCase();
  const emu = /sdk_gphone|goldfish|ranchu|emulator/.test(type)
    || /x86/.test(type) || /x86/.test(abi)
    || (brand === 'google' && /^sdk/.test(type));
  return emu ? 'emulator' : 'real';
}

/** 把任意身份 JSON 规整成带 name/source/meta 的身份文件结构（保留全部原字段/富 profile）。 */
function toIdentity(raw, name, sourceType, metaOverride = {}) {
  const meta = {
    avd: null, apk: path.basename(APK), serial: null,
    status: 'untested', last_test: null, last_code: null, last_results: null, note: '',
    ...(raw.meta || {}), ...metaOverride,
  };
  return {
    ...raw,
    name,
    source: sourceType,
    created: raw.created || nowIso(),
    meta,
  };
}

function indexEntry(id) {
  const m = id.meta || {};
  return {
    name: id.name,
    file: `devices/${id.name}.json`,
    device_id: id.device_id || '',
    source: id.source || detectSource(id),
    created: id.created || '',
    status: m.status || 'untested',
    last_test: m.last_test || null,
    last_code: m.last_code ?? null,
    last_results: m.last_results ?? null,
  };
}

// --- 存储：首次运行自动迁移 ---------------------------------------------------

/** 保证 devices/ + backups/ + index.json 存在；首次把现有单文件身份迁移进来。 */
function ensureStore() {
  fs.mkdirSync(DEVICES_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (fs.existsSync(INDEX_PATH)) return readJson(INDEX_PATH);

  log('首次运行：初始化 config/devices 并迁移现有身份');
  const identities = [];
  let activeName = null;

  // 1) 激活身份 config/device.json → emu-current（或按指纹判断）。
  if (fs.existsSync(ACTIVE_PATH)) {
    const raw = readJson(ACTIVE_PATH);
    const src = detectSource(raw);
    const name = src === 'emulator' ? 'emu-current' : `real-${String(raw.device_id || '').slice(-6)}`;
    const id = toIdentity(raw, name, src, {
      avd: src === 'emulator' ? 'hgx86' : null,
      status: 'untested', note: '迁移自 config/device.json',
    });
    atomicWrite(deviceFile(name), id);
    identities.push(id);
    activeName = name;
    log(`迁移激活身份 → ${name} (device_id=${raw.device_id})`);
  }

  // 2) 历史备份 config/device.backup.*.json → real-<serial> / emu-<id6>。
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    if (!/^device\.backup\..*\.json$/.test(f)) continue;
    let raw;
    try { raw = readJson(path.join(CONFIG_DIR, f)); } catch { continue; }
    const src = detectSource(raw);
    if (identities.some((x) => x.device_id === raw.device_id)) continue; // 与已迁移的重复
    // 不写死任何真实设备 ID / serial，统一按 device_id 末 6 位命名。
    const name = src === 'real'
      ? `real-${String(raw.device_id || '').slice(-6)}`
      : `emu-${String(raw.device_id || '').slice(-6)}`;
    if (fs.existsSync(deviceFile(name))) continue;
    const id = toIdentity(raw, name, src, {
      serial: null,
      status: 'untested', note: `迁移自 ${f}`,
    });
    atomicWrite(deviceFile(name), id);
    identities.push(id);
    log(`迁移备份 ${f} → ${name} (device_id=${raw.device_id})`);
  }

  const index = { active: activeName, identities: identities.map(indexEntry) };
  atomicWrite(INDEX_PATH, index);
  return index;
}

function loadIndex() { return ensureStore(); }
function saveIndex(index) { atomicWrite(INDEX_PATH, index); }

function loadIdentity(name) {
  const file = deviceFile(name);
  if (!fs.existsSync(file)) fail(`身份不存在: ${name}（先 list 看看）`);
  return readJson(file);
}

/** 把一次 test 结果回写到身份文件 meta 与 index 条目。 */
function recordTest(name, result) {
  const id = loadIdentity(name);
  id.meta = id.meta || {};
  id.meta.status = result.ok ? 'ok' : 'failed';
  id.meta.last_test = nowIso();
  id.meta.last_code = result.code ?? null;
  id.meta.last_results = result.count ?? null;
  if (result.error) id.meta.note = String(result.error).slice(0, 200);
  atomicWrite(deviceFile(name), id);

  const index = loadIndex();
  const e = index.identities.find((x) => x.name === name);
  if (e) {
    e.status = id.meta.status;
    e.last_test = id.meta.last_test;
    e.last_code = id.meta.last_code;
    e.last_results = id.meta.last_results;
    saveIndex(index);
  }
  return id;
}

// --- 复测（子进程，HG_DEVICE_CONFIG 指向该身份，不动激活身份） ----------------

function runTest(name) {
  const file = deviceFile(name);
  if (!fs.existsSync(file)) fail(`身份不存在: ${name}`);
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '__runtest'], {
    cwd: ROOT,
    env: { ...process.env, HG_DEVICE_CONFIG: file },
    encoding: 'utf8',
    timeout: 180000,
  });
  const out = `${r.stdout || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
  let result;
  if (line) {
    try { result = JSON.parse(line.slice('__RESULT__'.length)); } catch {}
  }
  if (!result) {
    result = { ok: false, code: null, count: 0, query: SEARCH_QUERY,
      error: (r.stderr || out || `exit ${r.status}`).toString().slice(-240) };
  }
  return result;
}

/** __runtest：在设置了 HG_DEVICE_CONFIG 的子进程里实跑一次搜索，打印 __RESULT__{...}。 */
async function runtestChild() {
  const result = { ok: false, code: null, count: 0, query: SEARCH_QUERY, error: null };
  let signer;
  try {
    const { Signer } = await import('../services/signer.js');
    const { search } = await import('../services/api.js');
    signer = new Signer();
    await signer.start();
    const items = await search(signer, SEARCH_QUERY, { pages: 1 });
    result.code = 0;
    result.count = items.length;
    result.ok = items.length > 0;
    if (!result.ok) result.error = 'empty-200（code=0 但 0 条，身份可能已被标记）';
  } catch (e) {
    const msg = String(e?.message || e);
    const m = /code=(-?\d+)/.exec(msg);
    if (m) result.code = Number(m[1]);
    result.error = msg.slice(0, 240);
  } finally {
    try { signer?.stop(); } catch {}
  }
  process.stdout.write(`__RESULT__${JSON.stringify(result)}\n`);
  process.exit(0);
}

// --- 命令 --------------------------------------------------------------------

function cmdList() {
  const index = loadIndex();
  if (!index.identities.length) { log('暂无身份；用 new 造一个，或先运行一次 feed/search 以生成 device.json'); return; }
  const rows = index.identities.map((e) => ({
    name: e.name + (e.name === index.active ? ' *' : ''),
    source: e.source || '',
    device_id: e.device_id || '',
    status: e.status || '',
    code: e.last_code == null ? '-' : String(e.last_code),
    tested: e.last_test ? e.last_test.replace('T', ' ').slice(0, 19) : '-',
  }));
  const cols = ['name', 'source', 'device_id', 'status', 'code', 'tested'];
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(w[c])).join('  ');
  console.log(line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  for (const r of rows) console.log(line(r));
  console.log(`\n* = 当前激活 (active=${index.active || '无'})`);
}

function cmdShow(name) {
  const id = loadIdentity(name);
  const redacted = { ...id };
  if (redacted.device_token) redacted.device_token = '***REDACTED***';
  console.log(JSON.stringify(redacted, null, 2));
}

async function cmdTest(name) {
  loadIdentity(name);
  log(`复测 ${name}（搜索 "${SEARCH_QUERY}"）...`);
  const result = runTest(name);
  recordTest(name, result);
  if (result.ok) log(`✓ ok  code=${result.code} 结果=${result.count}`);
  else log(`✗ 失败  code=${result.code ?? '-'} ${result.error || ''}`);
  if (!result.ok) process.exitCode = 1;
}

function backupActive() {
  if (!fs.existsSync(ACTIVE_PATH)) return;
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = nowIso().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.join(BACKUPS_DIR, `device-${ts}.json`);
  fs.copyFileSync(ACTIVE_PATH, dest);
  fs.chmodSync(dest, 0o600);
  // 只保留最近 5 个备份。
  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => /^device-.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of backups.slice(5)) fs.unlinkSync(path.join(BACKUPS_DIR, f));
}

function useIdentity(name, { force = false } = {}) {
  const id = loadIdentity(name);
  const status = id.meta?.status || 'untested';
  if (status !== 'ok' && !(status === 'untested' && force)) {
    fail(`${name} 状态=${status}，不允许 use（先 test，或 untested 加 --force）`);
  }
  backupActive();
  atomicWrite(ACTIVE_PATH, id);
  const index = loadIndex();
  index.active = name;
  saveIndex(index);
  log(`已切换激活身份 → ${name} (device_id=${id.device_id})`);
}

function cmdUse(name, force) { useIdentity(name, { force }); }

function cmdRotate() {
  const index = loadIndex();
  const oks = index.identities.filter((e) => e.status === 'ok' && e.name !== index.active);
  if (!oks.length) fail('没有其它 ok 身份可轮换（先 test 或 new 一个）');
  const next = oks[0];
  log(`轮换：${index.active || '无'} → ${next.name}`);
  useIdentity(next.name, { force: false });
}

function cmdRetire(name) {
  const id = loadIdentity(name);
  id.meta = id.meta || {};
  id.meta.status = 'retired';
  atomicWrite(deviceFile(name), id);
  const index = loadIndex();
  const e = index.identities.find((x) => x.name === name);
  if (e) e.status = 'retired';
  saveIndex(index);
  log(`已退役 ${name}（文件保留）`);
}

// --- doctor ------------------------------------------------------------------

function which(bin) {
  const r = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function cmdDoctor() {
  ensureStore(); // 保证 config/devices 已初始化/迁移，否则会误报 index 缺失
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  // KVM
  let kvm = false;
  try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); kvm = true; } catch {}
  add(kvm, '/dev/kvm 可读写', kvm ? 'ok' : '缺失/无权限；new 会失败（不跑 TCG）');

  // adb
  const adb = which('adb') || (fs.existsSync(`${process.env.HOME}/Android/Sdk/platform-tools/adb`) ? `${process.env.HOME}/Android/Sdk/platform-tools/adb` : null);
  add(!!adb, 'adb', adb || '未找到');

  // emulator
  const emuCandidates = [
    process.env.EMULATOR_BIN,
    `${process.env.HOME}/Android/Sdk/emulator/emulator`,
    '/opt/dev/android-sdk/emulator/emulator',
  ].filter(Boolean);
  const emu = emuCandidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  add(!!emu, 'emulator 可执行', emu || '未找到（设置 EMULATOR_BIN）');

  // AVD
  const avd = process.env.AVD || 'hgx86';
  const avdCfg = `${process.env.HOME}/.android/avd/${avd}.avd/config.ini`;
  add(fs.existsSync(avdCfg), `AVD ${avd}`, fs.existsSync(avdCfg) ? avdCfg : '不存在');

  // APK
  add(fs.existsSync(APK), 'APK', fs.existsSync(APK) ? APK : `不存在: ${APK}`);

  // java / javac
  add(!!which('java'), 'java', which('java') || '未找到（签名/注册需要）');
  add(!!(which('javac') || fs.existsSync(path.join(ROOT, 'signer', 'out'))), 'javac 或已编译 harness',
    which('javac') || path.join(ROOT, 'signer', 'out'));

  // ffmpeg
  add(!!which('ffmpeg'), 'ffmpeg', which('ffmpeg') || '未找到（HLS/解密需要）');

  // config
  add(fs.existsSync(INDEX_PATH), 'config/devices/index.json', fs.existsSync(INDEX_PATH) ? 'ok' : '缺失');

  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.label.padEnd(26)} ${c.detail}`);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) { console.log(`\n${bad.length} 项未通过`); process.exitCode = 1; }
  else console.log('\n全部通过');
}

// --- new ---------------------------------------------------------------------

function runningEmulators() {
  const adb = which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`;
  const r = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => /^emulator-\d+\s+device/.test(l)).map((l) => l.split(/\s+/)[0]);
}

function spawnEmulatorRegister({ name, avd, port }) {
  return new Promise((resolve) => {
    const out = deviceFile(name);
    const child = spawn('bash', [EMULATOR_SH], {
      cwd: ROOT,
      // WIPE=1：-wipe-data 冷启动，实测这是拿到新 device_id 的唯一有效办法。
      env: { ...process.env, AVD: avd, PORT: String(port), OUT: out, KEEP: '0', WIPE: '1', APK },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function cmdNew(opts) {
  const name = opts.name;
  if (!name) fail('new 需要 --name <name>');
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) fail('name 只能包含字母/数字/_/-');
  if (fs.existsSync(deviceFile(name))) fail(`身份已存在: ${name}`);

  // doctor 关键项
  try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
  catch { fail('/dev/kvm 不可用；拒绝在无 KVM 的机器上注册（不跑 TCG）。先修好 KVM 或用真机导出。'); }
  if (!fs.existsSync(APK)) fail(`找不到 APK: ${APK}`);

  const running = runningEmulators();
  if (running.length) fail(`已有模拟器在运行(${running.join(',')})，一次只允许 1 个；先关掉它：adb -s ${running[0]} emu kill`);

  const avd = opts.avd || 'hgx86';
  const port = Number(opts.port) || 5556;
  const index = loadIndex();

  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`新建身份 ${name}（AVD=${avd} port=${port} 第 ${attempt}/2 次）...`);
    const ok = await spawnEmulatorRegister({ name, avd, port: port + (attempt - 1) });
    if (!ok || !fs.existsSync(deviceFile(name))) {
      log(`第 ${attempt} 次失败`);
      try { fs.existsSync(deviceFile(name)) && fs.unlinkSync(deviceFile(name)); } catch {}
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      fail('模拟器注册失败（见上方日志）');
    }

    // 读回并补 name/source/meta。
    const raw = readJson(deviceFile(name));
    const src = detectSource(raw);

    // 去重：device_id 不能与已有身份相同。
    const dup = index.identities.find((e) => e.device_id === raw.device_id);
    if (dup) {
      log(`device_id=${raw.device_id} 与已有身份 ${dup.name} 重复`);
      try { fs.unlinkSync(deviceFile(name)); } catch {}
      if (attempt < 2) {
        log('重试（-wipe-data 会换新 device_id）...');
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      fail('device_id 重复，未写入 index（-wipe-data 后仍重复，异常；请检查模拟器）');
    }

    const id = toIdentity(raw, name, src, { avd, serial: `emulator-${port}`, status: 'untested' });
    atomicWrite(deviceFile(name), id);
    index.identities.push(indexEntry(id));
    saveIndex(index);
    log(`已写入身份 ${name} (device_id=${raw.device_id})`);

    if (!opts.noTest) {
      log('自动复测...');
      const result = runTest(name);
      recordTest(name, result);
      if (result.ok) log(`✓ ${name} ok code=${result.code} 结果=${result.count}`);
      else log(`✗ ${name} 复测未通过 code=${result.code ?? '-'} ${result.error || ''}`);
    }
    return;
  }
}

// --- 入口 --------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (n) => rest.includes(n);
  const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const positional = rest.find((a) => !a.startsWith('--'));

  switch (cmd) {
    case '__runtest': return runtestChild();
    case 'list': return cmdList();
    case 'show': return cmdShow(positional || fail('show 需要 <name>'));
    case 'test': return cmdTest(positional || fail('test 需要 <name>'));
    case 'use': return cmdUse(positional || fail('use 需要 <name>'), flag('--force'));
    case 'rotate': return cmdRotate();
    case 'retire': return cmdRetire(positional || fail('retire 需要 <name>'));
    case 'doctor': return cmdDoctor();
    case 'new': return cmdNew({ name: val('--name'), avd: val('--avd'), port: val('--port'), noTest: flag('--no-test') });
    default:
      console.log('usage: identity.mjs <list|show|test|use|rotate|new|retire|doctor> [args]');
      process.exitCode = 1;
  }
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));

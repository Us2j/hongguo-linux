#!/usr/bin/env node
/**
 * 设备身份导入/生成（设备注册的前置工具）。
 *
 *   node tools/device/register.mjs --fixed          # 用 HG_DEVICE_ID/HG_IID/... 环境变量写入
 *   node tools/device/register.mjs --random         # 生成一套新的匿名身份
 *   node tools/device/register.mjs --from cap.json  # 从抓包/手工导出的 JSON 导入
 *   node tools/device/register.mjs --show           # 查看当前 config/device.json
 *
 * 真正的“注册”是从 Android App 抓 /service/2/device_register/ 的响应；
 * 抓到 device_id/iid/cdid 后，用 --from 导入即可。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'device.json');

const PROFILES = [
  {
    device_type: 'SM-N9860', device_brand: 'Samsung',
    os_api: '28', os_version: '9', resolution: '900*1600', dpi: '320',
    rom_version: 'PQ3A.190705.10241111+release-keys',
    channel: 'oppo_8662_64',
  },
  {
    device_type: 'M2102J2SC', device_brand: 'Xiaomi',
    os_api: '30', os_version: '11', resolution: '1080*2400', dpi: '440',
    rom_version: 'RP1A.200720.011+release-keys',
    channel: 'xiaomi_8662_64',
  },
  {
    device_type: 'PJA110', device_brand: 'HONOR',
    os_api: '31', os_version: '12', resolution: '1200*2400', dpi: '480',
    rom_version: 'HUAWEI.PJA.110+release-keys',
    channel: 'honor_8662_64',
  },
  {
    device_type: '25053RT47C', device_brand: 'Redmi',
    os_api: '36', os_version: '16', resolution: '1280*2772', dpi: '520',
    rom_version: 'BP2A.250605.031.A3',
    channel: 'update_64',
  },
];

const KLINK_EGDI = process.env.HG_KLINK_EGDI || '';

const FIXED = {
  source: 'fixed-capture',
  device_id: process.env.HG_DEVICE_ID || '',
  iid: process.env.HG_IID || '',
  cdid: process.env.HG_CDID || '',
  install_id: null,
  session: null,
  openudid: null,
  klink_egdi: KLINK_EGDI,
  profile: {
    ...PROFILES[0],
    version_code: '71532',
    version_name: '7.1.5.32',
    manifest_version_code: '71532',
    update_version_code: '71532',
    host_abi: 'arm64-v8a',
    dragon_device_type: 'pad',
    pv_player: '71532',
    is_android_pad_screen: '0',
    compliance_status: '0',
    need_personal_recommend: '1',
    player_so_load: '1',
  },
  note: 'P0/P1 已验证可用；非登录身份',
};

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s[0] === '0' ? '1' + s.slice(1) : s;
}

function randomProfile() {
  const p = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  return {
    ...p,
    version_code: '71532',
    version_name: '7.1.5.32',
    manifest_version_code: '71532',
    update_version_code: '71532',
    host_abi: 'arm64-v8a',
    dragon_device_type: 'pad',
    pv_player: '71532',
    is_android_pad_screen: '0',
    compliance_status: '0',
    need_personal_recommend: '1',
    player_so_load: '1',
  };
}

function randomDevice() {
  return {
    source: 'generated',
    device_id: randomDigits(15),
    iid: randomDigits(16),
    cdid: crypto.randomUUID(),
    install_id: crypto.randomBytes(8).toString('hex'),
    session: crypto.randomBytes(9).toString('base64url'),
    openudid: crypto.randomBytes(8).toString('hex'),
    klink_egdi: KLINK_EGDI,
    profile: randomProfile(),
    note: '随机匿名身份；搜索可能被风控',
  };
}


function adbShell(serial, command) {
  const args = ['-s', serial];
  if (serial === 'auto') args.splice(0, 2);
  args.push('shell', command);
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 20000 }).trim();
}

function adbSu(serial, command) {
  // Google APIs emulator: `adb root` gives uid=0 directly; real phone: use su.
  try {
    if (/uid=0/.test(adbShell(serial, 'id'))) return adbShell(serial, command);
  } catch {}
  return adbShell(serial, `su -c '${command}'`);
}

function xmlString(xml, name) {
  const m = new RegExp(`<string name="${name}">([\\s\\S]*?)</string>`).exec(xml);
  if (!m) return null;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function versionName(code) {
  const map = { 74132: '7.4.1.32', 73332: '7.3.3.32', 72232: '7.2.2.32', 71532: '7.1.5.32' };
  return map[code] || '7.4.1.32';
}

function exportFromDevice(serial) {
  const base = '/data/data/com.phoenix.read/shared_prefs';
  const applog = adbSu(serial, `cat ${base}/applog_stats.xml`);
  const cdidXml = adbSu(serial, `cat ${base}/com.ss.android.deviceregister.utils.Cdid.xml`);
  const install = adbSu(serial, `cat ${base}/ug_install_settings_pref.xml`);

  const deviceId = xmlString(applog, 'device_id') || xmlString(install, 'device_id');
  const iid = xmlString(applog, 'install_id') || xmlString(install, 'install_id');
  const cdid = xmlString(cdidXml, 'cdid') || xmlString(install, 'cdid');
  if (!deviceId || !iid) throw new Error('设备上未找到 device_id/iid（App 是否已启动过？）');

  const versionCode = xmlString(applog, 'version_code') || '74132';
  const channel = xmlString(applog, 'channel') || 'fx_duanju_cn_rlx_7697138109812575256_pii8mejdm2s';
  const openudid = xmlString(install, 'openudid');
  const clientudid = xmlString(install, 'clientudid');
  const deviceToken = xmlString(install, 'device_token');

  const model = adbShell(serial, 'getprop ro.product.model');
  const brand = adbShell(serial, 'getprop ro.product.brand');
  const sdk = adbShell(serial, 'getprop ro.build.version.sdk');
  const release = adbShell(serial, 'getprop ro.build.version.release');
  const buildId = adbShell(serial, 'getprop ro.build.display.id');
  const sizeRaw = adbShell(serial, 'wm size');
  const densityRaw = adbShell(serial, 'wm density');
  const size = /(\d+)x(\d+)/.exec(sizeRaw) || [null, '1080', '2340'];
  const density = /(\d+)/.exec(densityRaw) || [null, '440'];

  return {
    source: 'device-export',
    device_id: deviceId,
    iid,
    cdid: cdid || crypto.randomUUID(),
    openudid: openudid || null,
    clientudid: clientudid || null,
    device_token: deviceToken || null,
    install_id: null,
    session: null,
    klink_egdi: KLINK_EGDI,
    profile: {
      device_type: model || 'Redmi K20 Pro',
      device_brand: brand || 'Xiaomi',
      os_api: sdk || '34',
      os_version: release || '14',
      resolution: `${size[1]}*${size[2]}`,
      dpi: density[1],
      rom_version: buildId || 'AP2A.240905.003',
      channel,
      version_code: versionCode,
      version_name: versionName(versionCode),
      manifest_version_code: versionCode,
      update_version_code: versionCode,
      host_abi: 'arm64-v8a',
      dragon_device_type: 'pad',
      pv_player: versionCode,
      is_android_pad_screen: '0',
      compliance_status: '0',
      need_personal_recommend: '1',
      player_so_load: '1',
    },
    note: 'exported from a real registered install via adb (root)',
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = String(obj[k]);
  }
  return out;
}

function normalize(raw) {
  const src = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const device = src?.device && typeof src.device === 'object' ? src.device : src;
  const profileSource = device.profile && typeof device.profile === 'object'
    ? device.profile : device;

  const profileKeys = [
    'device_type', 'device_brand', 'os_api', 'os_version', 'resolution', 'dpi',
    'rom_version', 'channel', 'version_code', 'version_name',
    'manifest_version_code', 'update_version_code', 'host_abi',
    'dragon_device_type', 'pv_player', 'is_android_pad_screen',
    'compliance_status', 'need_personal_recommend', 'player_so_load',
  ];
  const profile = {
    ...PROFILES[0],
    version_code: '71532',
    version_name: '7.1.5.32',
    manifest_version_code: '71532',
    update_version_code: '71532',
    host_abi: 'arm64-v8a',
    dragon_device_type: 'pad',
    pv_player: '71532',
    is_android_pad_screen: '0',
    compliance_status: '0',
    need_personal_recommend: '1',
    player_so_load: '1',
    ...pick(profileSource, profileKeys),
  };

  const device_id = device.device_id ?? device.deviceId ?? device.did;
  const iid = device.iid ?? device.install_id ?? device.installId;
  const cdid = device.cdid ?? device.clientudid ?? device.clientUdid;
  if (!device_id || !iid) {
    throw new Error('缺少 device_id 或 iid');
  }
  return {
    source: 'imported',
    device_id: String(device_id),
    iid: String(iid),
    cdid: cdid ? String(cdid) : crypto.randomUUID(),
    install_id: device.install_id ? String(device.install_id) : null,
    session: device.session ? String(device.session) : null,
    openudid: device.openudid ? String(device.openudid) : null,
    klink_egdi: device.klink_egdi ? String(device.klink_egdi) : KLINK_EGDI,
    profile,
    note: 'imported from capture/json',
  };
}

function writeConfig(cfg, outPath = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log(`[device] wrote ${outPath}`);
  console.log(JSON.stringify({
    source: cfg.source,
    device_id: cfg.device_id,
    iid: cfg.iid,
    cdid: cfg.cdid,
    profile: cfg.profile,
  }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const has = (name) => args.includes(name);
  const valueOf = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  // --out <path>：写到指定身份文件而非激活的 config/device.json（身份工厂用）。
  const outPath = typeof valueOf('--out') === 'string' ? path.resolve(valueOf('--out')) : CONFIG_PATH;
  const emit = (cfg) => writeConfig({ ...cfg, created: new Date().toISOString() }, outPath);

  if (has('--show') || args.length === 0) {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('[device] no config; run --fixed or --from');
      return;
    }
    console.log(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return;
  }

  if (has('--fixed')) {
    if (!FIXED.device_id || !FIXED.iid) {
      throw new Error('--fixed 需要 HG_DEVICE_ID / HG_IID（可选 HG_CDID / HG_KLINK_EGDI）；更推荐 --from-device');
    }
    emit(FIXED);
    return;
  }

  if (has('--random')) {
    emit(randomDevice());
    return;
  }

  if (has('--from-device')) {
    const serial = typeof valueOf('--from-device') === 'string' ? valueOf('--from-device') : 'auto';
    emit(exportFromDevice(serial));
    return;
  }

  if (has('--from')) {
    const file = valueOf('--from');
    if (!file) throw new Error('--from 需要 JSON 文件');
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    emit(normalize(raw));
    return;
  }

  throw new Error('usage: --fixed | --random | --from <json> | --from-device [serial] | --show [--out <path>]');
}

try {
  main();
} catch (e) {
  console.error('[device] error:', e.message);
  process.exitCode = 1;
}

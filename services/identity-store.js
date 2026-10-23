// 身份仓库的只读列表 + 切换激活，供 Electron 主进程在应用内热切换身份使用。
// 写盘语义与 tools/identity.mjs 一致（原子 rename、0600、滚动备份保留 5 个）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.HG_DATA_DIR || ROOT;
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const DEVICES_DIR = path.join(CONFIG_DIR, 'devices');
const BACKUPS_DIR = path.join(CONFIG_DIR, 'backups');
const INDEX_PATH = path.join(DEVICES_DIR, 'index.json');
const ACTIVE_PATH = path.join(CONFIG_DIR, 'device.json');

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 列出所有身份（不含敏感字段），标出当前激活。 */
export function listIdentities() {
  let idx;
  try { idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { active: null, identities: [] }; }
  const identities = (idx.identities || []).map((e) => ({
    name: e.name,
    device_id: e.device_id || '',
    source: e.source || '',
    status: e.status || 'untested',
    last_code: e.last_code ?? null,
    active: e.name === idx.active,
  }));
  return { active: idx.active || null, identities };
}

/** 切换激活身份：校验 ok → 备份旧 active（留 5）→ 原子复制 → 更新 index。返回新 active 的 device_id。 */
export function activateIdentity(name) {
  const file = path.join(DEVICES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`身份不存在: ${name}`);
  const id = JSON.parse(fs.readFileSync(file, 'utf8'));
  const status = id.meta?.status || 'untested';
  if (status !== 'ok') throw new Error(`${name} 状态=${status}，仅允许切换到 ok 身份`);

  if (fs.existsSync(ACTIVE_PATH)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dest = path.join(BACKUPS_DIR, `device-${ts}.json`);
    fs.copyFileSync(ACTIVE_PATH, dest);
    fs.chmodSync(dest, 0o600);
    const olds = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^device-.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of olds.slice(5)) fs.unlinkSync(path.join(BACKUPS_DIR, f));
  }

  atomicWrite(ACTIVE_PATH, id);
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    idx.active = name;
    atomicWrite(INDEX_PATH, idx);
  } catch { /* index 缺失不致命，device.json 已切换 */ }
  return { active: name, device_id: id.device_id };
}

/** 轮换到下一个 ok 且非 active 的身份。无可换返回 null。 */
export function rotate() {
  const { identities } = listIdentities();
  const next = identities.find((e) => e.status === 'ok' && !e.active);
  if (!next) return null;
  return activateIdentity(next.name);
}

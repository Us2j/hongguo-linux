#!/usr/bin/env node
/**
 * 按打包 profile 组装随包身份库到 resources/seed/config/：
 *   node tools/build/build-seed.mjs local [active]   # 全部身份，active 默认 real-837613c6
 *   node tools/build/build-seed.mjs user  [active]   # 仅模拟器身份 emu-*（不含真机），active 默认 emu-01
 *
 * 产物：resources/seed/config/{device.json, devices/index.json, devices/<name>.json}
 * 主进程首启会把它 cp 到 userData/config（见 electron/main.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVICES = path.join(ROOT, 'config', 'devices');
const INDEX = path.join(DEVICES, 'index.json');
const SEED = path.join(ROOT, 'resources', 'seed', 'config');

const profile = process.argv[2];
const activeArg = process.argv[3];
if (!['local', 'user'].includes(profile)) {
  console.error('用法: build-seed.mjs <local|user> [active]');
  process.exit(1);
}
if (!fs.existsSync(INDEX)) {
  console.error(`找不到身份库 ${INDEX}（先用 identity.mjs 造身份）`);
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const all = index.identities || [];

// profile 选集：local=全部；user=仅 emu-*（不含真机，避免泄露真机身份）。
const picked = all.filter((e) => e.status === 'ok'
  && (profile === 'local' ? true : /^emu/.test(e.name) && e.source !== 'real'));
if (!picked.length) {
  console.error(`profile=${profile} 没有可用(ok)身份`);
  process.exit(1);
}

// 选 active。
let active = activeArg
  || (profile === 'local'
    ? (picked.find((e) => e.name.startsWith('real-'))?.name)
    : (picked.find((e) => e.name === 'emu-01')?.name));
if (!active || !picked.some((e) => e.name === active)) active = picked[0].name;

// 写盘（先清空 SEED）。
fs.rmSync(path.join(ROOT, 'resources', 'seed'), { recursive: true, force: true });
fs.mkdirSync(path.join(SEED, 'devices'), { recursive: true });

for (const e of picked) {
  const src = path.join(DEVICES, `${e.name}.json`);
  fs.copyFileSync(src, path.join(SEED, 'devices', `${e.name}.json`));
  fs.chmodSync(path.join(SEED, 'devices', `${e.name}.json`), 0o600);
}
fs.writeFileSync(
  path.join(SEED, 'devices', 'index.json'),
  JSON.stringify({ active, identities: picked }, null, 2),
  { mode: 0o600 },
);
// device.json = active 身份内容
fs.copyFileSync(path.join(DEVICES, `${active}.json`), path.join(SEED, 'device.json'));
fs.chmodSync(path.join(SEED, 'device.json'), 0o600);

console.log(`[build-seed] profile=${profile} active=${active} 身份数=${picked.length}`);
console.log(`[build-seed] 名单: ${picked.map((e) => e.name).join(', ')}`);

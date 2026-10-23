#!/usr/bin/env node
// spade JS 移植自测：5 组运行时真值（libttmplayer FUN_001c4550 hook 抓取），
// 必须与 tools/decrypt/unwrap_spade.py 的 _TRUTH 一致。
//
//   node tools/test/test_spade.mjs
import { unwrapV1, spadeToKey } from '../../services/spade.js';

// [37B spade hex, 期望 32 hex content key]
const TRUTH = [
  ['93bc1df253ba1bf7618b19c448b806f64d810afc45b715fe5eb925f26cbf12f541ba098282', '287216bfa89e662a0f748120c305e199'],
  ['a1bc2ff164b91df04dbf00f17dba00f47cbb35c27b922aec67a628eb52972fdc7ea036a7a7', 'd742b28967e4e6c92b699f4375add27f'],
  ['9cbc12fb588721cd69b739f977b70be7429c08e074990ec847843dcc738638cf76b33ebcbc', '113fb30d9767d80e3edbb905b052204f'],
  ['a3bc2df760ba2bc27b8b34c04a8907f557be19f249be35c748ba03f64fbc1ff161ba29a2a2', 'b5674a8384f25d757585dadf343274d5'],
  ['9cbc12f45aba11f76fb814f444bd15f459b225cb5e8c15dd459a0fd170ac0ad358aa108b8b', '121846f9d5829130ebc0397023feaf8c'],
];

let ok = 0;
for (const [sp, exp] of TRUTH) {
  const got = unwrapV1(sp, 0);
  const hit = got === exp;
  ok += hit ? 1 : 0;
  console.log(`${hit ? 'OK  ' : 'FAIL'} ${got} == ${exp}`);
}

// spadeToKey(base64) 应与 unwrapV1(hex) 等价
const b64 = Buffer.from(TRUTH[0][0], 'hex').toString('base64');
const viaB64 = spadeToKey(b64, 0);
const b64ok = viaB64 === TRUTH[0][1];
console.log(`${b64ok ? 'OK  ' : 'FAIL'} spadeToKey(base64) -> ${viaB64}`);

const pass = ok === TRUTH.length && b64ok;
console.log(`${ok}/${TRUTH.length} vectors + base64 ${b64ok ? 'ok' : 'FAIL'}`);
if (!pass) process.exitCode = 1;

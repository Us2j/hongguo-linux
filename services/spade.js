// 红果 spade_a -> content key 纯离线 unwrap（JS 移植版，去 python 依赖）。
//
// 逐行移植自 tools/decrypt/unwrap_spade.py 的 unwrap_v1 / spade_to_key。
// 算法 = 纯字节变换（XOR + POPCOUNT + 位置相关），无 KEK、无 AES，连 node:crypto 都不需要。
// ver1 路径（flag=opt0x97，实测为 0）。ver2（app_v2/web_v2，AES-GCM）红果视频未用，返回 null。
//
// 链路: video_model.encrypt_info.spade_a(base64)
//       -> base64 decode -> unwrapV1 -> content key(16B -> 32 hex 字符)
//       -> 配合密文 AES-128-CTR 由 ffmpeg -decryption_key 解密。

function popcount(x) {
  x = x & 0xffffffff;
  let c = 0;
  // 处理成无符号 32 位再数 1
  x = x >>> 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

function s8(v) {
  v &= 0xff;
  return v >= 128 ? v - 256 : v;
}

function strncmp0(a, b, n) {
  for (let k = 0; k < n; k++) {
    const ca = k < a.length ? a[k] : 0;
    const cb = k < b.length ? b[k] : 0;
    if (ca !== cb) return false;
    if (ca === 0) return true;
  }
  return true;
}

/**
 * spade: Buffer（37B 密文）或 hex 字符串。
 * flag: 播放器 option 0x97 的值（实测为 0）；flag!=0 时变换方向相反。
 * 返回 32 hex content key 字符串，或 null（ver2 / 非法）。
 */
export function unwrapV1(spade, flag = 0) {
  if (typeof spade === 'string') spade = Buffer.from(spade, 'hex');
  const L = spade.length;
  if (L < 3) return null;

  const bVar5 = spade[0] ^ spade[1] ^ spade[2];
  const iVar9 = bVar5 - 0x30; // type 字符串长度
  if (iVar9 < 1) return null;

  const uVar1 = (L - bVar5) + 0x2f; // 工作缓冲长度
  if (uVar1 < 1 || 1 + uVar1 > L) return null;

  const dest = Buffer.from(spade.subarray(1, 1 + uVar1)); // memcpy(dest, spade+1, uVar1)

  // 解出 type 字符串, 判断 v1 / v2
  const s1 = Buffer.alloc(iVar9);
  const b16type = spade[L - iVar9 - 2];
  const b14type = spade[L - iVar9 - 1];
  for (let i = 0; i < iVar9; i++) {
    s1[i] = (b14type ^ b16type ^ spade[i + (L - iVar9)]) & 0xff;
  }
  if (strncmp0(s1, Buffer.from('app_v2'), iVar9)
    || strncmp0(s1, Buffer.from('web_v2'), iVar9)) {
    return null; // ver2: AES-GCM 路径, 此处不实现
  }

  // ver1 字节变换
  let b14 = 0x55;
  let b16 = 0xfa;
  for (let i = 0; i < uVar1; i++) {
    const b6 = dest[i];
    const u18 = popcount(i);
    let b3 = b6;
    let b7 = b14;
    if (i & 1) {
      b3 = b16;
      b7 = b6;
      b16 = b14;
    }
    const cVar4 = flag ? (u18 + 0x15) : s8(-0x15 - u18);
    dest[i] = (cVar4 + (b16 ^ b6)) & 0xff;
    b14 = b7;
    b16 = b3;
  }

  // 按 dest[0] 的 hex 值切出 content key
  const b0 = dest[0];
  let u11;
  if (b0 >= 0x30 && b0 <= 0x39) u11 = b0 - 0x30;
  else if (b0 >= 0x61 && b0 <= 0x7a) u11 = b0 - 0x57;
  else return null;

  const iv9 = uVar1 - (u11 & 0xff);
  if (iv9 < 2) return null;

  return dest.subarray(1, iv9).toString('latin1');
}

/**
 * video_model 的 spade_a(base64) -> content key(32 hex)。一步到位。
 * 返回 32 hex 字符串；非法/ver2 抛错。
 */
export function spadeToKey(spadeAB64, flag = 0) {
  if (!spadeAB64) throw new Error('missing spade_a');
  const key = unwrapV1(Buffer.from(spadeAB64, 'base64'), flag);
  if (!key || !/^[0-9a-f]{32}$/.test(key)) {
    throw new Error(`invalid content key: ${String(key).slice(0, 40)}`);
  }
  return key;
}

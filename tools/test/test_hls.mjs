#!/usr/bin/env node
// M1 端到端验证：<vid> → prepareHls → HLS server → ffprobe 应报 h264 1080x1920 + aac。
//
//   node tools/test/test_hls.mjs <vid>
//   node tools/test/test_hls.mjs            # 不给 vid 则 feed 第一条自动取
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Signer } from '../../services/signer.js';
import { feed } from '../../services/api.js';
import { prepareHls } from '../../services/media.js';
import { createHlsServer } from '../../services/hls_server.js';

const execFileAsync = promisify(execFile);

async function resolveVid(argVid) {
  if (argVid) return argVid;
  const signer = new Signer();
  await signer.start();
  try {
    const items = await feed(signer, { pages: 1 });
    const hit = items.find((x) => x.vid);
    if (!hit) throw new Error('feed 没有带 vid 的条目');
    console.log(`[test_hls] feed 第一条: ${hit.title} vid=${hit.vid}`);
    return hit.vid;
  } finally {
    signer.stop();
  }
}

async function main() {
  const vid = await resolveVid(process.argv[2]);
  const server = await createHlsServer();
  try {
    console.log(`[test_hls] prepareHls(${vid})…`);
    const t0 = Date.now();
    const info = await prepareHls(vid);
    console.log(`[test_hls] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      `${info.definition} ${info.width}x${info.height} cached=${info.cached}`);

    const url = server.urlFor(vid);
    console.log(`[test_hls] URL: ${url}`);

    const { stdout } = await execFileAsync('ffprobe', [
      '-hide_banner', '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'default=noprint_wrappers=1', url,
    ], { timeout: 30000 });
    console.log('[test_hls] ffprobe:\n' + stdout.trim());

    const ok = /codec_name=h264/.test(stdout) && /codec_name=aac/.test(stdout);
    console.log(ok ? '[test_hls] PASS (h264 + aac)' : '[test_hls] FAIL');
    if (!ok) process.exitCode = 1;
  } finally {
    await server.close();
    // ffmpeg 可能仍在后台写完整集；给它一点时间后强制退出进程。
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  }
}

main().catch((e) => {
  console.error('[test_hls] error:', e.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 无 UI 的「刷视频」：推荐/搜索 → 1080p → 下载解密 → 本地 HTTP 流 → mpv。
 *
 *   node bin/watch.mjs feed   --pages 2 --limit 5
 *   node bin/watch.mjs search "总裁" --pages 1 --limit 3
 *   node bin/watch.mjs feed --headless --limit 1   # 无显示器时解码验证
 *
 * mpv 播完自动下一集；Ctrl+C 退出。
 */
import { spawn } from 'node:child_process';
import { Signer } from '../services/signer.js';
import { feed, search, videoModel, pick1080 } from '../services/api.js';
import { prepare } from '../services/media.js';
import { createStreamServer } from '../services/stream.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

let stopping = false;
let currentPlayer = null;

function stopAll() {
  stopping = true;
  if (currentPlayer && currentPlayer.exitCode === null) {
    try { currentPlayer.kill('SIGTERM'); } catch {}
  }
}

function playWithMpv(url, title, headless) {
  const args = [
    '--no-terminal',
    '--really-quiet',
    `--title=${title}`,
    '--keep-open=no',
  ];
  if (headless) {
    args.push('--vo=null', '--ao=null', '--frames=180');
  } else {
    args.push('--force-window=yes', '--cache=yes');
  }
  args.push(url);
  return new Promise((resolve, reject) => {
    const proc = spawn('mpv', args, { stdio: 'ignore' });
    currentPlayer = proc;
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      currentPlayer = null;
      resolve({ code, signal });
    });
  });
}

async function collectItems(args, signer) {
  const pages = Number(args.pages || 1);
  const cmd = args._[0];
  if (cmd === 'feed') {
    return feed(signer, { pages });
  }
  if (cmd === 'search') {
    const query = args._[1];
    if (!query) throw new Error('search 需要关键词');
    return search(signer, query, { pages });
  }
  throw new Error(`unknown command: ${cmd}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(args.limit || 5);
  const headless = Boolean(args.headless)
    || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

  const signer = new Signer();
  const server = await createStreamServer();
  process.on('SIGINT', () => {
    stopAll();
    server.close().finally(() => process.exit(130));
  });

  await signer.start();
  try {
    const items = (await collectItems(args, signer))
      .filter((x) => x.vid)
      .slice(0, limit);
    if (items.length === 0) throw new Error('没有可播放的条目');

    console.log(`[watch] ${items.length} 条，headless=${headless}`);
    for (let i = 0; i < items.length; i++) {
      if (stopping) break;
      const item = items[i];
      console.log(`\n[watch] (${i + 1}/${items.length}) ${item.title}`);

      const current = await prepare(item.vid);
      const best = current.track || (await videoModel(item.vid)).reduce(
        (a, b) => (b.short > (a?.short || 0) ? b : a), null);
      console.log(`[watch] ${best?.definition || '?'} ${best?.width}x${best?.height}`
        + ` key=${current.key?.slice(0, 8)}…`);

      // 预取下一集
      const next = items[i + 1];
      if (next?.vid) {
        prepare(next.vid).catch((e) => console.log(`[prefetch] ${e.message}`));
      }

      const url = server.urlFor(item.vid);
      const started = Date.now();
      const result = await playWithMpv(url, item.title, headless);
      console.log(`[watch] mpv exit=${result.code} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (result.code === 4) { // 用户关闭窗口
        console.log('[watch] 用户退出');
        break;
      }
    }
  } finally {
    signer.stop();
    await server.close();
  }
}

main().catch((e) => {
  console.error('[watch] error:', e.message);
  stopAll();
  process.exitCode = 1;
});

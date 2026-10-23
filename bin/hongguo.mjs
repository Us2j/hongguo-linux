#!/usr/bin/env node
/**
 * 无 UI 的匿名红果客户端（P1）。
 *
 *   node bin/hongguo.mjs feed   --pages 2 [--models 3]
 *   node bin/hongguo.mjs search "总裁" --pages 1 [--models 3]
 *
 * 只做推荐流 / 搜索 + 可选 video_model 档位检查；不下载、不播放。
 */
import { Signer } from '../services/signer.js';
import { feed, search, videoModel, pick1080, GENRES } from '../services/api.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const GENRE_ALIASES = {
  '真人剧': 'short_play', '短剧': 'short_play', '真人': 'short_play',
  '漫剧': 'comic_series', '漫画': 'comic_series',
  'AI短剧': 'ai_series', 'AI剧': 'ai_series', 'ai': 'ai_series',
};

function normalizeGenre(value) {
  if (!value) return 'comic_series';
  const raw = String(value);
  if (GENRES[raw]) return raw;
  return GENRE_ALIASES[raw] || 'comic_series';
}

function printCard(i, item) {
  const ep = item.episode_cnt ? `${item.episode_cnt}集` : '';
  const cat = item.category ? `  ${item.category}` : '';
  console.log(`${String(i + 1).padStart(2, '0')}. ${item.title}  ${ep}${cat}`);
  console.log(`    id=${item.series_id}  vid=${item.vid || '-'}`);
}

async function printModels(items, n) {
  for (const item of items.slice(0, n)) {
    if (!item.vid) {
      console.log(`    [model] ${item.title}: 无 vid，跳过`);
      continue;
    }
    try {
      const tracks = await videoModel(item.vid);
      const best = pick1080(tracks);
      const list = tracks.map((t) => `${t.definition || t.short + 'p'}(${t.width}x${t.height})`).join(', ');
      console.log(`    [model] ${item.title}: ${best ? '1080p OK' : '无1080p'} | ${list}`);
    } catch (e) {
      console.log(`    [model] ${item.title}: ${e.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== 'feed' && cmd !== 'search') {
    console.log('usage:');
    console.log('  node bin/hongguo.mjs feed   --pages 2 [--genre 真人剧|漫剧|AI短剧]（默认漫剧） [--models 3]');
    console.log('  node bin/hongguo.mjs search "总裁" --pages 1 [--models 3]');
    process.exitCode = 1;
    return;
  }

  const pages = Number(args.pages || 1);
  const models = args.models ? Number(args.models) : 0;
  const signer = new Signer();
  await signer.start();
  try {
    let items;
    if (cmd === 'feed') {
      const genre = normalizeGenre(args.genre);
      console.log(`[feed] pages=${pages} genre=${genre} (${GENRES[genre].label})`);
      items = await feed(signer, {
        pages, genre,
        onPage: (page, list) => {
          console.log(`\n--- page ${page + 1} (${list.length}) ---`);
          list.forEach((item, i) => printCard(i, item));
        },
      });
    } else {
      const query = args._[1];
      if (!query) throw new Error('search 需要关键词');
      console.log(`[search] q=${query} pages=${pages}`);
      items = await search(signer, query, {
        pages,
        onPage: (page, list) => {
          console.log(`\n--- page ${page + 1} (${list.length}) ---`);
          list.forEach((item, i) => printCard(i, item));
        },
      });
    }
    if (models > 0) {
      console.log('\n--- video_model ---');
      await printModels(items, models);
    }
    if (args.json) {
      console.log(JSON.stringify(items, null, 2));
    }
  } finally {
    signer.stop();
  }
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exitCode = 1;
});

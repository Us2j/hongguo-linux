import { videoModel, pick1080 } from '../../services/api.js';
import fs from 'node:fs';
const vid = process.argv[2];
if (!vid) { console.error('usage: spike_track.mjs <vid>'); process.exit(1); }
const tracks = await videoModel(vid);
const t = pick1080(tracks);
if (!t) { console.error('no 1080p'); process.exit(2); }
console.log(JSON.stringify({vid, definition:t.definition, width:t.width, height:t.height, size:t.size, mainUrl:t.mainUrl, spadeA:t.spadeA}, null, 2));
fs.writeFileSync(`cache/${vid}.track.json`, JSON.stringify(t, null, 2));

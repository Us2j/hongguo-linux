import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hlsDir } from './media.js';

/**
 * 本地 HLS 服务：只 bind 127.0.0.1，带随机 token。
 *   GET /hls/<vid>/index.m3u8?token=...
 *   GET /hls/<vid>/init.mp4?token=...
 *   GET /hls/<vid>/segNNNNNN.m4s?token=...
 *
 * index.m3u8 会被动态改写，给 init/分片 URI 追加 ?token，
 * 这样 hls.js 后续请求分片时也带 token。
 */
export function createHlsServer() {
  const token = crypto.randomBytes(16).toString('hex');

  function sendFile(res, file, type, range) {
    const size = fs.statSync(file).size;
    const base = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    if (range) {
      const rm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (rm) {
        let start = rm[1] ? Number(rm[1]) : 0;
        let end = rm[2] ? Number(rm[2]) : size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
          res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, { ...base, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
        return;
      }
      if (url.searchParams.get('token') !== token) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const m = /^\/hls\/(\d{8,24})\/(index\.m3u8|init\.mp4|seg\d{6}\.m4s)$/.exec(url.pathname);
      if (!m) {
        res.writeHead(404).end('not found');
        return;
      }
      const dir = hlsDir(m[1]);
      const name = m[2];
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('not prepared');
        return;
      }

      if (name === 'index.m3u8') {
        // 改写 init / 分片 URI，追加 ?token
        let text = fs.readFileSync(file, 'utf8');
        text = text.replace(/URI="([^"]+)"/g, (_, u) => `URI="${u}?token=${token}"`);
        text = text.replace(/^(seg\d{6}\.m4s)$/gm, (_, s) => `${s}?token=${token}`);
        const buf = Buffer.from(text, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      sendFile(res, file, 'video/mp4', req.headers.range);
    } catch (e) {
      try { res.writeHead(500).end(String(e.message)); } catch {}
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        token,
        urlFor: (vid) => `http://127.0.0.1:${port}/hls/${vid}/index.m3u8?token=${token}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

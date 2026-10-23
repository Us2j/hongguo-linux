import http from 'node:http';
import fs from 'node:fs';
import { cachePath } from './media.js';

/**
 * Local HTTP server with Range support, so mpv (or a future <video>) can
 * stream the decrypted MP4 progressively.
 */
export function createStreamServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const m = /^\/v\/(\d{8,24})$/.exec(url.pathname);
      if (!m) {
        res.writeHead(404).end('not found');
        return;
      }
      const file = cachePath(m[1]);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('not prepared');
        return;
      }
      const size = fs.statSync(file).size;
      const range = req.headers.range;
      if (range) {
        const rm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!rm) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        let start = rm[1] ? Number(rm[1]) : 0;
        let end = rm[2] ? Number(rm[2]) : size - 1;
        if (!rm[1] && rm[2]) {
          start = Math.max(0, size - Number(rm[2]));
          end = size - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': size,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
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
        urlFor: (vid) => `http://127.0.0.1:${port}/v/${vid}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

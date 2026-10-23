import { createStreamServer } from '../../services/stream.js';
import { prepare } from '../../services/media.js';
const vid = process.argv[2] || '7688396347107445822';
await prepare(vid);
const server = await createStreamServer();
try {
  const url = server.urlFor(vid);
  const res = await fetch(url, { headers: { range: 'bytes=0-1023' } });
  const buf = await res.arrayBuffer();
  console.log(JSON.stringify({
    status: res.status,
    contentRange: res.headers.get('content-range'),
    contentLength: res.headers.get('content-length'),
    bytes: buf.byteLength,
    acceptRanges: res.headers.get('accept-ranges'),
  }, null, 2));
} finally {
  await server.close();
}

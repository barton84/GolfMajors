// Local test server. Serves /public and routes /api/* to the same handler Netlify runs.
// Uses an in-memory store and, if MOCK_ESPN_FILE is set, a saved ESPN response.
//   ADMIN_PASSWORD=test MOCK_ESPN_FILE=test/mock-espn-pre.json npm run dev
process.env.LOCAL_DEV = '1';
process.env.ADMIN_PASSWORD ||= 'test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const { handle } = await import('../lib/api.mjs');

const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await fs.readFile(path.join(root, 'index.html')));
    }
  })
  .listen(process.env.PORT || 8888, () => console.log(`http://localhost:${process.env.PORT || 8888}`));

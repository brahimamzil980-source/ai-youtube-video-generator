// UI-only preview. Serves the interface and an UNCONFIGURED provider status.
// It never loads .env and refuses every other /api/ request (no paid calls).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import worker from '../worker/index.js';
import { bundleAppJs } from './bundle.mjs';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);

http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/ai/status') {
      const r = await worker.fetch(new Request('http://localhost/api/ai/status', { headers: { 'oai-authenticated-user-id': 'local-preview' } }), {});
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
      return;
    }
    if (path.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'المعاينة المحلية لا ترسل طلبات للمزوّد.' }));
      return;
    }
    if (path === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript;charset=utf-8');
      res.end(await bundleAppJs());
      return;
    }
    if (path === '/' || path === '/index.html') {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(await readFile('public/index.html'));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch {
    res.writeHead(500);
    res.end('Preview error');
  }
}).listen(port, host, () => console.log('Preview ready on http://' + host + ':' + port));

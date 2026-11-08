// LIVE local run of the real Worker on YOUR OWN computer, for owner testing.
//
//   export OPENAI_API_KEY=...      # in your own terminal, never in chat or files
//   export ANTHROPIC_API_KEY=...
//   npm run build && BRAHIM_LIVE_LOCAL=1 npm run live
//
// Listens on 127.0.0.1 only and injects a local owner identity. Real, paid
// provider calls are made. Never deploy this script; production identity comes
// from the hosting platform's authentication.
import http from 'node:http';

if (process.env.BRAHIM_LIVE_LOCAL !== '1') {
  console.error('Refusing to start: set BRAHIM_LIVE_LOCAL=1 to confirm live, paid provider calls.');
  process.exit(1);
}
const { default: worker } = await import('../dist/server/index.js');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4174);
const origin = 'http://' + host + ':' + port;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(OPENAI_|ANTHROPIC_|RATE_LIMIT_)/.test(k)));

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('oai-authenticated-user-id', 'local-owner');
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await worker.fetch(new Request(origin + req.url, { method: req.method, headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch {
    res.writeHead(500);
    res.end('Local error');
  }
}).listen(port, host, () => console.log('LIVE local app on ' + origin + ' (paid calls enabled)'));

// LIVE smoke test against the real providers, run on your own computer.
// Makes real, paid calls: one short text per configured provider, one ~10-word
// MP3, one low-quality square image, and (only with --video) one 4-second video.
//
//   export OPENAI_API_KEY=... ANTHROPIC_API_KEY=...   (your terminal only)
//   BRAHIM_LIVE_LOCAL=1 npm run smoke            # text + voice + image
//   BRAHIM_LIVE_LOCAL=1 npm run smoke -- --video # also one 4s video
//
// Outputs are written to ./smoke-output/ so you can open them and confirm.
import { mkdir, writeFile } from 'node:fs/promises';
import worker from '../worker/index.js';

if (process.env.BRAHIM_LIVE_LOCAL !== '1') {
  console.error('Refusing to run: set BRAHIM_LIVE_LOCAL=1 to confirm paid provider calls.');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(OPENAI_|ANTHROPIC_|RATE_LIMIT_)/.test(k)));
const origin = 'http://127.0.0.1';
const headers = { origin, 'content-type': 'application/json', 'oai-authenticated-user-id': 'smoke-owner' };
const post = (path, body) => worker.fetch(new Request(origin + path, { method: 'POST', headers: { ...headers, 'x-brahim-request-id': crypto.randomUUID() }, body: JSON.stringify(body) }), env);
const get = (path) => worker.fetch(new Request(origin + path, { headers }), env);
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' — ' + detail); };

await mkdir('smoke-output', { recursive: true });
const status = await (await get('/api/ai/status')).json();
console.log('Models:', JSON.stringify({ text: status.providers, image: status.media.image.model, tts: status.media.tts.model, video: status.media.video.model }));

for (const provider of ['openai', 'anthropic']) {
  if (!status.providers[provider].configured) { record('text/' + provider, false, 'not configured (no key)'); continue; }
  const r = await post('/api/ai/generate', { provider, task: 'general', brand: 'مشروع شخصي', prompt: 'Reply with exactly: Brahim Studio connected.' });
  const data = await r.json();
  record('text/' + provider, r.ok, r.ok ? data.model + ': ' + data.text.slice(0, 80) : data.error);
}

if (status.media.tts.configured) {
  const r = await post('/api/tts', { text: 'Hello from Brahim Studio. This narration file was generated for testing.', voice: 'coral', language: 'en', format: 'mp3', rate: '1' });
  if (r.ok) {
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile('smoke-output/voice.mp3', buf);
    record('tts/mp3', true, buf.length + ' bytes -> smoke-output/voice.mp3');
  } else record('tts/mp3', false, (await r.json()).error);

  const img = await post('/api/image', { prompt: 'A small hand-drawn ink sketch of a coffee cup on cream paper, subtle watercolor accent.', ratio: '1:1', quality: 'low' });
  if (img.ok) {
    const data = await img.json();
    await writeFile('smoke-output/image.jpg', Buffer.from(data.image, 'base64'));
    record('image', true, data.model + ' -> smoke-output/image.jpg');
  } else record('image', false, (await img.json()).error);

  if (process.argv.includes('--video')) {
    const v = await post('/api/video', { prompt: 'A hand-drawn ink coffee cup on cream paper, steam rising gently, static camera.', ratio: '16:9', seconds: '4' });
    let job = await v.json();
    if (!v.ok) record('video', false, job.error);
    else {
      console.log('Video job', job.id, '— polling every 15s…');
      const started = Date.now();
      while (['queued', 'in_progress'].includes(job.status) && Date.now() - started < 20 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 15000));
        const s = await get('/api/video/status?id=' + job.id);
        if (s.ok) job = await s.json();
        console.log('  status', job.status, job.progress ?? '');
      }
      if (job.status === 'completed') {
        const c = await get('/api/video/content?id=' + job.id);
        const buf = Buffer.from(await c.arrayBuffer());
        await writeFile('smoke-output/video.mp4', buf);
        record('video', c.ok && buf.length > 1000, buf.length + ' bytes -> smoke-output/video.mp4');
      } else record('video', false, 'final status ' + job.status);
    }
  } else console.log('SKIP video (add --video to test one paid 4s clip)');
} else record('openai media', false, 'not configured (no OPENAI_API_KEY)');

process.exitCode = results.every((r) => r.ok) ? 0 : 1;

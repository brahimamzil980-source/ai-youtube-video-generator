// Mocked API tests. No real provider calls are made: global.fetch is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import app, { _internals } from '../worker/index.js';

const origin = 'https://studio.example';
const payload = { provider: 'openai', task: 'script', brand: 'Origins Drawn', prompt: 'Write a short story.' };
const req = (path, body, headers = {}) => new Request(origin + path, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner', ...headers },
  body: JSON.stringify(body),
});
const textReq = (body = payload, headers) => req('/api/ai/generate', body, headers);
const get = (path, headers = { 'oai-authenticated-user-id': 'owner' }) => new Request(origin + path, { headers });

// Tiny valid image data URLs (signature-checked by the server).
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]).toString('base64');
const FAKE_PNG = 'data:image/png;base64,' + Buffer.from('this is not really a png file').toString('base64');

async function withFetch(mock, fn) {
  const old = global.fetch;
  global.fetch = mock;
  try { return await fn(); } finally { global.fetch = old; }
}

test.beforeEach(() => { _internals.rateBuckets.clear(); _internals.recentRequestIds.clear(); });

test('rejects unauthenticated callers before contacting providers', async () => {
  let called = false;
  await withFetch(async () => { called = true; }, async () => {
    for (const path of ['/api/ai/generate', '/api/tts', '/api/image', '/api/video']) {
      const r = await app.fetch(req(path, payload, { 'oai-authenticated-user-id': '' }), { OPENAI_API_KEY: 'secret' });
      assert.equal(r.status, 401);
    }
    assert.equal((await app.fetch(get('/api/video/status?id=video_abc123', {}), { OPENAI_API_KEY: 'secret' })).status, 401);
  });
  assert.equal(called, false);
});

test('rejects cross-origin, wrong content type and unvalidated provider choices', async () => {
  assert.equal((await app.fetch(textReq(payload, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await app.fetch(textReq(payload, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await app.fetch(textReq({ ...payload, provider: 'custom' }))).status, 400);
});

test('missing configuration is explicit and never exposes secrets', async () => {
  const r = await app.fetch(textReq());
  assert.equal(r.status, 503);
  for (const [path, body] of [['/api/tts', { text: 'Hi', voice: 'coral', language: 'en', format: 'mp3', rate: '1' }], ['/api/image', { prompt: 'cup', ratio: '1:1', quality: 'low' }], ['/api/video', { prompt: 'cup', ratio: '16:9', seconds: '4' }]]) {
    assert.equal((await app.fetch(req(path, body))).status, 503, path);
  }
  const status = await app.fetch(get('/api/ai/status'), { OPENAI_API_KEY: 'super-secret' });
  const raw = await status.text();
  assert(!raw.includes('super-secret'));
  const data = JSON.parse(raw);
  assert.equal(data.providers.openai.configured, true);
  assert.equal(data.providers.anthropic.configured, false);
  assert.equal(data.media.image.configured, true);
  assert.equal(data.media.video.model, 'sora-2');
});

test('routes OpenAI and Claude text to fixed hosts with the correct auth headers', async () => {
  for (const provider of ['openai', 'anthropic']) {
    await withFetch(async (url, init) => {
      if (provider === 'openai') {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(init.headers.authorization, 'Bearer test-secret');
      } else {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(init.headers['x-api-key'], 'test-secret');
        assert.equal(init.headers.authorization, undefined);
        assert.equal(init.headers['anthropic-version'], '2026-10-21');
      }
      const body = JSON.parse(init.body);
      assert.equal(body.model, provider === 'openai' ? 'gpt-6-astra' : 'claude-sonnet-5-5');
      if (provider === 'anthropic') {
        assert.equal(body.temperature, undefined);
        assert.deepEqual(body.output_config, { effort: 'medium' });
      }
      return Response.json(provider === 'openai'
        ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Example reply' }] }], status: 'completed' }
        : { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Example reply' }], stop_reason: 'end_turn' });
    }, async () => {
      const r = await app.fetch(textReq({ ...payload, provider }), { OPENAI_API_KEY: 'test-secret', ANTHROPIC_API_KEY: 'test-secret' });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).text, 'Example reply');
    });
  }
});

test('Claude refusals are reported honestly', async () => {
  await withFetch(async () => Response.json({ content: [], stop_reason: 'refusal' }), async () => {
    const r = await app.fetch(textReq({ ...payload, provider: 'anthropic' }), { ANTHROPIC_API_KEY: 'k' });
    assert.equal(r.status, 422);
  });
});

test('does not leak upstream errors or replay failed requests', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ error: 'secret-test-key' }, { status: 429 }); }, async () => {
    const r = await app.fetch(textReq(), { OPENAI_API_KEY: 'test' });
    assert.equal(r.status, 429);
    assert(!(await r.text()).includes('secret-test-key'));
  });
  assert.equal(calls, 1);
});

test('duplicate client request IDs are refused without a second provider call', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }); }, async () => {
    const id = crypto.randomUUID();
    assert.equal((await app.fetch(textReq(payload, { 'x-brahim-request-id': id }), { OPENAI_API_KEY: 'k' })).status, 200);
    assert.equal((await app.fetch(textReq(payload, { 'x-brahim-request-id': id }), { OPENAI_API_KEY: 'k' })).status, 409);
  });
  assert.equal(calls, 1);
});

test('rate limit blocks bursts before contacting the provider', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ id: 'video_abc123', status: 'queued', progress: 0 }); }, async () => {
    const env = { OPENAI_API_KEY: 'k', RATE_LIMIT_VIDEO: '2' };
    const body = { prompt: 'cup', ratio: '16:9', seconds: '4' };
    assert.equal((await app.fetch(req('/api/video', body), env)).status, 202);
    assert.equal((await app.fetch(req('/api/video', body), env)).status, 202);
    assert.equal((await app.fetch(req('/api/video', body), env)).status, 429);
  });
  assert.equal(calls, 2);
});

test('TTS returns a downloadable audio file from the speech endpoint', async () => {
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-4o-mini-tts');
    assert.equal(body.voice, 'coral');
    assert.equal(body.response_format, 'mp3');
    assert.match(body.instructions, /English/);
    return new Response(new Uint8Array(500).fill(7), { headers: { 'content-type': 'audio/mpeg' } });
  }, async () => {
    const r = await app.fetch(req('/api/tts', { text: 'Hello there', voice: 'coral', language: 'en', format: 'mp3', rate: '1' }), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await r.arrayBuffer()).byteLength, 500);
  });
  assert.equal((await app.fetch(req('/api/tts', { text: 'x'.repeat(4001), voice: 'coral', language: 'en', format: 'mp3', rate: '1' }), { OPENAI_API_KEY: 'k' })).status, 400);
  assert.equal((await app.fetch(req('/api/tts', { text: 'Hi', voice: 'someone-real', language: 'en', format: 'mp3', rate: '1' }), { OPENAI_API_KEY: 'k' })).status, 400);
});

test('image generation uses generations without references and edits with references', async () => {
  const b64 = Buffer.alloc(300, 1).toString('base64');
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    const body = JSON.parse(init.body);
    assert.equal(body.size, '1024x1536');
    assert.equal(body.quality, 'low');
    return Response.json({ data: [{ b64_json: b64 }] });
  }, async () => {
    const r = await app.fetch(req('/api/image', { prompt: 'Drew', ratio: '9:16', quality: 'low' }), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).image, b64);
  });
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert(init.body instanceof FormData);
    assert.equal(init.body.getAll('image[]').length, 2);
    assert.equal(init.body.get('size'), '1536x1024');
    return Response.json({ data: [{ b64_json: b64 }] });
  }, async () => {
    const r = await app.fetch(req('/api/image', { prompt: 'Drew', ratio: '16:9', quality: 'medium', references: [PNG, PNG] }), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).usedReferences, 2);
  });
});

test('reference images are signature-checked and limited', async () => {
  let called = false;
  await withFetch(async () => { called = true; }, async () => {
    assert.equal((await app.fetch(req('/api/image', { prompt: 'x', ratio: '1:1', quality: 'low', references: [FAKE_PNG] }), { OPENAI_API_KEY: 'k' })).status, 400);
    assert.equal((await app.fetch(req('/api/image', { prompt: 'x', ratio: '1:1', quality: 'low', references: [PNG, PNG, PNG, PNG, PNG] }), { OPENAI_API_KEY: 'k' })).status, 400);
    assert.equal((await app.fetch(req('/api/video', { prompt: 'x', ratio: '16:9', seconds: '4', reference: 'data:text/html;base64,PGI+' }), { OPENAI_API_KEY: 'k' })).status, 400);
  });
  assert.equal(called, false);
});

test('video jobs: create with reference, poll status, stream content', async () => {
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/videos');
    assert.equal(init.body.get('model'), 'sora-2');
    assert.equal(init.body.get('seconds'), '8');
    assert.equal(init.body.get('size'), '720x1280');
    assert(init.body.get('input_reference'));
    return Response.json({ id: 'video_abc123', status: 'queued', progress: 0 });
  }, async () => {
    const r = await app.fetch(req('/api/video', { prompt: 'Drew walks', ratio: '9:16', seconds: '8', reference: PNG }), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 202);
    assert.deepEqual((await r.json()).id, 'video_abc123');
  });
  assert.equal((await app.fetch(req('/api/video', { prompt: 'x', ratio: '1:1', seconds: '8' }), { OPENAI_API_KEY: 'k' })).status, 400);
  assert.equal((await app.fetch(req('/api/video', { prompt: 'x', ratio: '9:16', seconds: '5' }), { OPENAI_API_KEY: 'k' })).status, 400);

  await withFetch(async (url) => {
    assert.equal(url, 'https://api.openai.com/v1/videos/video_abc123');
    return Response.json({ id: 'video_abc123', status: 'in_progress', progress: 42.4 });
  }, async () => {
    const r = await app.fetch(get('/api/video/status?id=video_abc123'), { OPENAI_API_KEY: 'k' });
    assert.deepEqual(await r.json(), { id: 'video_abc123', status: 'in_progress', progress: 42, seconds: null, size: null, model: null, failed: false });
  });
  assert.equal((await app.fetch(get('/api/video/status?id=../../secrets'), { OPENAI_API_KEY: 'k' })).status, 400);

  await withFetch(async (url) => {
    assert.equal(url, 'https://api.openai.com/v1/videos/video_abc123/content');
    return new Response(new Uint8Array(2048), { headers: { 'content-type': 'video/mp4' } });
  }, async () => {
    const r = await app.fetch(get('/api/video/content?id=video_abc123'), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal((await r.arrayBuffer()).byteLength, 2048);
  });
  await withFetch(async () => new Response('gone', { status: 404 }), async () => {
    assert.equal((await app.fetch(get('/api/video/content?id=video_abc123'), { OPENAI_API_KEY: 'k' })).status, 410);
  });
});

test('timeouts and network failures return 504 without retry', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error('network'); }, async () => {
    assert.equal((await app.fetch(req('/api/image', { prompt: 'x', ratio: '1:1', quality: 'low' }), { OPENAI_API_KEY: 'k' })).status, 504);
  });
  assert.equal(calls, 1);
});

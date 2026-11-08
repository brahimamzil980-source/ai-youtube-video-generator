// Tests for API keys entered in the app (worker/keys.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/index.js';
import { mockD1, mockR2 } from './mock-bindings.mjs';

const origin = 'https://studio.example';
const OPENAI_KEY = 'sk-proj-TESTKEY1234567890abcdefWXYZ';
const ANTHROPIC_KEY = 'sk-ant-api03-TESTKEY1234567890abcdQRST';
const envFor = (extra = {}) => ({ DB: mockD1(), MEDIA: mockR2(), ...extra });
const call = (env, path, { method = 'GET', user = 'owner', body, headers = {} } = {}) => app.fetch(new Request(origin + path, {
  method,
  headers: { origin, 'oai-authenticated-user-id': user, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const save = (env, provider, key, user) => call(env, '/api/keys/' + provider, { method: 'PUT', body: { key }, user });

async function withFetch(mock, fn) {
  const old = global.fetch;
  global.fetch = mock;
  try { return await fn(); } finally { global.fetch = old; }
}

test('without storage, keys cannot be saved and the summary says so', async () => {
  const summary = await (await call({}, '/api/keys')).json();
  assert.equal(summary.storage, false);
  assert.equal((await save({}, 'openai', OPENAI_KEY)).status, 503);
});

test('requires authentication, same origin, and a key-shaped value', async () => {
  const env = envFor();
  assert.equal((await call(env, '/api/keys', { user: '' })).status, 401);
  assert.equal((await call(env, '/api/keys/openai', { method: 'PUT', body: { key: OPENAI_KEY }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await save(env, 'openai', 'hello')).status, 400);
  assert.equal((await save(env, 'anthropic', OPENAI_KEY)).status, 400);
  assert.equal((await save(env, 'custom', OPENAI_KEY)).status, 404);
});

test('saved keys are encrypted at rest and never returned', async () => {
  const env = envFor();
  const res = await (await save(env, 'openai', OPENAI_KEY)).json();
  assert.deepEqual(res, { saved: true, last4: 'WXYZ', overriddenByServer: false });
  const row = await env.DB.prepare('SELECT * FROM provider_keys').bind().first();
  assert(!JSON.stringify(row).includes('TESTKEY'), 'plaintext key stored');
  assert(env.MEDIA.store.has('system/provider-key-master.bin'));
  for (const path of ['/api/keys', '/api/ai/status', '/api/sync/pull']) {
    const text = await (await call(env, path)).text();
    assert(!text.includes('TESTKEY'), 'key leaked by ' + path);
  }
  const summary = await (await call(env, '/api/keys')).json();
  assert.deepEqual(summary.openai, { source: 'stored', last4: 'WXYZ' });
  assert.deepEqual(summary.anthropic, { source: null, last4: null });
});

test('a saved key enables the provider and is used for its requests', async () => {
  const env = envFor();
  await save(env, 'anthropic', ANTHROPIC_KEY);
  const status = await (await call(env, '/api/ai/status')).json();
  assert.equal(status.providers.anthropic.configured, true);
  assert.equal(status.providers.openai.configured, false);
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], ANTHROPIC_KEY);
    return Response.json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
  }, async () => {
    const r = await call(env, '/api/ai/generate', { method: 'POST', body: { provider: 'anthropic', task: 'general', brand: 'مشروع شخصي', prompt: 'Hi' } });
    assert.equal(r.status, 200);
  });
});

test('a server secret takes precedence over a saved key', async () => {
  const env = envFor({ OPENAI_API_KEY: 'server-secret-key' });
  const res = await (await save(env, 'openai', OPENAI_KEY)).json();
  assert.equal(res.overriddenByServer, true);
  assert.deepEqual((await (await call(env, '/api/keys')).json()).openai, { source: 'server', last4: null, overridesStored: true });
  await withFetch(async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer server-secret-key');
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
  }, async () => {
    assert.equal((await call(env, '/api/ai/generate', { method: 'POST', body: { provider: 'openai', task: 'general', brand: 'مشروع شخصي', prompt: 'Hi' } })).status, 200);
  });
});

test('keys are scoped to their owner', async () => {
  const env = envFor();
  await save(env, 'openai', OPENAI_KEY, 'owner');
  const other = await (await call(env, '/api/ai/status', { user: 'someone-else' })).json();
  assert.equal(other.providers.openai.configured, false);
});

test('test endpoint reports valid and rejected keys without exposing them', async () => {
  const env = envFor();
  await save(env, 'openai', OPENAI_KEY);
  for (const [status, ok] of [[200, true], [401, false]]) {
    await withFetch(async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(init.headers.authorization, 'Bearer ' + OPENAI_KEY);
      return new Response('{}', { status });
    }, async () => {
      const r = await call(env, '/api/keys/openai/test', { method: 'POST' });
      const text = await r.text();
      assert.equal(JSON.parse(text).ok, ok);
      assert(!text.includes('TESTKEY'));
    });
  }
  assert.equal((await call(env, '/api/keys/anthropic/test', { method: 'POST' })).status, 404);
});

test('delete removes the saved key', async () => {
  const env = envFor();
  await save(env, 'openai', OPENAI_KEY);
  assert.equal((await call(env, '/api/keys/openai', { method: 'DELETE' })).status, 200);
  assert.equal((await (await call(env, '/api/ai/status')).json()).providers.openai.configured, false);
});

test('KEY_ENCRYPTION_SECRET is used instead of a generated master key', async () => {
  const env = envFor({ KEY_ENCRYPTION_SECRET: 'a-long-random-secret-value' });
  await save(env, 'openai', OPENAI_KEY);
  assert.equal(env.MEDIA.store.has('system/provider-key-master.bin'), false);
  assert.equal((await (await call(env, '/api/ai/status')).json()).providers.openai.configured, true);
  // A different secret cannot decrypt it.
  const wrong = { ...env, KEY_ENCRYPTION_SECRET: 'another-secret-value-xyz' };
  assert.equal((await (await call(wrong, '/api/keys')).json()).openai.source, 'broken');
});

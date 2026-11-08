// Sync API tests against SQLite-backed D1 and in-memory R2 mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/index.js';
import { mockD1, mockR2 } from './mock-bindings.mjs';

const origin = 'https://studio.example';
const envFor = () => ({ DB: mockD1(), MEDIA: mockR2() });
const call = (env, path, { method = 'GET', user = 'owner', body, headers = {} } = {}) => app.fetch(new Request(origin + path, {
  method,
  headers: { origin, 'oai-authenticated-user-id': user, ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
}), env);
const push = (env, records, user) => call(env, '/api/sync/push', { method: 'POST', body: { records }, user });
const pull = async (env, since = 0, user) => (await call(env, '/api/sync/pull?since=' + since, { user })).json();
const project = (id, title, extra = {}) => ({ id, title, text: 'prompt', outputs: [], jobs: [], ...extra });
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array(500).fill(1)]);
const ID = '0b6f2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

test('sync is reported unavailable without D1/R2 bindings, and refuses requests', async () => {
  const s = await (await call({}, '/api/ai/status')).json();
  assert.equal(s.sync.available, false);
  assert.equal((await call({}, '/api/sync/pull')).status, 503);
  const s2 = await (await call(envFor(), '/api/ai/status')).json();
  assert.equal(s2.sync.available, true);
});

test('requires authentication and same origin for writes', async () => {
  const env = envFor();
  assert.equal((await call(env, '/api/sync/pull', { user: '' })).status, 401);
  assert.equal((await call(env, '/api/sync/push', { method: 'POST', body: { records: [] }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(env, '/api/assets/' + ID, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video', origin: 'https://evil.example' } })).status, 403);
});

test('push/pull round trip with last-writer-wins and tombstones', async () => {
  const env = envFor();
  let r = await (await push(env, [{ kind: 'project', id: 'p1', data: project('p1', 'v1'), updatedAt: 1000 }, { kind: 'character', id: 'drew', data: { id: 'drew', name: 'Drew', description: 'd', image: '' }, updatedAt: 1000 }])).json();
  assert.deepEqual(r.results.map((x) => x.status), ['ok', 'ok']);
  // Older write is rejected as stale, newer one accepted.
  r = await (await push(env, [{ kind: 'project', id: 'p1', data: project('p1', 'old'), updatedAt: 900 }])).json();
  assert.equal(r.results[0].status, 'stale');
  await push(env, [{ kind: 'project', id: 'p1', data: project('p1', 'v2'), updatedAt: 2000 }]);
  const first = await pull(env);
  assert.equal(first.records.length, 2);
  assert.equal(first.records.find((x) => x.id === 'p1').data.title, 'v2');
  // Incremental pull only returns later changes.
  await push(env, [{ kind: 'character', id: 'drew', deleted: true, updatedAt: 3000 }]);
  const next = await pull(env, first.cursor);
  assert.deepEqual(next.records.map((x) => [x.id, x.deleted]), [['drew', true]]);
});

test('records are isolated per owner', async () => {
  const env = envFor();
  await push(env, [{ kind: 'project', id: 'p1', data: project('p1', 'mine'), updatedAt: 1 }], 'owner');
  assert.equal((await pull(env, 0, 'someone-else')).records.length, 0);
  await call(env, '/api/assets/' + ID, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } });
  assert.equal((await call(env, '/api/assets/' + ID, { user: 'someone-else' })).status, 404);
});

test('invalid records are rejected', async () => {
  const env = envFor();
  for (const bad of [{ kind: 'secrets', id: 'x', data: { id: 'x' }, updatedAt: 1 }, { kind: 'project', id: '../x', data: { id: '../x' }, updatedAt: 1 }, { kind: 'project', id: 'a', data: { id: 'b' }, updatedAt: 1 }, { kind: 'project', id: 'a', data: { id: 'a' }, updatedAt: -5 }]) {
    assert.equal((await push(env, [bad])).status, 400, JSON.stringify(bad));
  }
});

test('large records are stored in R2 and come back intact; old copies are removed', async () => {
  const env = envFor();
  const big = project('big', 'large', { reference: 'data:image/png;base64,' + 'A'.repeat(1_500_000) });
  await push(env, [{ kind: 'project', id: 'big', data: big, updatedAt: 10 }]);
  assert.equal([...env.MEDIA.store.keys()].filter((k) => k.startsWith('rec/')).length, 1);
  await push(env, [{ kind: 'project', id: 'big', data: { ...big, title: 'large 2' }, updatedAt: 20 }]);
  const keys = [...env.MEDIA.store.keys()].filter((k) => k.startsWith('rec/'));
  assert.equal(keys.length, 1);
  assert.match(keys[0], /\/20\.json$/);
  const got = (await pull(env)).records[0];
  assert.equal(got.data.title, 'large 2');
  assert.equal(got.data.reference.length, big.reference.length);
});

test('assets: signature check, idempotent upload, range reads, delete', async () => {
  const env = envFor();
  const bad = await call(env, '/api/assets/' + ID, { method: 'PUT', body: new Uint8Array(100).fill(1), headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } });
  assert.equal(bad.status, 415);
  assert.equal((await call(env, '/api/assets/not-a-uuid', { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } })).status, 400);
  const put = await call(env, '/api/assets/' + ID, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } });
  assert.equal(put.status, 201);
  assert.equal((await (await call(env, '/api/assets/' + ID, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } })).json()).existed, true);
  const full = await call(env, '/api/assets/' + ID);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, MP4.length);
  const part = await call(env, '/api/assets/' + ID, { headers: { range: 'bytes=4-7' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 4-7/' + MP4.length);
  assert.equal(new TextDecoder().decode(await part.arrayBuffer()), 'ftyp');
  assert.equal((await call(env, '/api/assets/' + ID, { headers: { range: 'bytes=99999-' } })).status, 416);
  const status = await (await call(env, '/api/sync/status')).json();
  assert.equal(status.usage.assets, 1);
  assert.equal((await call(env, '/api/assets/' + ID, { method: 'DELETE' })).status, 200);
  assert.equal((await call(env, '/api/assets/' + ID)).status, 404);
  assert.equal(env.MEDIA.store.size, 0);
});

test('storage quota is enforced', async () => {
  const env = { ...envFor(), SYNC_QUOTA_BYTES: '600' };
  assert.equal((await call(env, '/api/assets/' + ID, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } })).status, 201);
  const second = ID.replace(/5b$/, '5c');
  assert.equal((await call(env, '/api/assets/' + second, { method: 'PUT', body: MP4, headers: { 'content-type': 'video/mp4', 'x-brahim-asset-kind': 'video' } })).status, 507);
});

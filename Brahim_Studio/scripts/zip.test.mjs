// Tests for the ZIP writer (public/js/026-zip.js) and story planning API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import app from '../worker/index.js';

const source = await readFile(new URL('../public/js/026-zip.js', import.meta.url), 'utf8');
const { zipChunks, crc32 } = new Function(source + '\nreturn { zipChunks, crc32 };')();

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip archive is readable by unzip with UTF-8 names and exact contents', async (t) => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('unzip not installed'); }
  const bytes = new Uint8Array(70000).map((_, i) => (i * 7) % 256);
  const chunks = zipChunks([{ name: 'script.txt', data: 'Hello Drew\nسطر عربي' }, { name: 'scene-01.jpg', data: bytes }, { name: 'قصة.json', data: '{}' }]);
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'));
  const file = join(dir, 'out.zip');
  await writeFile(file, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  execFileSync('unzip', ['-tq', file]);
  assert.equal(execFileSync('unzip', ['-p', file, 'script.txt']).toString(), 'Hello Drew\nسطر عربي');
  assert.deepEqual(new Uint8Array(execFileSync('unzip', ['-p', file, 'scene-01.jpg'])), bytes);
  assert.match(execFileSync('unzip', ['-Z1', file]).toString(), /قصة\.json/);
});

const origin = 'https://studio.example';
const plan = (body, env, fetchMock) => {
  const old = global.fetch;
  global.fetch = fetchMock;
  return app.fetch(new Request(origin + '/api/story/plan', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' }, body: JSON.stringify(body) }), env).finally(() => { global.fetch = old; });
};
const body = { provider: 'openai', brand: 'Origins Drawn', idea: 'Drew gets a raise', scenes: 3, seconds: 45, language: 'en', character: { name: 'Drew', description: 'Messy dark brown hair, navy hoodie.' } };
const reply = (text) => async (url, init) => {
  const sent = JSON.parse(init.body);
  assert.match(sent.instructions, /Return ONLY a JSON object/);
  assert.match(sent.input, /exactly 3/);
  assert.match(sent.input, /navy hoodie/);
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], status: 'completed' });
};
const scene = (n) => ({ narration: 'Line ' + n, imagePrompt: 'Drew in scene ' + n, motionPrompt: 'Slow push-in' });

test('story plan returns validated scenes, tolerating code fences', async () => {
  const r = await plan(body, { OPENAI_API_KEY: 'k' }, reply('```json\n' + JSON.stringify({ title: 'The Raise', scenes: [scene(1), scene(2), scene(3)] }) + '\n```'));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.title, 'The Raise');
  assert.equal(data.scenes.length, 3);
  assert.equal(data.scenes[2].imagePrompt, 'Drew in scene 3');
});

test('story plan rejects malformed model output and bad input', async () => {
  assert.equal((await plan(body, { OPENAI_API_KEY: 'k' }, reply('Sorry, here is a story without JSON.'))).status, 502);
  assert.equal((await plan(body, { OPENAI_API_KEY: 'k' }, reply(JSON.stringify({ title: 'x', scenes: [{ narration: 'only narration' }] })))).status, 502);
  assert.equal((await plan({ ...body, scenes: 40 }, { OPENAI_API_KEY: 'k' }, reply('{}'))).status, 400);
  assert.equal((await plan({ ...body, language: 'xx' }, { OPENAI_API_KEY: 'k' }, reply('{}'))).status, 400);
  assert.equal((await plan(body, {}, reply('{}'))).status, 503);
});

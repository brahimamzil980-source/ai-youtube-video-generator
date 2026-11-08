// Tests for long-narration splitting and MP3/WAV joining (public/js/025-audio.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/025-audio.js', import.meta.url), 'utf8');
const { splitNarration, mergeWav, mergeMp3, mergeAudio, readWav, mp3Frames } = new Function(source + '\nreturn { splitNarration, mergeWav, mergeMp3, mergeAudio, readWav, mp3Frames };')();

test('short text stays in one part', () => {
  assert.deepEqual(splitNarration('  Hello there.  '), ['Hello there.']);
  assert.deepEqual(splitNarration(''), []);
});

test('long text splits at sentence ends under the limit and loses nothing', () => {
  const sentence = 'Drew looked at his payslip and wondered where the money went. ';
  const text = sentence.repeat(200).trim();
  const parts = splitNarration(text, 3800);
  assert(parts.length >= 3);
  for (const p of parts) {
    assert(p.length <= 3800, 'part too long: ' + p.length);
    assert.match(p, /\.$/, 'part should end at a sentence');
  }
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('paragraph breaks and Arabic punctuation are preferred cut points', () => {
  const para = 'a'.repeat(2500) + '\n\n' + 'b'.repeat(2500);
  assert.deepEqual(splitNarration(para, 3800), ['a'.repeat(2500), 'b'.repeat(2500)]);
  const ar = ('كان درو ينظر إلى الفاتورة؟ ').repeat(300);
  for (const p of splitNarration(ar, 3800)) assert.match(p, /؟$/);
});

test('text without punctuation or spaces is still cut within the limit', () => {
  const parts = splitNarration('x'.repeat(9000), 3800);
  assert.deepEqual(parts.map((p) => p.length), [3800, 3800, 1400]);
});

function wav(samples, { rate = 24000, unknownSize = false, extraChunk = false } = {}) {
  const extra = extraChunk ? 8 + 4 : 0;
  const bytes = new Uint8Array(44 + extra + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  let o = 36;
  if (extraChunk) { w(o, 'LIST'); v.setUint32(o + 4, 4, true); w(o + 8, 'INFO'); o += 12; }
  w(o, 'data'); v.setUint32(o + 4, unknownSize ? 0xffffffff : samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(o + 8 + i * 2, s, true));
  return bytes;
}

test('WAV parts join with silence between them and a correct header', () => {
  const a = wav([100, 200, 300]);
  const b = wav([-5, -6], { unknownSize: true, extraChunk: true });
  const merged = mergeWav([a, b], 1); // 1 ms at 24 kHz = 24 samples of silence
  const { fmt, data } = readWav(merged);
  assert.equal(fmt.rate, 24000);
  assert.equal(data.length, (3 + 24 + 2) * 2);
  const v = new DataView(data.buffer, data.byteOffset);
  assert.deepEqual([v.getInt16(0, true), v.getInt16(4, true), v.getInt16(6, true), v.getInt16(data.length - 2, true)], [100, 300, 0, -6]);
  assert.throws(() => mergeWav([a, wav([1], { rate: 44100 })]));
});

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames.
function frame(fill, xing = false) {
  const f = new Uint8Array(417).fill(fill);
  f.set([0xff, 0xfb, 0x90, 0x00]);
  if (xing) f.set([...'Xing'].map((c) => c.charCodeAt(0)), 4 + 32);
  return f;
}
function mp3(fills, { id3 = false, xing = false, v1 = false } = {}) {
  const chunks = [];
  if (id3) chunks.push(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]));
  if (xing) chunks.push(frame(0, true));
  fills.forEach((f) => chunks.push(frame(f)));
  if (v1) { const t = new Uint8Array(128); t.set([0x54, 0x41, 0x47]); chunks.push(t); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

test('MP3 parts join as pure audio frames (ID3, Xing and ID3v1 removed)', () => {
  const a = mp3([1, 2], { id3: true, xing: true, v1: true });
  const b = mp3([3], { id3: true, xing: true });
  assert.equal(mp3Frames(a).frames.length, 2 * 417);
  const merged = mergeMp3([a, b]);
  assert.equal(merged.length, 3 * 417);
  assert.deepEqual([merged[4], merged[417 + 4], merged[834 + 4]], [1, 2, 3]);
  assert.throws(() => mergeMp3([new Uint8Array(500)]));
});

test('a single part is returned unchanged', () => {
  const a = mp3([1], { id3: true });
  assert.equal(mergeAudio([a], 'mp3'), a);
});

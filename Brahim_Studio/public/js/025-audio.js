// Long narration support: split text into provider-sized parts and join the
// returned audio into one file. Pure functions (no DOM) so they can be tested in Node.

const LONG_TEXT_MAX_CHARS = 40000;

// Splits text into parts of at most `max` characters, preferring paragraph breaks,
// then sentence ends (Latin and Arabic punctuation), then spaces.
function splitNarration(text, max = 3800) {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    const para = window.lastIndexOf('\n\n');
    if (para > max * 0.5) cut = para + 2;
    if (cut < 0) {
      const re = /[.!?…؟。]["'”’»)\]]*\s+/g;
      let m;
      while ((m = re.exec(window))) if (m.index + m[0].length <= max && m.index > max * 0.4) cut = m.index + m[0].length;
    }
    if (cut < 0) {
      const re = /[,;:،؛]\s+/g;
      let m;
      while ((m = re.exec(window))) if (m.index + m[0].length <= max && m.index > max * 0.5) cut = m.index + m[0].length;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ', max);
      cut = space > max * 0.3 ? space + 1 : max;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// ---- WAV ----------------------------------------------------------------------

function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw Error('ملف WAV غير صالح');
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    let size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ') {
      fmt = { format: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
    } else if (id === 'data') {
      // Streamed WAVs may declare an unknown (0 or 0xFFFFFFFF) size: take the rest.
      if (!size || start + size > bytes.length) size = bytes.length - start;
      if (!fmt) throw Error('ملف WAV بلا تنسيق');
      return { fmt, data: bytes.subarray(start, start + size) };
    }
    offset = start + size + (size % 2);
  }
  throw Error('ملف WAV بلا بيانات صوت');
}

// Joins WAV files with the same format, adding `gapMs` of silence between parts.
function mergeWav(files, gapMs = 300) {
  const parsed = files.map(readWav);
  const f = parsed[0].fmt;
  if (parsed.some((p) => p.fmt.format !== f.format || p.fmt.channels !== f.channels || p.fmt.rate !== f.rate || p.fmt.bits !== f.bits)) throw Error('أجزاء WAV بتنسيقات مختلفة');
  const blockAlign = f.channels * (f.bits / 8);
  const gap = Math.round((f.rate * gapMs) / 1000) * blockAlign;
  const dataSize = parsed.reduce((n, p) => n + p.data.length, 0) + gap * (parsed.length - 1);
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const write = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, f.format, true);
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.rate, true);
  view.setUint32(28, f.rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, f.bits, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  parsed.forEach((p, i) => {
    out.set(p.data, offset);
    offset += p.data.length + (i < parsed.length - 1 ? gap : 0); // gap stays zero-filled = silence
  });
  return out;
}

// ---- MP3 ----------------------------------------------------------------------

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 Layer III
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Returns frame info for a Layer III header at `o`, or null.
function mp3Frame(bytes, o) {
  if (o + 4 > bytes.length || bytes[o] !== 0xff || (bytes[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (bytes[o + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIndex = bytes[o + 2] >> 4;
  const rateIndex = (bytes[o + 2] >> 2) & 3;
  const padding = (bytes[o + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = MP3_BITRATES[version === 3 ? 1 : 2][bitrateIndex] * 1000;
  const rate = MP3_RATES[version][rateIndex];
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + padding;
  return length > 4 ? { length, version, rate, mono: (bytes[o + 3] >> 6) === 3 } : null;
}

// Returns only the audio frames: strips ID3v2/ID3v1 tags and the Xing/Info/VBRI
// header frame, whose duration would describe a single part only.
function mp3Frames(bytes) {
  let start = 0;
  while (bytes[start] === 0x49 && bytes[start + 1] === 0x44 && bytes[start + 2] === 0x33) {
    const size = ((bytes[start + 6] & 0x7f) << 21) | ((bytes[start + 7] & 0x7f) << 14) | ((bytes[start + 8] & 0x7f) << 7) | (bytes[start + 9] & 0x7f);
    start += 10 + size + (bytes[start + 5] & 0x10 ? 10 : 0);
  }
  let end = bytes.length;
  if (end - 128 >= start && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) end -= 128;
  // Find the first frame that is followed by another valid frame (avoids false syncs).
  let first = -1;
  for (let o = start; o < Math.min(end, start + 65536); o++) {
    const f = mp3Frame(bytes, o);
    if (f && (o + f.length >= end || mp3Frame(bytes, o + f.length))) { first = o; break; }
  }
  if (first < 0) throw Error('ملف MP3 غير صالح');
  const f = mp3Frame(bytes, first);
  const sideInfo = f.version === 3 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
  const tag = String.fromCharCode(...bytes.subarray(first + 4 + sideInfo, first + 8 + sideInfo));
  const vbri = String.fromCharCode(...bytes.subarray(first + 36, first + 40));
  if (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI') first += f.length;
  return { frames: bytes.subarray(first, end), rate: f.rate };
}

function mergeMp3(files) {
  const parts = files.map(mp3Frames);
  if (parts.some((p) => p.rate !== parts[0].rate)) throw Error('أجزاء MP3 بترددات مختلفة');
  const out = new Uint8Array(parts.reduce((n, p) => n + p.frames.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p.frames, offset);
    offset += p.frames.length;
  }
  return out;
}

function mergeAudio(files, format) {
  if (files.length === 1) return files[0];
  return format === 'wav' ? mergeWav(files) : mergeMp3(files);
}

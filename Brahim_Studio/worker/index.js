// Brahim Studio — private Worker (Cloudflare-compatible fetch handler).
//
// Every /api/ route requires the identity header that the ChatGPT Sites
// authentication boundary injects (`oai-authenticated-user-id`). That header is
// trusted ONLY behind that boundary; do not expose this Worker elsewhere without
// replacing `authenticatedUser()` with real authentication for the new host.
//
// Provider secrets are read from `env` (server-side secrets) and never returned,
// logged, or echoed in error messages.
//
// The build step prepends `const HTML` and `const APP_JS`; importing this file
// directly (tests) only exercises the API routes.

import { handleSync, syncStatus } from './sync.js';
import { handleKeys, withStoredKeys, providerDetail } from './keys.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INSTRUCTIONS = 'You are the writing assistant in Brahim Studio, a private creative workspace. Follow the requested language. For Origins Drawn, default to English finance and consumer psychology stories featuring Drew: messy dark brown hair, expressive round face, navy hoodie, black stick limbs, hand-drawn ink on cream paper, detailed environments and subtle watercolor accents. For Little Hearts, default to warm English family stories. Do not invent verified statistics or promise asset generation. Return useful plain text; never claim to have generated images, video or audio.';

const TASKS = {
  script: 'Write a compelling video script.',
  prompt: 'Improve the visual-generation prompt. Preserve the requested character and give detailed environment and action.',
  narration: 'Write narration suitable for text-to-speech. Return spoken words only unless asked otherwise.',
  general: 'Help with the user request.',
};

const BRANDS = ['Origins Drawn', 'Little Hearts', 'مشروع شخصي'];

// Model IDs are defaults only. Each can be overridden by a server variable and
// must be checked against the provider account before relying on it.
const DEFAULT_MODELS = {
  openai: 'gpt-6-astra',
  anthropic: 'claude-sonnet-5-5',
  image: 'gpt-image-2',
  tts: 'gpt-4o-mini-tts',
  video: 'sora-2',
};

const ANTHROPIC_VERSION = '2026-10-21';

const TTS_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS_LANGUAGES = { en: 'English', ar: 'Arabic', fr: 'French' };
const TTS_MAX_CHARS = 4000;

const IMAGE_SIZES = { '9:16': '1024x1536', '16:9': '1536x1024', '1:1': '1024x1024' };
const IMAGE_QUALITIES = ['low', 'medium', 'high'];
const VIDEO_SIZES = { '9:16': '720x1280', '16:9': '1280x720' };
const VIDEO_SECONDS = ['4', '8', '12'];

const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

const TEXT_BODY_LIMIT = 60_000;
const MEDIA_BODY_LIMIT = 24_000_000;

// Best-effort, per-instance spending guard. Worker instances do not share
// memory, so this is NOT a hard budget: set a monthly budget/limit in the
// provider dashboards as the real ceiling.
const DEFAULT_RATE_LIMITS = { text: 30, image: 12, tts: 30, video: 4 }; // per 10 minutes
const RATE_WINDOW_MS = 10 * 60 * 1000;

const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', ...SECURITY_HEADERS },
});

const fail = (message, status) => json({ error: message }, status);

function models(env) {
  return {
    openai: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
    anthropic: env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
    image: env.OPENAI_IMAGE_MODEL || DEFAULT_MODELS.image,
    tts: env.OPENAI_TTS_MODEL || DEFAULT_MODELS.tts,
    video: env.OPENAI_VIDEO_MODEL || DEFAULT_MODELS.video,
  };
}

function rateLimits(env) {
  const read = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    text: read('RATE_LIMIT_TEXT', DEFAULT_RATE_LIMITS.text),
    image: read('RATE_LIMIT_IMAGE', DEFAULT_RATE_LIMITS.image),
    tts: read('RATE_LIMIT_TTS', DEFAULT_RATE_LIMITS.tts),
    video: read('RATE_LIMIT_VIDEO', DEFAULT_RATE_LIMITS.video),
  };
}

function status(env) {
  const m = models(env);
  const openai = !!env.OPENAI_API_KEY;
  return {
    providers: {
      openai: { configured: openai, model: m.openai },
      anthropic: { configured: !!env.ANTHROPIC_API_KEY, model: m.anthropic },
    },
    media: {
      image: { configured: openai, provider: 'OpenAI', model: m.image, ratios: Object.keys(IMAGE_SIZES), qualities: IMAGE_QUALITIES, maxReferences: MAX_REFERENCES },
      tts: { configured: openai, provider: 'OpenAI', model: m.tts, voices: TTS_VOICES, languages: Object.keys(TTS_LANGUAGES), formats: ['mp3', 'wav'], maxChars: TTS_MAX_CHARS },
      video: { configured: openai, provider: 'OpenAI', model: m.video, ratios: Object.keys(VIDEO_SIZES), seconds: VIDEO_SECONDS },
    },
    sync: syncStatus(env),
    limits: { windowMinutes: RATE_WINDOW_MS / 60000, perWindow: rateLimits(env), scope: 'per-instance best effort' },
  };
}

function authenticatedUser(request) {
  return request.headers.get('oai-authenticated-user-id') || '';
}

async function readLimited(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw Error('size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

// In-memory guards (per Worker instance).
const rateBuckets = new Map();
const recentRequestIds = new Map();
const REQUEST_ID_TTL_MS = 30 * 60 * 1000;

function takeRateToken(user, kind, env) {
  const limit = rateLimits(env)[kind];
  const key = user + ':' + kind;
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}

// Rejects a replay of the same client request ID (double tap, resubmitted form).
function claimRequestId(user, id) {
  if (!id) return true;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return false;
  const now = Date.now();
  for (const [key, t] of recentRequestIds) if (now - t > REQUEST_ID_TTL_MS) recentRequestIds.delete(key);
  const key = user + ':' + id;
  if (recentRequestIds.has(key)) return false;
  recentRequestIds.set(key, now);
  return true;
}

const IMAGE_SIGNATURES = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

// Parses a base64 data URL, checks the declared type against the real file
// signature, and returns bytes. Returns null when anything is off.
function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  let binary;
  try { binary = atob(match[2]); } catch { return null; }
  if (binary.length < 16 || binary.length > MAX_REFERENCE_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!IMAGE_SIGNATURES[match[1]](bytes)) return null;
  return { mime: match[1], bytes, ext: match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6) };
}

async function callProvider(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

const TIMEOUT_MESSAGE = 'تعذر تأكيد اكتمال الطلب بسبب مشكلة اتصال أو انتهاء المهلة. راجع استخدام حساب المزوّد قبل المحاولة مجددًا.';

// Maps an upstream failure to an Arabic message plus the provider's sanitized reason.
async function providerFailure(response) {
  const s = response.status;
  let detail = null;
  try { detail = providerDetail(await response.json()); } catch {}
  const answer = (message, status) => json(detail ? { error: message, detail } : { error: message }, status);
  if (s === 401 || s === 403) return answer('المزوّد رفض بيانات الاتصال أو صلاحيات النموذج.', 502);
  if (s === 429) return answer('المزوّد أوقف الطلب بسبب الرصيد أو حد الاستخدام.', 429);
  if (s === 400) return answer('المزوّد رفض الطلب (قد يكون الوصف مخالفًا لسياسة المحتوى أو أن الإعداد غير مدعوم لهذا النموذج).', 502);
  if (s === 404) return answer('النموذج أو المورد غير موجود لدى المزوّد. تحقق من اسم النموذج في إعدادات الخادم.', 502);
  return answer('تعذر إكمال الطلب لدى المزوّد (' + s + '). تحقق من إعداد النموذج والخدمة.', 502);
}

const openaiHeaders = (env, extra = {}) => ({ authorization: 'Bearer ' + env.OPENAI_API_KEY, ...extra });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function generateText(body, env) {
  const { provider, task, brand, prompt } = body || {};
  if (!['openai', 'anthropic'].includes(provider) || !Object.hasOwn(TASKS, task) || !BRANDS.includes(brand) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) {
    return fail('تحقق من المزوّد والمهمة والنص (حتى 12000 حرف).', 400);
  }
  const isOpenAI = provider === 'openai';
  if (!(isOpenAI ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)) return fail('هذا المزوّد غير مفعّل. يلزم ضبط مفتاح API في الخادم.', 503);
  const model = models(env)[provider];
  const instructions = INSTRUCTIONS + '\nProject: ' + brand + '\nTask: ' + TASKS[task];

  let response;
  if (isOpenAI) {
    response = await callProvider(OPENAI + '/responses', {
      method: 'POST',
      headers: openaiHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model, instructions, input: prompt.trim(), max_output_tokens: 8000, store: false }),
    }, 120_000);
  } else {
    const request = { model, system: instructions, messages: [{ role: 'user', content: prompt.trim() }], max_tokens: 16000 };
    const effort = env.ANTHROPIC_EFFORT ?? 'medium';
    if (effort) request.output_config = { effort };
    response = await callProvider(ANTHROPIC + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(request),
    }, 120_000);
  }
  if (!response) return fail(TIMEOUT_MESSAGE, 504);
  if (!response.ok) return providerFailure(response);

  let data;
  try { data = await response.json(); } catch { return fail('وصل رد غير صالح من المزوّد.', 502); }
  if (!isOpenAI && data.stop_reason === 'refusal') return fail('رفض النموذج هذا الطلب. عدّل صياغته وحاول مرة أخرى.', 422);
  const text = isOpenAI
    ? (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n')
    : (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!text) return fail('لم يصل نص قابل للعرض من المزوّد.', 502);
  return json({
    text,
    provider: isOpenAI ? 'OpenAI' : 'Claude',
    model,
    truncated: isOpenAI ? data.status === 'incomplete' : data.stop_reason === 'max_tokens',
  });
}

const RATE_INSTRUCTION = { '0.85': 'Speak at a calm, slightly slow pace.', '1': 'Speak at a natural pace.', '1.15': 'Speak at a brisk, energetic pace.' };

async function generateSpeech(body, env) {
  const { text, voice, language, format, rate, style } = body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > TTS_MAX_CHARS || !TTS_VOICES.includes(voice) || !Object.hasOwn(TTS_LANGUAGES, language) || !['mp3', 'wav'].includes(format) || !Object.hasOwn(RATE_INSTRUCTION, String(rate ?? '1')) || (style != null && (typeof style !== 'string' || style.length > 500))) {
    return fail('تحقق من النص (حتى ' + TTS_MAX_CHARS + ' حرف) والصوت واللغة والصيغة.', 400);
  }
  if (!env.OPENAI_API_KEY) return fail('توليد الصوت غير مفعّل. يلزم ضبط مفتاح OpenAI في الخادم.', 503);
  const model = models(env).tts;
  const instructions = ['Read the text in ' + TTS_LANGUAGES[language] + '.', RATE_INSTRUCTION[String(rate ?? '1')], 'Use a warm, clear storytelling voice suitable for a YouTube narration.', style ? 'Delivery notes: ' + style.trim() : ''].filter(Boolean).join(' ');
  const response = await callProvider(OPENAI + '/audio/speech', {
    method: 'POST',
    headers: openaiHeaders(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ model, input: text.trim(), voice, response_format: format, instructions }),
  }, 120_000);
  if (!response) return fail(TIMEOUT_MESSAGE, 504);
  if (!response.ok) return providerFailure(response);
  const audio = await response.arrayBuffer().catch(() => null);
  if (!audio || audio.byteLength < 100) return fail('لم يصل ملف صوتي صالح من المزوّد.', 502);
  return new Response(audio, {
    headers: {
      'content-type': format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      'x-brahim-model': model,
      ...SECURITY_HEADERS,
    },
  });
}

async function generateImage(body, env) {
  const { prompt, ratio, quality, references = [] } = body || {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || !Object.hasOwn(IMAGE_SIZES, ratio) || !IMAGE_QUALITIES.includes(quality) || !Array.isArray(references) || references.length > MAX_REFERENCES) {
    return fail('تحقق من الوصف والمقاس والجودة وعدد الصور المرجعية (حتى ' + MAX_REFERENCES + ').', 400);
  }
  const decoded = references.map(decodeImage);
  if (decoded.some((d) => !d)) return fail('إحدى الصور المرجعية غير صالحة (PNG أو JPEG أو WEBP حتى 4MB).', 400);
  if (!env.OPENAI_API_KEY) return fail('توليد الصور غير مفعّل. يلزم ضبط مفتاح OpenAI في الخادم.', 503);
  const model = models(env).image;
  const params = { model, prompt: prompt.trim(), size: IMAGE_SIZES[ratio], quality, output_format: 'jpeg', output_compression: 90, n: 1 };

  let response;
  if (decoded.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    decoded.forEach((img, i) => form.append('image[]', new Blob([img.bytes], { type: img.mime }), 'reference-' + (i + 1) + '.' + img.ext));
    response = await callProvider(OPENAI + '/images/edits', { method: 'POST', headers: openaiHeaders(env), body: form }, 240_000);
  } else {
    response = await callProvider(OPENAI + '/images/generations', {
      method: 'POST',
      headers: openaiHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify(params),
    }, 240_000);
  }
  if (!response) return fail(TIMEOUT_MESSAGE, 504);
  if (!response.ok) return providerFailure(response);
  let data;
  try { data = await response.json(); } catch { return fail('وصل رد غير صالح من المزوّد.', 502); }
  const b64 = data?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length < 100) return fail('لم تصل صورة صالحة من المزوّد.', 502);
  return json({ image: b64, mime: 'image/jpeg', model, usedReferences: decoded.length });
}

const VIDEO_ID = /^video_[A-Za-z0-9_-]{4,100}$/;

function videoSummary(data) {
  const allowed = ['queued', 'in_progress', 'completed', 'failed'];
  return {
    id: data.id,
    status: allowed.includes(data.status) ? data.status : 'in_progress',
    progress: Number.isFinite(data.progress) ? Math.max(0, Math.min(100, Math.round(data.progress))) : null,
    seconds: data.seconds ?? null,
    size: data.size ?? null,
    model: data.model ?? null,
    failed: data.status === 'failed',
    ...(data.status === 'failed' && providerDetail(data) ? { detail: providerDetail(data) } : {}),
  };
}

async function createVideo(body, env) {
  const { prompt, ratio, seconds, reference } = body || {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || !Object.hasOwn(VIDEO_SIZES, ratio) || !VIDEO_SECONDS.includes(String(seconds))) {
    return fail('تحقق من الوصف والمقاس (9:16 أو 16:9) والمدة (4 أو 8 أو 12 ثانية).', 400);
  }
  let image = null;
  if (reference != null) {
    image = decodeImage(reference);
    if (!image) return fail('الصورة المرجعية للفيديو غير صالحة (PNG أو JPEG أو WEBP حتى 4MB).', 400);
  }
  if (!env.OPENAI_API_KEY) return fail('توليد الفيديو غير مفعّل. يلزم ضبط مفتاح OpenAI في الخادم.', 503);
  const form = new FormData();
  form.append('model', models(env).video);
  form.append('prompt', prompt.trim());
  form.append('seconds', String(seconds));
  form.append('size', VIDEO_SIZES[ratio]);
  if (image) form.append('input_reference', new Blob([image.bytes], { type: image.mime }), 'reference.' + image.ext);
  const response = await callProvider(OPENAI + '/videos', { method: 'POST', headers: openaiHeaders(env), body: form }, 60_000);
  if (!response) return fail(TIMEOUT_MESSAGE, 504);
  if (!response.ok) return providerFailure(response);
  let data;
  try { data = await response.json(); } catch { return fail('وصل رد غير صالح من المزوّد.', 502); }
  if (typeof data?.id !== 'string' || !VIDEO_ID.test(data.id)) return fail('لم يرجع المزوّد رقم مهمة صالحًا.', 502);
  return json(videoSummary(data), 202);
}

async function videoStatus(id, env) {
  if (!VIDEO_ID.test(id || '')) return fail('رقم مهمة غير صالح.', 400);
  if (!env.OPENAI_API_KEY) return fail('توليد الفيديو غير مفعّل.', 503);
  const response = await callProvider(OPENAI + '/videos/' + id, { headers: openaiHeaders(env) }, 30_000);
  if (!response) return fail('تعذر الاتصال بالمزوّد لمعرفة الحالة. سنحاول لاحقًا.', 504);
  if (!response.ok) return providerFailure(response);
  let data;
  try { data = await response.json(); } catch { return fail('وصل رد غير صالح من المزوّد.', 502); }
  return json(videoSummary({ ...data, id }));
}

async function videoContent(id, env) {
  if (!VIDEO_ID.test(id || '')) return fail('رقم مهمة غير صالح.', 400);
  if (!env.OPENAI_API_KEY) return fail('توليد الفيديو غير مفعّل.', 503);
  const response = await callProvider(OPENAI + '/videos/' + id + '/content', { headers: openaiHeaders(env) }, 120_000);
  if (!response) return fail('تعذر تنزيل الفيديو. حاول مرة أخرى.', 504);
  if (!response.ok) return response.status === 404 ? fail('ملف الفيديو لم يعد متاحًا لدى المزوّد.', 410) : providerFailure(response);
  return new Response(response.body, {
    headers: { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="brahim-' + id + '.mp4"', ...SECURITY_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const POST_ROUTES = {
  '/api/ai/generate': { kind: 'text', limit: TEXT_BODY_LIMIT, handler: generateText },
  '/api/tts': { kind: 'tts', limit: TEXT_BODY_LIMIT, handler: generateSpeech },
  '/api/image': { kind: 'image', limit: MEDIA_BODY_LIMIT, handler: generateImage },
  '/api/video': { kind: 'video', limit: MEDIA_BODY_LIMIT, handler: createVideo },
};

async function handleApi(request, env, url) {
  const user = authenticatedUser(request);
  if (!user) return fail('سجّل الدخول لفتح هذه الميزة.', 401);

  const keys = await handleKeys(request, env, url, user, { json, fail, readLimited });
  if (keys) return keys;
  // Keys saved in the app fill in for missing server secrets on every other route.
  env = await withStoredKeys(env, user);

  const synced = await handleSync(request, env, url, user, { json, fail, readLimited, securityHeaders: SECURITY_HEADERS });
  if (synced) return synced;

  if (request.method === 'GET') {
    if (url.pathname === '/api/ai/status') return json(status(env));
    if (url.pathname === '/api/video/status') return videoStatus(url.searchParams.get('id'), env);
    if (url.pathname === '/api/video/content') return videoContent(url.searchParams.get('id'), env);
  }

  const route = POST_ROUTES[url.pathname];
  if (!route) return fail('المسار غير متاح.', 404);
  if (request.method !== 'POST') return fail('طريقة غير مسموحة.', 405);
  if (request.headers.get('origin') !== url.origin) return fail('مصدر الطلب غير مسموح.', 403);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return fail('نوع الطلب غير صالح.', 415);

  let body;
  try { body = await readLimited(request, route.limit); } catch { return fail('طلب غير صالح أو أكبر من الحد المسموح.', 400); }
  if (!claimRequestId(user, request.headers.get('x-brahim-request-id'))) return fail('هذا الطلب أُرسل من قبل. لم تتم إعادة إرساله لتجنب خصم مكرر.', 409);
  if (!takeRateToken(user, route.kind, env)) return fail('وصلت إلى حد الطلبات المؤقت لحماية رصيدك. انتظر بضع دقائق.', 429);
  return route.handler(body, env);
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const js = url.pathname === '/app.js';
    if (url.pathname !== '/' && url.pathname !== '/index.html' && !js) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : js ? APP_JS : HTML, {
      headers: {
        'content-type': js ? 'text/javascript;charset=utf-8' : 'text/html;charset=utf-8',
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      },
    });
  },
};

// Exposed for tests only.
export const _internals = { rateBuckets, recentRequestIds, decodeImage };

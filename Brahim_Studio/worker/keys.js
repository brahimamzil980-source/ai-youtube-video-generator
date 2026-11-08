// Provider API keys entered in the app (Settings), for hosts without a secrets UI.
//
// - Stored server-side only: D1 table `provider_keys`, encrypted with AES-GCM.
// - The encryption key comes from the KEY_ENCRYPTION_SECRET secret when set; otherwise
//   a random 256-bit key is generated once and kept in R2 (separate from the D1 data).
// - A key is never returned to the browser: only its source and last 4 characters.
// - A key configured as a server secret (OPENAI_API_KEY / ANTHROPIC_API_KEY) always wins.

const KEY_PROVIDERS = {
  openai: { env: 'OPENAI_API_KEY', pattern: /^sk-[A-Za-z0-9_-]{20,300}$/, testUrl: 'https://api.openai.com/v1/models', headers: (k) => ({ authorization: 'Bearer ' + k }) },
  anthropic: { env: 'ANTHROPIC_API_KEY', pattern: /^sk-ant-[A-Za-z0-9_-]{20,300}$/, testUrl: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2026-10-21' }) },
};
const KEY_SCHEMA = 'CREATE TABLE IF NOT EXISTS provider_keys (owner TEXT NOT NULL, provider TEXT NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL, last4 TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, provider))';
const MASTER_OBJECT = 'system/provider-key-master.bin';
const KEY_TEST_WINDOW_MS = 10 * 60 * 1000;
const KEY_TEST_LIMIT = 10;

const keySchemaReady = new WeakMap();
const keyTests = new Map();

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function keyStorageAvailable(env) {
  return !!(env.DB && env.MEDIA);
}

function ensureKeySchema(env) {
  if (!keySchemaReady.has(env.DB)) {
    const ready = env.DB.prepare(KEY_SCHEMA).run().catch((e) => { keySchemaReady.delete(env.DB); throw e; });
    keySchemaReady.set(env.DB, ready);
  }
  return keySchemaReady.get(env.DB);
}

async function encryptionKey(env) {
  let raw;
  if (env.KEY_ENCRYPTION_SECRET) {
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('brahim-studio-keys:' + env.KEY_ENCRYPTION_SECRET)));
  } else {
    const existing = await env.MEDIA.get(MASTER_OBJECT);
    if (existing) raw = new Uint8Array(await new Response(existing.body).arrayBuffer());
    if (!raw || raw.length !== 32) {
      raw = crypto.getRandomValues(new Uint8Array(32));
      await env.MEDIA.put(MASTER_OBJECT, raw);
    }
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function keyOwner(user) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('brahim-studio:' + user));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function storedKeys(env, user) {
  if (!keyStorageAvailable(env)) return {};
  await ensureKeySchema(env);
  const owner = await keyOwner(user);
  const { results = [] } = await env.DB.prepare('SELECT provider, iv, data, last4 FROM provider_keys WHERE owner = ?').bind(owner).all();
  if (!results.length) return {};
  const cryptoKey = await encryptionKey(env);
  const out = {};
  for (const row of results) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv), additionalData: new TextEncoder().encode(owner + ':' + row.provider) }, cryptoKey, unb64(row.data));
      out[row.provider] = { key: new TextDecoder().decode(plain), last4: row.last4 };
    } catch {
      out[row.provider] = { key: null, last4: row.last4, broken: true };
    }
  }
  return out;
}

// Returns env with stored keys filled in where no server secret is set.
async function withStoredKeys(env, user) {
  if (!keyStorageAvailable(env) || (env.OPENAI_API_KEY && env.ANTHROPIC_API_KEY)) return env;
  let stored;
  try { stored = await storedKeys(env, user); } catch { return env; }
  const merged = { ...env };
  for (const [provider, cfg] of Object.entries(KEY_PROVIDERS)) {
    if (!merged[cfg.env] && stored[provider]?.key) merged[cfg.env] = stored[provider].key;
  }
  return merged;
}

async function keysSummary(env, user) {
  let stored = {};
  try { stored = await storedKeys(env, user); } catch {}
  const out = { storage: keyStorageAvailable(env) };
  for (const [provider, cfg] of Object.entries(KEY_PROVIDERS)) {
    const s = stored[provider];
    out[provider] = env[cfg.env]
      ? { source: 'server', last4: null, overridesStored: !!s }
      : s ? { source: s.broken ? 'broken' : 'stored', last4: s.last4 } : { source: null, last4: null };
  }
  return out;
}

async function handleKeys(request, env, url, user, { json, fail, readLimited }) {
  if (!url.pathname.startsWith('/api/keys')) return null;
  if (request.method === 'GET' && url.pathname === '/api/keys') return json(await keysSummary(env, user));
  const match = /^\/api\/keys\/(openai|anthropic)(\/test)?$/.exec(url.pathname);
  if (!match) return fail('المسار غير متاح.', 404);
  const provider = match[1];
  const cfg = KEY_PROVIDERS[provider];
  if (request.headers.get('origin') !== url.origin) return fail('مصدر الطلب غير مسموح.', 403);

  if (match[2]) {
    if (request.method !== 'POST') return fail('طريقة غير مسموحة.', 405);
    const now = Date.now();
    const hits = (keyTests.get(user) || []).filter((t) => now - t < KEY_TEST_WINDOW_MS);
    if (hits.length >= KEY_TEST_LIMIT) return fail('محاولات اختبار كثيرة. انتظر بضع دقائق.', 429);
    hits.push(now);
    keyTests.set(user, hits);
    const active = await withStoredKeys(env, user);
    const key = active[cfg.env];
    if (!key) return fail('لا يوجد مفتاح لهذا المزوّد.', 404);
    let response;
    try {
      response = await fetch(cfg.testUrl, { headers: cfg.headers(key), signal: AbortSignal.timeout(20_000) });
    } catch {
      return fail('تعذر الوصول إلى المزوّد للاختبار.', 504);
    }
    if (response.ok) return json({ ok: true, message: 'المفتاح صالح والمزوّد يقبله.' });
    if (response.status === 401 || response.status === 403) return json({ ok: false, message: 'المزوّد رفض هذا المفتاح (غير صالح أو ملغى).' });
    if (response.status === 429) return json({ ok: false, message: 'المفتاح معروف لكن المزوّد أوقف الطلب (رصيد أو حد استخدام).' });
    return json({ ok: false, message: 'رد غير متوقع من المزوّد (' + response.status + ').' });
  }

  if (!keyStorageAvailable(env)) return fail('حفظ المفاتيح يحتاج قاعدة D1 (DB) وتخزين R2 (MEDIA) في الاستضافة.', 503);
  await ensureKeySchema(env);
  const owner = await keyOwner(user);

  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM provider_keys WHERE owner = ? AND provider = ?').bind(owner, provider).run();
    return json({ deleted: true });
  }
  if (request.method !== 'PUT') return fail('طريقة غير مسموحة.', 405);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return fail('نوع الطلب غير صالح.', 415);
  let body;
  try { body = await readLimited(request, 2000); } catch { return fail('طلب غير صالح.', 400); }
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!cfg.pattern.test(key)) return fail(provider === 'openai' ? 'هذا لا يشبه مفتاح OpenAI (يبدأ بـ sk-).' : 'هذا لا يشبه مفتاح Anthropic (يبدأ بـ sk-ant-).', 400);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await encryptionKey(env);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner + ':' + provider) }, cryptoKey, new TextEncoder().encode(key)));
  await env.DB.prepare('INSERT INTO provider_keys (owner, provider, iv, data, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, provider) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, updated_at = excluded.updated_at')
    .bind(owner, provider, b64(iv), b64(data), key.slice(-4), Date.now()).run();
  return json({ saved: true, last4: key.slice(-4), overriddenByServer: !!env[cfg.env] });
}

export { handleKeys, withStoredKeys };

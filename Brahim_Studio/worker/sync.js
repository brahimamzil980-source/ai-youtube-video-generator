// Cross-device sync: records in D1 (binding `DB`), media files in R2 (binding `MEDIA`).
//
// Every query is scoped to the authenticated owner. Records use last-writer-wins on the
// client's `updatedAt`; each accepted write gets a per-owner increasing `rev`, which is
// the pull cursor. Records too large for a D1 row are stored as JSON objects in R2.

const SYNC_KINDS = ['character', 'project', 'voiceScript', 'audio'];
const ASSET_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav'];
const ASSET_KINDS = ['image', 'video', 'audio'];
const MAX_RECORD_BYTES = 6_000_000;
const INLINE_RECORD_BYTES = 800_000;
const MAX_ASSET_BYTES = 95_000_000;
const DEFAULT_QUOTA_BYTES = 5 * 1024 ** 3;
const PULL_PAGE = 100;
const PULL_MAX_BYTES = 20_000_000;
const SYNC_BODY_LIMIT = 30_000_000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS records (owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, r2 TEXT, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, PRIMARY KEY (owner, kind, id))',
  'CREATE INDEX IF NOT EXISTS records_rev ON records (owner, rev)',
  'CREATE TABLE IF NOT EXISTS assets (owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, r2 TEXT NOT NULL, PRIMARY KEY (owner, id))',
];

const schemaReady = new WeakMap(); // per D1 binding

function syncAvailable(env) {
  return !!(env.DB && env.MEDIA);
}

function ensureSchema(env) {
  if (!schemaReady.has(env.DB)) {
    const ready = (async () => {
      for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    })().catch((e) => { schemaReady.delete(env.DB); throw e; });
    schemaReady.set(env.DB, ready);
  }
  return schemaReady.get(env.DB);
}

async function ownerKey(user) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('brahim-studio:' + user));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MEDIA_SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'video/mp4': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  'audio/mpeg': (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/wav': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45,
};

function validRecord(r) {
  if (!r || typeof r !== 'object') return false;
  if (!SYNC_KINDS.includes(r.kind) || typeof r.id !== 'string' || !ID_RE.test(r.id)) return false;
  if (!Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0 || r.updatedAt > Date.now() + 24 * 3600 * 1000) return false;
  if (r.deleted) return true;
  return r.data && typeof r.data === 'object' && !Array.isArray(r.data) && r.data.id === r.id;
}

async function pushRecords(body, env, owner, ok, fail) {
  const records = body?.records;
  if (!Array.isArray(records) || records.length > 500 || !records.every(validRecord)) return fail('بيانات المزامنة غير صالحة.', 400);
  const results = [];
  for (const r of records) {
    const deleted = r.deleted ? 1 : 0;
    const text = deleted ? null : JSON.stringify(r.data);
    if (text && text.length > MAX_RECORD_BYTES) { results.push({ kind: r.kind, id: r.id, status: 'too_large' }); continue; }
    const previous = await env.DB.prepare('SELECT r2, updated_at FROM records WHERE owner = ? AND kind = ? AND id = ?').bind(owner, r.kind, r.id).first();
    if (previous && previous.updated_at >= r.updatedAt) { results.push({ kind: r.kind, id: r.id, status: 'stale' }); continue; }
    let r2 = null;
    let inline = text;
    if (text && text.length > INLINE_RECORD_BYTES) {
      r2 = 'rec/' + owner + '/' + r.kind + '/' + r.id + '/' + r.updatedAt + '.json';
      await env.MEDIA.put(r2, text, { httpMetadata: { contentType: 'application/json' } });
      inline = null;
    }
    const res = await env.DB.prepare(
      'INSERT INTO records (owner, kind, id, data, r2, updated_at, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM records WHERE owner = ?)) ' +
      'ON CONFLICT (owner, kind, id) DO UPDATE SET data = excluded.data, r2 = excluded.r2, updated_at = excluded.updated_at, deleted = excluded.deleted, rev = excluded.rev WHERE excluded.updated_at > records.updated_at'
    ).bind(owner, r.kind, r.id, inline, r2, r.updatedAt, deleted, owner).run();
    const accepted = (res?.meta?.changes ?? 0) > 0;
    if (!accepted) {
      if (r2) await env.MEDIA.delete(r2);
      results.push({ kind: r.kind, id: r.id, status: 'stale' });
      continue;
    }
    if (previous?.r2 && previous.r2 !== r2) await env.MEDIA.delete(previous.r2);
    results.push({ kind: r.kind, id: r.id, status: 'ok' });
  }
  return ok({ results });
}

async function pullRecords(url, env, owner, ok, fail) {
  const since = Number(url.searchParams.get('since') || 0);
  if (!Number.isSafeInteger(since) || since < 0) return fail('مؤشر المزامنة غير صالح.', 400);
  const { results = [] } = await env.DB.prepare('SELECT kind, id, data, r2, updated_at, deleted, rev FROM records WHERE owner = ? AND rev > ? ORDER BY rev LIMIT ?').bind(owner, since, PULL_PAGE).all();
  const records = [];
  let bytes = 0;
  let cursor = since;
  for (const row of results) {
    let data = null;
    if (!row.deleted) {
      let text = row.data;
      if (row.r2) {
        const obj = await env.MEDIA.get(row.r2);
        text = obj ? await obj.text() : null;
      }
      if (text == null) continue;
      bytes += text.length;
      if (records.length && bytes > PULL_MAX_BYTES) break;
      try { data = JSON.parse(text); } catch { continue; }
    }
    records.push({ kind: row.kind, id: row.id, data, updatedAt: row.updated_at, deleted: !!row.deleted });
    cursor = row.rev;
  }
  const more = results.length === PULL_PAGE || cursor < (results[results.length - 1]?.rev ?? cursor);
  return ok({ records, cursor, more });
}

async function putAsset(request, env, owner, id, ok, fail) {
  const mime = (request.headers.get('content-type') || '').split(';')[0].trim();
  const kind = request.headers.get('x-brahim-asset-kind');
  if (!ASSET_MIMES.includes(mime) || !ASSET_KINDS.includes(kind)) return fail('نوع الملف غير مدعوم.', 415);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_ASSET_BYTES) return fail('الملف أكبر من الحد المسموح.', 413);
  const existing = await env.DB.prepare('SELECT size FROM assets WHERE owner = ? AND id = ?').bind(owner, id).first();
  if (existing) return ok({ id, size: existing.size, existed: true });
  let buffer;
  try { buffer = await request.arrayBuffer(); } catch { return fail('تعذر قراءة الملف.', 400); }
  if (buffer.byteLength < 16 || buffer.byteLength > MAX_ASSET_BYTES) return fail('حجم الملف غير صالح.', 413);
  if (!MEDIA_SIGNATURES[mime](new Uint8Array(buffer, 0, 16))) return fail('محتوى الملف لا يطابق نوعه.', 415);
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE owner = ?').bind(owner).first();
  const quota = Number(env.SYNC_QUOTA_BYTES) > 0 ? Number(env.SYNC_QUOTA_BYTES) : DEFAULT_QUOTA_BYTES;
  if ((used?.total ?? 0) + buffer.byteLength > quota) return fail('امتلأت مساحة التخزين السحابية المخصصة. احذف نتائج قديمة.', 507);
  const key = 'asset/' + owner + '/' + id;
  await env.MEDIA.put(key, buffer, { httpMetadata: { contentType: mime } });
  await env.DB.prepare('INSERT OR IGNORE INTO assets (owner, id, kind, mime, size, created_at, r2) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(owner, id, kind, mime, buffer.byteLength, Date.now(), key).run();
  return ok({ id, size: buffer.byteLength, existed: false }, 201);
}

// Supports single byte ranges: Safari on iPhone needs them to play video.
async function getAsset(request, env, owner, id, fail, securityHeaders) {
  const row = await env.DB.prepare('SELECT mime, size, r2 FROM assets WHERE owner = ? AND id = ?').bind(owner, id).first();
  if (!row) return fail('الملف غير موجود في التخزين السحابي.', 404);
  const headers = { 'content-type': row.mime, 'accept-ranges': 'bytes', ...securityHeaders, 'cache-control': 'private, max-age=31536000, immutable' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, row.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), row.size - 1) : row.size - 1;
    if (start >= row.size || start > end) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + row.size, ...securityHeaders } });
    const obj = await env.MEDIA.get(row.r2, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return fail('الملف غير موجود في التخزين السحابي.', 404);
    return new Response(obj.body, { status: 206, headers: { ...headers, 'content-range': 'bytes ' + start + '-' + end + '/' + row.size, 'content-length': String(end - start + 1) } });
  }
  const obj = await env.MEDIA.get(row.r2);
  if (!obj) return fail('الملف غير موجود في التخزين السحابي.', 404);
  return new Response(obj.body, { headers: { ...headers, 'content-length': String(row.size) } });
}

async function deleteAsset(env, owner, id, ok) {
  const row = await env.DB.prepare('SELECT r2 FROM assets WHERE owner = ? AND id = ?').bind(owner, id).first();
  if (row) {
    await env.MEDIA.delete(row.r2);
    await env.DB.prepare('DELETE FROM assets WHERE owner = ? AND id = ?').bind(owner, id).run();
  }
  return ok({ id, deleted: !!row });
}

async function syncUsage(env, owner) {
  const a = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM assets WHERE owner = ?').bind(owner).first();
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE owner = ? AND deleted = 0').bind(owner).first();
  const quota = Number(env.SYNC_QUOTA_BYTES) > 0 ? Number(env.SYNC_QUOTA_BYTES) : DEFAULT_QUOTA_BYTES;
  return { records: r?.n ?? 0, assets: a?.n ?? 0, bytes: a?.total ?? 0, quota };
}

// Entry point for /api/sync/* and /api/assets/*. Returns null for other paths.
export async function handleSync(request, env, url, user, { json, fail, readLimited, securityHeaders }) {
  const path = url.pathname;
  if (!path.startsWith('/api/sync/') && !path.startsWith('/api/assets/')) return null;
  if (!syncAvailable(env)) return fail('المزامنة غير مفعّلة: يلزم ربط قاعدة D1 (DB) وتخزين R2 (MEDIA) في الاستضافة.', 503);
  const writes = !['GET', 'HEAD'].includes(request.method);
  if (writes && request.headers.get('origin') !== url.origin) return fail('مصدر الطلب غير مسموح.', 403);
  try {
    await ensureSchema(env);
    const owner = await ownerKey(user);
    if (path === '/api/sync/status' && request.method === 'GET') return json({ available: true, usage: await syncUsage(env, owner) });
    if (path === '/api/sync/pull' && request.method === 'GET') return await pullRecords(url, env, owner, json, fail);
    if (path === '/api/sync/push' && request.method === 'POST') {
      if (!(request.headers.get('content-type') || '').startsWith('application/json')) return fail('نوع الطلب غير صالح.', 415);
      let body;
      try { body = await readLimited(request, SYNC_BODY_LIMIT); } catch { return fail('طلب غير صالح أو أكبر من الحد المسموح.', 400); }
      return await pushRecords(body, env, owner, json, fail);
    }
    const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(path);
    if (assetMatch) {
      const id = assetMatch[1];
      if (!ASSET_ID_RE.test(id)) return fail('رقم ملف غير صالح.', 400);
      if (request.method === 'GET') return await getAsset(request, env, owner, id, fail, securityHeaders);
      if (request.method === 'PUT') return await putAsset(request, env, owner, id, json, fail);
      if (request.method === 'DELETE') return await deleteAsset(env, owner, id, json);
      return fail('طريقة غير مسموحة.', 405);
    }
    return fail('المسار غير متاح.', 404);
  } catch {
    return fail('تعذر الوصول إلى التخزين السحابي. حاول مرة أخرى.', 503);
  }
}

export function syncStatus(env) {
  return { available: syncAvailable(env) };
}

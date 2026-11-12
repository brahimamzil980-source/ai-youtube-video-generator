// Cross-device sync (opt-in). Records go to the server's D1 database, generated
// media files to its R2 storage. Changes are detected by comparing each record
// with a hash of the last synced version, so every existing edit path is covered.
// Conflicts: last writer wins per record (character, project, script, audio entry).

const SYNC_SOURCES = {
  character: { list: () => db.characters, set: (l) => (db.characters = l), key: (x) => x.id },
  project: { list: () => db.projects, set: (l) => (db.projects = l), key: (x) => x.id },
  voiceScript: { list: () => db.voiceScripts, set: (l) => (db.voiceScripts = l), key: (x) => x.id },
  audio: { list: () => db.audio, set: (l) => (db.audio = l), key: (x) => x.assetId },
  story: { list: () => db.stories, set: (l) => (db.stories = l), key: (x) => x.id },
};

let syncBusy = false;
let syncAgain = false;
let syncTimer = null;
let syncServerAvailable = false;
let lastSyncError = '';

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + text.length;
}

// Data sent for a record. Audio entries get an `id` (their asset ID) for the server.
function recordData(kind, item) {
  return kind === 'audio' ? { ...item, id: item.assetId } : item;
}

function localRecords() {
  const out = new Map();
  for (const [kind, src] of Object.entries(SYNC_SOURCES)) {
    for (const item of src.list()) {
      const id = src.key(item);
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) out.set(kind + ':' + id, { kind, id, item });
    }
  }
  return out;
}

function applyRemote(remote) {
  const src = SYNC_SOURCES[remote.kind];
  if (!src) return;
  const list = src.list().filter((x) => src.key(x) !== remote.id);
  if (!remote.deleted) {
    const data = { ...remote.data };
    if (remote.kind === 'audio') delete data.id;
    const index = src.list().findIndex((x) => src.key(x) === remote.id);
    if (index >= 0) list.splice(index, 0, data);
    else list.push(data);
  }
  src.set(list);
}

async function syncFetch(path, init) {
  const r = await fetch(path, { cache: 'no-store', ...init });
  if (!r.ok) {
    let message = 'خطأ في المزامنة (' + r.status + ')';
    try { message = (await r.json()).error || message; } catch {}
    if (r.status === 401) message = 'انتهت الجلسة. أعد فتح الموقع وسجّل الدخول.';
    throw Error(message);
  }
  return r.json();
}

async function pullAll(local) {
  let changed = false;
  for (let page = 0; page < 200; page++) {
    const data = await syncFetch('/api/sync/pull?since=' + (db.sync.cursor || 0));
    for (const remote of data.records) {
      const key = remote.kind + ':' + remote.id;
      const mine = local.get(key);
      const synced = db.sync.hashes[key];
      const dirty = mine ? hashText(JSON.stringify(recordData(mine.kind, mine.item))) !== synced : !!synced;
      // A local edit made after the remote one wins; it will be pushed next.
      if (dirty && db.sync.lastChange > remote.updatedAt) continue;
      applyRemote(remote);
      if (remote.deleted) delete db.sync.hashes[key];
      else db.sync.hashes[key] = hashText(JSON.stringify(remote.data));
      changed = true;
    }
    db.sync.cursor = data.cursor;
    if (!data.more) break;
  }
  return changed;
}

async function pushDirty() {
  const local = localRecords();
  const changes = [];
  const at = Math.min(db.sync.lastChange || Date.now(), Date.now());
  for (const [key, rec] of local) {
    const data = recordData(rec.kind, rec.item);
    const h = hashText(JSON.stringify(data));
    if (db.sync.hashes[key] !== h) changes.push({ key, hash: h, record: { kind: rec.kind, id: rec.id, data, updatedAt: at } });
  }
  for (const key of Object.keys(db.sync.hashes)) {
    if (!local.has(key)) {
      const [kind, id] = key.split(':');
      changes.push({ key, hash: null, record: { kind, id, deleted: true, updatedAt: at } });
    }
  }
  let stale = false;
  // Batches of ~8MB keep each request well under the server limit.
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await syncFetch('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: batch.map((c) => c.record) }) });
    result.results.forEach((res, i) => {
      const c = batch[i];
      if (res.status === 'ok') {
        if (c.hash) db.sync.hashes[c.key] = c.hash;
        else delete db.sync.hashes[c.key];
      } else if (res.status === 'stale') stale = true;
      else if (res.status === 'too_large') lastSyncError = 'عنصر أكبر من الحد المسموح للمزامنة: ' + c.key;
    });
    batch = [];
    size = 0;
  };
  for (const c of changes) {
    const bytes = JSON.stringify(c.record).length;
    if (size + bytes > 8_000_000 || batch.length >= 200) await flush();
    batch.push(c);
    size += bytes;
  }
  await flush();
  return { pushed: changes.length, stale };
}

function referencedAssets() {
  const ids = [];
  for (const p of db.projects) for (const o of p.outputs) ids.push({ id: o.assetId, kind: o.kind });
  for (const a of db.audio) ids.push({ id: a.assetId, kind: 'audio' });
  return ids;
}

async function uploadAssets() {
  let uploaded = 0;
  for (const { id, kind } of referencedAssets()) {
    const record = await getAsset(id).catch(() => null);
    if (!record || record.uploaded) continue;
    const r = await fetch('/api/assets/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': record.mime, 'X-Brahim-Asset-Kind': kind },
      body: record.blob,
    });
    if (!r.ok) {
      let message = 'تعذر رفع ملف.';
      try { message = (await r.json()).error || message; } catch {}
      throw Error(message);
    }
    record.uploaded = true;
    await assetTx('readwrite', (store) => store.put(record));
    uploaded++;
  }
  return uploaded;
}

async function flushDeletes() {
  const pending = [...new Set(db.sync.pendingDeletes)];
  for (const id of pending) {
    const r = await fetch('/api/assets/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.ok || r.status === 400) db.sync.pendingDeletes = db.sync.pendingDeletes.filter((x) => x !== id);
  }
}

async function syncNow({ manual = false } = {}) {
  if (!db.sync.enabled || !syncServerAvailable) return;
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true;
  lastSyncError = '';
  renderSync('جارٍ المزامنة…');
  try {
    let changed = await pullAll(localRecords());
    const { stale } = await pushDirty();
    if (stale) changed = (await pullAll(localRecords())) || changed;
    await flushDeletes();
    const uploaded = await uploadAssets();
    db.sync.lastSync = Date.now();
    save({ fromSync: true });
    if (changed) { render(); renderScripts(); renderAudio(); renderStoryPage(); const p = currentProject(); if (p) showProject(p); }
    if (manual) toast('تمت المزامنة' + (uploaded ? ' (رُفع ' + uploaded + ' ملف)' : ''));
  } catch (e) {
    lastSyncError = e.message || 'تعذرت المزامنة.';
    save({ fromSync: true });
    if (manual) toast(lastSyncError);
  } finally {
    syncBusy = false;
    renderSync();
    if (syncAgain) { syncAgain = false; scheduleSync(1000); }
  }
}

function scheduleSync(delay = 4000) {
  clearTimeout(syncTimer);
  if (db.sync.enabled) syncTimer = setTimeout(() => syncNow(), delay);
}
onSave((fromSync) => { if (!fromSync) scheduleSync(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(500); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);

async function renderSync(busyText) {
  const box = $('syncstatus');
  if (!box) return;
  $('syncenable').classList.toggle('hidden', db.sync.enabled || !syncServerAvailable);
  $('syncnow').classList.toggle('hidden', !db.sync.enabled || !syncServerAvailable);
  $('syncdisable').classList.toggle('hidden', !db.sync.enabled);
  $('syncnow').disabled = syncBusy;
  if (!syncServerAvailable) {
    box.textContent = providerStatus ? '○ المزامنة غير متاحة: الخادم يحتاج قاعدة بيانات D1 (DB) وتخزين R2 (MEDIA). بياناتك تبقى في هذا الجهاز.' : 'جارٍ التحقق…';
    return;
  }
  if (!db.sync.enabled) {
    box.textContent = '○ المزامنة متاحة لكنها غير مفعّلة على هذا الجهاز.';
    return;
  }
  const parts = [busyText || ('● مفعّلة' + (db.sync.lastSync ? ' — آخر مزامنة ' + new Date(db.sync.lastSync).toLocaleString('ar') : ''))];
  if (lastSyncError) parts.push('⚠ ' + lastSyncError);
  box.textContent = parts.join(' · ');
  if (!busyText) {
    try {
      const s = await syncFetch('/api/sync/status');
      $('syncusage').textContent = 'في السحابة: ' + s.usage.records + ' عنصر و' + s.usage.assets + ' ملف (' + Math.round(s.usage.bytes / 1048576) + ' MB من ' + Math.round(s.usage.quota / 1073741824) + ' GB).';
    } catch {}
  }
}

onStatus((s) => {
  const was = syncServerAvailable;
  syncServerAvailable = !!s?.sync?.available;
  renderSync();
  if (syncServerAvailable && !was) syncNow();
});

$('syncenable').onclick = async () => {
  if (!confirm('تفعيل المزامنة يرفع شخصياتك ومشاريعك ونصوصك وملفاتك المولّدة إلى تخزين موقعك الخاص (يصل إليه حسابك فقط)، ثم يدمجها مع الأجهزة الأخرى.\n\nسيتم أولًا تحميل نسخة احتياطية من بيانات هذا الجهاز. متابعة؟')) return;
  $('export').click();
  db.sync.enabled = true;
  db.sync.cursor = 0;
  db.sync.hashes = {};
  // On the first sync the cloud copy wins any conflict; records only on this device are uploaded.
  db.sync.lastChange = 0;
  save({ fromSync: true });
  await syncNow({ manual: true });
};
$('syncnow').onclick = () => syncNow({ manual: true });
$('syncdisable').onclick = () => {
  if (!confirm('إيقاف المزامنة على هذا الجهاز؟ بياناتك تبقى هنا وفي السحابة، لكن التغييرات لن تُرسل أو تُستقبل.')) return;
  db.sync.enabled = false;
  save({ fromSync: true });
  renderSync();
};

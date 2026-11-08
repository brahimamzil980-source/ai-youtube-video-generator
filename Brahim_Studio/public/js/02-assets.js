// Generated media store (IndexedDB) + image file validation and resizing.

const ASSET_DB = 'brahim-studio-assets';
let assetDbPromise;

function openAssets() {
  assetDbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(Error('IndexedDB غير متاح في هذا المتصفح'));
    const req = indexedDB.open(ASSET_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('assets', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return assetDbPromise;
}

async function assetTx(mode, fn) {
  const database = await openAssets();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('assets', mode);
    const request = fn(tx.objectStore('assets'));
    tx.oncomplete = () => resolve(request instanceof IDBRequest ? request.result ?? null : request);
    tx.onerror = () => reject(tx.error || Error('تعذر حفظ الملف في المتصفح'));
    tx.onabort = () => reject(tx.error || Error('مساحة التخزين غير كافية لحفظ الملف'));
  });
}

async function putAsset(blob, meta) {
  const record = { id: crypto.randomUUID(), blob, mime: blob.type, size: blob.size, createdAt: new Date().toISOString(), ...meta };
  await assetTx('readwrite', (store) => store.put(record));
  return record;
}
const getAsset = (id) => assetTx('readonly', (store) => store.get(id));
const deleteAsset = (id) => assetTx('readwrite', (store) => store.delete(id));

const objectUrls = new Map();
async function assetUrl(id) {
  if (objectUrls.has(id)) return objectUrls.get(id);
  const record = await getAsset(id).catch(() => null);
  if (!record) return db.sync.enabled ? '/api/assets/' + encodeURIComponent(id) : null;
  const url = URL.createObjectURL(record.blob);
  objectUrls.set(id, url);
  return url;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = node('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadAsset(id, filename) {
  const record = await getAsset(id).catch(() => null);
  if (record) return downloadBlob(record.blob, filename);
  if (!db.sync.enabled) return toast('الملف غير موجود في هذا المتصفح.');
  try {
    toast('جارٍ جلب الملف من التخزين السحابي…');
    const r = await fetch('/api/assets/' + encodeURIComponent(id));
    if (!r.ok) throw Error();
    downloadBlob(await r.blob(), filename);
  } catch {
    toast('تعذر جلب الملف من التخزين السحابي.');
  }
}

// Deletes a generated file on this device and, when sync is on, in cloud storage.
async function forgetAsset(id) {
  await deleteAsset(id).catch(() => {});
  if (objectUrls.has(id)) { URL.revokeObjectURL(objectUrls.get(id)); objectUrls.delete(id); }
  if (db.sync.enabled) { db.sync.pendingDeletes.push(id); save(); }
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4' };
const extFor = (mime) => EXT[mime] || 'bin';

function base64ToBlob(b64, mime) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Checks the real file signature, not only the extension/MIME the browser reports.
async function sniffImage(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(Error('تعذر قراءة الصورة'));
    img.src = src;
  });
}

// Reads a user-selected reference image as a data URL (max 2MB, stored in localStorage).
async function readImageFile(file) {
  if (!file) return '';
  if (file.size > 2_000_000) throw Error('اختر صورة أصغر من 2MB');
  const type = await sniffImage(file);
  if (!type) throw Error('الصورة يجب أن تكون PNG أو JPEG أو WEBP حقيقية');
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(Error('تعذر قراءة الصورة'));
    r.readAsDataURL(new Blob([file], { type }));
  });
  await loadImage(dataUrl); // confirms it decodes
  return dataUrl;
}

// Re-encodes any stored reference to JPEG, fitting inside maxSide, for upload.
async function normalizeReference(dataUrl, maxSide = 1536) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// Video providers need the first frame at exactly the output size: center-crop to fill.
async function cropReference(dataUrl, width, height) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.9);
}

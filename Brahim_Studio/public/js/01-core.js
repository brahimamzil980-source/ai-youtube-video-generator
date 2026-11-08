// Core: DOM helpers, local database (localStorage), navigation, API helper.
// All files in public/js are concatenated in name order inside one IIFE.

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'brahim-studio-v1';
const SCHEMA_VERSION = 2;

const MODE_CODES = { 'صورة': 'image', 'فيديو من صورة': 'i2v', 'فيديو من وصف': 't2v' };
const MODE_LABELS = { image: 'صورة', i2v: 'فيديو من صورة', t2v: 'فيديو من وصف' };

const DREW = {
  id: 'drew',
  name: 'Drew',
  description: 'Messy dark brown hair, expressive round face, navy hoodie, black stick limbs. Hand-drawn black-ink illustration, cream paper, cross-hatching, richly detailed environments, subtle watercolor accents.',
  image: '',
};

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (className) n.className = className;
  return n;
}

function button(text, onClick, className = 'secondary') {
  const b = node('button', text, className);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').style.display = 'none'), 4000);
}

// Upgrades any stored shape (v1 or v2) to the current schema without losing fields.
function migrate(data) {
  const out = data && typeof data === 'object' ? data : {};
  out.characters = Array.isArray(out.characters) ? out.characters : [{ ...DREW }];
  out.projects = Array.isArray(out.projects) ? out.projects : [];
  out.voiceScripts = Array.isArray(out.voiceScripts) ? out.voiceScripts : [];
  out.audio = Array.isArray(out.audio) ? out.audio : [];
  for (const p of out.projects) {
    if (MODE_CODES[p.mode]) p.mode = MODE_CODES[p.mode];
    if (!MODE_LABELS[p.mode]) p.mode = 'image';
    p.outputs = Array.isArray(p.outputs) ? p.outputs : [];
    p.jobs = Array.isArray(p.jobs) ? p.jobs : [];
    p.rawPrompt ??= '';
    p.characterId ??= '';
    p.duration ??= '';
    p.quality ??= 'medium';
    p.reference ??= '';
  }
  out.sync = out.sync && typeof out.sync === 'object' ? out.sync : { enabled: false, cursor: 0, hashes: {}, lastChange: 0, pendingDeletes: [] };
  out.sync.hashes ??= {};
  out.sync.pendingDeletes ??= [];
  out.version = SCHEMA_VERSION;
  return out;
}

let db;
try { db = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { db = null; }
db = migrate(db);

const saveListeners = [];
function onSave(fn) { saveListeners.push(fn); }
function save({ fromSync = false } = {}) {
  try {
    if (!fromSync) db.sync.lastChange = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    saveListeners.forEach((fn) => fn(fromSync));
    return true;
  } catch {
    toast('مساحة التخزين غير كافية. صدّر بياناتك واحذف مرجعًا كبيرًا.');
    return false;
  }
}

const renderers = [];
function onRender(fn) { renderers.push(fn); }
function render() { renderers.forEach((fn) => fn()); }

const pageListeners = [];
function onPage(fn) { pageListeners.push(fn); }
function go(page) {
  document.querySelectorAll('main>section').forEach((s) => s.classList.toggle('hidden', s.id !== page));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  pageListeners.forEach((fn) => fn(page));
  render();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => go(b.dataset.page)));

const newRequestId = () => crypto.randomUUID();

let DEVICE_ID;
try {
  DEVICE_ID = localStorage.getItem('brahim-device-id') || crypto.randomUUID();
  localStorage.setItem('brahim-device-id', DEVICE_ID);
} catch {
  DEVICE_ID = crypto.randomUUID();
}

// Calls a JSON API route. Throws an Error carrying the server's Arabic message.
async function api(path, body, { binary = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Brahim-Request-Id': newRequestId() },
      body: JSON.stringify(body),
    });
  } catch {
    throw Error('انقطع الاتصال قبل وصول الرد. قد يكون الطلب وصل للمزوّد؛ راجع النتائج قبل إعادة المحاولة.');
  }
  if (!response.ok) {
    let message = 'تعذر إكمال الطلب (' + response.status + ').';
    try { message = (await response.json()).error || message; } catch {}
    if (response.status === 401) message = 'انتهت الجلسة أو لم تسجّل الدخول. أعد فتح الموقع وسجّل الدخول.';
    throw Error(message);
  }
  return binary ? response : response.json();
}

// Provider status shared by every section.
let providerStatus = null;
const statusListeners = [];
function onStatus(fn) { statusListeners.push(fn); }
async function refreshStatus() {
  try {
    const r = await fetch('/api/ai/status', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    providerStatus = data;
  } catch {
    providerStatus = null;
  }
  statusListeners.forEach((fn) => fn(providerStatus));
}

function confirmPaid(lines) {
  return confirm(['هذه عملية مدفوعة على حساب OpenAI الخاص بك:', ...lines, '', 'متابعة؟'].join('\n'));
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

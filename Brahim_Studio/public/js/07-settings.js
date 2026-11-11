// Connection status panel, backup export/import, start-up.

function renderConnection(s) {
  const grid = $('connectiongrid');
  grid.replaceChildren();
  const row = (label, value) => {
    const d = node('div');
    d.append(node('span', label), node('span', value));
    grid.append(d);
  };
  if (!s) return row('الخادم', 'تعذر التحقق');
  const mark = (on, model) => (on ? '● مهيّأ · ' : '○ غير مفعّل · ') + model;
  row('كتابة — OpenAI', mark(s.providers.openai.configured, s.providers.openai.model));
  row('كتابة — Claude', mark(s.providers.anthropic.configured, s.providers.anthropic.model));
  row('صور — OpenAI', mark(s.media.image.configured, s.media.image.model));
  row('صوت MP3/WAV — OpenAI', mark(s.media.tts.configured, s.media.tts.model));
  row('فيديو — OpenAI', mark(s.media.video.configured, s.media.video.model));
  const l = s.limits.perWindow;
  row('حد مؤقت كل ' + s.limits.windowMinutes + ' دقائق', 'text ' + l.text + ' · image ' + l.image + ' · tts ' + l.tts + ' · video ' + l.video);
}
onStatus(renderConnection);
$('statusrefresh').onclick = refreshStatus;

async function renderStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('storageinfo').textContent = 'المساحة المستعملة في هذا المتصفح: ' + Math.round(est.usage / 1048576) + ' MB من حوالي ' + Math.round(est.quota / 1048576) + ' MB.';
  } catch {}
}
onPage((page) => { if (page === 'settings') renderStorage(); });

$('export').onclick = () => {
  const backup = { ...db, exportedAt: new Date().toISOString() };
  delete backup.sync;
  downloadBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), 'brahim-studio-backup-' + stamp() + '.json');
};

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isOptStr = (v, max) => v == null || isStr(v, max);
const isImage = (v) => v == null || v === '' || (isStr(v, 3_000_000) && IMAGE_DATA_URL.test(v));

function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.version != null && (!Number.isInteger(data.version) || data.version > SCHEMA_VERSION)) return false;
  if (!Array.isArray(data.characters) || !Array.isArray(data.projects)) return false;
  if (data.characters.length > 500 || data.projects.length > 5000) return false;
  const ids = new Set();
  const uniqueId = (id) => isStr(id, 100) && id.length > 0 && !ids.has(id) && ids.add(id);
  const charsOk = data.characters.every((c) => c && uniqueId(c.id) && isStr(c.name, 200) && isStr(c.description, 5000) && isImage(c.image));
  const projectsOk = data.projects.every((p) => p && uniqueId(p.id) && isStr(p.text, 20000) && isOptStr(p.title, 500) && isOptStr(p.brand, 100) && isOptStr(p.mode, 50) && isOptStr(p.ratio, 10) && isOptStr(p.rawPrompt, 20000) && isImage(p.reference) && (p.outputs == null || Array.isArray(p.outputs)) && (p.jobs == null || Array.isArray(p.jobs)));
  const voiceOk = data.voiceScripts == null || (Array.isArray(data.voiceScripts) && data.voiceScripts.every((v) => v && uniqueId(v.id) && isStr(v.title, 500) && isStr(v.text, 50000) && isOptStr(v.language, 10) && isOptStr(String(v.rate ?? ''), 10)));
  const audioOk = data.audio == null || Array.isArray(data.audio);
  const storiesOk = data.stories == null || (Array.isArray(data.stories) && data.stories.length <= 1000 && data.stories.every((st) => st && uniqueId(st.id) && isOptStr(st.title, 500) && Array.isArray(st.sceneIds)));
  return charsOk && projectsOk && voiceOk && audioOk && storiesOk;
}

$('import').onchange = async (e) => {
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 50_000_000) throw Error('big');
    const data = JSON.parse(await f.text());
    if (!validateBackup(data)) throw Error('invalid');
    if (!confirm('استبدال بيانات هذا المتصفح بالنسخة الاحتياطية؟ (الملفات المولّدة المحفوظة في المتصفح تبقى كما هي.)')) return;
    const previous = db;
    delete data.exportedAt;
    data.sync = previous.sync; // keep this device's sync state; imported changes sync as new edits
    db = migrate(data);
    if (!save()) { db = previous; return; }
    resetProject();
    render();
    renderScripts();
    renderAudio();
    toast('تم الاستيراد');
  } catch {
    toast('تعذر استيراد هذا الملف');
  } finally {
    e.target.value = '';
  }
};

// Start-up
render();
refreshStatus();
pollJobs();
setInterval(() => { if (document.visibilityState === 'visible') refreshStatus(); }, 5 * 60 * 1000);

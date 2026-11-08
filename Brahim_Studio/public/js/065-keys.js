// API keys entered in Settings. Keys go to the server once and never come back:
// the page only ever sees their source and last 4 characters.

const KEY_LABELS = { openai: 'OpenAI', anthropic: 'Claude' };
let keyStorage = false;

async function refreshKeys() {
  let data = null;
  try {
    const r = await fetch('/api/keys', { cache: 'no-store' });
    if (r.ok) data = await r.json();
  } catch {}
  keyStorage = !!data?.storage;
  $('keystorage').textContent = !data
    ? 'تعذر التحقق من حالة المفاتيح.'
    : keyStorage ? '' : '○ حفظ المفاتيح هنا يحتاج ربط قاعدة D1 (DB) وتخزين R2 (MEDIA) في الاستضافة. بدونها، ضع المفاتيح كأسرار في إعدادات الاستضافة.';
  for (const provider of Object.keys(KEY_LABELS)) {
    const info = data?.[provider];
    const text = !info ? '—'
      : info.source === 'server' ? '● مضبوط في أسرار الاستضافة' + (info.overridesStored ? ' (له الأولوية على المفتاح المحفوظ هنا)' : '')
      : info.source === 'stored' ? '● محفوظ هنا ••••' + info.last4
      : info.source === 'broken' ? '⚠ المفتاح المحفوظ (••••' + info.last4 + ') لم يعد قابلًا للقراءة. احفظه من جديد.'
      : '○ لا يوجد مفتاح';
    $('key-' + provider + '-status').textContent = text;
    $('key-' + provider + '-save').disabled = !keyStorage;
    $('key-' + provider + '-input').disabled = !keyStorage;
    $('key-' + provider + '-delete').disabled = !keyStorage || !['stored', 'broken'].includes(info?.source);
    $('key-' + provider + '-test').disabled = !info?.source || info.source === 'broken';
  }
}

async function keyRequest(provider, method, path = '', body) {
  const r = await fetch('/api/keys/' + provider + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw Error(data.error || 'تعذر إكمال الطلب (' + r.status + ').');
  return data;
}

for (const provider of Object.keys(KEY_LABELS)) {
  const input = $('key-' + provider + '-input');
  $('key-' + provider + '-save').onclick = async () => {
    const key = input.value.trim();
    if (!key) return toast('الصق المفتاح أولًا');
    $('key-' + provider + '-save').disabled = true;
    try {
      const res = await keyRequest(provider, 'PUT', '', { key });
      input.value = '';
      toast('تم حفظ مفتاح ' + KEY_LABELS[provider] + ' (••••' + res.last4 + ')' + (res.overriddenByServer ? ' — لكن مفتاح الاستضافة له الأولوية' : ''));
      await refreshKeys();
      await refreshStatus();
    } catch (e) {
      toast(e.message);
    } finally {
      $('key-' + provider + '-save').disabled = !keyStorage;
    }
  };
  $('key-' + provider + '-test').onclick = async () => {
    $('key-' + provider + '-test').disabled = true;
    $('key-' + provider + '-status').textContent = 'جارٍ الاختبار…';
    try {
      const res = await keyRequest(provider, 'POST', '/test');
      toast((res.ok ? '✓ ' : '✗ ') + KEY_LABELS[provider] + ': ' + res.message);
    } catch (e) {
      toast(e.message);
    }
    await refreshKeys();
  };
  $('key-' + provider + '-delete').onclick = async () => {
    if (!confirm('حذف مفتاح ' + KEY_LABELS[provider] + ' المحفوظ؟')) return;
    try {
      await keyRequest(provider, 'DELETE');
      toast('تم حذف المفتاح');
      await refreshKeys();
      await refreshStatus();
    } catch (e) {
      toast(e.message);
    }
  };
  // Never keep a typed key around when leaving the page.
  window.addEventListener('pagehide', () => { input.value = ''; });
}

onPage((page) => { if (page === 'settings') refreshKeys(); });

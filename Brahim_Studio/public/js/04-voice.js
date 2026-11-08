// Voice studio: free device preview (speechSynthesis) + downloadable OpenAI TTS files.

const synth = window.speechSynthesis;
let availableVoices = [];
let utterance;

function fillVoices() {
  const previous = $('voicechoice').value;
  availableVoices = synth ? synth.getVoices() : [];
  const matching = availableVoices.filter((v) => v.lang.toLowerCase().startsWith($('voicelang').value));
  $('voicechoice').replaceChildren();
  matching.forEach((v) => $('voicechoice').add(new Option(v.name + ' · ' + v.lang, v.voiceURI)));
  if (matching.some((v) => v.voiceURI === previous)) $('voicechoice').value = previous;
  if (!matching.length) {
    $('voicechoice').add(new Option('لا يوجد صوت لهذه اللغة على الجهاز', ''));
    $('voicestatus').textContent = synth ? 'لم يتوفر صوت جهاز لهذه اللغة. يمكنك توليد ملف احترافي بدلًا من ذلك.' : 'هذا المتصفح لا يدعم معاينة الصوت.';
  } else {
    $('voicestatus').textContent = 'المعاينة جاهزة. هذه أصوات الجهاز، وليست ملفًا قابلًا للتحميل.';
  }
  $('speak').disabled = !synth || !matching.length;
}
if (synth) synth.addEventListener('voiceschanged', fillVoices);
$('voicelang').onchange = () => { stopSpeech(); fillVoices(); };

function stopSpeech() {
  if (synth) synth.cancel();
  utterance = null;
  $('stopvoice').disabled = true;
  $('speak').disabled = !synth || !$('voicechoice').value;
}

function countVoice() {
  const n = $('voicetext').value.length;
  const max = providerStatus?.media?.tts?.maxChars || 4000;
  $('voicecount').textContent = n + ' حرف' + (n > max ? ' — الملف الاحترافي يقبل حتى ' + max + ' حرف في المرة الواحدة' : '');
}
$('voicetext').oninput = countVoice;

$('speak').onclick = () => {
  const text = $('voicetext').value.trim();
  if (!text) return toast('أدخل نص التعليق الصوتي');
  const voice = availableVoices.find((v) => v.voiceURI === $('voicechoice').value);
  if (!voice) return toast('اختر صوتًا متاحًا');
  stopSpeech();
  utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = Number($('voicerate').value);
  utterance.onstart = () => { $('voicestatus').textContent = 'جارٍ تشغيل المعاينة…'; $('speak').disabled = true; $('stopvoice').disabled = false; };
  utterance.onend = () => { $('voicestatus').textContent = 'اكتملت المعاينة.'; $('speak').disabled = false; $('stopvoice').disabled = true; };
  utterance.onerror = (e) => {
    $('voicestatus').textContent = e.error === 'canceled' || e.error === 'interrupted' ? 'تم إيقاف المعاينة.' : 'تعذر تشغيل هذا الصوت. جرّب صوتًا آخر أو تحقق من إعدادات الجهاز.';
    $('speak').disabled = false;
    $('stopvoice').disabled = true;
  };
  synth.speak(utterance);
};
$('stopvoice').onclick = () => { stopSpeech(); $('voicestatus').textContent = 'تم إيقاف المعاينة.'; };
onPage((page) => { if (page !== 'voice') stopSpeech(); });
window.addEventListener('pagehide', stopSpeech);

// --- Saved scripts -----------------------------------------------------------

function renderScripts() {
  $('voicesaved').replaceChildren();
  db.voiceScripts.slice().reverse().forEach((v) => {
    const wrap = node('div', null, 'card');
    wrap.append(node('h3', v.title), node('small', v.language + ' · ' + v.rate + '×' + (v.ttsVoice ? ' · ' + v.ttsVoice : '')));
    wrap.append(button('فتح', () => {
      stopSpeech();
      $('voicetitle').value = v.title;
      $('voicetext').value = v.text;
      $('voicelang').value = v.language;
      $('voicerate').value = v.rate;
      if (v.ttsVoice && [...$('ttsvoice').options].some((o) => o.value === v.ttsVoice)) $('ttsvoice').value = v.ttsVoice;
      if (v.style != null) $('ttsstyle').value = v.style;
      fillVoices();
      if (availableVoices.some((a) => a.voiceURI === v.voice)) $('voicechoice').value = v.voice;
      countVoice();
      window.scrollTo({ top: 0 });
    }));
    wrap.append(button('حذف', () => {
      if (!confirm('حذف هذا النص؟')) return;
      db.voiceScripts = db.voiceScripts.filter((x) => x.id !== v.id);
      save();
      renderScripts();
    }));
    $('voicesaved').append(wrap);
  });
  if (!db.voiceScripts.length) $('voicesaved').append(node('p', 'لا توجد نصوص صوتية محفوظة بعد.'));
}

$('savevoice').onclick = () => {
  const text = $('voicetext').value.trim();
  if (!text) return toast('أدخل النص أولًا');
  db.voiceScripts.push({ id: crypto.randomUUID(), title: $('voicetitle').value.trim() || text.slice(0, 40), text, language: $('voicelang').value, rate: $('voicerate').value, voice: $('voicechoice').value, ttsVoice: $('ttsvoice').value, style: $('ttsstyle').value.trim() });
  if (!save()) { db.voiceScripts.pop(); return; }
  renderScripts();
  toast('تم حفظ النص وإعدادات الصوت');
};

$('downloadscript').onclick = () => {
  if (!$('voicetext').value.trim()) return toast('أدخل النص أولًا');
  downloadBlob(new Blob([$('voicetext').value], { type: 'text/plain;charset=utf-8' }), 'brahim-voiceover.txt');
};

// --- Professional TTS file ---------------------------------------------------

let ttsBusy = false;
let lastAudio = null;

function updateTtsState() {
  const tts = providerStatus?.media?.tts;
  if (tts && !$('ttsvoice').options.length) {
    tts.voices.forEach((v) => $('ttsvoice').add(new Option(v[0].toUpperCase() + v.slice(1), v)));
    $('ttsvoice').value = tts.voices.includes('coral') ? 'coral' : tts.voices[0];
  }
  $('ttsconnection').textContent = !providerStatus
    ? 'تعذر التحقق من الاتصال بالخادم.'
    : tts?.configured
      ? '● مهيّأ — ' + tts.model + ' (أول ملف ناجح يؤكد الصلاحية)'
      : '○ غير مفعّل — يلزم ضبط OPENAI_API_KEY كسرّ في الخادم';
  $('ttsgenerate').disabled = ttsBusy || !tts?.configured;
  countVoice();
}
onStatus(updateTtsState);

$('ttsgenerate').onclick = async () => {
  if (ttsBusy) return;
  const tts = providerStatus?.media?.tts;
  const text = $('voicetext').value.trim();
  if (!text) return toast('أدخل نص التعليق الصوتي');
  if (text.length > tts.maxChars) return toast('النص أطول من ' + tts.maxChars + ' حرف. قسّمه إلى أجزاء.');
  const format = $('ttsformat').value;
  if (!confirmPaid(['• ملف صوتي ' + format.toUpperCase() + ' بنموذج ' + tts.model, '• الصوت ' + $('ttsvoice').value + ' · ' + text.length + ' حرف'])) return;
  ttsBusy = true;
  updateTtsState();
  $('ttsstatus').textContent = 'جارٍ توليد الملف الصوتي…';
  try {
    const response = await api('/api/tts', { text, voice: $('ttsvoice').value, language: $('voicelang').value, format, rate: $('voicerate').value, style: $('ttsstyle').value.trim() || null }, { binary: true });
    const blob = await response.blob();
    if (blob.size < 100) throw Error('وصل ملف صوتي فارغ.');
    const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const model = response.headers.get('x-brahim-model') || tts.model;
    const record = await putAsset(new Blob([blob], { type: mime }), { kind: 'audio', model });
    const title = $('voicetitle').value.trim() || text.slice(0, 40);
    db.audio.push({ assetId: record.id, title, voice: $('ttsvoice').value, language: $('voicelang').value, format, mime, model, chars: text.length, createdAt: record.createdAt });
    save();
    lastAudio = db.audio[db.audio.length - 1];
    $('ttsaudio').src = await assetUrl(record.id);
    $('ttsresult').classList.remove('hidden');
    $('ttsstatus').textContent = 'تم توليد الملف (' + Math.round(blob.size / 1024) + ' KB) وحفظه في «ملفاتك الصوتية».';
    renderAudio();
  } catch (e) {
    $('ttsstatus').textContent = e.message + ' لم تتم إعادة إرسال الطلب تلقائيًا.';
  } finally {
    ttsBusy = false;
    updateTtsState();
  }
};

const audioFilename = (a) => 'brahim-' + (a.title || 'voice').replace(/[^\w؀-ۿ-]+/g, '-').slice(0, 40) + '-' + a.createdAt.slice(0, 10) + '.' + a.format;

$('ttsdownload').onclick = () => { if (lastAudio) downloadAsset(lastAudio.assetId, audioFilename(lastAudio)); };

let audioRenderToken = 0;
async function renderAudio() {
  const token = ++audioRenderToken;
  const cards = [];
  for (const a of db.audio.slice().reverse()) {
    const card = node('div', null, 'card');
    card.append(node('h3', a.title), node('small', a.voice + ' · ' + a.language + ' · ' + a.format.toUpperCase() + ' · ' + a.chars + ' حرف'));
    const url = await assetUrl(a.assetId);
    if (token !== audioRenderToken) return; // a newer render started
    if (url) {
      const player = node('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = url;
      card.append(player);
    } else card.append(node('p', 'الملف غير موجود في هذا المتصفح.'));
    card.append(button('تحميل', () => downloadAsset(a.assetId, audioFilename(a))));
    card.append(button('حذف', async () => {
      if (!confirm('حذف هذا الملف الصوتي؟')) return;
      db.audio = db.audio.filter((x) => x !== a);
      save();
      await forgetAsset(a.assetId);
      renderAudio();
    }));
    cards.push(card);
  }
  if (!cards.length) cards.push(node('p', 'لا توجد ملفات صوتية مولّدة بعد.'));
  $('audiolist').replaceChildren(...cards);
}

onPage((page) => { if (page === 'voice') { renderScripts(); renderAudio(); } });
fillVoices();
renderScripts();
renderAudio();

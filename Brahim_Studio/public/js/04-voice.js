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
  const max = Math.min(3800, providerStatus?.media?.tts?.maxChars || 4000);
  const parts = n > max ? splitNarration($('voicetext').value, max).length : 1;
  $('voicecount').textContent = n + ' حرف' + (parts > 1 ? ' — سيُولَّد على ' + parts + ' أجزاء ويُدمج في ملف واحد' : '') + (n > LONG_TEXT_MAX_CHARS ? ' — الحد الأقصى ' + LONG_TEXT_MAX_CHARS + ' حرف' : '');
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
      : '○ غير مفعّل — أضف مفتاح OpenAI من «الاتصال والبيانات»';
  $('ttsgenerate').disabled = ttsBusy || !tts?.configured;
  countVoice();
}
onStatus(updateTtsState);

// A long text is generated part by part. Finished parts stay in memory (per text and
// settings), so after a failure or a stop, generating again only pays for missing parts.
const narrationJobs = new Map();
let ttsStop = false;

function ttsSettings(text) {
  return { text, voice: $('ttsvoice').value, language: $('voicelang').value, format: $('ttsformat').value, rate: $('voicerate').value, style: $('ttsstyle').value.trim() || null };
}

function narrationJob(settings) {
  const key = JSON.stringify(settings);
  if (!narrationJobs.has(key)) {
    const parts = splitNarration(settings.text, Math.min(3800, providerStatus.media.tts.maxChars));
    narrationJobs.set(key, { key, settings, parts, audio: parts.map(() => null), model: providerStatus.media.tts.model });
  }
  return narrationJobs.get(key);
}

// Confirmation lines describing what a narration will cost.
function narrationCostLines(job) {
  const remaining = job.audio.filter((a) => !a).length;
  const lines = ['• ملف صوتي ' + job.settings.format.toUpperCase() + ' بنموذج ' + job.model, '• الصوت ' + job.settings.voice + ' · ' + job.settings.text.length + ' حرف'];
  if (job.parts.length > 1) lines.push('• النص طويل: ' + job.parts.length + ' أجزاء' + (remaining < job.parts.length ? '، باقي ' + remaining + ' (الأجزاء الجاهزة لن تُعاد)' : '') + '، ثم تُدمج في ملف واحد');
  return lines;
}

// Generates (or resumes) a narration and saves it to the audio library.
// onProgress(done, total, message) reports progress; shouldStop() can end it between parts.
async function generateNarration(job, title, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const total = job.parts.length;
  for (let i = 0; i < total; i++) {
    if (job.audio[i]) continue;
    if (shouldStop()) throw Error('تم الإيقاف بعد ' + job.audio.filter(Boolean).length + ' من ' + total + ' أجزاء. اضغط «توليد» لإكمال الباقي.');
    onProgress(job.audio.filter(Boolean).length, total, total > 1 ? 'جارٍ توليد الجزء ' + (i + 1) + ' من ' + total + '…' : 'جارٍ توليد الملف الصوتي…');
    let response;
    try {
      response = await api('/api/tts', { ...job.settings, text: job.parts[i] }, { binary: true });
    } catch (e) {
      throw Error((total > 1 ? 'توقف عند الجزء ' + (i + 1) + ': ' : '') + e.message + (total > 1 && i > 0 ? ' الأجزاء الجاهزة محفوظة؛ اضغط «توليد» لإكمال الباقي فقط.' : ''));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 100) throw Error('وصل جزء صوتي فارغ.');
    job.audio[i] = bytes;
    job.model = response.headers.get('x-brahim-model') || job.model;
  }
  onProgress(total, total, total > 1 ? 'جارٍ دمج ' + total + ' أجزاء في ملف واحد…' : 'جارٍ الحفظ…');
  let merged;
  try {
    merged = mergeAudio(job.audio, job.settings.format);
  } catch (e) {
    throw Error('تعذر دمج الأجزاء: ' + e.message);
  }
  const mime = job.settings.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  const record = await putAsset(new Blob([merged], { type: mime }), { kind: 'audio', model: job.model });
  const entry = { assetId: record.id, title, voice: job.settings.voice, language: job.settings.language, format: job.settings.format, mime, model: job.model, chars: job.settings.text.length, parts: total, size: merged.length, createdAt: record.createdAt };
  db.audio.push(entry);
  save();
  narrationJobs.delete(job.key);
  renderAudio();
  return entry;
}

function ttsProgress(done, total) {
  $('ttsprogress').classList.toggle('hidden', total < 2);
  $('ttsprogress').max = total;
  $('ttsprogress').value = done;
}

$('ttsgenerate').onclick = async () => {
  if (ttsBusy) return;
  const text = $('voicetext').value.trim();
  if (!text) return toast('أدخل نص التعليق الصوتي');
  if (text.length > LONG_TEXT_MAX_CHARS) return toast('النص أطول من ' + LONG_TEXT_MAX_CHARS + ' حرف. قسّمه إلى ملفات.');
  const job = narrationJob(ttsSettings(text));
  if (!confirmPaid(narrationCostLines(job))) return;
  ttsBusy = true;
  ttsStop = false;
  updateTtsState();
  $('ttsstop').classList.toggle('hidden', job.parts.length < 2);
  try {
    const entry = await generateNarration(job, $('voicetitle').value.trim() || text.slice(0, 40), {
      onProgress: (done, total, message) => { ttsProgress(done, total); $('ttsstatus').textContent = message; },
      shouldStop: () => ttsStop,
    });
    lastAudio = entry;
    $('ttsaudio').src = await assetUrl(entry.assetId);
    $('ttsresult').classList.remove('hidden');
    $('ttsstatus').textContent = 'تم توليد الملف (' + Math.round(entry.size / 1024) + ' KB' + (entry.parts > 1 ? '، ' + entry.parts + ' أجزاء مدمجة' : '') + ') وحفظه في «ملفاتك الصوتية».';
  } catch (e) {
    $('ttsstatus').textContent = e.message + ' لم تتم إعادة إرسال أي طلب تلقائيًا.';
  } finally {
    ttsBusy = false;
    $('ttsstop').classList.add('hidden');
    updateTtsState();
  }
};

$('ttsstop').onclick = () => {
  ttsStop = true;
  $('ttsstatus').textContent = 'سيتوقف التوليد بعد الجزء الحالي…';
};

const audioFilename = (a) => 'brahim-' + (a.title || 'voice').replace(/[^\w؀-ۿ-]+/g, '-').slice(0, 40) + '-' + a.createdAt.slice(0, 10) + '.' + a.format;

$('ttsdownload').onclick = () => { if (lastAudio) downloadAsset(lastAudio.assetId, audioFilename(lastAudio)); };

let audioRenderToken = 0;
async function renderAudio() {
  const token = ++audioRenderToken;
  const cards = [];
  for (const a of db.audio.slice().reverse()) {
    const card = node('div', null, 'card');
    card.append(node('h3', a.title), node('small', a.voice + ' · ' + a.language + ' · ' + a.format.toUpperCase() + ' · ' + a.chars + ' حرف' + (a.parts > 1 ? ' · ' + a.parts + ' أجزاء' : '')));
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

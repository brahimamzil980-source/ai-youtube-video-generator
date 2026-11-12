// Story pipeline: idea -> script and scenes (GPT/Claude) -> scene images -> scene videos
// -> one narration -> ZIP package. Each scene is an ordinary project (with storyId), so
// generation, video polling, sync and downloads reuse the existing code.

let currentStoryId = null;
let storyBusy = false;
let storyStop = false;

const currentStory = () => db.stories.find((st) => st.id === currentStoryId) || null;
const storyScenes = (st) => st.sceneIds.map((id) => db.projects.find((p) => p.id === id)).filter(Boolean);
const latestOutput = (p, kind) => [...p.outputs].reverse().find((o) => o.kind === kind) || null;
const pendingVideo = (p) => p.jobs.some((j) => ['queued', 'in_progress', 'completed'].includes(j.status));

function slug(text) {
  return (text || 'story').toLowerCase().replace(/[^\w؀-ۿ]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
}

function scenePrompt(st, p) {
  const character = db.characters.find((c) => c.id === st.characterId);
  return buildPrompt({ rawPrompt: p.rawPrompt, character, mode: 'image', ratio: st.ratio, duration: p.duration });
}

function sceneVideoPrompt(p) {
  return [p.motionPrompt || 'Subtle natural motion and a slow camera push-in.', 'Animate the reference image: keep the exact art style, characters, clothing and composition.', 'No on-screen text, no brand logos.'].join('\n\n');
}

function touchStory(st) {
  st.updatedAt = new Date().toISOString();
}

// ---- Planning ---------------------------------------------------------------

function fillStoryCharacters() {
  const select = $('storycharacter');
  const previous = select.value;
  select.replaceChildren(new Option('بدون شخصية ثابتة', ''));
  db.characters.forEach((c) => select.add(new Option(c.name + (c.image ? ' 🖼' : ''), c.id)));
  select.value = db.characters.some((c) => c.id === previous) ? previous : db.characters.some((c) => c.id === 'drew') ? 'drew' : '';
}

$('storyplan').onclick = async () => {
  if (storyBusy) return;
  const idea = $('storyidea').value.trim();
  if (!idea) return toast('اكتب فكرة القصة أولًا');
  const provider = $('storyprovider').value;
  if (!providerStatus?.providers?.[provider]?.configured) return toast('هذا الكاتب غير مفعّل. أضف مفتاحه من «الاتصال والبيانات».');
  const character = db.characters.find((c) => c.id === $('storycharacter').value);
  storyBusy = true;
  $('storyplan').disabled = true;
  $('storyplanstatus').textContent = 'جارٍ كتابة القصة وتقسيمها إلى مشاهد… قد يستغرق ذلك دقيقة.';
  try {
    const plan = await api('/api/story/plan', {
      provider,
      brand: $('storybrand').value,
      idea,
      scenes: Number($('storyscenes').value),
      seconds: Number($('storylength').value),
      language: $('storylang').value,
      character: character ? { name: character.name, description: character.description } : null,
    });
    const now = new Date().toISOString();
    const st = { id: crypto.randomUUID(), title: plan.title, idea, brand: $('storybrand').value, provider, model: plan.model, characterId: character?.id || '', ratio: $('storyratio').value, language: $('storylang').value, sceneIds: [], narration: null, createdAt: now, updatedAt: now };
    plan.scenes.forEach((sc, i) => {
      const p = newScene(st, i, sc);
      db.projects.push(p);
      st.sceneIds.push(p.id);
    });
    db.stories.push(st);
    if (!save()) throw Error('تعذر حفظ القصة (مساحة التخزين).');
    currentStoryId = st.id;
    $('storyplanstatus').textContent = 'كتب ' + plan.provider + ' (' + plan.model + ') ' + plan.scenes.length + ' مشاهد. راجعها وعدّلها، ثم ولّد الصور.' + (plan.truncated ? ' الجواب قد يكون مختصرًا.' : '');
    renderStoryPage();
  } catch (e) {
    $('storyplanstatus').textContent = e.message + ' لم تتم إعادة إرسال الطلب تلقائيًا.';
  } finally {
    storyBusy = false;
    $('storyplan').disabled = false;
    updateStoryButtons();
  }
};

function newScene(st, index, sc) {
  const now = new Date().toISOString();
  const p = {
    id: crypto.randomUUID(), storyId: st.id, sceneIndex: index,
    title: st.title + ' — ' + (index + 1), brand: st.brand, mode: 'image', ratio: st.ratio, duration: $('storyseconds').value || '4', quality: $('storyquality').value || 'medium',
    characterId: st.characterId, rawPrompt: sc.imagePrompt, narration: sc.narration, motionPrompt: sc.motionPrompt,
    reference: '', outputs: [], jobs: [], createdAt: now, updatedAt: now,
  };
  p.text = scenePrompt(st, p);
  return p;
}

// ---- Rendering --------------------------------------------------------------

function renderStoryList() {
  const list = $('storylist');
  list.replaceChildren();
  if (!db.stories.length) list.append(node('p', 'لا توجد قصص بعد.', 'hint'));
  db.stories.slice().reverse().forEach((st) => {
    const scenes = storyScenes(st);
    const row = node('div', null, 'storyitem');
    const info = node('div');
    info.append(node('strong', st.title), node('small', ' · ' + scenes.length + ' مشاهد · ' + scenes.filter((p) => latestOutput(p, 'image')).length + ' صور · ' + scenes.filter((p) => latestOutput(p, 'video')).length + ' فيديو' + (st.narration ? ' · تعليق صوتي' : '')));
    row.append(info, button(st.id === currentStoryId ? 'مفتوحة' : 'فتح', () => { currentStoryId = st.id; renderStoryPage(); window.scrollTo({ top: 0 }); }));
    list.append(row);
  });
}

function sceneStatus(p) {
  const wrap = node('div');
  const img = latestOutput(p, 'image');
  const vid = latestOutput(p, 'video');
  wrap.append(node('span', img ? 'صورة ✓' : 'بدون صورة', 'pill' + (img ? '' : ' wait')));
  const job = p.jobs.find((j) => ['queued', 'in_progress', 'completed'].includes(j.status));
  if (vid) wrap.append(node('span', 'فيديو ✓', 'pill'));
  else if (job) wrap.append(node('span', 'فيديو قيد التوليد' + (job.progress != null ? ' ' + job.progress + '%' : ''), 'pill wait'));
  const failed = p.jobs.filter((j) => ['failed', 'expired', 'error'].includes(j.status)).pop();
  if (!vid && !job && failed?.message) wrap.append(node('div', failed.message, 'error'));
  return wrap;
}

async function fillThumb(thumb, p) {
  const vid = latestOutput(p, 'video');
  const img = latestOutput(p, 'image');
  const out = vid || img;
  if (!out) { thumb.textContent = 'لم تُولَّد صورة بعد'; return; }
  const url = await assetUrl(out.assetId);
  if (!url) { thumb.textContent = 'الملف غير موجود في هذا الجهاز'; return; }
  const el = node(out.kind === 'video' ? 'video' : 'img');
  el.src = url;
  if (out.kind === 'video') { el.controls = true; el.playsInline = true; el.preload = 'metadata'; } else el.alt = 'صورة المشهد';
  thumb.replaceChildren(el);
}

function sceneField(p, key, label, ltr) {
  const id = 'scene-' + p.id + '-' + key;
  const l = node('label', label);
  l.htmlFor = id;
  const t = node('textarea');
  t.id = id;
  t.dir = ltr ? 'ltr' : 'auto';
  t.value = p[key] || '';
  t.onchange = () => {
    p[key] = t.value.trim();
    const st = db.stories.find((x) => x.id === p.storyId);
    if (key === 'rawPrompt' && st) p.text = scenePrompt(st, p);
    p.updatedAt = new Date().toISOString();
    if (st) touchStory(st);
    save();
  };
  return [l, t];
}

let storyRenderToken = 0;
function renderScenes(st) {
  const token = ++storyRenderToken;
  const grid = $('storyscenesgrid');
  grid.replaceChildren();
  storyScenes(st).forEach((p, i) => {
    const card = node('div', null, 'scene');
    card.dataset.project = p.id;
    card.append(node('h3', 'المشهد ' + (i + 1)));
    const thumb = node('div', '…', 'thumb');
    thumb.dataset.asset = (latestOutput(p, 'video') || latestOutput(p, 'image'))?.assetId || '';
    card.append(thumb);
    const status = node('div', null, 'scenestatus');
    status.append(sceneStatus(p));
    card.append(status);
    card.append(...sceneField(p, 'narration', 'التعليق', false), ...sceneField(p, 'rawPrompt', 'برومبت الصورة', true), ...sceneField(p, 'motionPrompt', 'حركة الفيديو', true));
    const actions = node('div', null, 'actions');
    actions.append(
      button('صورة', () => runImages(st, [p])),
      button('فيديو', () => runVideos(st, [p])),
      button('فتح كمشروع', () => { go('create'); openProject(p); }),
      button('حذف المشهد', () => deleteScene(st, p)),
    );
    card.append(actions);
    grid.append(card);
    if (token === storyRenderToken) fillThumb(thumb, p);
  });
}

// Updates thumbnails and status badges without rebuilding text fields (keeps typing focus).
function refreshSceneCards() {
  const st = currentStory();
  if (!st || $('story').classList.contains('hidden')) return;
  const cards = [...$('storyscenesgrid').children];
  const scenes = storyScenes(st);
  if (cards.length !== scenes.length || cards.some((c, i) => c.dataset.project !== scenes[i].id)) return renderStoryPage();
  cards.forEach((card, i) => {
    const p = scenes[i];
    const key = (latestOutput(p, 'video') || latestOutput(p, 'image'))?.assetId || '';
    const thumb = card.querySelector('.thumb');
    if (thumb.dataset.asset !== key) { thumb.dataset.asset = key; fillThumb(thumb, p); }
    card.querySelector('.scenestatus').replaceChildren(sceneStatus(p));
  });
  renderStoryList();
}

async function renderStoryPage() {
  fillStoryCharacters();
  if (providerStatus?.media?.tts && !$('storyvoice').options.length) {
    providerStatus.media.tts.voices.forEach((v) => $('storyvoice').add(new Option(v[0].toUpperCase() + v.slice(1), v)));
    $('storyvoice').value = providerStatus.media.tts.voices.includes('coral') ? 'coral' : providerStatus.media.tts.voices[0];
  }
  renderStoryList();
  const st = currentStory();
  $('storyempty').classList.toggle('hidden', !!st);
  $('storyview').classList.toggle('hidden', !st);
  if (!st) { $('storyscenesgrid').replaceChildren(); return; }
  if (document.activeElement !== $('storytitle')) $('storytitle').value = st.title;
  const scenes = storyScenes(st);
  $('storymeta').textContent = st.brand + ' · ' + st.ratio + ' · ' + scenes.length + ' مشاهد · كتبها ' + (st.model || st.provider) + ' · ' + { en: 'English', ar: 'العربية', fr: 'Français' }[st.language];
  if (st.narration) {
    const entry = db.audio.find((a) => a.assetId === st.narration);
    const url = entry ? await assetUrl(entry.assetId) : null;
    $('storyaudiowrap').classList.toggle('hidden', !url);
    if (url && $('storyaudio').getAttribute('src') !== url) $('storyaudio').src = url;
  } else $('storyaudiowrap').classList.add('hidden');
  const editing = $('storyscenesgrid').contains(document.activeElement);
  if (!editing) renderScenes(st);
  updateStoryButtons();
}

function updateStoryButtons() {
  const media = !!providerStatus?.media?.image?.configured;
  ['storyimages', 'storyvideos', 'storynarration'].forEach((id) => ($(id).disabled = storyBusy || !media));
  $('storyzip').disabled = storyBusy;
  $('storyaddscene').disabled = storyBusy;
  $('storydelete').disabled = storyBusy;
  $('storystop').classList.toggle('hidden', !storyBusy);
}

$('storytitle').onchange = () => {
  const st = currentStory();
  if (!st) return;
  st.title = $('storytitle').value.trim() || st.title;
  storyScenes(st).forEach((p, i) => (p.title = st.title + ' — ' + (i + 1)));
  touchStory(st);
  save();
  renderStoryList();
};

$('storyaddscene').onclick = () => {
  const st = currentStory();
  if (!st) return;
  const p = newScene(st, st.sceneIds.length, { narration: '', imagePrompt: 'Describe the new scene here.', motionPrompt: 'Slow camera push-in.' });
  db.projects.push(p);
  st.sceneIds.push(p.id);
  touchStory(st);
  save();
  renderStoryPage();
};

async function deleteScene(st, p) {
  if (!confirm('حذف هذا المشهد ونتائجه؟')) return;
  st.sceneIds = st.sceneIds.filter((id) => id !== p.id);
  db.projects = db.projects.filter((x) => x.id !== p.id);
  storyScenes(st).forEach((x, i) => (x.sceneIndex = i));
  touchStory(st);
  save();
  for (const out of p.outputs) await forgetAsset(out.assetId);
  renderStoryPage();
}

$('storydelete').onclick = async () => {
  const st = currentStory();
  if (!st || !confirm('حذف القصة «' + st.title + '» وكل مشاهدها ونتائجها من هذا الجهاز ومن السحابة؟ (التعليق الصوتي يبقى في «ملفاتك الصوتية».)')) return;
  const scenes = storyScenes(st);
  db.projects = db.projects.filter((p) => p.storyId !== st.id);
  db.stories = db.stories.filter((x) => x.id !== st.id);
  currentStoryId = null;
  save();
  for (const p of scenes) for (const out of p.outputs) await forgetAsset(out.assetId);
  renderStoryPage();
};

// ---- Batch generation -------------------------------------------------------

function storyProgress(done, total, message) {
  $('storyprogress').classList.toggle('hidden', total < 1);
  $('storyprogress').max = Math.max(total, 1);
  $('storyprogress').value = done;
  if (message) $('storystatus').textContent = message;
}

async function withStoryBusy(fn) {
  storyBusy = true;
  storyStop = false;
  updateStoryButtons();
  try {
    await fn();
  } catch (e) {
    $('storystatus').textContent = e.message + ' ما تمّ يبقى محفوظًا، ولم تتم إعادة أي طلب تلقائيًا.';
  } finally {
    storyBusy = false;
    $('storyprogress').classList.add('hidden');
    updateStoryButtons();
    refreshSceneCards();
  }
}

async function runImages(st, only) {
  if (storyBusy) return;
  const targets = only || storyScenes(st).filter((p) => !latestOutput(p, 'image'));
  if (!targets.length) return toast('كل المشاهد عندها صورة. استعمل زر «صورة» في مشهد لإعادة توليده.');
  const quality = $('storyquality').value;
  const character = db.characters.find((c) => c.id === st.characterId);
  if (!confirmPaid(['• ' + targets.length + ' صورة بنموذج ' + providerStatus.media.image.model, '• المقاس ' + st.ratio + ' · الجودة ' + quality, character?.image ? '• تُرسل صورة ' + character.name + ' كمرجع مع كل صورة' : '• بدون صورة مرجعية (الوصف النصي فقط)'])) return;
  await withStoryBusy(async () => {
    let done = 0;
    for (const p of targets) {
      if (storyStop) throw Error('تم الإيقاف بعد ' + done + ' من ' + targets.length + ' صور.');
      storyProgress(done, targets.length, 'جارٍ توليد صورة المشهد ' + (p.sceneIndex + 1) + ' (' + (done + 1) + ' من ' + targets.length + ')…');
      p.quality = quality;
      p.ratio = st.ratio;
      p.text = scenePrompt(st, p);
      try {
        await requestImage(p);
      } catch (e) {
        throw Error('توقف عند المشهد ' + (p.sceneIndex + 1) + ': ' + e.message);
      }
      done++;
      refreshSceneCards();
    }
    storyProgress(done, targets.length, 'تم توليد ' + done + ' صورة. الخطوة التالية: «تحريك المشاهد».');
  });
}

async function assetBlob(id) {
  const record = await getAsset(id).catch(() => null);
  if (record) return record.blob;
  if (!db.sync.enabled) return null;
  const r = await fetch('/api/assets/' + encodeURIComponent(id));
  return r.ok ? r.blob() : null;
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(Error('تعذر قراءة الصورة'));
  r.readAsDataURL(blob);
});

async function runVideos(st, only) {
  if (storyBusy) return;
  const scenes = only || storyScenes(st);
  const targets = scenes.filter((p) => latestOutput(p, 'image') && (only || (!latestOutput(p, 'video') && !pendingVideo(p))));
  const missing = scenes.filter((p) => !latestOutput(p, 'image')).length;
  if (!targets.length) return toast(missing ? 'ولّد صور المشاهد أولًا: التحريك يبدأ من صورة كل مشهد.' : 'كل المشاهد متحركة أو قيد التوليد.');
  const seconds = $('storyseconds').value;
  if (!confirmPaid(['• ' + targets.length + ' فيديو بنموذج ' + providerStatus.media.video.model, '• ' + seconds + ' ثوانٍ لكل مشهد (المجموع ' + targets.length * Number(seconds) + ' ثانية) · ' + st.ratio, '• كل فيديو يبدأ من صورة مشهده', missing ? '• ' + missing + ' مشهد بدون صورة سيُتجاوز' : ''].filter(Boolean))) return;
  await withStoryBusy(async () => {
    let done = 0;
    for (const p of targets) {
      if (storyStop) throw Error('تم الإيقاف بعد إرسال ' + done + ' من ' + targets.length + ' فيديو.');
      storyProgress(done, targets.length, 'جارٍ إرسال فيديو المشهد ' + (p.sceneIndex + 1) + ' (' + (done + 1) + ' من ' + targets.length + ')…');
      const blob = await assetBlob(latestOutput(p, 'image').assetId);
      if (!blob) throw Error('صورة المشهد ' + (p.sceneIndex + 1) + ' غير متاحة في هذا الجهاز.');
      p.duration = seconds;
      p.ratio = st.ratio;
      const reference = await cropReference(await blobToDataUrl(blob), ...VIDEO_SIZES[st.ratio]);
      try {
        await startVideoJob(p, reference, sceneVideoPrompt(p));
      } catch (e) {
        throw Error('توقف عند المشهد ' + (p.sceneIndex + 1) + ': ' + e.message);
      }
      done++;
      refreshSceneCards();
    }
    storyProgress(done, targets.length, 'أُرسلت ' + done + ' مهمة فيديو. التوليد يستغرق بضع دقائق؛ كل فيديو يظهر في مشهده عند اكتماله ما دام الموقع مفتوحًا.');
  });
}

$('storyimages').onclick = () => { const st = currentStory(); if (st) runImages(st); };
$('storyvideos').onclick = () => { const st = currentStory(); if (st) runVideos(st); };
$('storystop').onclick = () => { storyStop = true; $('storystatus').textContent = 'سيتوقف بعد العنصر الحالي…'; };

$('storynarration').onclick = async () => {
  const st = currentStory();
  if (!st || storyBusy) return;
  const text = storyScenes(st).map((p) => (p.narration || '').trim()).filter(Boolean).join('\n\n');
  if (!text) return toast('لا يوجد نص تعليق في المشاهد.');
  if (text.length > LONG_TEXT_MAX_CHARS) return toast('نص التعليق أطول من ' + LONG_TEXT_MAX_CHARS + ' حرف.');
  const job = narrationJob({ text, voice: $('storyvoice').value, language: st.language, format: $('storyformat').value, rate: '1', style: null });
  if (!confirmPaid(narrationCostLines(job))) return;
  await withStoryBusy(async () => {
    const entry = await generateNarration(job, st.title + ' — narration', {
      onProgress: (done, total, message) => storyProgress(done, total, message),
      shouldStop: () => storyStop,
    });
    st.narration = entry.assetId;
    touchStory(st);
    save();
    $('storystatus').textContent = 'تم توليد التعليق الصوتي (' + Math.round(entry.size / 1024) + ' KB) وربطه بالقصة.';
    await renderStoryPage();
  });
};

// ---- ZIP package ------------------------------------------------------------

function storyScript(st, scenes) {
  const lines = [st.title, '', 'Idea: ' + st.idea, 'Brand: ' + st.brand + ' · Ratio: ' + st.ratio, ''];
  scenes.forEach((p, i) => {
    lines.push('--- Scene ' + (i + 1) + ' ---', p.narration || '', '', 'Image prompt: ' + (p.rawPrompt || ''), 'Motion: ' + (p.motionPrompt || ''), '');
  });
  return lines.join('\n');
}

$('storyzip').onclick = async () => {
  const st = currentStory();
  if (!st || storyBusy) return;
  await withStoryBusy(async () => {
    const scenes = storyScenes(st);
    const files = [
      { name: 'script.txt', data: storyScript(st, scenes) },
      { name: 'story.json', data: JSON.stringify({ title: st.title, idea: st.idea, brand: st.brand, ratio: st.ratio, language: st.language, scenes: scenes.map((p, i) => ({ scene: i + 1, narration: p.narration, imagePrompt: p.rawPrompt, motionPrompt: p.motionPrompt })) }, null, 2) },
    ];
    let missing = 0;
    const total = scenes.length + (st.narration ? 1 : 0);
    let done = 0;
    for (const [i, p] of scenes.entries()) {
      storyProgress(done, total, 'جارٍ تجميع ملفات المشهد ' + (i + 1) + '…');
      const n = String(i + 1).padStart(2, '0');
      for (const kind of ['image', 'video']) {
        const out = latestOutput(p, kind);
        if (!out) continue;
        const blob = await assetBlob(out.assetId);
        if (!blob) { missing++; continue; }
        files.push({ name: 'scene-' + n + '.' + extFor(out.mime), data: new Uint8Array(await blob.arrayBuffer()) });
      }
      done++;
    }
    if (st.narration) {
      const entry = db.audio.find((a) => a.assetId === st.narration);
      const blob = entry ? await assetBlob(entry.assetId) : null;
      if (blob) files.push({ name: 'narration.' + entry.format, data: new Uint8Array(await blob.arrayBuffer()) });
      else missing++;
    }
    storyProgress(total, total, 'جارٍ إنشاء ملف ZIP…');
    const zip = new Blob(zipChunks(files), { type: 'application/zip' });
    downloadBlob(zip, 'brahim-story-' + slug(st.title) + '.zip');
    $('storystatus').textContent = 'تم تحميل المشروع: ' + files.length + ' ملف (' + Math.round(zip.size / 1048576 * 10) / 10 + ' MB).' + (missing ? ' ' + missing + ' ملف غير متاح في هذا الجهاز ولم يُضمَّن.' : '');
  });
};

// ---- Wiring -----------------------------------------------------------------

onPage((page) => { if (page === 'story') renderStoryPage(); });
onStatus(() => { if (!$('story').classList.contains('hidden')) renderStoryPage(); else updateStoryButtons(); });
let storyRefreshTimer;
onSave(() => { clearTimeout(storyRefreshTimer); storyRefreshTimer = setTimeout(refreshSceneCards, 300); });
$('storybrand').onchange = () => { if ($('storybrand').value === 'Origins Drawn' && db.characters.some((c) => c.id === 'drew')) $('storycharacter').value = 'drew'; };

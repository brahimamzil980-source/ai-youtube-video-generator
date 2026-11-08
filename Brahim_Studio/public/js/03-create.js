// Scene workbench, image/video generation, video job polling, projects and characters.

const VIDEO_SIZES = { '9:16': [720, 1280], '16:9': [1280, 720] };
let currentProjectId = null;

function currentProject() {
  return db.projects.find((p) => p.id === currentProjectId) || null;
}

function syncModeControls() {
  const mode = $('mode').value;
  const video = mode !== 'image';
  $('durationwrap').classList.toggle('hidden', !video);
  $('qualitywrap').classList.toggle('hidden', video);
  [...$('ratio').options].forEach((o) => { if (o.value === '1:1') o.disabled = video; });
  if (video && $('ratio').value === '1:1') $('ratio').value = '9:16';
  $('generate').textContent = video ? 'توليد الفيديو ↗' : 'توليد الصورة ↗';
}
$('mode').onchange = syncModeControls;

function selectedCharacter() {
  return db.characters.find((c) => c.id === $('character').value) || null;
}

function buildPrompt({ rawPrompt, character, mode, ratio, duration }) {
  return [
    rawPrompt,
    character ? 'Character reference (' + character.name + '): ' + character.description : '',
    'Format: ' + ratio,
    'Type: ' + { image: 'single still image', i2v: 'video animated from the reference image', t2v: 'video from text' }[mode],
    mode !== 'image' ? 'Duration: ' + duration + ' seconds' : '',
    character || mode === 'i2v' ? 'Maintain the original character appearance and clothing exactly as in the reference image.' : '',
  ].filter(Boolean).join('\n\n');
}

// Saves the form as the current project (creating it if needed). Returns the project.
async function saveDraft() {
  const rawPrompt = $('prompt').value.trim();
  if (!rawPrompt) throw Error('اكتب وصف المشهد أولًا');
  const character = selectedCharacter();
  const mode = $('mode').value;
  const uploaded = await readImageFile($('reference').files[0]);
  const existing = currentProject();
  const fields = {
    title: rawPrompt.slice(0, 65),
    brand: $('brand').value,
    mode,
    ratio: $('ratio').value,
    duration: $('duration').value,
    quality: $('quality').value,
    characterId: character?.id || '',
    rawPrompt,
    text: buildPrompt({ rawPrompt, character, mode, ratio: $('ratio').value, duration: $('duration').value }),
    reference: uploaded || existing?.reference || '',
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    const previous = { ...existing };
    Object.assign(existing, fields);
    if (!save()) { Object.assign(existing, previous); throw Error('لم يتم الحفظ'); }
    $('reference').value = '';
    return existing;
  }
  const project = { id: crypto.randomUUID(), createdAt: fields.updatedAt, outputs: [], jobs: [], ...fields };
  db.projects.push(project);
  if (!save()) { db.projects.pop(); throw Error('لم يتم الحفظ'); }
  currentProjectId = project.id;
  $('reference').value = '';
  return project;
}

function openProject(p) {
  currentProjectId = p.id;
  $('mode').value = p.mode;
  $('brand').value = p.brand;
  $('character').value = db.characters.some((c) => c.id === p.characterId) ? p.characterId : '';
  $('prompt').value = p.rawPrompt || p.text;
  $('ratio').value = p.ratio;
  if (p.duration && [...$('duration').options].some((o) => o.value === p.duration)) $('duration').value = p.duration;
  if (p.quality) $('quality').value = p.quality;
  syncModeControls();
  showProject(p);
}

function resetProject() {
  currentProjectId = null;
  $('prompt').value = '';
  $('reference').value = '';
  $('genstatus').textContent = '';
  $('output').classList.add('hidden');
  $('outputs').replaceChildren();
  $('jobs').replaceChildren();
  $('preview').replaceChildren(node('div', '✧ مشروع جديد'));
  $('currentproject').textContent = 'مشروع جديد';
}

async function showProject(p) {
  $('currentproject').textContent = 'المشروع الحالي: ' + p.title;
  $('result').textContent = p.text;
  $('output').classList.remove('hidden');
  const latest = p.outputs[p.outputs.length - 1];
  $('preview').replaceChildren();
  if (latest) {
    const url = await assetUrl(latest.assetId);
    if (url) {
      const el = node(latest.kind === 'video' ? 'video' : 'img');
      el.src = url;
      if (latest.kind === 'video') { el.controls = true; el.playsInline = true; } else el.alt = 'آخر نتيجة';
      $('preview').append(el);
    }
  } else if (p.reference) {
    const i = node('img');
    i.src = p.reference;
    i.alt = 'الصورة المرجعية';
    $('preview').append(i);
  } else {
    $('preview').append(node('div', '✧ المشروع جاهز — لم يتم توليد وسائط بعد'));
  }
  renderJobs(p);
  renderGallery(p, $('outputs'));
}

function renderJobs(p) {
  $('jobs').replaceChildren();
  for (const job of p.jobs.filter((j) => j.status !== 'downloaded')) {
    const box = node('div', null, 'job');
    const label = { queued: 'في الانتظار لدى المزوّد', in_progress: 'جارٍ إنشاء الفيديو', completed: 'اكتمل — جارٍ التنزيل', failed: 'فشل التوليد لدى المزوّد', expired: 'انتهت صلاحية الملف لدى المزوّد', error: 'تعذر التنزيل' }[job.status] || job.status;
    box.append(node('div', '🎬 ' + label + (job.progress != null ? ' — ' + job.progress + '%' : '')));
    if (['queued', 'in_progress'].includes(job.status)) {
      const bar = node('progress');
      bar.max = 100;
      if (job.progress != null) bar.value = job.progress;
      box.append(bar);
    }
    box.append(node('small', job.id + ' · ' + job.seconds + 's · ' + job.size));
    if (job.message) box.append(node('div', job.message, 'error'));
    if (job.status === 'error') box.append(button('إعادة محاولة التنزيل', () => { job.status = 'completed'; save(); pollJobs(); }));
    if (['failed', 'expired', 'error'].includes(job.status)) box.append(button('إخفاء', () => { p.jobs = p.jobs.filter((j) => j !== job); save(); renderJobs(p); }));
    $('jobs').append(box);
  }
}

const galleryTokens = new WeakMap();
async function renderGallery(p, container) {
  const token = (galleryTokens.get(container) || 0) + 1;
  galleryTokens.set(container, token);
  const boxes = [];
  for (const out of p.outputs.slice().reverse()) {
    const url = await assetUrl(out.assetId);
    if (galleryTokens.get(container) !== token) return; // a newer render started
    const box = node('div', null, 'asset');
    if (url) {
      const el = node(out.kind === 'video' ? 'video' : 'img');
      el.src = url;
      if (out.kind === 'video') { el.controls = true; el.playsInline = true; el.preload = 'metadata'; } else el.alt = 'نتيجة مولّدة';
      box.append(el);
    } else box.append(node('small', 'الملف غير موجود في هذا المتصفح'));
    box.append(node('small', (out.kind === 'video' ? 'فيديو' : 'صورة') + ' · ' + (out.model || '') + ' · ' + new Date(out.createdAt).toLocaleString('ar')));
    box.append(button('تحميل', () => downloadAsset(out.assetId, 'brahim-' + out.kind + '-' + out.createdAt.slice(0, 19).replace(/[:T]/g, '-') + '.' + extFor(out.mime))));
    if (out.kind === 'image') box.append(button('استعمالها كمرجع للفيديو', () => useAsReference(p, out)));
    box.append(button('حذف', async () => {
      if (!confirm('حذف هذه النتيجة من المتصفح؟')) return;
      p.outputs = p.outputs.filter((o) => o !== out);
      save();
      await forgetAsset(out.assetId);
      if (p.id === currentProjectId) showProject(p);
      render();
    }));
    boxes.push(box);
  }
  container.replaceChildren(...boxes);
}

async function useAsReference(p, out) {
  try {
    const record = await getAsset(out.assetId);
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(record.blob);
    });
    // Keep localStorage small: store a 1280px JPEG.
    p.reference = await normalizeReference(dataUrl, 1280);
    if (!save()) return;
    go('create');
    openProject(p);
    $('mode').value = 'i2v';
    syncModeControls();
    toast('أصبحت الصورة مرجعًا للمشروع. اختر «فيديو من صورة» ثم «توليد».');
  } catch {
    toast('تعذر استعمال الصورة كمرجع');
  }
}

let generating = false;
function setGenerating(on, message = '') {
  generating = on;
  $('generate').disabled = on || !providerStatus?.media?.image?.configured;
  $('prepare').disabled = on;
  $('genstatus').textContent = message;
}

async function generateImage(p) {
  const status = providerStatus.media.image;
  const references = [];
  const character = db.characters.find((c) => c.id === p.characterId);
  if (character?.image) references.push(await normalizeReference(character.image));
  if (p.reference) references.push(await normalizeReference(p.reference));
  if (!confirmPaid(['• توليد صورة واحدة بنموذج ' + status.model, '• المقاس ' + p.ratio + ' · الجودة ' + p.quality, '• صور مرجعية مرسلة: ' + references.length])) return;
  setGenerating(true, 'جارٍ توليد الصورة… قد يستغرق ذلك حتى دقيقتين. لا تغلق الصفحة.');
  try {
    const data = await api('/api/image', { prompt: p.text, ratio: p.ratio, quality: p.quality, references });
    const blob = base64ToBlob(data.image, data.mime);
    const record = await putAsset(blob, { kind: 'image', projectId: p.id, model: data.model });
    p.outputs.push({ assetId: record.id, kind: 'image', mime: data.mime, model: data.model, createdAt: record.createdAt });
    save();
    setGenerating(false, 'تم توليد الصورة وحفظها في المشروع' + (data.usedReferences ? ' (باستعمال ' + data.usedReferences + ' مرجع).' : '.'));
    showProject(p);
  } catch (e) {
    setGenerating(false, e.message + ' لم تتم إعادة إرسال الطلب تلقائيًا.');
  }
}

async function generateVideo(p) {
  const status = providerStatus.media.video;
  if (!VIDEO_SIZES[p.ratio]) return toast('الفيديو يدعم 9:16 أو 16:9 فقط');
  let reference = null;
  if (p.mode === 'i2v') {
    const character = db.characters.find((c) => c.id === p.characterId);
    const source = p.reference || character?.image;
    if (!source) return toast('«فيديو من صورة» يحتاج صورة مرجعية للمشهد أو صورة للشخصية');
    reference = await cropReference(source, ...VIDEO_SIZES[p.ratio]);
  }
  if (!confirmPaid(['• فيديو واحد بنموذج ' + status.model, '• المدة ' + p.duration + ' ثوانٍ · المقاس ' + p.ratio, reference ? '• يبدأ من الصورة المرجعية (مقصوصة على المقاس)' : '• من الوصف فقط'])) return;
  setGenerating(true, 'جارٍ إرسال مهمة الفيديو…');
  try {
    const job = await api('/api/video', { prompt: p.text, ratio: p.ratio, seconds: p.duration, reference });
    p.jobs.push({ id: job.id, device: DEVICE_ID, status: job.status, progress: job.progress, seconds: p.duration, size: VIDEO_SIZES[p.ratio].join('x'), model: status.model, createdAt: new Date().toISOString() });
    save();
    setGenerating(false, 'تم إنشاء مهمة الفيديو. التوليد يستغرق عادة بضع دقائق؛ يمكنك متابعة العمل وستُحفظ النتيجة تلقائيًا ما دام الموقع مفتوحًا.');
    showProject(p);
    pollJobs();
  } catch (e) {
    setGenerating(false, e.message + ' لم تتم إعادة إرسال الطلب تلقائيًا.');
  }
}

$('generate').onclick = async () => {
  if (generating) return;
  if (!providerStatus?.media?.image?.configured) return toast('التوليد غير مفعّل: يلزم مفتاح OpenAI في الخادم');
  try {
    const p = await saveDraft();
    render();
    await showProject(p);
    if (p.mode === 'image') await generateImage(p);
    else await generateVideo(p);
  } catch (e) {
    setGenerating(false, '');
    toast(e.message);
  }
};

$('prepare').onclick = async () => {
  try {
    const p = await saveDraft();
    showProject(p);
    render();
    toast('تم حفظ المشروع وتحضير البرومبت');
  } catch (e) {
    toast(e.message);
  }
};

$('newproject').onclick = resetProject;

$('example').onclick = () => {
  $('prompt').value = 'Drew celebrates a pay raise in a busy office. His friends cheer around him, while a shopping advertisement catches his eye. Expressive reactions, detailed office props, layered composition, subtle camera push-in. No on-screen text.';
  $('character').value = 'drew';
};

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('result').textContent);
    toast('تم نسخ البرومبت');
  } catch {
    toast('تعذر النسخ. حدد النص وانسخه يدويًا');
  }
};

// --- Video job polling ------------------------------------------------------
// Job IDs are stored in the project, so polling resumes after a reload.

let pollTimer = null;
let polling = false;
async function pollJobs() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  let pending = false;
  try {
    for (const p of db.projects) {
      for (const job of p.jobs) {
        // Only the device that started a job polls and downloads it (avoids duplicate outputs).
        if (job.device && job.device !== DEVICE_ID) continue;
        if (['queued', 'in_progress'].includes(job.status)) {
          pending = true;
          try {
            const r = await fetch('/api/video/status?id=' + encodeURIComponent(job.id), { cache: 'no-store' });
            const data = await r.json();
            if (r.ok) {
              job.status = data.status;
              job.progress = data.progress;
              if (data.status === 'failed') job.message = 'رفض المزوّد أو فشل في إنشاء الفيديو. عدّل الوصف أو الصورة وجرّب من جديد.';
            } else if (r.status !== 504) {
              job.message = data.error;
            }
          } catch { /* network blip: try again next round */ }
        }
        if (job.status === 'completed') await downloadJob(p, job);
      }
    }
    save();
    const p = currentProject();
    if (p) renderJobs(p);
  } finally {
    polling = false;
  }
  if (pending) pollTimer = setTimeout(pollJobs, 10_000);
}

async function downloadJob(p, job) {
  try {
    const r = await fetch('/api/video/content?id=' + encodeURIComponent(job.id), { cache: 'no-store' });
    if (!r.ok) {
      let msg = 'تعذر تنزيل الفيديو.';
      try { msg = (await r.json()).error || msg; } catch {}
      job.status = r.status === 410 ? 'expired' : 'error';
      job.message = msg;
      return;
    }
    const blob = await r.blob();
    if (!blob.size) throw Error('empty');
    const record = await putAsset(new Blob([blob], { type: 'video/mp4' }), { kind: 'video', projectId: p.id, model: job.model, jobId: job.id });
    p.outputs.push({ assetId: record.id, kind: 'video', mime: 'video/mp4', model: job.model, createdAt: record.createdAt, jobId: job.id });
    job.status = 'downloaded';
    save();
    toast('اكتمل الفيديو وحُفظ في المشروع');
    if (p.id === currentProjectId) showProject(p);
    render();
  } catch {
    job.status = 'error';
    job.message = 'تعذر حفظ الفيديو في المتصفح (قد تكون المساحة ممتلئة).';
  }
}

// --- Characters --------------------------------------------------------------

$('addchar').onclick = async () => {
  if (!$('charname').value.trim() || !$('chardesc').value.trim()) return toast('أدخل الاسم والوصف');
  try {
    const c = { id: crypto.randomUUID(), name: $('charname').value.trim().slice(0, 80), description: $('chardesc').value.trim().slice(0, 2000), image: await readImageFile($('charfile').files[0]) };
    db.characters.push(c);
    if (!save()) { db.characters.pop(); return; }
    $('charname').value = '';
    $('chardesc').value = '';
    $('charfile').value = '';
    render();
    toast('تم حفظ الشخصية');
  } catch (e) {
    toast(e.message);
  }
};

onRender(() => {
  const selected = $('character').value;
  $('character').replaceChildren(new Option('بدون شخصية', ''));
  db.characters.forEach((c) => $('character').add(new Option(c.name + (c.image ? ' 🖼' : ''), c.id)));
  $('character').value = db.characters.some((c) => c.id === selected) ? selected : '';

  $('charcards').replaceChildren();
  db.characters.forEach((c) => {
    const card = node('div', null, 'card');
    if (c.image) {
      const i = node('img');
      i.src = c.image;
      i.alt = c.name;
      card.append(i);
    }
    card.append(node('h3', c.name), node('p', c.description), node('small', c.image ? 'تُرسل صورتها كمرجع عند التوليد' : 'بدون صورة مرجعية — الوصف النصي فقط'));
    card.append(button('حذف', () => {
      if (confirm('حذف الشخصية؟')) {
        db.characters = db.characters.filter((x) => x.id !== c.id);
        save();
        render();
      }
    }));
    $('charcards').append(card);
  });

  $('projectcards').replaceChildren();
  if (!db.projects.length) $('projectcards').append(node('p', 'لم تضف أي مشروع بعد. ابدأ بتحضير مشهد.'));
  db.projects.slice().reverse().forEach((p) => {
    const card = node('div', null, 'card');
    const thumbHolder = node('div');
    card.append(thumbHolder);
    const latest = p.outputs[p.outputs.length - 1];
    if (latest) {
      assetUrl(latest.assetId).then((url) => {
        if (!url) return;
        const el = node(latest.kind === 'video' ? 'video' : 'img');
        el.src = url;
        if (latest.kind === 'video') { el.muted = true; el.playsInline = true; el.preload = 'metadata'; } else el.alt = p.title;
        thumbHolder.append(el);
      });
    } else if (p.reference) {
      const i = node('img');
      i.src = p.reference;
      i.alt = 'مرجع المشهد';
      thumbHolder.append(i);
    }
    const pending = p.jobs.filter((j) => ['queued', 'in_progress', 'completed'].includes(j.status)).length;
    const state = p.outputs.length ? p.outputs.length + ' نتيجة مولّدة' : pending ? 'فيديو قيد التوليد' : 'محضّر — لم يتم التوليد';
    card.append(node('small', p.brand + ' · ' + MODE_LABELS[p.mode]), node('h3', p.title), node('p', p.ratio + ' · ' + state + (pending && p.outputs.length ? ' · فيديو قيد التوليد' : '')));
    card.append(button('فتح المشروع', () => { go('create'); openProject(p); }));
    card.append(button('حذف', async () => {
      if (!confirm('حذف المشروع ونتائجه من هذا المتصفح؟')) return;
      db.projects = db.projects.filter((x) => x.id !== p.id);
      save();
      for (const out of p.outputs) await forgetAsset(out.assetId);
      if (currentProjectId === p.id) resetProject();
      render();
    }));
    $('projectcards').append(card);
  });
});

onStatus((s) => {
  const ok = !!s?.media?.image?.configured;
  if (!generating) $('generate').disabled = !ok;
  $('genhint').textContent = ok
    ? 'التوليد عبر OpenAI (' + s.media.image.model + ' للصور، ' + s.media.video.model + ' للفيديو). كل عملية تطلب تأكيدك وتستهلك رصيد حسابك.'
    : s ? 'توليد الصور والفيديو غير مفعّل: يلزم ضبط OPENAI_API_KEY كسرّ في الخادم. يمكنك الحفظ والتحضير.' : 'تعذر التحقق من الاتصال بالخادم.';
});

syncModeControls();

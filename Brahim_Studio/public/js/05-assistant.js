// AI writing assistant (OpenAI / Claude through the server).

let aiBusy = false;
let aiAnswer = '';

function updateAIState() {
  const provider = providerStatus?.providers?.[$('aiprovider').value];
  $('aiconnection').textContent = provider
    ? provider.configured ? '● مهيّأ — ' + provider.model + ' (أول جواب ناجح يؤكد الصلاحية)' : '○ غير مفعّل — أضف المفتاح من «الاتصال والبيانات»'
    : 'تعذر التحقق من الاتصال. حاول التحديث.';
  $('aisend').disabled = aiBusy || !provider?.configured;
  $('airefresh').disabled = aiBusy;
}
onStatus(updateAIState);
$('aiprovider').onchange = updateAIState;
$('airefresh').onclick = refreshStatus;

$('aisend').onclick = async () => {
  if (aiBusy) return;
  const prompt = $('aiinput').value.trim();
  if (!prompt) return toast('اكتب طلبك أولًا');
  aiBusy = true;
  updateAIState();
  $('aistatus').textContent = 'جارٍ انتظار جواب المساعد…';
  $('aiprovider').disabled = true;
  try {
    const data = await api('/api/ai/generate', { provider: $('aiprovider').value, task: $('aitask').value, brand: $('aibrand').value, prompt });
    if (typeof data.text !== 'string' || !data.text.trim()) throw Error('لم يرجع المزوّد نصًا.');
    aiAnswer = data.text;
    $('aianswer').textContent = aiAnswer;
    ['aicopy', 'aitoscene', 'aitovoice'].forEach((id) => ($(id).disabled = false));
    $('aistatus').textContent = 'وصل الجواب من ' + data.provider + ' · ' + data.model + (data.truncated ? ' — الجواب قد يكون مختصرًا بسبب حد الطول.' : '');
  } catch (e) {
    $('aistatus').textContent = e.message + ' لم تتم إعادة إرسال الطلب تلقائيًا.';
  } finally {
    aiBusy = false;
    $('aiprovider').disabled = false;
    updateAIState();
  }
};

$('aicopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(aiAnswer);
    toast('تم النسخ');
  } catch {
    toast('حدد الجواب وانسخه يدويًا');
  }
};
$('aitoscene').onclick = () => { if (aiAnswer) { $('prompt').value = aiAnswer.slice(0, 6000); go('create'); toast('تم نقل الجواب لوصف المشهد'); } };
$('aitovoice').onclick = () => { if (aiAnswer) { $('voicetext').value = aiAnswer; countVoice(); go('voice'); toast('تم نقل الجواب إلى استوديو الصوت'); } };

let config = null;
let currentStream = null;
let templateImageEl = null;
let lastComposedDataUrl = null;
let lastOriginalPhotoPath = null;
let copies = 1;
let currentPrintJobId = null;
let pendingDslrCapture = false;
let liveActive = false;
let liveFails = 0;
let liveStarting = false;

const screens = {
  camera: document.getElementById('screen-camera'),
  preview: document.getElementById('screen-preview'),
  printing: document.getElementById('screen-printing')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name === 'camera') resumeDslrLive();
}

const video = document.getElementById('video');
const captureCanvas = document.getElementById('capture-canvas');
const previewCanvas = document.getElementById('preview-canvas');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownLabelText = document.getElementById('countdown-label-text');
const countdownNumber = document.getElementById('countdown-number');
const disconnectOverlay = document.getElementById('disconnect-overlay');
const dslrStatus = document.getElementById('dslr-status');
const dslrLive = document.getElementById('dslr-live');
const copiesCount = document.getElementById('copies-count');
const printingStatus = document.getElementById('printing-status');
const btnPrintRetry = document.getElementById('btn-print-retry');
const btnPrintDone = document.getElementById('btn-print-done');
const shareModal = document.getElementById('share-modal');
const shareQr = document.getElementById('share-qr');
const shareUrl = document.getElementById('share-url');
const errorToast = document.getElementById('error-toast');
const errorToastText = document.getElementById('error-toast-text');

function showErrorToast(message) {
  errorToastText.textContent = message;
  errorToast.classList.remove('hidden');
}
document.getElementById('error-toast-close').addEventListener('click', () => {
  errorToast.classList.add('hidden');
});

async function init() {
  config = await window.api.getConfig();
  copies = config.printer.copiesDefault || 1;
  copiesCount.textContent = copies;
  await loadTemplateImage();
  applyCameraModeUI();
  applyOperatorModeUI();
  if (config.camera.source === 'webcam') await startCamera();
  else startDslrLive();
}

window.api.onConfigUpdated(async (newConfig) => {
  config = newConfig;
  await loadTemplateImage();
  applyCameraModeUI();
  applyOperatorModeUI();
  if (config.camera.source === 'webcam') { stopDslrLive(); await startCamera(); }
  else { stopCamera(); startDslrLive(); }
});

window.api.onDslrPhotoCaptured(async (filePath) => {
  if (!pendingDslrCapture) return;
  pendingDslrCapture = false;
  countdownOverlay.classList.add('hidden');
  dslrStatus.textContent = 'Photo received';

  const dataUrl = await window.api.readPhotoAsDataUrl(filePath);
  if (!dataUrl) { showErrorToast('Could not read the photo from the camera.'); return; }
  const img = await loadImage(dataUrl);
  lastOriginalPhotoPath = filePath;
  composeAndShowPreview(img);
});

window.api.onPrintQueueUpdate((jobs) => {
  if (!currentPrintJobId) return;
  const job = jobs.find(j => j.id === currentPrintJobId);
  if (!job) return;
  renderPrintStatus(job);
});

function applyOperatorModeUI() {
  document.getElementById('btn-settings').classList.toggle('hidden', !!config.operatorMode);
}

let unlockTaps = [];
document.getElementById('operator-unlock-zone').addEventListener('click', () => {
  const now = Date.now();
  unlockTaps = unlockTaps.filter(t => now - t < 3000);
  unlockTaps.push(now);
  if (unlockTaps.length >= 5) { unlockTaps = []; window.api.openSettings(); }
});

function applyCameraModeUI() {
  const isDslr = config.camera.source === 'dslr';
  const liveOn = isDslr && dslrLiveEnabled();
  video.style.display = isDslr ? 'none' : 'block';
  dslrLive.classList.toggle('hidden', !liveOn);
  dslrStatus.classList.toggle('hidden', !isDslr);
  if (isDslr) dslrStatus.textContent = 'DSLR Mode — ready';
}

const DSLR_LIVE_URL = 'http://localhost:5513/liveview.jpg';

function dslrLiveEnabled() {
  return config && config.camera.source === 'dslr' && (config.dslr.engine || 'live') !== 'headless';
}

async function startDslrLive() {
  stopDslrLive();
  if (!dslrLiveEnabled()) return;
  if (liveStarting) return;
  liveStarting = true;
  dslrStatus.textContent = 'DSLR Mode — starting camera preview...';
  const res = await window.api.dslrLiveStart();
  liveStarting = false;
  if (!dslrLiveEnabled()) return;
  if (!res.ok) {
    dslrStatus.textContent = 'DSLR Mode — ready (no live preview)';
    showErrorToast(res.error || 'Live preview could not start.');
    return;
  }
  liveActive = true;
  liveFails = 0;
  pollDslrLive();
}

function stopDslrLive() {
  liveActive = false;
}

function resumeDslrLive() {
  if (!dslrLiveEnabled() || liveActive || liveStarting) return;
  liveActive = true;
  liveFails = 0;
  window.api.dslrLiveShow();
  pollDslrLive();
}

function pollDslrLive() {
  if (!liveActive) return;
  const probe = new Image();
  probe.onload = () => {
    if (!liveActive) return;
    dslrLive.src = probe.src;
    if (liveFails > 0 || dslrStatus.textContent.indexOf('starting') !== -1) dslrStatus.textContent = 'DSLR Mode — ready';
    liveFails = 0;
    setTimeout(pollDslrLive, 60);
  };
  probe.onerror = () => {
    if (!liveActive) return;
    liveFails += 1;
    if (liveFails % 20 === 0) window.api.dslrLiveShow();   // re-open live view if it dropped
    setTimeout(pollDslrLive, 300);
  };
  probe.src = DSLR_LIVE_URL + '?t=' + Date.now();
}

async function loadTemplateImage() {
  templateImageEl = null;
  if (!config.template.path) return;
  const dataUrl = await window.api.readTemplate(config.template.path);
  if (!dataUrl) return;
  templateImageEl = await loadImage(dataUrl);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function applyCssFilter() {
  const c = config.camera;
  video.style.filter = `brightness(${100 + (c.brightness || 0)}%) contrast(${100 + (c.contrast || 0)}%) saturate(${100 + (c.saturation || 0)}%)`;
}

async function startCamera() {
  stopCamera();
  disconnectOverlay.classList.add('hidden');
  const c = config.camera;
  const constraints = { audio: false, video: { width: { ideal: c.width || 1280 }, height: { ideal: c.height || 720 } } };
  if (c.deviceId) constraints.video.deviceId = { exact: c.deviceId };

  try {
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    applyCssFilter();

    const track = currentStream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => disconnectOverlay.classList.remove('hidden'));
    }
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      const advanced = {};
      if (caps.exposureCompensation && c.exposureCompensation != null) advanced.exposureCompensation = c.exposureCompensation;
      if (caps.whiteBalanceMode && c.whiteBalanceMode) advanced.whiteBalanceMode = c.whiteBalanceMode;
      if (caps.focusMode && c.focusMode) advanced.focusMode = c.focusMode;
      if (Object.keys(advanced).length) {
        try { await track.applyConstraints({ advanced: [advanced] }); } catch (e) {}
      }
    }
  } catch (err) {
    disconnectOverlay.classList.remove('hidden');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

document.getElementById('btn-reconnect').addEventListener('click', async () => {
  disconnectOverlay.classList.add('hidden');
  await startCamera();
});

function runCountdown(label) {
  return new Promise((resolve) => {
    countdownLabelText.textContent = label || 'GET READY!';
    let n = config.countdownSeconds || 5;
    countdownOverlay.classList.remove('hidden');
    countdownNumber.textContent = n;
    const interval = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(interval); resolve(); }
      else countdownNumber.textContent = n;
    }, 1000);
  });
}

function captureFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  const c = config.camera;
  ctx.filter = `brightness(${100 + (c.brightness || 0)}%) contrast(${100 + (c.contrast || 0)}%) saturate(${100 + (c.saturation || 0)}%)`;
  ctx.drawImage(video, 0, 0, w, h);
  return captureCanvas;
}

async function composeAndShowPreview(photoImageOrCanvas) {
  renderComposition(previewCanvas, photoImageOrCanvas, templateImageEl, config);
  lastComposedDataUrl = previewCanvas.toDataURL('image/jpeg', 0.92);
  showScreen('preview');
}

document.getElementById('btn-take').addEventListener('click', async () => {
  if (config.camera.source === 'dslr') {
    pendingDslrCapture = true;
    await runCountdown('GET READY!');
    countdownOverlay.classList.remove('hidden');
    countdownLabelText.textContent = 'Capturing...';
    countdownNumber.textContent = '';
    dslrStatus.textContent = 'Triggering camera...';

    stopDslrLive();
    const result = await window.api.triggerDslrCapture();
    countdownOverlay.classList.add('hidden');
    pendingDslrCapture = false;

    if (!result.success) {
      dslrStatus.textContent = 'DSLR Mode — ready';
      resumeDslrLive();
      showErrorToast(result.error || 'Could not capture from the camera.');
      return;
    }

    dslrStatus.textContent = 'Photo received';
    lastOriginalPhotoPath = result.filePath;
    const dataUrl = await window.api.readPhotoAsDataUrl(result.filePath);
    if (!dataUrl) { showErrorToast('Captured the photo but could not read it back.'); return; }
    const img = await loadImage(dataUrl);
    await composeAndShowPreview(img);
  } else {
    await runCountdown('GET READY!');
    countdownOverlay.classList.add('hidden');
    const photoCanvas = captureFrame();
    const rawDataUrl = photoCanvas.toDataURL('image/jpeg', 0.95);
    const saveResult = await window.api.saveOriginalPhoto(rawDataUrl);
    lastOriginalPhotoPath = saveResult.saved ? saveResult.path : null;
    if (!saveResult.saved) showErrorToast('Could not save the original photo, but you can still preview and print it.');
    await composeAndShowPreview(photoCanvas);
  }
});

document.getElementById('btn-minus').addEventListener('click', () => {
  copies = Math.max(1, copies - 1);
  copiesCount.textContent = copies;
});
document.getElementById('btn-plus').addEventListener('click', () => {
  const max = config.printer.maxCopies || 10;
  copies = Math.min(max, copies + 1);
  copiesCount.textContent = copies;
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  countdownOverlay.classList.add('hidden');
  pendingDslrCapture = false;
  showScreen('camera');
});

document.getElementById('btn-print').addEventListener('click', async () => {
  showScreen('printing');
  btnPrintRetry.classList.add('hidden');
  btnPrintDone.classList.add('hidden');
  printingStatus.textContent = 'Queued...';

  currentPrintJobId = await window.api.enqueuePrint({
    dataUrl: lastComposedDataUrl,
    widthMM: config.paper.widthMM,
    heightMM: config.paper.heightMM,
    copies,
    printerName: config.printer.name || undefined,
    sourcePhotoPath: lastOriginalPhotoPath,
    borderless: !!config.printer.borderless
  });
});

function renderPrintStatus(job) {
  if (job.status === 'queued') {
    printingStatus.textContent = `Queued (copies: ${job.copies})`;
  } else if (job.status === 'printing') {
    printingStatus.textContent = `Printing...\nCopies: ${job.copies}`;
  } else if (job.status === 'printed') {
    printingStatus.textContent = 'Print Complete';
    btnPrintDone.classList.remove('hidden');
  } else if (job.status === 'failed') {
    printingStatus.textContent = 'Print Failed\n' + (job.lastError || 'Unknown error') + '\n\nYour photo is safely saved either way.';
    btnPrintRetry.classList.remove('hidden');
    btnPrintDone.classList.remove('hidden');
  }
}

btnPrintRetry.addEventListener('click', async () => {
  if (currentPrintJobId) await window.api.retryPrint(currentPrintJobId);
  btnPrintRetry.classList.add('hidden');
  btnPrintDone.classList.add('hidden');
  printingStatus.textContent = 'Retrying...';
});

btnPrintDone.addEventListener('click', () => {
  currentPrintJobId = null;
  showScreen('camera');
});

document.getElementById('btn-share').addEventListener('click', async () => {
  if (!lastOriginalPhotoPath) { showErrorToast('No saved photo available to share yet.'); return; }
  const result = await window.api.sharePhoto(lastOriginalPhotoPath);
  shareQr.src = result.qrDataUrl;
  shareUrl.textContent = result.url;
  shareModal.classList.remove('hidden');
});
document.getElementById('btn-share-close').addEventListener('click', () => {
  shareModal.classList.add('hidden');
});

document.getElementById('btn-settings').addEventListener('click', () => {
  window.api.openSettings();
});

init();
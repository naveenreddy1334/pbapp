const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec, spawn } = require('child_process');
const http = require('http');
const { loadConfig, saveConfig, defaultConfig, BUILTIN_PAPERS } = require('./config-store');
const logger = require('./logger');
const printQueue = require('./print-queue');
const dslrWatcher = require('./dslr-watcher');
const dslrTrigger = require('./dslr-trigger');
const shareServer = require('./share-server');
const license = require('./license');

let mainWindow;
let settingsWindow;
let activationWindow;
const startupTimer = { appReady: null, windowShown: null };

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: String(err), stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

// Remove the default File/Edit/View/Window/Help menu bar app-wide —
// this is a commercial kiosk-style app, not a developer tool, and that
// bar had no useful items in it anyway.
Menu.setApplicationMenu(null);

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startupTimer.windowShown = Date.now();
    logger.info('startup complete', { ms: startupTimer.windowShown - startupTimer.appReady });
  });

  printQueue.on('update', (jobs) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-queue:update', jobs);
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createActivationWindow() {
  activationWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  activationWindow.loadFile('activation.html');
}

// ---------- digiCamControl bundling + lifecycle management ----------
// Bundled so end clients never install anything separately (see
// vendor/digicamcontrol/ and package.json's extraResources).
function getBundledDigiCamDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'digicamcontrol')
    : path.join(__dirname, 'vendor', 'digicamcontrol');
}

function resolveDigiCamPaths() {
  const bundledDir = getBundledDigiCamDir();
  const bundledRemoteCmd = path.join(bundledDir, 'CameraControlRemoteCmd.exe');
  const bundledMainExe = path.join(bundledDir, 'CameraControl.exe');
  const hasBundled = fs.existsSync(bundledRemoteCmd);
  return { bundledDir, bundledRemoteCmd, bundledMainExe, hasBundled };
}

let digiCamControlProcess = null;

// Checks Windows' own process list so we never spawn a second instance —
// doing so previously caused orphaned processes to pile up across app
// restarts, which slowed everything down and left zombies in Task Manager.
function isDigiCamControlAlreadyRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(false); return; }
    exec('tasklist /FI "IMAGENAME eq CameraControl.exe" /FO CSV /NH', (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout && stdout.toLowerCase().includes('cameracontrol.exe'));
    });
  });
}

// Best-effort: minimize digiCamControl's window shortly after launch so
// it never visually distracts an operator or client. This is cosmetic
// only — if it fails for any reason, the app still functions normally.
function minimizeDigiCamControlWindowSoon() {
  if (process.platform !== 'win32') return;
  setTimeout(() => {
    const psScript =
      '$sig=\'[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);\';' +
      'Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native;' +
      'Get-Process CameraControl -ErrorAction SilentlyContinue | ForEach-Object { [Native.Win32]::ShowWindowAsync($_.MainWindowHandle, 2) }';
    execFile('powershell.exe', ['-WindowStyle', 'Hidden', '-NoProfile', '-Command', psScript], { windowsHide: true }, (err) => {
      if (err) logger.warn('could not minimize digiCamControl window', { error: String(err) });
    });
  }, 2500); // give the app time to actually open its window first
}

// ---------------- digiCamControl (background engine) ----------------
// "live" engine (default): bundled digiCamControl runs in the background with
// its web server on, its windows are kept off-screen, and the booth screen shows
// its live view. "headless" engine (dslr.engine = "headless" in booth-config.json):
// CameraControlCmd.exe is used per photo and digiCamControl is never launched.
const DIGICAM_PORT = 5513;
let hiderProcess = null;

function getDslrEngine() {
  try { return (loadConfig().dslr.engine || 'live'); } catch (e) { return 'live'; }
}

function digiWebServerUp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: DIGICAM_PORT, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function digiSendCommand(cmdQuery) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: DIGICAM_PORT, path: '/?' + cmdQuery, timeout: 4000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Keeps every digiCamControl window pushed far off-screen (still "visible" to
// Windows, so live view keeps streaming) so nobody in front of the booth sees it.
const HIDER_PS = `
param([int]$ParentPid)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DcHide {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Run(uint[] pids) {
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(pids, p) >= 0 && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        if (r.L > -20000) { SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010); }
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  $ids = @()
  foreach ($p in (Get-Process -Name CameraControl -ErrorAction SilentlyContinue)) { $ids += [uint32]$p.Id }
  if ($ids.Count -gt 0) { [DcHide]::Run([uint32[]]$ids) }
  Start-Sleep -Milliseconds 200
}
`;

function startWindowHider() {
  if (process.platform !== 'win32') return;
  if (hiderProcess && !hiderProcess.killed) return;
  try {
    const ps1 = path.join(app.getPath('temp'), 'wcs-hide-digicam.ps1');
    fs.writeFileSync(ps1, HIDER_PS, 'utf-8');
    hiderProcess = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: 'ignore' });
    hiderProcess.on('error', (err) => logger.warn('window hider error', { error: String(err) }));
    hiderProcess.on('exit', () => { hiderProcess = null; });
    logger.info('digiCamControl window hider started');
  } catch (e) {
    logger.warn('could not start window hider', { error: String(e) });
  }
}

function stopWindowHider() {
  if (hiderProcess && !hiderProcess.killed) {
    try { hiderProcess.kill(); } catch (e) {}
  }
  hiderProcess = null;
}

async function ensureDigiCamControlRunning() {
  if (process.platform !== 'win32') return;
  if (getDslrEngine() === 'headless') return;
  const { bundledMainExe, hasBundled } = resolveDigiCamPaths();
  if (!hasBundled) return;

  startWindowHider();
  if (digiCamControlProcess && !digiCamControlProcess.killed) return;

  const alreadyRunning = await isDigiCamControlAlreadyRunning();
  if (alreadyRunning) {
    logger.info('digiCamControl already running, not launching another instance');
    return;
  }

  try {
    digiCamControlProcess = spawn(bundledMainExe, [], {
      cwd: path.dirname(bundledMainExe), detached: false, stdio: 'ignore', windowsHide: true
    });
    digiCamControlProcess.on('error', (err) => {
      logger.error('digiCamControl process error', { error: String(err) });
    });
    digiCamControlProcess.on('exit', () => { digiCamControlProcess = null; });
    logger.info('bundled digiCamControl launched', { bundledMainExe, pid: digiCamControlProcess.pid });
  } catch (e) {
    logger.error('failed to launch bundled digiCamControl', { error: String(e) });
  }
}

// Starts digiCamControl (if needed), waits for its web server, opens live view.
async function startDslrLive() {
  if (getDslrEngine() === 'headless') return { ok: false, error: 'Live view is off (headless engine).' };
  if (process.platform !== 'win32') return { ok: false, error: 'DSLR live view is Windows only.' };
  await ensureDigiCamControlRunning();

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {          // up to ~20 s
    up = await digiWebServerUp();
    if (!up) await new Promise(r => setTimeout(r, 500));
  }
  if (!up) {
    logger.warn('digiCamControl web server did not respond on port ' + DIGICAM_PORT);
    return { ok: false, error: 'Camera software is not ready. (One-time setup: run the app once with --digicam-setup and turn on "Use web server".)' };
  }
  await digiSendCommand('CMD=LiveViewWnd_Show');
  logger.info('digiCamControl live view requested');
  return { ok: true };
}

function killDigiCamControlIfOwned() {
  stopWindowHider();
  if (digiCamControlProcess && !digiCamControlProcess.killed) {
    try {
      digiCamControlProcess.kill();
      logger.info('digiCamControl process terminated on app quit');
    } catch (e) {
      logger.warn('could not terminate digiCamControl process', { error: String(e) });
    }
  }
}

async function startBackgroundServices(config) {
  if (config.camera.source === 'dslr') {
    await ensureDigiCamControlRunning();
  }
  if (config.camera.source === 'dslr' && config.dslr.watchFolder) {
    const result = dslrWatcher.start(config.dslr.watchFolder, (filePath) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dslr:photo-captured', filePath);
      }
    });
    if (!result.started) logger.warn('dslr watcher did not start', { error: result.error });
  }
  if (config.sharing.enabled) {
    await shareServer.start(config.sharing.port);
  }
}

app.whenReady().then(async () => {
  // One-time setup helper: `WebcamSnap.exe --digicam-setup` opens the bundled
  // digiCamControl visibly so "Use web server" / "Start minimized" can be ticked.
  if (process.argv.includes('--digicam-setup')) {
    const { bundledMainExe, hasBundled } = resolveDigiCamPaths();
    if (hasBundled) {
      const p = spawn(bundledMainExe, [], { cwd: path.dirname(bundledMainExe), detached: false, stdio: 'ignore' });
      p.on('exit', () => app.quit());
    } else {
      dialog.showErrorBox('Setup', 'Bundled digiCamControl was not found.');
      app.quit();
    }
    return;
  }
  startupTimer.appReady = Date.now();
  logger.init(app.getPath('userData'));
  logger.info('app ready', { ms_since_process_start: Math.round(process.uptime() * 1000) });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const licenseCheckStart = Date.now();
  const licenseStatus = await license.getStatus();
  logger.info('license check complete', { ms: Date.now() - licenseCheckStart });

  if (!licenseStatus.activated || !licenseStatus.valid) {
    createActivationWindow();
    return;
  }

  createMainWindow();
  const config = loadConfig();
  startBackgroundServices(config);
});

app.on('window-all-closed', () => {
  dslrWatcher.stop();
  shareServer.stop();
  killDigiCamControlIfOwned();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killDigiCamControlIfOwned();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// ---------- Licensing ----------
ipcMain.handle('license:activate', async (event, { licenseKey, email }) => {
  const result = await license.activate({ licenseKey, email });
  if (result.success) {
    if (activationWindow) { activationWindow.close(); activationWindow = null; }
    createMainWindow();
    const config = loadConfig();
    startBackgroundServices(config);
  }
  return result;
});

ipcMain.handle('license:status', () => license.getStatus());
ipcMain.handle('license:deviceId', () => license.getDeviceId());

// ---------- Settings window ----------
ipcMain.handle('open-settings', () => createSettingsWindow());

// ---------- Config ----------
ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (event, partialConfig) => {
  const current = loadConfig();
  let merged = {
    ...current,
    ...partialConfig,
    camera: { ...current.camera, ...(partialConfig.camera || {}) },
    dslr: { ...current.dslr, ...(partialConfig.dslr || {}) },
    sharing: { ...current.sharing, ...(partialConfig.sharing || {}) },
    paper: { ...current.paper, ...(partialConfig.paper || {}) },
    layout: { ...current.layout, ...(partialConfig.layout || {}) },
    template: { ...current.template, ...(partialConfig.template || {}) },
    printer: { ...current.printer, ...(partialConfig.printer || {}) }
  };

  if (partialConfig.camera && 'source' in partialConfig.camera) {
    // Auto-default the watch folder so switching to DSLR mode "just works"
    // without requiring a manual folder pick first.
    if (merged.camera.source === 'dslr' && !merged.dslr.watchFolder) {
      merged.dslr.watchFolder = path.join(app.getPath('pictures'), 'PhotoBooth', 'DSLR-Captures');
    }
    saveConfig(merged);
    dslrWatcher.stop();
    if (merged.camera.source === 'dslr') {
      ensureDigiCamControlRunning();
      if (merged.dslr.watchFolder) {
        dslrWatcher.start(merged.dslr.watchFolder, (filePath) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dslr:photo-captured', filePath);
        });
      }
    }
  } else {
    saveConfig(merged);
  }

  if (partialConfig.dslr && merged.camera.source === 'dslr') {
    dslrWatcher.stop();
    dslrWatcher.start(merged.dslr.watchFolder, (filePath) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dslr:photo-captured', filePath);
    });
  }
  if (partialConfig.sharing && 'enabled' in partialConfig.sharing) {
    if (merged.sharing.enabled) shareServer.start(merged.sharing.port);
    else shareServer.stop();
  }

  if (mainWindow) mainWindow.webContents.send('config:updated', merged);
  return merged;
});

ipcMain.handle('config:papers', () => BUILTIN_PAPERS);

ipcMain.handle('config:reset', () => {
  const def = defaultConfig();
  saveConfig(def);
  if (mainWindow) mainWindow.webContents.send('config:updated', def);
  return def;
});

// ---------- DSLR live view ----------
ipcMain.handle('dslr:live-start', async () => startDslrLive());
ipcMain.handle('dslr:live-show', async () => {
  if (getDslrEngine() === 'headless') return false;
  return digiSendCommand('CMD=LiveViewWnd_Show');
});

// ---------- DSLR active shutter trigger ----------
ipcMain.handle('dslr:trigger-capture', async () => {
  const config = loadConfig();
  await ensureDigiCamControlRunning();
  const { bundledRemoteCmd, hasBundled } = resolveDigiCamPaths();
  const remoteCmdPath = config.dslr.remoteCmdPath || (hasBundled ? bundledRemoteCmd : '');
  const result = await dslrTrigger.triggerCapture({
    remoteCmdPath,
    outputFolder: config.dslr.watchFolder,
    engine: config.dslr.engine || 'live',
    fallbackRoots: [path.join(app.getPath('pictures'), 'digiCamControl')]
  });
  if (result.success) dslrWatcher.markSeen(path.basename(result.filePath));
  return result;
});

ipcMain.handle('dslr:bundled-status', () => {
  const { hasBundled, bundledRemoteCmd } = resolveDigiCamPaths();
  return { hasBundled, bundledRemoteCmd: hasBundled ? bundledRemoteCmd : null };
});

ipcMain.handle('dslr:choose-remote-cmd', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow || mainWindow, {
    title: 'Choose CameraControlRemoteCmd.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('dslr:choose-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow || mainWindow, {
    title: 'Choose DSLR Capture Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// ---------- Presets ----------
ipcMain.handle('presets:save', (event, name) => {
  const current = loadConfig();
  const snapshot = { ...current };
  delete snapshot.presets;
  delete snapshot.activePreset;
  current.presets[name] = snapshot;
  current.activePreset = name;
  saveConfig(current);
  return current;
});

ipcMain.handle('presets:load', (event, name) => {
  const current = loadConfig();
  const preset = current.presets[name];
  if (!preset) return current;
  const merged = { ...current, ...preset, activePreset: name };
  saveConfig(merged);
  if (mainWindow) mainWindow.webContents.send('config:updated', merged);
  return merged;
});

ipcMain.handle('presets:delete', (event, name) => {
  const current = loadConfig();
  delete current.presets[name];
  if (current.activePreset === name) current.activePreset = '';
  saveConfig(current);
  return current;
});

// ---------- Events ----------
ipcMain.handle('events:save', (event, { name, date, client, presetName }) => {
  const current = loadConfig();
  current.events[name] = { date, client, presetName };
  saveConfig(current);
  return current;
});

ipcMain.handle('events:delete', (event, name) => {
  const current = loadConfig();
  delete current.events[name];
  if (current.activeEvent === name) current.activeEvent = '';
  saveConfig(current);
  return current;
});

ipcMain.handle('events:start', (event, name) => {
  const current = loadConfig();
  const evt = current.events[name];
  if (!evt) return current;
  let merged = { ...current, activeEvent: name, operatorMode: true };
  if (evt.presetName && current.presets[evt.presetName]) {
    merged = { ...merged, ...current.presets[evt.presetName], activeEvent: name, operatorMode: true, events: current.events };
  }
  saveConfig(merged);
  logger.info('event started', { name, preset: evt.presetName });
  if (mainWindow) mainWindow.webContents.send('config:updated', merged);
  if (settingsWindow) settingsWindow.close();
  return merged;
});

ipcMain.handle('events:end', () => {
  const current = loadConfig();
  const merged = { ...current, activeEvent: '', operatorMode: false };
  saveConfig(merged);
  logger.info('event ended');
  if (mainWindow) mainWindow.webContents.send('config:updated', merged);
  return merged;
});

// ---------- Startup timing ----------
ipcMain.handle('diagnostics:startup-time', () => {
  if (!startupTimer.appReady || !startupTimer.windowShown) return null;
  return startupTimer.windowShown - startupTimer.appReady;
});

// ---------- Template upload ----------
ipcMain.handle('template:choose', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow || mainWindow, {
    title: 'Choose Template Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;

  const destDir = path.join(app.getPath('userData'), 'templates');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(filePaths[0]));
  fs.copyFileSync(filePaths[0], destPath);
  return destPath;
});

ipcMain.handle('template:read', (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1) || 'png';
    return `data:image/${ext};base64,${data.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

// ---------- Printers ----------
ipcMain.handle('printers:list', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
});

// ---------- Photo storage ----------
function photosDir() {
  const dir = path.join(app.getPath('pictures'), 'PhotoBooth');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampedFilename(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${stamp}_${rand}.${ext}`;
}

ipcMain.handle('photo:save-original', (event, dataUrl) => {
  try {
    const dir = photosDir();
    const filename = timestampedFilename('jpg');
    const filePath = path.join(dir, filename);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, base64, 'base64');
    fs.renameSync(tmpPath, filePath);
    logger.info('original photo saved', { filePath });
    return { saved: true, path: filePath };
  } catch (e) {
    logger.error('failed to save original photo', { error: String(e) });
    return { saved: false, error: String(e) };
  }
});

ipcMain.handle('save-photo', async (event, dataUrl) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Photo',
    defaultPath: path.join(app.getPath('pictures'), `snap-${Date.now()}.png`),
    filters: [{ name: 'PNG Images', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { saved: false };
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, base64Data, 'base64');
  return { saved: true, path: filePath };
});

ipcMain.handle('photo:read-as-dataurl', (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'jpg';
    const mime = ext === 'png' ? 'png' : 'jpeg';
    return `data:image/${mime};base64,${data.toString('base64')}`;
  } catch (e) {
    logger.error('failed to read dslr photo', { filePath, error: String(e) });
    return null;
  }
});

// ---------- Print queue ----------
ipcMain.handle('print:enqueue', (event, { dataUrl, widthMM, heightMM, copies, printerName, sourcePhotoPath, borderless }) => {
  return printQueue.enqueue({ dataUrl, widthMM, heightMM, copies, printerName, sourcePhotoPath, borderless });
});

ipcMain.handle('print:retry', (event, jobId) => printQueue.retry(jobId));
ipcMain.handle('print:snapshot', () => printQueue.snapshot());

// ---------- WiFi sharing ----------
ipcMain.handle('share:photo', async (event, filePath) => {
  const config = loadConfig();
  if (!shareServer.server) await shareServer.start(config.sharing.port);
  return shareServer.share(filePath, config.sharing.expiryMinutes);
});

ipcMain.handle('share:status', () => ({
  running: !!shareServer.server,
  port: shareServer.port,
  ip: shareServer.getLocalIp()
}));

// ---------- Diagnostics ----------
ipcMain.handle('diagnostics:open-log-folder', () => {
  const dir = logger.getLogDir();
  if (dir) shell.openPath(dir);
  return dir;
});

ipcMain.handle('diagnostics:system-info', () => ({
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  appVersion: app.getVersion()
}));
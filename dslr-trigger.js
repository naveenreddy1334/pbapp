const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function timestampedFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `dslr_${stamp}_${rand}.jpg`;
}

function waitForStableFile(filePath, { timeoutMs = 10000, pollMs = 300 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastSize = -1;
    let stableReadings = 0;

    const check = () => {
      if (Date.now() - start > timeoutMs) {
        resolve({ success: false, error: 'Timed out waiting for the camera to save the photo.' });
        return;
      }
      fs.stat(filePath, (err, stats) => {
        if (err) {
          setTimeout(check, pollMs);
          return;
        }
        if (stats.size > 0 && stats.size === lastSize) {
          stableReadings += 1;
          if (stableReadings >= 2) {
            resolve({ success: true, filePath });
            return;
          }
        } else {
          stableReadings = 0;
        }
        lastSize = stats.size;
        setTimeout(check, pollMs);
      });
    };
    check();
  });
}

let capturing = false;

function httpGet(pathAndQuery, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 5513, path: pathAndQuery, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function runExe(exe, args, timeout) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, cwd: path.dirname(exe) }, (err, stdout, stderr) => {
      logger.info('dslr trigger: tool finished', {
        exe: path.basename(exe),
        err: err ? String(err.message || err) : null,
        out: (String(stdout || '') + ' ' + String(stderr || '')).trim().slice(0, 400)
      });
      resolve(!err);
    });
  });
}

function newestJpegSince(roots, sinceMs) {
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.jpe?g$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(full); } catch (x) { continue; }
      if (st.mtimeMs >= sinceMs && (!best || st.mtimeMs > best.m)) best = { p: full, m: st.mtimeMs };
    }
  };
  roots.forEach(r => walk(r, 0));
  return best ? best.p : null;
}

async function liveCapture(remoteCmdPath, fullPath, fallbackRoots) {
  const started = Date.now() - 1000;

  // 1) remote command into our folder, retried a few times
  for (let i = 0; i < 3; i++) {
    await runExe(remoteCmdPath, ['/c', 'capture', fullPath], 20000);
    const r = await waitForStableFile(fullPath, { timeoutMs: 8000 });
    if (r.success) return r;
    await new Promise(res => setTimeout(res, 1500));
  }

  // 2) web-server capture, then pick up the newest JPEG digiCamControl wrote
  logger.warn('dslr trigger: remote cmd failed, trying web capture');
  const sent = await httpGet('/?CMD=Capture', 6000);
  if (sent) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 700));
      const found = newestJpegSince(fallbackRoots || [], started);
      if (found) {
        const stable = await waitForStableFile(found, { timeoutMs: 8000 });
        if (stable.success) {
          try { fs.copyFileSync(found, fullPath); return { success: true, filePath: fullPath }; }
          catch (e) { return { success: true, filePath: found }; }
        }
      }
    }
  }
  return { success: false };
}

function triggerCapture({ remoteCmdPath, outputFolder, engine, fallbackRoots }) {
  return new Promise((resolve) => {
    if (capturing) {
      resolve({ success: false, error: 'A photo is already being taken. Please wait.' });
      return;
    }
    if (!outputFolder) {
      resolve({ success: false, error: 'DSLR output folder is not configured in Settings.' });
      return;
    }
    try {
      fs.mkdirSync(outputFolder, { recursive: true });
    } catch (e) {
      resolve({ success: false, error: 'Could not create output folder: ' + String(e) });
      return;
    }

    const failMsg = 'Could not take the photo. Make sure the camera is on, in photo mode and connected by USB, then try again.';
    const fullPath = path.join(outputFolder, timestampedFilename());
    const useLive = (engine || 'live') !== 'headless';
    logger.info('dslr trigger: capturing', { fullPath, engine: useLive ? 'live' : 'headless' });

    capturing = true;
    const finish = (result) => {
      capturing = false;
      if (result && result.success) {
        logger.info('dslr trigger: capture complete', { filePath: result.filePath });
        resolve({ success: true, filePath: result.filePath });
      } else {
        logger.warn('dslr trigger: capture did not complete');
        resolve({ success: false, error: failMsg });
      }
    };

    if (useLive) {
      if (!remoteCmdPath) { capturing = false; resolve({ success: false, error: 'Camera software path is not configured.' }); return; }
      liveCapture(remoteCmdPath, fullPath, fallbackRoots).then(finish);
      return;
    }

    // headless: CameraControlCmd.exe talks to the camera directly, no window.
    const cmdExe = remoteCmdPath ? path.join(path.dirname(remoteCmdPath), 'CameraControlCmd.exe') : '';
    if (!cmdExe || !fs.existsSync(cmdExe)) {
      capturing = false;
      resolve({ success: false, error: 'Camera software is missing from this build.' });
      return;
    }
    runExe(cmdExe, ['/filename', fullPath, '/capture'], 30000).then((ok) => {
      waitForStableFile(fullPath, { timeoutMs: ok ? 25000 : 4000 }).then(finish);
    });
  });
}

module.exports = { triggerCapture };
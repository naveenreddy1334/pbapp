const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const logger = require('./logger');
const { verifyLicense, cleanKey } = require('./license-core');

const LICENSE_FILE = () => path.join(app.getPath('userData'), 'license.dat');
const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function getDeviceId() {
  const idFile = path.join(app.getPath('userData'), 'device-id');
  try {
    return fs.readFileSync(idFile, 'utf-8').trim();
  } catch (e) {
    const id = crypto.randomUUID();
    fs.writeFileSync(idFile, id, 'utf-8');
    return id;
  }
}

function loadPublicKey() {
  try {
    return fs.readFileSync(path.join(__dirname, 'license-public.pem'), 'utf-8');
  } catch (e) {
    logger.error('license-public.pem missing — licensing is not configured in this build');
    return null;
  }
}

function saveLicenseData(data) {
  const json = JSON.stringify(data);
  const payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf-8');
  fs.writeFileSync(LICENSE_FILE(), payload);
}

function loadLicenseData() {
  try {
    const payload = fs.readFileSync(LICENSE_FILE());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(payload) : payload.toString('utf-8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

async function activate({ licenseKey, email }) {
  const publicKey = loadPublicKey();
  if (!publicKey) return { success: false, reason: 'Licensing is not configured in this build.' };

  const deviceId = getDeviceId();
  const key = cleanKey(licenseKey);
  const result = verifyLicense(key, publicKey, deviceId);
  if (!result.ok) {
    logger.warn('license activation rejected', { reason: result.reason });
    return { success: false, reason: result.reason };
  }

  const now = new Date().toISOString();
  saveLicenseData({
    licenseKey: key, email, deviceId,
    customer: result.payload.customer || null,
    expiresAt: result.payload.exp || null,
    activatedAt: now, lastSeenAt: now
  });
  logger.info('license activated', { deviceId, customer: result.payload.customer || null, expires: result.payload.exp || 'never' });
  return { success: true };
}

// Fully offline check, run on every launch.
async function getStatus() {
  const data = loadLicenseData();
  if (!data) return { activated: false };

  const publicKey = loadPublicKey();
  if (!publicKey) return { activated: true, valid: false, reason: 'Licensing is not configured in this build.' };

  const deviceId = getDeviceId();
  const now = new Date();

  // Clock rollback guard: refuse if the clock was set back to dodge an expiry date.
  const lastSeen = data.lastSeenAt ? new Date(data.lastSeenAt).getTime() : 0;
  if (now.getTime() < lastSeen - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return { activated: true, valid: false, reason: 'The computer clock looks incorrect. Please fix the date and time.' };
  }

  const result = verifyLicense(data.licenseKey, publicKey, deviceId, now);
  if (!result.ok) return { activated: true, valid: false, reason: result.reason };

  data.lastSeenAt = new Date(Math.max(now.getTime(), lastSeen)).toISOString();
  try { saveLicenseData(data); } catch (e) {}
  return {
    activated: true, valid: true, offline: false,
    customer: data.customer || null, expiresAt: data.expiresAt || null
  };
}

function deactivateLocal() {
  try { fs.unlinkSync(LICENSE_FILE()); } catch (e) {}
}

module.exports = { activate, getStatus, getDeviceId, deactivateLocal };

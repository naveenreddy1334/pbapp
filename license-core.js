// Offline license keys: Ed25519-signed, optionally locked to one laptop's Device ID.
// Key format:  PB1.<base64url JSON payload>.<base64url signature>
const crypto = require('crypto');

const PREFIX = 'PB1';

function cleanKey(key) {
  return String(key || '').replace(/\s+/g, '');
}

function signLicense(payload, privateKeyPem) {
  const body = PREFIX + '.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), crypto.createPrivateKey(privateKeyPem));
  return body + '.' + sig.toString('base64url');
}

// Returns { ok:true, payload } or { ok:false, reason }
function verifyLicense(key, publicKeyPem, deviceId, now) {
  now = now || new Date();
  const parts = cleanKey(key).split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'Invalid license key.' };

  let payload;
  try {
    const pub = crypto.createPublicKey(publicKeyPem);
    const valid = crypto.verify(
      null,
      Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
      pub,
      Buffer.from(parts[2], 'base64url')
    );
    if (!valid) return { ok: false, reason: 'Invalid license key.' };
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'Invalid license key.' };
  }

  if (!payload || payload.v !== 1) return { ok: false, reason: 'Unsupported license version.' };
  if (payload.device && payload.device !== '*' && payload.device !== deviceId) {
    return { ok: false, reason: 'This license key is for a different computer.' };
  }
  if (payload.exp) {
    const exp = new Date(payload.exp);
    if (isNaN(exp.getTime()) || now > exp) return { ok: false, reason: 'This license has expired.' };
  }
  return { ok: true, payload };
}

module.exports = { signLicense, verifyLicense, cleanKey, PREFIX };

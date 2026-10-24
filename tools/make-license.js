// Usage:
//   node tools/make-license.js --customer "Client Name" --device <DEVICE-ID> --days 365
//   node tools/make-license.js --customer "Demo" --device "*" --days 7      (works on any laptop)
//   omit --days for a license that never expires
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { signLicense } = require('../license-core');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const privPath = process.env.LICENSE_PRIVATE_KEY_FILE || path.join(__dirname, '..', 'license-private.pem');
if (!fs.existsSync(privPath)) {
  console.error('license-private.pem not found. Run: node tools/make-license-keypair.js');
  process.exit(1);
}

const customer = arg('customer', '');
const device = arg('device', '');
const days = arg('days', '');
if (!customer || !device) {
  console.error('Required: --customer "Name" --device <DEVICE-ID or *>   (optional: --days 365)');
  process.exit(1);
}

const now = new Date();
const payload = {
  v: 1,
  id: crypto.randomBytes(4).toString('hex'),
  customer,
  device,
  iat: now.toISOString(),
  exp: days ? new Date(now.getTime() + Number(days) * 86400000).toISOString() : null
};

const key = signLicense(payload, fs.readFileSync(privPath, 'utf-8'));
console.log('\nCustomer : ' + customer);
console.log('Device   : ' + (device === '*' ? 'any computer' : device));
console.log('Expires  : ' + (payload.exp || 'never'));
console.log('\nLICENSE KEY (send this to the customer):\n\n' + key + '\n');

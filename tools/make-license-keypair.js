// Run ONCE on your own computer:   node tools/make-license-keypair.js
// Creates license-private.pem (KEEP SECRET, back it up, never commit/send it)
// and license-public.pem (goes into the app; safe to commit).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const privPath = path.join(root, 'license-private.pem');
const pubPath = path.join(root, 'license-public.pem');

if (fs.existsSync(privPath) && !process.argv.includes('--force')) {
  console.error('license-private.pem already exists. Refusing to overwrite (all keys you issued would stop working).');
  console.error('Use --force only if you really want a brand-new key pair.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Created:\n  ' + privPath + '   <- SECRET: back this up somewhere safe, never share it\n  ' + pubPath + '    <- goes into the app\n');
console.log('Now rebuild the app so it includes license-public.pem.');

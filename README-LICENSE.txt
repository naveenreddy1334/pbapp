REAL LICENSING - SETUP (do this once, on YOUR laptop)
=====================================================

1. Copy these files into the retrophotobooth folder (replace when asked):
     license.js, license-core.js, activation.html, package.json, .gitignore
   and the folder:  tools\

2. Create your key pair (ONCE):
     node tools/make-license-keypair.js
   This creates:
     license-private.pem  -> SECRET. Back it up (USB / password manager). Never send it,
                             never commit it (.gitignore already blocks it).
                             If you lose it you cannot issue new keys.
     license-public.pem   -> goes inside the app. Safe to commit to Git.

3. Build:
     npm install
     npm run build:win

4. Issue a key for a customer:
   a) Open the built app on THEIR laptop. The activation screen shows "Device ID: ...".
      They send you that ID.
   b) On your laptop:
        node tools/make-license.js --customer "Client Name" --device THEIR-DEVICE-ID --days 365
      (leave out --days for a key that never expires)
   c) Send them the long key that starts with PB1. They paste it in the app.

   Demo key that works on any laptop for a week:
        node tools/make-license.js --customer "Demo" --device "*" --days 7

Notes
- Old test keys like ABCD-1234-ABCD-1234 no longer work.
- Keys are checked offline on every launch (no server, no internet needed).
- A key locked to a Device ID will not work on another computer.
- The app refuses to run if someone sets the clock back to dodge an expiry date.
- Limits: this stops casual sharing. It cannot revoke a key remotely, and a determined
  person could edit the app files. Remote revoke needs a license server.

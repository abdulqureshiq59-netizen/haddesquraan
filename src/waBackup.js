// Backs up the WhatsApp login session (Baileys auth folder) to the Google Sheet,
// and restores it on boot when the server disk was wiped - so no re-scan after restarts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sheets = require('./sheets');
const { log, sleep, encode, decode } = require('./util');
const { DATA_DIR } = require('./store');

const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const info = { lastBackupAt: null, restored: null };
let lastHash = null;
let timer = null;

// Only these are needed to come back without a new QR scan. The per-chat "session-*.json" files
// are re-created by WhatsApp on their own - and in a big community there can be thousands of them,
// which made every backup huge and slow.
const KEEP = /^(creds\.json|app-state-sync-key-.*\.json|app-state-sync-version-.*\.json)$/;

function snapshot() {
  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return null;
  const files = {};
  for (const name of fs.readdirSync(AUTH_DIR)) {
    if (!KEEP.test(name)) continue;
    const p = path.join(AUTH_DIR, name);
    if (fs.statSync(p).isFile()) files[name] = fs.readFileSync(p, 'utf8');
  }
  const hash = crypto.createHash('sha1').update(JSON.stringify(files)).digest('hex');
  return { files, hash };
}

async function backupNow() {
  timer = null;
  if (!sheets.enabled()) return;
  try {
    const snap = snapshot();
    if (!snap || snap.hash === lastHash) return;
    await sheets.saveBlob('wa-auth', encode(snap.files));
    lastHash = snap.hash;
    info.lastBackupAt = new Date().toISOString();
  } catch (e) {
    log('WhatsApp session backup failed, retrying in 2 min:', e.message);
    schedule(120000);
  }
}

function schedule(delay = 120000) {
  if (!sheets.enabled()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(backupNow, delay);
}

async function restoreIfMissing() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return (info.restored = 'local');
  if (!sheets.enabled()) return (info.restored = 'none');
  for (let i = 1; i <= 5; i++) {
    try {
      const data = await sheets.getBlob('wa-auth');
      if (!data) return (info.restored = 'none');
      const files = decode(data);

      // An old backup can contain thousands of stale per-chat session files. Restoring those
      // makes WhatsApp reject the login ("unlinked") straight away, so only the login files
      // are restored - WhatsApp rebuilds the rest by itself.
      const wanted = Object.entries(files).filter(([name]) => KEEP.test(path.basename(name)));

      // A backup without a real, finished login is worse than no backup: it causes an
      // unlink loop at start-up. Better to ask for a fresh scan.
      const credsEntry = wanted.find(([name]) => path.basename(name) === 'creds.json');
      let creds = null;
      try { creds = credsEntry ? JSON.parse(credsEntry[1]) : null; } catch {}
      if (!creds || !creds.registered || !creds.me) {
        log('The saved WhatsApp login in the Sheet is incomplete - ignoring it, please link again.');
        await clearAll();
        return (info.restored = 'none');
      }

      for (const [name, content] of wanted) {
        fs.writeFileSync(path.join(AUTH_DIR, path.basename(name)), content);
      }
      lastHash = snapshot()?.hash || null;
      log(`WhatsApp login restored from Google Sheet (${wanted.length} files, ${Object.keys(files).length - wanted.length} old ones skipped)`);
      return (info.restored = 'sheet');
    } catch (e) {
      log(`WhatsApp session restore failed (attempt ${i}/5):`, e.message);
      await sleep(5000);
    }
  }
  return (info.restored = 'error');
}

async function clearAll() {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  lastHash = null;
  if (sheets.enabled()) {
    try {
      await sheets.saveBlob('wa-auth', '');
    } catch (e) {
      log('Could not clear session backup in Sheet:', e.message);
    }
  }
}

async function flush() {
  if (timer) clearTimeout(timer);
  await backupNow(); // skipped automatically if nothing changed
}

module.exports = { AUTH_DIR, info, schedule, backupNow, restoreIfMissing, clearAll, flush };
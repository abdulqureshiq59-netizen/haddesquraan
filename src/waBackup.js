// Backs up the WhatsApp login session (Baileys auth folder) to the Google Sheet,
// and restores it on boot when the server disk was wiped - so no re-scan after restarts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sheets = require('./sheets');
const { log, sleep, encode, decode } = require('./util');
const { DATA_DIR } = require('./store');

const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const info = { lastBackupAt: null, restored: null, pending: false, lastError: null };
let lastHash = null;
let timer = null;

// Only these are needed to come back without a new QR scan. The per-chat "session-*.json" files
// are re-created by WhatsApp on their own - and in a big community there can be thousands of them,
// which made every backup huge and slow.
const KEEP = /^(creds\.json|app-state-sync-key-.*\.json|app-state-sync-version-.*\.json)$/;

// While waiting for a QR scan, Baileys already writes a creds.json that is NOT a finished
// login yet. Backing that up would wipe the good session in the Sheet - which is exactly
// what happens if the server restarts at that moment. So a backup is only made once the
// login is really complete.
function finishedLogin() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
    return !!(creds && creds.registered && creds.me);
  } catch {
    return false;
  }
}

// creds.json is the only file WhatsApp really needs to come back without a new scan.
// The app-state-sync keys only save it some re-syncing, so they are added just while the
// backup stays small - a huge backup is what made saving fail silently before.
const MAX_BACKUP_BYTES = Number(process.env.WA_BACKUP_MAX_BYTES || 200 * 1024);

function snapshot() {
  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return null;
  if (!finishedLogin()) return null;
  const files = { 'creds.json': fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8') };
  let size = files['creds.json'].length;

  const extras = fs.readdirSync(AUTH_DIR)
    .filter((n) => n !== 'creds.json' && KEEP.test(n))
    .map((n) => ({ name: n, at: fs.statSync(path.join(AUTH_DIR, n)).mtimeMs }))
    .sort((a, b) => b.at - a.at);          // newest keys first, they are the useful ones
  for (const { name } of extras) {
    const body = fs.readFileSync(path.join(AUTH_DIR, name), 'utf8');
    if (size + body.length > MAX_BACKUP_BYTES) break;
    files[name] = body;
    size += body.length;
  }
  const hash = crypto.createHash('sha1').update(JSON.stringify(files)).digest('hex');
  return { files, hash };
}

async function backupNow() {
  timer = null;
  if (!sheets.enabled()) return;
  if (info.pending) return;   // we could not read the saved login yet - do NOT overwrite it
  try {
    const snap = snapshot();
    if (!snap || snap.hash === lastHash) return;
    await sheets.saveBlob('wa-auth', encode(snap.files));
    lastHash = snap.hash;
    info.lastBackupAt = new Date().toISOString();
    log(`WhatsApp login backed up to the Sheet (${Object.keys(snap.files).length} files)`);
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

// Keeps trying in the background. Until it succeeds the bot must NOT ask for a new QR,
// because a saved login probably exists in the Sheet and a fresh scan would wipe it.
function retryRestoreInBackground() {
  const timer = setInterval(async () => {
    try {
      const r = await restoreOnce();
      if (r !== 'error') {
        info.pending = false;
        info.restored = r;
        clearInterval(timer);
        log(`WhatsApp login restore finished: ${r}`);
        if (typeof info.onRestored === 'function') info.onRestored(r);
      }
    } catch (e) {
      info.lastError = e.message;
    }
  }, 30000);
  timer.unref?.();
}

async function restoreIfMissing() {
  const r = await restoreOnce();
  if (r === 'error') {
    info.pending = true;
    log('!!! Could not read the saved WhatsApp login from the Sheet. NOT asking for a new QR yet - retrying every 30s so the saved login is not lost.');
    retryRestoreInBackground();
  }
  return (info.restored = r);
}

async function restoreOnce() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return 'local';
  if (!sheets.enabled()) return 'none';
  const tries = Number(process.env.WA_RESTORE_ATTEMPTS || 5);
  for (let i = 1; i <= tries; i++) {
    try {
      const data = await sheets.getBlob('wa-auth');
      if (!data) return 'none';
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
        return 'none';
      }

      for (const [name, content] of wanted) {
        fs.writeFileSync(path.join(AUTH_DIR, path.basename(name)), content);
      }
      lastHash = snapshot()?.hash || null;
      log(`WhatsApp login restored from Google Sheet (${wanted.length} files, ${Object.keys(files).length - wanted.length} old ones skipped)`);
      return 'sheet';
    } catch (e) {
      info.lastError = e.message;
      log(`WhatsApp login restore failed (attempt ${i}/${tries}):`, e.message);
      if (i < tries) await sleep(5000);
    }
  }
  return 'error';
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

module.exports = {
  finishedLogin, AUTH_DIR, info, schedule, backupNow, restoreIfMissing, restoreOnce, clearAll, flush };

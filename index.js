// Quran & Hadees daily WhatsApp poster - entry point (dashboard + bot)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load .env from the folder you ran the command in, or from the folder this file lives in.
// On Windows, Notepad often saves it as ".env.txt" - that is caught below.
const envInfo = { file: null, problem: null };
{
  const candidates = [path.join(process.cwd(), '.env'), path.join(__dirname, '.env')];
  const found = candidates.find((f) => fs.existsSync(f));
  if (found) {
    require('dotenv').config({ path: found });
    envInfo.file = found;
  } else {
    require('dotenv').config();

    // On Render (and any host) there is no .env file - the values are set as environment
    // variables instead. That is completely normal, so don't scare anyone with an error.
    const fromHost = ['QURAN_FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'SHEETS_WEBAPP_URL', 'DASHBOARD_PASSWORD']
      .some((k) => process.env[k]);
    if (fromHost) {
      envInfo.file = 'environment variables (no .env file needed)';
      envInfo.fromHost = true;
    }

    const wrong = envInfo.file ? null : [
      ['.env.txt', 'Windows saved it as ".env.txt". Rename it to exactly ".env" (turn on "File name extensions" in Explorer first).'],
      ['.env.example', 'You still have ".env.example". Rename/copy it to exactly ".env".'],
      ['env', 'The file is named "env". Rename it to ".env" - with the dot in front.'],
    ].find(([n]) => fs.existsSync(path.join(__dirname, n)) || fs.existsSync(path.join(process.cwd(), n)));
    if (!envInfo.file) {
      envInfo.problem = wrong ? wrong[1] : 'No .env file found next to index.js. Create one (copy .env.example).';
    }
  }
}

const express = require('express');

const store = require('./src/store');
const sheets = require('./src/sheets');
const waBackup = require('./src/waBackup');
const wa = require('./src/whatsapp');
const drive = require('./src/drive');
const bot = require('./src/bot');
const { log, quietNoise, digits, nowParts, parseHHMM } = require('./src/util');
quietNoise();

const PORT = Number(process.env.PORT || 3000);
const USER = process.env.DASHBOARD_USER || 'admin';
const PASS = process.env.DASHBOARD_PASSWORD || '';

const app = express();
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.send('ok')); // for uptime pings (keeps Render awake)

// Simple password protection for the dashboard
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
app.use((req, res, next) => {
  if (!PASS) return next();
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && value) {
    const [u, ...p] = Buffer.from(value, 'base64').toString().split(':');
    if (same(u, USER) && same(p.join(':'), PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Quran Hadees Bot"').status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req, res)) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
};

async function setupSteps() {
  const st = store.get();
  const s = st.settings;
  const key = drive.serviceAccountEmail();

  // Check the folders can actually be READ, not just that the IDs are filled in
  const srcLabel = s.driveSource === 'script' ? 'your own Google account' : 'the service account';
  let folders = { done: false, detail: 'Paste both Drive folder links below and press Save folders' };
  if (s.quranFolder && s.hadeesFolder) {
    try {
      const stats = await bot.driveStats();
      const bad = stats.filter((f) => f.error);
      const empty = stats.filter((f) => !f.error && f.total === 0);
      if (bad.length) {
        folders.detail = s.driveSource === 'script'
          ? `${bad.map((f) => f.label).join(' and ')} folder: your own Google account cannot open it.`
          : `${bad.map((f) => f.label).join(' and ')} folder: no access yet. Either share it with ${key || 'the key email'} as Viewer, or switch "Read images using" to your own Google account.`;
      } else if (empty.length) {
        folders.detail = `${empty.map((f) => f.label).join(' and ')} folder is shared but has no images in it.`;
      } else {
        folders.done = true;
        folders.detail = stats.map((f) => `${f.label}: ${f.total} images (${f.left} not posted yet)`).join(' · ') + ` — read using ${srcLabel}`;
      }
    } catch (e) {
      folders.detail = e.message;
    }
  }

  return [
    { id: 'env', title: envInfo.fromHost ? 'Settings loaded from the host' : envInfo.file ? 'Settings file (.env) loaded' : '.env file NOT loaded',
      done: !!envInfo.file, detail: envInfo.file || envInfo.problem },
    { id: 'key', title: s.driveSource === 'script' ? 'Reading Drive as your own account' : 'Google key loaded',
      done: s.driveSource === 'script' ? sheets.enabled() : !!key,
      detail: s.driveSource === 'script'
        ? 'Images are read through your Apps Script, so folders shared with your own Google account work'
        : (key ? 'Sharing email: ' + key : 'Put service-account.json next to index.js, or set GOOGLE_SERVICE_ACCOUNT_JSON') },
    { id: 'folders', title: folders.done ? 'Drive folders readable' : 'Drive folders not readable yet', done: folders.done, detail: folders.detail },
    { id: 'whatsapp', title: 'WhatsApp linked', done: wa.isConnected(),
      detail: 'Scan the QR or use a pairing code' },
    { id: 'group', title: 'LIVE group chosen', done: !!s.targetJid,
      detail: 'Press Load groups, then Set LIVE on the right group' },
    { id: 'backup', title: (sheets.enabled() && sheets.status.lastOkAt && !sheets.status.lastError) ? 'Google Sheet backup working' : 'Google Sheet backup not working yet', done: !!(sheets.enabled() && sheets.status.lastOkAt && !sheets.status.lastError),
      detail: !sheets.enabled() ? 'Set SHEETS_WEBAPP_URL and SHEETS_WEBAPP_SECRET in .env'
        : sheets.status.lastError ? sheets.status.lastError
        : sheets.status.info ? `Saving into sheet "${sheets.status.info.sheetName}"`
        : 'Press Check connection to see which sheet it writes to' },
  ];
}

app.get('/api/status', wrap(async () => {
  const st = store.get();
  if (!st) {
    return {
      starting: true,
      whatsapp: wa.status,
      setup: [], history: [],
      envFile: envInfo.file, envProblem: envInfo.problem,
      serviceAccountEmail: drive.serviceAccountEmail(),
      nextRun: { text: 'starting…' },
      settings: {}, lastDate: {}, sentCount: { quran: 0, hadees: 0 }, test: {},
      backup: { enabled: sheets.enabled(), blocked: false, lastError: sheets.status.lastError },
    };
  }
  return {
    setup: await setupSteps(),
    envFile: envInfo.file,
    envProblem: envInfo.problem,
    serviceAccountEmail: drive.serviceAccountEmail(),
    whatsapp: wa.status,
    settings: st.settings,
    now: nowParts(st.settings.timezone).label,
    nextRun: bot.nextRun(),
    busy: bot.isBusy(),
    lastDate: st.lastDate,
    sentCount: { quran: st.sent.quran.length, hadees: st.sent.hadees.length },
    test: { count: st.test.count, lastAt: st.test.lastAt },
    backup: {
      enabled: sheets.enabled(),
      blocked: store.isBlocked(),
      stateRestoredFrom: store.backupInfo.restoredFrom,
      stateLastBackupAt: store.backupInfo.lastMirrorAt,
      sessionRestored: waBackup.info.restored,
      sessionLastBackupAt: waBackup.info.lastBackupAt,
      lastOkAt: sheets.status.lastOkAt,
      lastError: sheets.status.lastError,
      lastErrorAt: sheets.status.lastErrorAt,
      info: sheets.status.info,
    },
    history: st.history.slice(0, 50),
  };
}));

app.get('/api/drive', wrap(async (req) => ({ folders: await bot.driveStats(req.query.refresh === '1') })));

app.get('/api/groups', wrap(async () => ({ groups: await wa.listGroups() })));

// Try any folder link without saving it - proves whether sharing is the problem
app.post('/api/check-folder', wrap(async (req) => {
  const id = drive.folderIdFrom(req.body.folder);
  if (!id) throw new Error('Paste a Google Drive folder link first');
  const source = drive.SOURCES.includes(req.body.source) ? req.body.source : store.get().settings.driveSource;
  sheets.clearListCache(); // always ask Google fresh when you press Check
  const { name, files } = await drive.listFolder(id, source);
  return { id, name, source, images: files.length, sample: files.slice(0, 3).map((f) => f.name) };
}));

app.post('/api/pair', wrap(async (req) => ({ code: await wa.requestPairingCode(req.body.phone) })));
app.post('/api/new-qr', wrap(async () => { await wa.newQr(); return {}; }));

app.post('/api/logout', wrap(async () => { await wa.logout(); return {}; }));
app.post('/api/reconnect', wrap(async () => { await wa.reconnect(); return {}; }));

app.post('/api/target', wrap(async (req) => {
  const { kind, id, name } = req.body; // kind: live | test
  if (!/@g\.us$/.test(id || '')) throw new Error('Invalid group id');
  const s = store.get().settings;
  if (kind === 'test') Object.assign(s, { testTargetJid: id, testTargetName: name || '' });
  else Object.assign(s, { targetJid: id, targetName: name || '' });
  store.save();
  return { settings: s };
}));

app.post('/api/settings', wrap(async (req) => {
  const b = req.body || {};
  const s = store.get().settings;
  const next = { ...s };
  if (b.postTime !== undefined) { parseHHMM(b.postTime); next.postTime = b.postTime.trim().padStart(5, '0'); }
  for (const [field, label] of [['quranFolder', 'Quran'], ['hadeesFolder', 'Hadees']]) {
    if (b[field] !== undefined) {
      const id = drive.folderIdFrom(b[field]);
      if (id && !/^[a-zA-Z0-9_-]{5,}$/.test(id)) {
        throw new Error(`That does not look like a ${label} folder link or ID. Copy the folder's link from Google Drive and paste the whole thing.`);
      }
      next[field] = id;
    }
  }
  if (b.driveSource !== undefined) {
    if (!drive.SOURCES.includes(b.driveSource)) throw new Error('Invalid Drive source');
    if (b.driveSource === 'script' && !sheets.enabled()) throw new Error('Set SHEETS_WEBAPP_URL in .env first - reading Drive as yourself goes through the Apps Script');
    next.driveSource = b.driveSource;
  }
  if (b.pickOrder !== undefined) {
    if (!['name', 'created', 'random'].includes(b.pickOrder)) throw new Error('Invalid pick order');
    next.pickOrder = b.pickOrder;
  }
  if (b.quranCaption !== undefined) next.quranCaption = String(b.quranCaption).slice(0, 1000);
  if (b.hadeesCaption !== undefined) next.hadeesCaption = String(b.hadeesCaption).slice(0, 1000);
  if (b.adminNumber !== undefined) next.adminNumber = digits(b.adminNumber);
  if (b.testIntervalMin !== undefined) {
    const n = Number(b.testIntervalMin);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('Test interval must be 1-60 minutes');
    next.testIntervalMin = n;
  }
  if (b.testMaxPosts !== undefined) {
    const n = Number(b.testMaxPosts);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('Max test posts must be 1-200');
    next.testMaxPosts = n;
  }
  if (b.paused !== undefined) next.paused = !!b.paused;
  if (b.liveRepeat !== undefined) {
    if (b.liveRepeat && !next.targetJid) throw new Error('Choose the LIVE group first');
    if (b.liveRepeat && !s.liveRepeat) Object.assign(store.get().test, { lastAt: 0, count: 0 });
    next.liveRepeat = !!b.liveRepeat;
    if (next.liveRepeat) next.testMode = false;
  }
  if (b.testMode !== undefined) {
    if (b.testMode && !next.testTargetJid) throw new Error('Choose a TEST group first (Groups section)');
    if (b.testMode && !s.testMode) Object.assign(store.get().test, { lastAt: 0, count: 0 });
    next.testMode = !!b.testMode;
    if (next.testMode) next.liveRepeat = false;
  }
  const refresh = s.driveSource !== next.driveSource || s.quranFolder !== next.quranFolder || s.hadeesFolder !== next.hadeesFolder;
  Object.assign(s, next);
  store.save();
  if (refresh) bot.clearStatsCache();
  return { settings: s };
}));

app.post('/api/send', wrap(async (req) => {
  const mode = req.body.mode; // manual | self | test
  if (!['manual', 'self', 'test'].includes(mode)) throw new Error('Invalid mode');
  return { results: await bot.postPair(mode) };
}));

app.post('/api/reset-test', wrap(async () => {
  Object.assign(store.get().test, { sent: { quran: [], hadees: [] }, lastAt: 0, count: 0 });
  store.save();
  return {};
}));

app.post('/api/sheet-check', wrap(async () => {
  if (!sheets.enabled()) throw new Error('SHEETS_WEBAPP_URL is not set in .env');
  const info = await sheets.getInfo();
  return { info };
}));

app.post('/api/backup-now', wrap(async () => {
  if (!sheets.enabled()) throw new Error('SHEETS_WEBAPP_URL is not set');
  await sheets.ping();
  store.save();
  await store.flush();
  await waBackup.backupNow();
  return {};
}));

async function main() {
  if (envInfo.fromHost) log('Settings: taken from environment variables');
  else if (envInfo.file) log(`Settings file: ${envInfo.file}`);
  else log(`!!! .env NOT LOADED - ${envInfo.problem}`);
  if (!drive.serviceAccountEmail()) log('WARNING: no Google key found - set GOOGLE_SERVICE_ACCOUNT_JSON or add service-account.json');
  if (!PASS) log('WARNING: DASHBOARD_PASSWORD is not set - the dashboard is open to anyone with the link');

  // Open the dashboard straight away, so you can always see what is happening
  app.listen(PORT, () => log(`Dashboard running on http://localhost:${PORT}`));

  const r = await store.init();
  log(`State: ${r}`);
  const w = await waBackup.restoreIfMissing();
  log(`WhatsApp login: ${w}`);

  if (waBackup.info.pending) {
    // a saved login is probably in the Sheet - wait for it instead of asking for a new QR
    waBackup.info.onRestored = () => wa.start().catch((e) => log('WhatsApp start failed:', e.message));
  } else {
    await wa.start();
  }
  bot.startScheduler();
}

async function shutdown(sig) {
  log(`${sig} received - saving backups before exit`);
  const t = setTimeout(() => process.exit(0), 15000);
  try {
    await store.flush();
    await waBackup.flush();
  } catch (e) {
    log('Final backup error:', e.message);
  }
  clearTimeout(t);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('Unhandled rejection:', e?.message || e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

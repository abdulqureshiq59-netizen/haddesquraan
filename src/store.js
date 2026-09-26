// Local JSON state (source of truth) + automatic mirror to Google Sheet (backup).
// If the server's disk is wiped (Render redeploy/restart), state is restored from the Sheet on boot.
// If the Sheet can't be reached at boot, live posting stays BLOCKED until restore works,
// so the bot never re-posts images it already sent.
const fs = require('fs');
const path = require('path');
const sheets = require('./sheets');
const { log, sleep, digits, encode, decode, nowParts } = require('./util');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

function envSettings() {
  return {
    driveSource: require('./drive').defaultSource(),
    quranFolder: process.env.QURAN_FOLDER_ID || '',
    hadeesFolder: process.env.HADEES_FOLDER_ID || '',
    targetJid: process.env.TARGET_GROUP_JID || '',
    targetName: '',
    testTargetJid: process.env.TEST_GROUP_JID || '',
    testTargetName: '',
    postTime: process.env.POST_TIME || '04:00',
    timezone: process.env.TZ_NAME || 'Asia/Kuwait',
    catchupHours: num(process.env.CATCHUP_HOURS, 6),
    pickOrder: (process.env.PICK_ORDER || 'name').toLowerCase(),
    quranCaption: process.env.QURAN_CAPTION || '',
    hadeesCaption: process.env.HADEES_CAPTION || '',
    adminNumber: digits(process.env.ADMIN_NUMBER),
    lowStock: num(process.env.LOW_STOCK_WARNING, 5),
    testMode: false,
    liveRepeat: false,   // testing only: keep posting to the LIVE group every few minutes
    testIntervalMin: num(process.env.TEST_INTERVAL_MINUTES, 2),
    testMaxPosts: num(process.env.TEST_MAX_POSTS, 15),
    paused: false,
  };
}

function fresh() {
  return {
    settings: envSettings(),
    sent: { quran: [], hadees: [] },
    lastDate: {},
    test: { sent: { quran: [], hadees: [] }, lastAt: 0, count: 0 },
    alerts: {},
    copies: {},     // original Drive file id -> id of the copy in your own Drive
    history: [],
  };
}

function normalize(s = {}) {
  const f = fresh();
  const settings = { ...f.settings, ...(s.settings || {}) };
  for (const k of ['quranFolder', 'hadeesFolder', 'targetJid', 'testTargetJid', 'adminNumber']) {
    if (!settings[k]) settings[k] = f.settings[k];
  }
  return {
    settings,
    sent: { ...f.sent, ...(s.sent || {}) },
    lastDate: { ...(s.lastDate || {}) },
    test: { ...f.test, ...(s.test || {}), sent: { ...f.test.sent, ...((s.test || {}).sent || {}) } },
    alerts: s.alerts || {},
    copies: s.copies || {},
    history: s.history || [],
  };
}

// These are set in .env, not in the dashboard any more. Whatever .env says wins at every
// start, so changing .env is enough - no more "the dashboard still has the old value".
const ENV_KEYS = {
  quranFolder: 'QURAN_FOLDER_ID',
  hadeesFolder: 'HADEES_FOLDER_ID',
  driveSource: 'DRIVE_SOURCE',
  quranCaption: 'QURAN_CAPTION',
  hadeesCaption: 'HADEES_CAPTION',
  pickOrder: 'PICK_ORDER',
  adminNumber: 'ADMIN_NUMBER',
  testTargetJid: 'TEST_GROUP_JID',
};
function applyEnv(st) {
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const v = process.env[envName];
    if (v !== undefined && v !== '') st.settings[key] = key === 'adminNumber' ? digits(v) : v.trim();
  }
  return st;
}

let state = null;
let blocked = false; // true = Sheet backup exists but could not be read yet
const backupInfo = { restoredFrom: null, lastMirrorAt: null };

function writeLocal() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic
}

let mirrorTimer = null;
function scheduleMirror(delay = 5000) {
  if (!sheets.enabled() || blocked) return;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(pushMirror, delay);
}
// Only what is really needed to come back after a wipe. The history is already written to the
// History tab row by row, and a big backup made the request fail (Apps Script answers a large
// POST with a 404), so it is left out here.
function backupShape() {
  return {
    settings: state.settings,
    sent: state.sent,
    lastDate: state.lastDate,
    copies: state.copies,
  };
}

async function pushMirror() {
  mirrorTimer = null;
  try {
    await sheets.saveBlob('state', encode(backupShape()));
    backupInfo.lastMirrorAt = new Date().toISOString();
  } catch (e) {
    log('State backup to Sheet failed, retrying in 60s:', e.message);
    scheduleMirror(60000);
  }
}

function save() {
  if (blocked) return; // keep in memory only until the real state is restored
  writeLocal();
  scheduleMirror();
}

async function tryRestore() {
  const data = await sheets.getBlob('state');
  if (!data) return false;
  state = applyEnv(normalize(decode(data)));
  blocked = false;
  writeLocal();
  backupInfo.restoredFrom = 'sheet';
  log(`State restored from Google Sheet (${state.sent.quran.length} Quran + ${state.sent.hadees.length} Hadees already posted)`);
  return true;
}

async function init() {
  if (fs.existsSync(STATE_FILE)) {
    state = applyEnv(normalize(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))));
    backupInfo.restoredFrom = 'local';
    scheduleMirror(2000);
    return 'local';
  }
  if (!sheets.enabled()) {
    state = fresh();
    save();
    log('No Sheet backup configured - starting with a fresh state');
    return 'new';
  }
  for (let i = 1; i <= 3; i++) {
    try {
      if (await tryRestore()) return 'restored';
      state = fresh();
      save();
      log('No backup found in Sheet - starting fresh');
      return 'new';
    } catch (e) {
      log(`Restore from Sheet failed (attempt ${i}/3):`, e.message);
      await sleep(5000);
    }
  }
  // Could not reach the Sheet: don't risk re-posting old images
  state = fresh();
  blocked = true;
  log('!!! Could not read backup from Sheet. Live posting is paused until restore works (retrying every 60s).');
  const retry = setInterval(async () => {
    try {
      if (await tryRestore()) clearInterval(retry);
      else {
        blocked = false;
        save();
        clearInterval(retry);
        log('Sheet reachable, no backup there - starting fresh');
      }
    } catch (e) {
      log('Restore retry failed:', e.message);
    }
  }, 60000);
  return 'error';
}

function addHistory(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  state.history.unshift(e);
  state.history = state.history.slice(0, 300);
  sheets.queueHistory([
    nowParts(state.settings.timezone).label,
    e.mode,
    e.item || '',
    e.file || '',
    e.target || '',
    e.ok ? 'OK' : `FAILED: ${e.error || ''}`,
    e.remaining ?? '',
  ]);
}

async function flush() {
  if (mirrorTimer) {
    clearTimeout(mirrorTimer);
    await pushMirror();
  }
  await sheets.flushHistory();
}

module.exports = {
  init, save, flush, addHistory,
  get: () => state,
  isBlocked: () => blocked,
  backupInfo,
  DATA_DIR,
};

// Posting logic + scheduler.
// LIVE: once a day at postTime (Kuwait) -> 1 new Quran + 1 new Hadees image to the LIVE group.
// TEST: every N minutes -> next pair to the TEST group, using a separate "test" list,
//       so testing never uses up the client's real images.
const store = require('./store');
const drive = require('./drive');
const wa = require('./whatsapp');
const { log, sleep, nowParts, parseHHMM, chooseNext } = require('./util');

const ITEMS = [
  { key: 'quran', label: 'Quran', folderKey: 'quranFolder', captionKey: 'quranCaption' },
  { key: 'hadees', label: 'Hadees', folderKey: 'hadeesFolder', captionKey: 'hadeesCaption' },
];

let busy = false;
let lastLiveAttempt = 0;
const LIVE_RETRY_MS = 10 * 60 * 1000;

async function alertOnce(key, text) {
  const st = store.get();
  if (st.alerts[key]) return;
  st.alerts[key] = new Date().toISOString();
  const keys = Object.keys(st.alerts);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete st.alerts[k];
  store.save();
  if (!st.settings.adminNumber || !wa.isConnected()) return;
  try {
    await wa.sendText(`${st.settings.adminNumber}@s.whatsapp.net`, text);
  } catch (e) {
    log('Admin alert failed:', e.message);
  }
}

// mode: live      - the normal once-a-day post
//       manual    - "Send now", also counts as today's post
//       repeat    - testing: posts to the LIVE group again and again, ignoring the once-a-day rule
//       test      - to the TEST group, using a separate list
//       self      - to my own number, nothing recorded
async function postPair(mode) {
  const st = store.get();
  const s = st.settings;
  if (busy) throw new Error('A post is already in progress');
  if (store.isBlocked() && ['live', 'manual', 'repeat'].includes(mode)) {
    throw new Error('Backup not restored from Google Sheet yet - live posting paused so old images are not re-sent');
  }
  if (!wa.isConnected()) throw new Error('WhatsApp is not connected');

  let target, targetName;
  if (mode === 'test') [target, targetName] = [s.testTargetJid, s.testTargetName];
  else if (mode === 'self') {
    if (!s.adminNumber) throw new Error('Set "My number" in settings first');
    [target, targetName] = [`${s.adminNumber}@s.whatsapp.net`, 'My number'];
  } else [target, targetName] = [s.targetJid, s.targetName];
  if (!target) throw new Error(mode === 'test' ? 'Choose a TEST group first' : 'Choose the LIVE group first');

  busy = true;
  const today = nowParts(s.timezone).date;
  const records = ['live', 'manual', 'repeat'].includes(mode);
  const results = [];
  try {
    for (const it of ITEMS) {
      if (mode === 'live' && st.lastDate[it.key] === today) {
        results.push({ item: it.label, skipped: 'already posted today' });
        continue;
      }
      try {
        if (!s[it.folderKey]) throw new Error(`${it.label} folder is not set - paste the Drive folder link in Settings`);
        const files = await drive.listImages(s[it.folderKey], s.driveSource);
        const list = mode === 'test' ? st.test.sent[it.key] : st.sent[it.key];
        let { file, remaining } = chooseNext(files, mode === 'self' ? st.sent[it.key] : list, s.pickOrder);
        if (!file && mode === 'test' && files.length) {
          st.test.sent[it.key] = []; // test list finished -> start test cycle again
          ({ file, remaining } = chooseNext(files, [], s.pickOrder));
        }
        if (!file) throw new Error(files.length ? `All ${it.label} images have already been posted` : `${it.label} folder has no images`);

        const buf = await drive.download(file.id, s.driveSource);
        const sent = await wa.sendImage(target, buf, file.mimeType, s[it.captionKey]);

        if (records) {
          st.sent[it.key].push(file.id);
          st.lastDate[it.key] = today;
        } else if (mode === 'test') {
          st.test.sent[it.key].push(file.id);
        }
        store.addHistory({ mode, item: it.label, file: file.name, target: targetName || target, ok: true,
                           remaining: records ? remaining : null, msgId: sent?.id || null, members: sent?.members ?? null });
        store.save();
        results.push({ item: it.label, file: file.name, remaining });
        log(`[${mode}] ${it.label}: sent "${file.name}" to ${targetName || target}` +
            `${sent?.members ? ` (${sent.members} members)` : ''}${records ? ` (${remaining} new left)` : ''}` +
            `${sent?.id ? ` id=${sent.id}` : ''}`);

        if (records && remaining <= s.lowStock) {
          await alertOnce(`low-${it.key}-${today}`, `ℹ️ Only ${remaining} new ${it.label} images left in Google Drive. Please add more soon.`);
        }
        await sleep(3000);
      } catch (e) {
        log(`[${mode}] ${it.label} failed:`, e.message);
        store.addHistory({ mode, item: it.label, target: targetName || target, ok: false, error: e.message });
        store.save();
        results.push({ item: it.label, error: e.message });
        if (mode === 'live') await alertOnce(`fail-${it.key}-${today}`, `❌ ${it.label} image could not be posted today: ${e.message}`);
      }
    }
  } finally {
    busy = false;
  }
  return results;
}

async function tick() {
  const st = store.get();
  if (!st || busy || !wa.isConnected()) return;
  const s = st.settings;
  if (s.paused) return;

  // testing only: repeat the LIVE post every few minutes
  if (s.liveRepeat) {
    if (!s.targetJid) return;
    if (Date.now() - st.test.lastAt < s.testIntervalMin * 60000) return;
    st.test.lastAt = Date.now();
    st.test.count++;
    if (st.test.count >= s.testMaxPosts) {
      s.liveRepeat = false;
      log(`Live repeat switched off automatically after ${st.test.count} posts - back to once a day`);
    }
    store.save();
    await postPair('repeat').catch((e) => log('Repeat post failed:', e.message));
    return;
  }

  if (s.testMode) {
    if (!s.testTargetJid) return;
    if (Date.now() - st.test.lastAt < s.testIntervalMin * 60000) return;
    st.test.lastAt = Date.now();
    st.test.count++;
    if (st.test.count >= s.testMaxPosts) {
      s.testMode = false;
      log(`Test mode switched off automatically after ${st.test.count} test posts`);
    }
    store.save();
    await postPair('test').catch((e) => log('Test post failed:', e.message));
    return;
  }

  if (store.isBlocked()) return;
  const now = nowParts(s.timezone);
  const late = now.minutes - parseHHMM(s.postTime).minutes;
  const done = ITEMS.every((it) => st.lastDate[it.key] === now.date);
  if (done || late < 0 || late > s.catchupHours * 60) return;
  if (Date.now() - lastLiveAttempt < LIVE_RETRY_MS) return; // if something failed, retry every 10 min
  lastLiveAttempt = Date.now();
  if (late > 1) log(`Catch-up: today's ${s.postTime} post was missed, posting now`);
  await postPair('live').catch((e) => log('Live post failed:', e.message));
}

function nextRun() {
  const st = store.get();
  const s = st.settings;
  if (s.paused) return { text: 'Paused', short: 'Stopped', minutes: null };
  if (s.liveRepeat || s.testMode) {
    const live = s.liveRepeat;
    const ms = Math.max(0, st.test.lastAt + s.testIntervalMin * 60000 - Date.now());
    const who = live ? (s.targetName || 'LIVE group') : (s.testTargetName || 'test group');
    return {
      text: `${live ? 'LIVE repeat' : 'TEST post'} to ${who} in ${Math.ceil(ms / 1000)}s`,
      short: `${live ? 'LIVE repeat' : 'Test'} in ${Math.ceil(ms / 1000)}s`,
      minutes: ms / 60000, repeating: true,
    };
  }
  const now = nowParts(s.timezone);
  const pt = parseHHMM(s.postTime).minutes;
  const done = ITEMS.every((it) => st.lastDate[it.key] === now.date);
  const late = now.minutes - pt;
  if (!done && late >= 0 && late <= s.catchupHours * 60) return { text: 'Due now', minutes: 0 };
  const tomorrow = done || late > 0;
  const mins = tomorrow ? 1440 - now.minutes + pt : pt - now.minutes;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const when = `${tomorrow ? 'tomorrow' : 'today'} ${s.postTime} (${s.timezone}), in ${h}h ${m}m`;
  const why = done
    ? 'Already posted today - next '                      // one post per day, on purpose
    : late > 0
    ? `Today's ${s.postTime} was missed by more than ${s.catchupHours}h - next `
    : 'Next ';
  const short = done ? `Done · next ${s.postTime}`
    : late > 0 ? `Missed · next ${s.postTime}`
    : `${tomorrow ? 'Tomorrow' : 'Today'} ${s.postTime} · ${h}h ${m}m`;
  return { text: why + when, short, minutes: mins, done, tomorrow };
}

// Drive stats for the dashboard (cached 60s)
let statsCache = { at: 0, data: null };
async function driveStats(force = false) {
  if (!force && statsCache.data && Date.now() - statsCache.at < 60000) return statsCache.data;
  if (force) require('./sheets').clearListCache();
  const st = store.get();
  const out = [];
  for (const it of ITEMS) {
    const folderId = st.settings[it.folderKey];
    if (!folderId) { out.push({ key: it.key, label: it.label, error: 'Folder not set - paste the Drive folder link in Settings' }); continue; }
    try {
      const src = st.settings.driveSource;
      const { name, files } = await drive.listFolder(folderId, src);
      const { file, remaining } = chooseNext(files, st.sent[it.key], st.settings.pickOrder);
      out.push({ key: it.key, label: it.label, folderId, folderName: name, total: files.length, left: file ? remaining + 1 : 0, next: file?.name || null });
    } catch (e) {
      out.push({ key: it.key, label: it.label, folderId, error: e.message });
    }
  }
  statsCache = { at: Date.now(), data: out };
  return out;
}

let interval = null;
function startScheduler() {
  clearInterval(interval);
  interval = setInterval(() => tick().catch((e) => log('Scheduler error:', e.message)), 20000);
  setTimeout(() => tick().catch(() => {}), 5000);
}

const clearStatsCache = () => { statsCache = { at: 0, data: null }; };

module.exports = { postPair, tick, nextRun, driveStats, clearStatsCache, startScheduler, isBusy: () => busy, _reset: () => { busy = false; lastLiveAttempt = 0; } };

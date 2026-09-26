// Talks to the Google Apps Script Web App (apps-script/Code.gs) that stores backups in the Google Sheet
const { log } = require('./util');

const URL = process.env.SHEETS_WEBAPP_URL || '';
const SECRET = process.env.SHEETS_WEBAPP_SECRET || '';

const status = { enabled: !!URL, lastOkAt: null, lastError: null, lastErrorAt: null, info: null };
const enabled = () => !!URL;

const BACKUP_ACTIONS = ['ping', 'getInfo', 'saveBlob', 'getBlob', 'appendHistory'];
// Safe to send again if the first try fails halfway. 'appendHistory' is NOT (it would duplicate rows).
const RETRYABLE = ['ping', 'getInfo', 'getBlob', 'saveBlob', 'driveList', 'driveFile'];

// Apps Script gets confused by parallel requests (it locks the script), so we send one at a time.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// Apps Script sometimes answers with a 404/500 HTML page for a moment. Try again before giving up.
async function call(action, payload = {}, timeoutMs = 120000) {
  const attempts = RETRYABLE.includes(action) ? 4 : 1;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await serialize(() => callOnce(action, payload, timeoutMs));
    } catch (e) {
      last = e;
      if (i === attempts || !/did not return JSON|timed out|fetch failed|network/i.test(e.message)) throw e;
      log(`Apps Script ${action} failed (try ${i}/${attempts}): ${e.message} - retrying`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw last;
}

async function callOnce(action, payload = {}, timeoutMs = 120000) {
  if (!URL) throw new Error('SHEETS_WEBAPP_URL is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'Content-Type': 'text/plain;charset=utf-8', 'Accept': 'application/json' };
  try {
    // Apps Script answers a POST with a redirect to googleusercontent.com, and the real answer
    // is at that address. Letting fetch follow it automatically is what produced the random
    // "HTTP 404" - so the redirect is followed by hand here.
    let res = await fetch(URL, {
      method: 'POST', headers,
      body: JSON.stringify({ secret: SECRET, action, ...payload }),
      redirect: 'manual', signal: ctrl.signal,
    });
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const next = res.headers.get('location');
      if (!next) break;
      res = await fetch(next, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: ctrl.signal });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const looksLikeLogin = /accounts\.google\.com|sign in|Google Account/i.test(text);
      throw new Error(
        `The Apps Script URL did not return JSON (HTTP ${res.status}). ` +
        (looksLikeLogin
          ? 'It is asking for a Google login, so the Web App is not deployed with access "Anyone".'
          : res.status === 404
          ? 'That address no longer exists. In the Sheet: Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy, then copy the /exec URL into .env again.'
          : 'Check the deployment (Execute as: Me, Who has access: Anyone).')
      );
    }
    if (!json.ok) throw new Error(json.error || 'Apps Script error');
    if (json.version && json.version !== 'qh-bot-1') {
      throw new Error('This Apps Script URL belongs to a different project (backend version "' + json.version + '"). Deploy apps-script/Code.gs from THIS bot and use its /exec URL.');
    }
    if (json.sheetName) status.info = { sheetName: json.sheetName, sheetId: json.sheetId, sheetUrl: json.sheetUrl, tabs: json.tabs };
    if (BACKUP_ACTIONS.includes(action)) {
      status.lastOkAt = new Date().toISOString();
      status.lastError = null;
    }
    return json;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Apps Script timed out' : e.message;
    if (BACKUP_ACTIONS.includes(action)) {
      status.lastError = msg;
      status.lastErrorAt = new Date().toISOString();
    }
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

const saveBlob = (key, data) => call('saveBlob', { key, data });
const getBlob = async (key) => (await call('getBlob', { key })).data || null;
const appendHistory = (rows) => call('appendHistory', { rows });
const ping = () => call('ping');
async function getInfo() {
  const r = await call('getInfo');
  if (!r.sheetName) {
    throw new Error('This /exec URL is running old or different code (it did not report a spreadsheet). Paste apps-script/Code.gs into the Qwait sheet\'s Apps Script and deploy a NEW VERSION.');
  }
  return r;
}

// Reading Drive through the script (it runs as the sheet's owner)
function scriptAgeError(e) {
  const m = e.message || '';
  if (/Unknown action/i.test(m)) {
    return new Error('Your Apps Script is an older version. Paste the latest apps-script/Code.gs into the Sheet and deploy a NEW VERSION, then try again.');
  }
  if (/do not have permission to call DriveApp|auth\/drive/i.test(m)) {
    return new Error(
      'The Apps Script has not been given permission to read Drive yet. Open the script editor, pick the function "authorizeDrive" in the box at the top, press Run, ' +
      'and accept the permission screen (Advanced > Go to ... > Allow). Deploying a new version does not ask for permissions - only running a function does.'
    );
  }
  return e;
}
const listCache = new Map(); // folderId -> { at, value } (a few seconds, so one refresh = one call)
const clearListCache = () => listCache.clear();

const LIST_FRESH_MS = 60000;      // reuse a good answer for a minute
const LIST_STALE_MS = 30 * 60000; // and rather than fail, use an old one for up to half an hour

async function driveList(folderId, fresh = false) {
  const hit = listCache.get(folderId);
  if (!fresh && hit && Date.now() - hit.at < LIST_FRESH_MS) return hit.value;
  try {
    const r = await call('driveList', { folderId });
    if (!r.name || !Array.isArray(r.files)) {
      throw new Error('The Apps Script gave an incomplete answer for this folder. Try again in a moment.');
    }
    const value = { name: r.name, files: r.files };
    listCache.set(folderId, { at: Date.now(), value });
    return value;
  } catch (e) {
    // Google refused this time - show what we had instead of breaking the dashboard
    if (hit && Date.now() - hit.at < LIST_STALE_MS) {
      log(`Using the folder list from ${Math.round((Date.now() - hit.at) / 1000)}s ago (Google did not answer)`);
      return hit.value;
    }
    throw scriptAgeError(e);
  }
}
const CHUNK_BYTES = Number(process.env.DRIVE_CHUNK_BYTES || 400 * 1024);

// One request per image is far faster than several: Apps Script re-reads the whole file
// for every slice, so slicing made a 500 KB image take three slow round trips.
async function driveFileWhole(fileId) {
  const r = await call('driveFile', { fileId });
  if (typeof r.data !== 'string' || !r.data.length) throw new Error('empty answer');
  const buffer = Buffer.from(r.data, 'base64');
  const total = Number(r.size);
  if (Number.isFinite(total) && total > 0 && buffer.length !== total) throw new Error('incomplete answer');
  if (!buffer.length) throw new Error('empty answer');
  return { buffer, mimeType: r.mimeType, name: r.name };
}

// Images come back in slices and are joined here, so size is never a problem
async function driveFile(fileId) {
  try {
    try {
      return await driveFileWhole(fileId);     // normal path
    } catch (e) {
      log(`Fetching this image in one go did not work (${e.message}), trying it in pieces`);
    }
    const parts = [];
    let got = 0;
    let total = null;
    let meta = {};
    for (let guard = 0; guard < 60; guard++) {
      const r = await call('driveFile', { fileId, start: got, len: CHUNK_BYTES });
      if (typeof r.data !== 'string') throw new Error('The Apps Script did not return the image data.');
      const part = Buffer.from(r.data, 'base64');
      if (total === null) { total = Number(r.size); meta = { mimeType: r.mimeType, name: r.name }; }
      if (!Number.isFinite(total) || total <= 0) throw new Error('This file looks empty in Drive (0 bytes).');
      if (!part.length) break;
      parts.push(part);
      got += part.length;
      if (got >= total) break;
    }
    const buffer = Buffer.concat(parts);
    if (!buffer.length) throw new Error('The image came back empty from Drive.');
    if (total && buffer.length !== total) {
      throw new Error(`Only ${buffer.length} of ${total} bytes arrived for this image. Try again.`);
    }
    return { buffer, ...meta };
  } catch (e) { throw scriptAgeError(e); }
}

// Ask the script to put a copy of the image in your own Drive, readable by the service account
async function driveCopy(fileId, shareWith) {
  try {
    const r = await call('driveCopy', { fileId, shareWith });
    if (!r.copyId) throw new Error('The Apps Script did not return the copied file id.');
    return r;
  } catch (e) { throw scriptAgeError(e); }
}

// History rows are batched so many sends = one request
let pending = [];
let timer = null;
function queueHistory(row) {
  if (!URL) return;
  pending.push(row);
  clearTimeout(timer);
  timer = setTimeout(flushHistory, 5000);
}
async function flushHistory() {
  if (!pending.length) return;
  const rows = pending;
  pending = [];
  try {
    await appendHistory(rows);
  } catch (e) {
    log('Sheet history append failed, will retry:', e.message);
    pending = rows.concat(pending).slice(-500);
    clearTimeout(timer);
    timer = setTimeout(flushHistory, 60000);
  }
}

module.exports = { enabled, status, saveBlob, getBlob, ping, getInfo, driveList, driveFile, driveCopy, clearListCache, queueHistory, flushHistory, _listCache: listCache };
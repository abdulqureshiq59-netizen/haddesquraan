// Reading the Google Drive folders. Two ways, same interface:
//
//   source = 'service'  ->  Google API with the service-account key.
//                           The client must share each folder with the key's email.
//   source = 'script'   ->  through your Apps Script Web App, which runs AS YOU.
//                           Works for folders shared with your own Google account,
//                           so the client does not have to share anything again.
const fs = require('fs');
const sheets = require('./sheets');
const { log } = require('./util');

const SOURCES = ['service', 'script'];
const defaultSource = () => (SOURCES.includes(process.env.DRIVE_SOURCE) ? process.env.DRIVE_SOURCE : 'service');

// Accepts a full Drive link or a bare ID
function folderIdFrom(input) {
  const v = String(input || '').trim();
  const m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(v) || /[?&]id=([a-zA-Z0-9_-]+)/.exec(v);
  return m ? m[1] : v;
}

// ---------- service account ----------
let client = null;
function api() {
  if (client) return client;
  const { google } = require('googleapis');
  const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
  let auth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    auth = new google.auth.GoogleAuth({ credentials: JSON.parse(text), scopes });
  } else {
    const keyFile = process.env.GOOGLE_KEY_FILE || './service-account.json';
    if (!fs.existsSync(keyFile)) throw new Error(`Google key not found: set GOOGLE_SERVICE_ACCOUNT_JSON or put the key at ${keyFile}`);
    auth = new google.auth.GoogleAuth({ keyFile, scopes });
  }
  client = google.drive({ version: 'v3', auth });
  return client;
}

// Which email the folders must be shared with, in service-account mode
function serviceAccountEmail() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    if (raw) {
      const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(text).client_email || null;
    }
    const keyFile = process.env.GOOGLE_KEY_FILE || './service-account.json';
    if (fs.existsSync(keyFile)) return JSON.parse(fs.readFileSync(keyFile, 'utf8')).client_email || null;
  } catch {}
  return null;
}

// Turn Google's technical errors into something you can act on
function explain(e, folderId, source) {
  const m = String((e && e.message) || e);
  if (source === 'script') {
    if (/not found|No item with the given ID|do not have permission/i.test(m)) {
      return new Error(
        'Your own Google account cannot open this folder either. Open the folder link while logged in as the account that owns the Google Sheet, ' +
        'and make sure it is the same account - the Apps Script reads Drive as that account.'
      );
    }
    return e;
  }
  if (/File not found/i.test(m)) {
    return new Error(
      `This folder is not shared with the bot yet (Google says "not found", which also means "no access"). ` +
      `Either ask the client to share it with ${serviceAccountEmail() || 'the service account email'} as Viewer, ` +
      `or switch "Read images using" to your own Google account.`
    );
  }
  if (/does not have permission|insufficient|forbidden/i.test(m)) {
    return new Error(`Shared, but without permission to read. It must be shared as Viewer with ${serviceAccountEmail() || 'the service account email'}.`);
  }
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(m)) {
    return new Error('Google Drive API is switched off for this Google Cloud project. Turn it on: Cloud Console > APIs & Services > Library > "Google Drive API" > Enable, then wait a minute.');
  }
  if (/invalid_grant|JWT|clock/i.test(m)) {
    return new Error('Google rejected the key (invalid_grant). Usually the computer clock is wrong, or the key was deleted in Cloud Console.');
  }
  return e;
}

function checkScript() {
  if (!sheets.enabled()) {
    throw new Error('Reading Drive through your own account needs the Google Sheet connection. Set SHEETS_WEBAPP_URL in .env first.');
  }
}

// ---------- public interface ----------
async function listImages(folderIdOrUrl, source = defaultSource()) {
  const folderId = folderIdFrom(folderIdOrUrl);
  if (!folderId) throw new Error('Folder ID is not set');
  try {
    if (source === 'script') {
      checkScript();
      return (await sheets.driveList(folderId)).files;
    }
    const files = [];
    let pageToken;
    do {
      const res = await api().files.list({
        q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      files.push(...res.data.files);
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    // Google does NOT report an error for a folder you cannot see - it just returns an empty
    // list. So an empty result is checked properly, otherwise "no access" looks like "no images".
    if (!files.length) {
      await api().files.get({ fileId: folderId, fields: 'id', supportsAllDrives: true });
    }
    return files;
  } catch (e) {
    throw explain(e, folderId, source);
  }
}

// Name + images in ONE request (the script returns both), so the dashboard makes half the calls
async function listFolder(folderIdOrUrl, source = defaultSource()) {
  const id = folderIdFrom(folderIdOrUrl);
  if (!id) throw new Error('Folder ID is not set');
  try {
    if (source === 'script') {
      checkScript();
      const r = await sheets.driveList(id);
      return { name: r.name, files: r.files };
    }
    const [name, files] = [await folderName(id, source), await listImages(id, source)];
    return { name, files };
  } catch (e) {
    throw explain(e, id, source);
  }
}

async function folderName(folderIdOrUrl, source = defaultSource()) {
  const id = folderIdFrom(folderIdOrUrl);
  try {
    if (source === 'script') {
      checkScript();
      return (await sheets.driveList(id)).name;
    }
    const res = await api().files.get({ fileId: id, fields: 'name', supportsAllDrives: true });
    return res.data.name;
  } catch (e) {
    throw explain(e, id, source);
  }
}

// Remembers which copy belongs to which original, so each image is copied only once
let copyStore = null;
function copies() {
  if (!copyStore) {
    try { copyStore = require('./store').get()?.copies || {}; } catch { copyStore = {}; }
  }
  return copyStore;
}
function rememberCopy(fileId, copyId) {
  copies()[fileId] = copyId;
  try { require('./store').save(); } catch {}
}

async function download(fileId, source = defaultSource()) {
  try {
    if (source === 'script') {
      checkScript();
      const email = serviceAccountEmail();

      // Fast path: the image is copied into your own Drive once, then read with the normal
      // Google API. Pulling the bytes through Apps Script is slow and often fails.
      if (email) {
        try {
          let copyId = copies()[fileId];
          if (!copyId) {
            const r = await sheets.driveCopy(fileId, email);
            copyId = r.copyId;
            rememberCopy(fileId, copyId);
          }
          const res = await api().files.get({ fileId: copyId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
          const buf = Buffer.from(res.data);
          if (buf.length) return buf;
          throw new Error('the copy was empty');
        } catch (e) {
          delete copies()[fileId];
          log(`Fast download did not work (${e.message}), falling back to the Apps Script`);
        }
      }
      return (await sheets.driveFile(fileId)).buffer;
    }
    const res = await api().files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  } catch (e) {
    throw explain(e, fileId, source);
  }
}

module.exports = { listImages, folderName, listFolder, download, folderIdFrom, serviceAccountEmail, explain, SOURCES, defaultSource };
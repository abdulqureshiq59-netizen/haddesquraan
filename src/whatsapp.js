// WhatsApp connection (Baileys) with BOTH login methods: QR code and 8-digit pairing code.
// Designed to stay calm while linking: one socket at a time, the QR stays on screen until a new
// one actually arrives, and "restart required" right after a scan is handled silently.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const waBackup = require('./waBackup');
const { log, sleep, digits } = require('./util');

const AUTH_DIR = waBackup.AUTH_DIR;
const SENT_FILE = path.join(AUTH_DIR, '..', 'sent-messages.json');

// WhatsApp asks the sender to send a message AGAIN when a member's phone could not read it
// ("retry receipt"). If we cannot answer that, THAT MEMBER NEVER SEES THE IMAGE - the message
// shows only on our own phone. So every message we send is kept here for a while.
const sentStore = new Map();
function loadSent() {
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')))) sentStore.set(k, v);
  } catch {}
}
function rememberSent(msg) {
  if (!msg?.key?.id || !msg.message) return;
  sentStore.set(msg.key.id, msg.message);
  while (sentStore.size > 100) sentStore.delete(sentStore.keys().next().value);
  try {
    fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
    fs.writeFileSync(SENT_FILE, JSON.stringify(Object.fromEntries(sentStore)));
  } catch {}
}

// WhatsApp remembers which members it has already given the group key to. If that memory is
// stale (members joined, or the session was rebuilt), those members get a message they cannot
// open - it simply never appears for them. Clearing the memory makes WhatsApp hand the key to
// every current member again on the next send.
const keyRefreshed = new Map();
const KEY_REFRESH_MS = 30 * 60 * 1000;

function refreshSenderKey(jid, force = false) {
  const last = keyRefreshed.get(jid) || 0;
  if (!force && Date.now() - last < KEY_REFRESH_MS) return 0;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(AUTH_DIR)) {
      if (!/^sender-key-memory/.test(name)) continue;
      if (!name.includes(jid.split('@')[0])) continue;
      fs.unlinkSync(path.join(AUTH_DIR, name));
      removed++;
    }
  } catch (e) {
    log('Could not refresh the group key memory:', e.message);
  }
  keyRefreshed.set(jid, Date.now());
  if (removed) log(`Group key memory cleared for ${jid} - every member will get the key again`);
  return removed;
}

// Fresh member list before every group send, so the keys reach everyone who is in the group NOW
const groupCache = new Map();
async function groupMeta(jid, fresh = false) {
  const hit = groupCache.get(jid);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const data = await sock.groupMetadata(jid);
  groupCache.set(jid, { at: Date.now(), data });
  return data;
}
const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
const QR_TIMEOUT_MS = 75000; // how long one QR stays valid before Baileys makes a new one

let sock = null;
let gen = 0;            // only the newest socket's events count
let starting = false;   // never build two sockets at once
let retry = 0;
let reconnectTimer = null;
let wantPairingFor = null; // phone number waiting for a pairing code

const status = {
  // linking | connected | reconnecting | replaced | logged_out | error
  state: 'linking',
  stage: 'starting',     // what to tell the user while linking
  qrDataUrl: null,
  qrExpiresAt: null,
  pairingCode: null,
  pairingNumber: null,
  me: null,
  lastError: null,
  connectedAt: null,
  attempts: 0,
};

const isConnected = () => status.state === 'connected';
const registered = () => !!sock?.authState?.creds?.registered;

function scheduleRestart(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => start().catch((e) => log('Reconnect error:', e.message)), ms);
}

async function start() {
  if (starting) return;
  starting = true;
  if (!sentStore.size) loadSent();
  clearTimeout(reconnectTimer);
  const myGen = ++gen;
  try {
    if (sock) { try { sock.end(undefined); } catch {} sock = null; }
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

    if (!state.creds.registered) {
      status.state = 'linking';
      if (!status.qrDataUrl && !status.pairingCode) status.stage = 'starting';
    } else if (status.stage === 'finishing') {
      // just scanned/paired - keep showing "almost done" instead of flashing "reconnecting"
      status.state = 'linking';
    } else if (status.state !== 'connected') {
      status.state = 'reconnecting';
    }
    status.attempts++;

    const s = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
      qrTimeout: QR_TIMEOUT_MS,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 1000,
      maxMsgRetryCount: 5,
      defaultQueryTimeoutMs: 60000,
      // answer "please send it again" requests from members whose phone could not read the image
      getMessage: async (key) => sentStore.get(key?.id) || undefined,
      cachedGroupMetadata: async (jid) => groupCache.get(jid)?.data,
    });
    sock = s;

    s.ev.on('creds.update', async () => { await saveCreds(); waBackup.schedule(); });

    // A pairing code was requested before the socket existed - ask for it now
    if (wantPairingFor && !state.creds.registered) {
      const number = wantPairingFor;
      setTimeout(async () => {
        if (myGen !== gen || registered()) return;
        try {
          const code = await s.requestPairingCode(number);
          status.pairingCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          status.pairingNumber = number;
          status.stage = 'pairing';
          status.qrDataUrl = null;
          log(`Pairing code for ${number}: ${status.pairingCode}`);
        } catch (e) {
          wantPairingFor = null;
          status.lastError = 'Could not get a pairing code: ' + e.message;
          status.stage = 'qr';
          log(status.lastError);
        }
      }, 1500);
    }

    s.ev.on('connection.update', async (u) => {
      if (myGen !== gen) return; // event from an old socket - ignore
      const { connection, lastDisconnect, qr } = u;

      if (qr && !wantPairingFor) {
        status.state = 'linking';
        status.stage = 'qr';
        status.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        status.qrExpiresAt = Date.now() + QR_TIMEOUT_MS;
        status.lastError = null;
        if (process.env.PRINT_QR !== 'false') {
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
          log('Scan the QR above, or open the dashboard.');
        }
      }

      if (connection === 'open') {
        retry = 0;
        wantPairingFor = null;
        Object.assign(status, {
          state: 'connected', stage: 'done', qrDataUrl: null, qrExpiresAt: null,
          pairingCode: null, pairingNumber: null, lastError: null,
          connectedAt: new Date().toISOString(),
          me: { id: jidNormalizedUser(s.user?.id || ''), name: s.user?.name || '' },
        });
        log(`WhatsApp connected as ${status.me.id}`);
        waBackup.schedule(5000);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || '';

        // Right after a successful scan/pairing WhatsApp always asks for a restart - this is normal
        if (code === DisconnectReason.restartRequired) {
          status.stage = 'finishing';
          status.qrDataUrl = null;
          log('Link accepted - finishing connection…');
          return scheduleRestart(500);
        }
        if (code === DisconnectReason.loggedOut) {
          log('WhatsApp was unlinked from the phone. Clearing the session.');
          Object.assign(status, { state: 'logged_out', stage: 'starting', me: null, qrDataUrl: null, pairingCode: null });
          await waBackup.clearAll();
          return scheduleRestart(1500);
        }
        if (code === DisconnectReason.connectionReplaced) {
          Object.assign(status, {
            state: 'replaced',
            lastError: 'Another copy of this bot took over the WhatsApp session. Run only one copy (PC or server, not both), then press Reconnect.',
          });
          return log(status.lastError);
        }

        if (!registered()) {
          // still linking: the QR simply expired, or the connection dropped mid-scan
          status.state = 'linking';
          status.stage = status.pairingCode ? 'pairing' : 'refreshing';
          status.lastError = null;
          return scheduleRestart(1200);
        }

        status.state = 'reconnecting';
        status.lastError = msg || `connection closed (${code})`;
        const delay = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
        log(`WhatsApp disconnected (${code}). Reconnecting in ${Math.round(delay / 1000)}s`);
        scheduleRestart(delay);
      }
    });
  } finally {
    starting = false;
  }
}

async function requestPairingCode(phone) {
  const number = digits(phone);
  if (number.length < 8) throw new Error('Enter the full number with country code, digits only (example: 923001234567)');
  if (isConnected()) throw new Error('Already connected. Log out first to link another number.');
  wantPairingFor = number;
  status.pairingCode = null;
  status.qrDataUrl = null;
  status.stage = 'pairing';
  await start();                       // fresh socket that asks for the code
  for (let i = 0; i < 40; i++) {       // wait up to ~20s for the code
    if (status.pairingCode) return status.pairingCode;
    if (status.lastError) throw new Error(status.lastError);
    await sleep(500);
  }
  throw new Error('WhatsApp did not send a pairing code. Check your internet and try again.');
}

async function newQr() {
  wantPairingFor = null;
  status.pairingCode = null;
  status.qrDataUrl = null;
  status.stage = 'starting';
  await start();
}

async function logout() {
  gen++;                     // ignore the close event caused by our own logout
  clearTimeout(reconnectTimer);
  wantPairingFor = null;
  try { await sock?.logout(); } catch {}
  try { sock?.end(undefined); } catch {}
  sock = null;
  Object.assign(status, { state: 'linking', stage: 'starting', me: null, qrDataUrl: null, pairingCode: null, connectedAt: null });
  await waBackup.clearAll();
  await start();
}

async function reconnect() {
  retry = 0;
  status.lastError = null;
  await start();
}

async function listGroups() {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  const groups = await sock.groupFetchAllParticipating();
  const meIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j)));
  return Object.values(groups)
    .map((g) => {
      const parts = g.participants || [];
      const me = parts.find((p) => meIds.has(jidNormalizedUser(p.id || '')) || meIds.has(jidNormalizedUser(p.jid || '')));
      const admin = me ? !!me.admin : false;
      let kind = 'group';
      if (g.isCommunity) kind = 'community';
      else if (g.isCommunityAnnounce || (g.linkedParent && g.announce)) kind = 'announce';
      else if (g.linkedParent) kind = 'sub';
      return {
        id: g.id,
        name: g.subject || '(no name)',
        kind,
        type: { community: 'Community (cannot post here)', announce: 'Community Announcements', sub: 'Group inside a community', group: 'Group' }[kind],
        members: parts.length,
        admin,
        adminOnly: !!g.announce,
        canPost: kind !== 'community' && (!g.announce || admin),
      };
    })
    .sort((a, b) => (b.canPost - a.canPost) || (b.admin - a.admin) || a.name.localeCompare(b.name));
}

async function sendImage(jid, buffer, mimetype, caption) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  let members = null;
  if (jid.endsWith('@g.us')) {
    try {
      const meta = await groupMeta(jid, true);      // always fresh before a group send
      members = (meta.participants || []).length;
    } catch (e) {
      log('Could not refresh the group member list:', e.message);
    }
    refreshSenderKey(jid);                          // make sure every member can open it
  }
  const msg = await sock.sendMessage(jid, { image: buffer, mimetype, ...(caption ? { caption } : {}) });
  rememberSent(msg);
  return { id: msg?.key?.id || null, members };
}

async function sendText(jid, text) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  rememberSent(await sock.sendMessage(jid, { text }));
}

module.exports = { start, status, isConnected, groupMeta, refreshSenderKey, requestPairingCode, newQr, logout, reconnect, listGroups, sendImage, sendText };
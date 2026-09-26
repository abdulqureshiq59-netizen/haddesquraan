// Small shared helpers: logging, Kuwait-time maths, image picking
const zlib = require('zlib');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// WhatsApp's crypto library prints "Bad MAC" / "Failed to decrypt" / "Closing session" for every
// incoming message it cannot read. The bot only SENDS, so this is harmless noise that hides the
// real messages. Set DEBUG_SIGNAL=1 in .env if you ever want to see it.
const NOISE = /Bad MAC|Failed to decrypt|Closing session|SessionEntry|verifyMAC|session_cipher|queue_job|libsignal|No session record|MessageCounterError/i;
function quietNoise() {
  if (process.env.DEBUG_SIGNAL === '1') return;
  let muted = 0;
  for (const m of ['log', 'error', 'warn']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : (first && first.message) || '';
      if (NOISE.test(text) || (first && first.stack && NOISE.test(first.stack))) { muted++; return; }
      orig(...args);
    };
  }
  setInterval(() => {
    if (muted) { log(`(${muted} WhatsApp decrypt messages hidden - harmless, the bot only sends)`); muted = 0; }
  }, 10 * 60 * 1000).unref();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (v) => String(v || '').replace(/\D/g, '');

// Current date + minutes-since-midnight in a given timezone (server timezone does not matter)
function nowParts(tz = 'Asia/Kuwait', date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    label: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`,
  };
}

function parseHHMM(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Invalid time "${t}" (use HH:MM, e.g. 04:00)`);
  return { h: +m[1], m: +m[2], minutes: +m[1] * 60 + +m[2] };
}

// Pick the next never-sent image. order: name (natural, 1..2..10) | created | random
function chooseNext(files, sentIds, order = 'name') {
  const sent = new Set(sentIds || []);
  const unsent = files.filter((f) => !sent.has(f.id));
  if (!unsent.length) return { file: null, remaining: 0 };
  let file;
  if (order === 'random') {
    file = unsent[Math.floor(Math.random() * unsent.length)];
  } else if (order === 'created') {
    file = [...unsent].sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''))[0];
  } else {
    file = [...unsent].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    )[0];
  }
  return { file, remaining: unsent.length - 1 };
}

// Compact encoding for backups stored in Google Sheets
const encode = (obj) => 'gz:' + zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const decode = (str) => JSON.parse(zlib.gunzipSync(Buffer.from(String(str).slice(3), 'base64')).toString());

module.exports = { log, quietNoise, sleep, digits, nowParts, parseHHMM, chooseNext, encode, decode };
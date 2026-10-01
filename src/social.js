// Posting to Instagram (and anything else) through a Make.com webhook.
//
// We never touch Instagram directly: the bot sends Make a small JSON message with a
// public link to the image plus the caption, and Make - which is already approved by
// Meta - does the actual posting. No Meta app, no app review, no login automation.
//
// The image link points back at this same server (/img/...), so no extra hosting is
// needed. The link is signed so it cannot be guessed.
const crypto = require('crypto');
const { log, sleep } = require('./util');

const TIMEOUT_MS = 30000;
const TRIES = 3;

function webhookUrl() {
  return (process.env.SOCIAL_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL || '').trim();
}

// Render sets RENDER_EXTERNAL_URL by itself, so normally nothing has to be configured.
// On your own PC a Cloudflare tunnel provides the address instead (see tunnel.js).
function publicBase() {
  const v = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (v) return v.replace(/\/+$/, '');
  try { return require('./tunnel').current() || ''; } catch { return ''; }
}

function secret() {
  return String(process.env.IMG_SECRET || process.env.DASHBOARD_PASSWORD || 'qh-img');
}
const sign = (fileId) => crypto.createHmac('sha256', secret()).update(String(fileId)).digest('hex').slice(0, 12);
const verify = (fileId, sig) => {
  const want = Buffer.from(sign(fileId));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

function imageUrl(fileId) {
  const base = publicBase();
  if (!base) throw new Error('PUBLIC_URL is not set, so Instagram has no link to download the image from');
  return `${base}/img/${encodeURIComponent(fileId)}.${sign(fileId)}.jpg`;
}

// Two ways to give Instagram a link it can download from:
//
//   own server  - PUBLIC_URL is set (Render), so the /img/... link on this same server is used.
//   upload      - no PUBLIC_URL (running on your own PC, which the internet cannot reach):
//                 the picture is uploaded to a temporary image host and that link is used.
//                 The link dies by itself after 3 days, which is long after Instagram has
//                 taken its copy.
// Several free image hosts, tried one after another - if one is blocked by the internet
// provider (which happens), the next one is used. The link only has to live long enough
// for Instagram to fetch its own copy, which takes seconds.
// Ones that answer with the picture itself come first. tmpfiles is last because it
// sometimes answers with its own web page, which Instagram cannot use.
const HOSTS = [
  { name: 'uguu.se', url: 'https://uguu.se/upload', field: 'files[]' },
  { name: '0x0.st', url: 'https://0x0.st', field: 'file' },
  { name: 'catbox', url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    field: 'fileToUpload', extra: { reqtype: 'fileupload', time: '72h' } },
  { name: 'file.io', url: 'https://file.io/?expires=1d', field: 'file' },
  { name: 'tmpfiles.org', url: 'https://tmpfiles.org/api/v1/upload', field: 'file' },
];
function hosts() {
  const forced = (process.env.IMAGE_HOST_URL || '').trim();
  return forced ? [{ name: 'your own host', url: forced, field: 'file' }, ...HOSTS] : HOSTS;
}
const useUpload = () => !publicBase();

// Every host answers differently: some give the plain link, some give JSON
function linkFrom(text) {
  const t = String(text || '').trim();
  // Instagram refuses plain http, and tmpfiles needs /dl/ for the picture itself
  const tidy = (u) => {
    const v = String(u).replace(/tmpfiles\.org\/(?!dl\/)/i, 'tmpfiles.org/dl/');
    return /^http:\/\/(127\.0\.0\.1|localhost)/i.test(v) ? v : v.replace(/^http:/i, 'https:');
  };
  if (/^https?:\/\//i.test(t)) return tidy(t);
  try {
    const j = JSON.parse(t);
    const hit = j?.data?.url || j?.url || j?.files?.[0]?.url || j?.href;
    if (hit) return tidy(hit);
  } catch {}
  return null;
}

async function uploadOne(host, buffer, name) {
  const form = new FormData();
  for (const [k, v] of Object.entries(host.extra || {})) form.append(k, v);
  form.append(host.field, new Blob([buffer], { type: 'image/jpeg' }), name || 'post.jpg');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const res = await fetch(host.url, {
      method: 'POST',
      body: form,
      signal: ac.signal,
      headers: { 'User-Agent': 'quran-hadees-bot/1.0' },  // 0x0.st refuses requests without one
    });
    const text = await res.text();
    const link = res.ok ? linkFrom(text) : null;
    if (!link) throw new Error(`answered ${res.status} ${String(text).slice(0, 80)}`);
    return link;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'no answer in 45s' : (e.cause?.message || e.message));
  } finally {
    clearTimeout(timer);
  }
}

async function uploadTemp(buffer, name) {
  const tried = [];
  for (const host of hosts()) {
    try {
      const link = await uploadOne(host, buffer, name);
      // uploading is not enough - the link has to give the picture back, or Instagram
      // refuses it and Make.com switches the whole scenario off
      await checkLink(link);
      log(`Instagram: picture uploaded to ${host.name}`);
      return link;
    } catch (e) {
      tried.push(`${host.name}: ${e.message}`);
      log(`Instagram: ${host.name} did not work (${e.message}), trying the next one`);
    }
  }
  throw new Error(
    'no image host could be reached from this computer, so Instagram has nowhere to download from. ' +
    'Tried - ' + tried.join(' | ') + '. On Render this is not needed at all, PUBLIC_URL is used there.'
  );
}

// Why Instagram posting is off right now, in plain words (null = it is ready)
function notReady(settings) {
  if (!settings.instagramOn) return 'Instagram posting is switched off in Settings';
  if (!webhookUrl()) return 'SOCIAL_WEBHOOK_URL is not set - paste the Make.com webhook address there';
  return null;
}

const enabled = (settings) => !notReady(settings);

// Make.com switches the whole scenario OFF when Instagram refuses a post, which would
// silently stop the client's daily posting. So the link is checked here first: if it does
// not answer with a real JPEG, nothing is sent to Make and the reason is reported instead.
async function checkLink(link) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(link, { signal: ac.signal });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\/jpeg/i.test(type)) {
      const where = new URL(link).origin;
      throw new Error(
        useUpload()
          ? `${where} gave back a web page instead of the picture (${res.status} ${type || 'no type'})`
          : `the image link does not give back a JPEG (${res.status} ${type || 'no type'}). ` +
            `Check that ${where} is running the latest code and that IMG_SECRET is the same there as here.`
      );
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > 8 * 1024 * 1024) throw new Error('the image is bigger than the 8 MB Instagram allows');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('the image link did not answer in 20s');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function post({ fileId, caption, item, file, buffer }) {
  const url = webhookUrl();
  if (!url) throw new Error('No Make.com webhook address is set');

  let link;
  if (useUpload()) {
    if (!buffer) throw new Error('the picture itself is needed to upload it');
    const { buffer: jpeg } = await require('./image').forInstagram(buffer);
    link = await uploadTemp(jpeg, file);
  } else {
    link = imageUrl(fileId);
    await checkLink(link);
  }
  const body = JSON.stringify({
    image_url: link,
    caption: caption || '',
    platform: 'instagram',
    item: item || '',
    file: file || '',
    at: new Date().toISOString(),
  });

  let last;
  for (let i = 1; i <= TRIES; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      });
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (!res.ok) throw new Error(`Make.com answered ${res.status} ${text}`);
      log(`Instagram: handed "${file || fileId}" to Make.com (${text || 'accepted'})`);
      return { ok: true, answer: text };
    } catch (e) {
      last = e.name === 'AbortError' ? new Error('Make.com did not answer in 30s') : e;
      if (i < TRIES) await sleep(3000 * i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

module.exports = { post, checkLink, uploadTemp, uploadOne, useUpload, linkFrom, imageUrl, sign, verify, enabled, notReady, webhookUrl, publicBase };

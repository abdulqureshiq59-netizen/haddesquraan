// Gives this bot a public https address while it runs on your own PC.
//
// On Render the address already exists (PUBLIC_URL), so this file does nothing there.
// On your own computer the internet cannot reach localhost, and Instagram has to be able
// to download the picture. So a Cloudflare "quick tunnel" is opened: it hands out a
// temporary https address that points at this bot. Nothing to sign up for, nothing to
// configure, and it closes when the bot closes.
const { spawn } = require('child_process');
const { log } = require('./util');

let url = null;
let child = null;
let starting = null;

const READY = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

async function binary() {
  const own = (process.env.CLOUDFLARED_BIN || '').trim();   // if you already have cloudflared
  if (own) return own;
  let cf;
  try {
    cf = require('cloudflared');
  } catch {
    throw new Error('the tunnel helper is missing - run:  npm install cloudflared');
  }
  const fs = require('fs');
  if (!fs.existsSync(cf.bin)) {
    log('Tunnel: downloading the helper once (about 20 MB)...');
    await cf.install(cf.bin);
  }
  return cf.bin;
}

function start(port) {
  if (url) return Promise.resolve(url);
  if (starting) return starting;

  starting = (async () => {
    const bin = await binary();
    return await new Promise((resolve, reject) => {
      child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        stop();
        reject(new Error('the tunnel did not come up in 90s'));
      }, 90000);

      const look = (chunk) => {
        const hit = READY.exec(String(chunk));
        if (!hit || url) return;
        url = hit[0];
        clearTimeout(timer);
        log(`Tunnel: this bot is reachable at ${url} (only while it is running)`);
        resolve(url);
      };
      child.stdout.on('data', look);
      child.stderr.on('data', look);   // cloudflared prints the address on stderr
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        if (!url) { clearTimeout(timer); reject(new Error(`the tunnel stopped straight away (code ${code})`)); }
        url = null;
        child = null;
      });
    });
  })().catch((e) => {
    starting = null;
    throw e;
  });

  return starting;
}

function stop() {
  if (child) { try { child.kill(); } catch {} }
  child = null;
  url = null;
  starting = null;
}

module.exports = { start, stop, current: () => url };

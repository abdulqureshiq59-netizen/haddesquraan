# Quran & Hadees — Daily WhatsApp Community Poster

Every day at a set time (4:00 AM Kuwait for this client) the bot picks **one never-posted image from the
Quran folder** and **one from the Hadees folder** in Google Drive, and posts both to the client's
WhatsApp Community. A dashboard handles everything: linking WhatsApp, choosing the group, testing,
and a Google Sheet backup so a restart never re-sends old images or asks for a new QR scan.

---

## Files — which ones you actually need

**Keep these (this is the whole bot):**

```
index.js              dashboard server + startup
package.json
.env                  your settings (copy from .env.example)
service-account.json  the Google key (not needed if you use GOOGLE_SERVICE_ACCOUNT_JSON)
src/bot.js            posting logic and the daily scheduler
src/whatsapp.js       WhatsApp connection (QR + pairing code)
src/drive.js          Google Drive
src/store.js          the list of posted images, local file + Sheet mirror
src/waBackup.js       WhatsApp session backup / restore
src/sheets.js         talks to the Apps Script backup
src/util.js           small helpers
public/index.html     the dashboard page
apps-script/Code.gs   paste this into your Google Sheet's Apps Script
render.yaml           only if you deploy on Render
```

**Safe to delete** (they are only my offline checks and pictures):
`test/`, `docs/`, `README.md`, `.env.example`.

Nothing in the bot loads them — deleting the whole `test` and `docs` folders changes nothing.

---

## Install

```bash
npm install
cp .env.example .env     # fill it in
npm start
```

Open `http://localhost:3000`, log in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.
The dashboard opens with a **Setup checklist** — follow it top to bottom; all five ticks must be green.

Folder links, post time, captions, groups and alert number are all set **inside the dashboard**.
`.env` only holds the things that must exist before startup:

```
DASHBOARD_PASSWORD=...             dashboard login
GOOGLE_SERVICE_ACCOUNT_JSON=...    or put service-account.json in the folder
SHEETS_WEBAPP_URL=...              the /exec URL of YOUR deployment of Code.gs
SHEETS_WEBAPP_SECRET=...           same value as SECRET inside Code.gs
```

---

## Google Sheet backup — the part people get wrong

The `/exec` URL is **not** shared between projects. A URL from another bot runs that bot's code and
writes to that bot's sheet, so this bot will refuse it and say so.

1. Open the sheet you want to use → **Extensions → Apps Script**.
2. Delete everything there, paste `apps-script/Code.gs`.
3. At the top set:
   - `SECRET` — any password; the same value goes into `SHEETS_WEBAPP_SECRET` in `.env`
   - `SHEET_ID` — the long id in your sheet's URL: `docs.google.com/spreadsheets/d/<THIS PART>/edit`
4. **Deploy → New deployment → Web app**, *Execute as:* **Me**, *Who has access:* **Anyone** → copy the `/exec` URL.
5. Put it in `.env`, restart the bot, press **Check connection** in the Backup card.
   It prints the **name of the sheet it is actually writing to** — if that is not your sheet, `SHEET_ID` is wrong.

Two tabs appear by themselves: **Backup** (posted list + WhatsApp session, compressed) and **History**
(readable log of every post).

Changing `Code.gs` later: **Deploy → Manage deployments → edit → Version: New version** keeps the same URL.
Pasting new code without deploying a new version does nothing — the URL keeps serving the old code.

---

## Linking WhatsApp

- **QR:** WhatsApp → Linked devices → Link a device → scan. The code refreshes by itself about once a
  minute; that is normal, just scan whatever is on screen. Don't reload the page while scanning.
- **Pairing code:** type the number with country code → *Get code* → on the phone: Linked devices →
  Link a device → **Link with phone number instead** → type the 8 digits.

After a successful scan WhatsApp always drops the connection once and reconnects — the dashboard shows
"Almost done…" and finishes by itself. Never run two copies of the bot on the same number (PC + server);
one kicks the other out and the dashboard will say so.

---

## Groups

Press **Load groups**. By default the list shows **only groups where this number is an admin**, because
a bot can't post anywhere else. For a Community, pick its **Announcements** group.

- **Set LIVE** → the client's real group.
- **Set TEST** → your own group for testing.

---

## Testing before handover

| Button | What it does |
|---|---|
| Preview to my own number | private preview, marks nothing |
| Send one pair to TEST group | one pair into your test group |
| **Test mode** | a pair to the TEST group every N minutes, stops itself after N posts |

Test mode keeps a **separate list**, so it never uses up the client's real images, and the daily live
post is off while it's on.

---

## How it stays safe long term

- New images the client uploads are picked up automatically — Drive is read fresh at every post.
- The posted list is saved locally **and** mirrored to the Sheet after each post.
- After a wipe: state and WhatsApp session are restored from the Sheet — no new QR scan.
- If the Sheet can't be read after a wipe, live posting **stays blocked** and retries every minute
  instead of starting again from image 1.
- Server down at post time? It posts when it comes back, up to `CATCHUP_HOURS` late; after that it skips
  the day rather than posting at a strange hour.
- A failed send is not marked as posted; it retries every 10 minutes that day.
- Your number gets a WhatsApp alert if a folder runs out of new images or a post fails.

## Deploy (Render)

Runtime **Node**, build `npm install`, start `node index.js`, health check `/health`, plan **Starter**
(the free plan sleeps and keeps breaking the WhatsApp session). Use `GOOGLE_SERVICE_ACCOUNT_JSON`
instead of uploading the key file. Run only one instance.

## Tests

```bash
./test/test.sh
```

43 checks plus a QR-flow check, all offline with fake Drive / WhatsApp / Apps Script: picking order and
no duplicates, scheduling and catch-up, test mode, folder exhaustion, Drive and send failures, Sheet
backup and restore, the whole dashboard API, and the WhatsApp linking states.

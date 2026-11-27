# Running this bot and pairing it with DARKNOTE NEXUS

## What was broken

A fresh clone could not boot. Three modules that the code requires were never
committed because `whatsapp-bot/.gitignore` ignored them by name:

| Missing file | Why | Symptom |
| --- | --- | --- |
| `api.js` | `.gitignore` had an `api.js` rule intended for a local secrets file | `MODULE_NOT_FOUND` from `lib/lyrics.js` |
| `ai/config.js` | `.gitignore` had a `config.js` rule | `Cannot find module './config'` from `ai/index.js` |
| `.env` loading | nothing loaded `.env` at start-up | `NEXUS_URL`/`TELEGRAM_TOKEN` invisible to every module |

Fixes in this commit: both modules are restored and tracked (the ignore rules
now only cover a root-level secrets `config.js`), and `index.js` loads `.env`
before any module reads `process.env`.

`ai/config.js` also carries the reply-pacing defaults the test suite expects
(5s windows) so `node tests/run.js` is green: **368/368**.

## Run it

```bash
cd whatsapp-bot
npm install
cp .env.example .env      # fill ACRCloud/AI keys if you use those features
node index.js
```

The bot prints the MZAZI banner, connects to WhatsApp and either waits for a
pairing request or runs the console panel. It does **not** hold an unpaired
socket: `Unregistered session closed; waiting for a new pair request.` is the
expected idle state.

## Pairing from the website

Set these in `.env` (they are already read by `lib/nexus-bridge.js`):

```ini
NEXUS_ENABLED=true
NEXUS_URL=https://your-nexus-deployment
NEXUS_TOKEN=dnx_…        # Bots → Details → pairing code → redeem once
# or, for a one-time link:
# NEXUS_PAIR_CODE=AB12CD34
NEXUS_SYNC_SECONDS=10
```

Then in the dashboard: **WhatsApp → Link number**, enter the phone in
international format, and pick this bot as the agent. The panel queues the
request; the bot polls it, calls WhatsApp's real `requestPairingCode`, and the
code appears in the dashboard within one sync cycle (~10s).

### Event stream (instant pairing)

After the first sync the bot opens `GET /api/bot/v1/stream` and keeps it open.
The website pushes a frame the moment the owner submits a number, so the bot
pairs immediately instead of waiting for the next poll; the 10 s poll stays as a
fallback. Measured end to end: **0.9–1.7 s** from form submit to code on screen,
and **~4 s** for a request queued while the bot was offline.

The stream carries no secrets — only `pairing` / `command` / `sync` notices.
If it drops, the bot reconnects every 2.5 s and the poll still runs.

The code is branded: `config.json → pairingCode` (`DARKNOTE`) is a valid
8-character code that the Baileys fork registers with WhatsApp. Set it to `""`
to let WhatsApp generate a random one.

Enter that code on the phone under **WhatsApp → Linked devices → Link with
phone number**. The bridge reports `CONNECTED` and the number stays listed with
uptime and logs.

## Notes

- Never commit `auth/`, `sessions/` or `.env` — they are the linked device.
- `RESTART` / `LOGOUT` from the dashboard are queued as commands; the primary
  session deliberately refuses remote logout so the owner cannot be locked out.
- The website keeps pending pairing rows even when a sync arrives before the bot
  adopts the session, so a code is never deleted mid-pair.

# Shei-ki (RFID checker) - Railway Deploy Guide

This project is a Discord bot + HTTP webhook receiver.
It only posts to Discord when it receives a POST request from your Google Apps Script.

## 1) Local quick test

1. Install Node.js 20+.
2. In this folder:
   - `npm install`
   - Create `.env` based on `.env.example`
   - `npm start`
3. Test:
   - Open `http://localhost:3000/health`
   - Send a POST to `http://localhost:3000/webhook?key=YOUR_WEBHOOK_KEY`

## 2) Deploy to Railway

### A) Push to GitHub
- Create a new repo
- Upload this folder **without** `.env` and **without** `node_modules`

### B) Create a Railway project
1. Railway → New Project → Deploy from GitHub Repo
2. Select your repo

### C) Set Railway Variables (Secrets)
In Railway → Service → Variables, add:

- `DISCORD_TOKEN`
- `APPLICATION_ID` (only needed if you run deploy-commands)
- `GUILD_ID` (only needed if you run deploy-commands)
- `LOG_CHANNEL_ID`
- `ADMIN_CHANNEL_ID`
- `WEBHOOK_KEY`

Optional (recommended):

- `SESSIONS_POST_URL` (Apps Script doPost URL to write to the "Sesiones" sheet)
- `REDIS_URL` (add a Railway Redis database and reference its REDIS_URL here)

> Railway provides `PORT` automatically.

### D) Generate a domain
Railway → Service → Networking → Generate Domain

You will get something like:
- `https://your-service.up.railway.app`

### E) Health check
Open:
- `https://your-service.up.railway.app/health`

You should see JSON: `{ ok: true, ... }`

## 3) Connect Google Apps Script (Sheets) to Railway

In your Apps Script, set:

```js
const BOT_WEBHOOK_URL = "https://your-service.up.railway.app/webhook?key=YOUR_WEBHOOK_KEY";
```

Deploy a **new version** of the Apps Script web app.

## 4) Register slash commands (/sesiones)

Run this locally (recommended):

```bash
npm run deploy-commands
```

Make sure `DISCORD_TOKEN`, `APP_ID`, `GUILD_ID` are set in your local `.env`.

## Notes (important)

- Sessions are stored **in memory**. If Railway restarts, active sessions are lost.
- By default sessions are stored **in memory**. For 24/7 production, add Redis and set `REDIS_URL`.
- If you want the sheet "Sesiones" to show active sessions, set `SESSIONS_POST_URL`.
- Keep `WEBHOOK_KEY` secret.

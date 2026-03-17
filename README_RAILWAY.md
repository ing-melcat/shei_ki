# Shei-ki (RFID → Sheets → Discord)

## 1) Variables
Configura en Railway:
- DISCORD_TOKEN
- LOG_CHANNEL_ID
- ADMIN_CHANNEL_ID
- WEBHOOK_KEY
- SESSIONS_POST_URL
- (opcional) REDIS_URL (si agregas Redis en Railway)

## 2) Endpoint
- POST /webhook?key=WEBHOOK_KEY
- GET /health

## 3) Deploy slash commands (solo 1 vez o cuando cambien)
En tu PC (NO Railway):
1) crea .env local con DISCORD_TOKEN, APPLICATION_ID, GUILD_ID
2) npm install
3) npm run deploy-commands
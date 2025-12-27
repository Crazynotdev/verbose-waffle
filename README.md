```markdown
# CRAZY MINI

Web SaaS — WhatsApp bot with Baileys Pairing Code (real WhatsApp Web).

Structure:
- server.js (main)
- pair/pair.js (pairing logic using Baileys)
- bot/commands.js (message command handler)
- sessions/ (auth state files per session)
- public/ (frontend)
- package.json
- ecosystem.config.js (pm2)

Install:
1. node >= 18
2. npm install
3. copy `.env` from `.env.example` and fill secrets
4. npm start

Notes:
- Uses lowdb (JSON) for a simple persistent store. Replace with PostgreSQL if needed for scale.
- Sessions are stored under `SESSIONS_DIR` with useMultiFileAuthState.
```

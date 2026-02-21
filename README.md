# Muëcy Ops (MVP)

This is the **cloud** version (Railway/Render) of Muëcy Ops:
- Reads recent Gmail (last 7 days) and creates tasks
- Telegram bot to create tasks and get a daily briefing
- Google OAuth connect endpoint

## Quick start (Railway)
1) Create a GitHub repo and upload this folder.
2) In Railway: New Project -> Deploy from GitHub.
3) Add Postgres plugin and copy its DATABASE_URL into Railway Variables.
4) Add variables from `server/.env.example`.
5) In Google Cloud Console:
   - Create OAuth Client
   - Add Authorized redirect URI:
     `https://YOUR-APP.DOMAIN/auth/google/callback`
6) Open:
   `https://YOUR-APP.DOMAIN/auth/google`

## Telegram commands
- `tarea: cortar fillers cocina / Producción / high`
- `top`
- `hoy`
- `done: fillers`

## Endpoints
- GET `/` health
- GET `/auth/google` start OAuth
- GET `/auth/google/callback` OAuth callback
- POST `/sync` manual Gmail sync

# Comet Edge Server (Self-hosted)

Drop-in replacement for the Cloudflare Worker + Durable Objects edge, using
Bun + Hono + bun:sqlite. Same API contract, no rows_written limit.

## Quick start (Docker)

```bash
# 1. Clone and configure
git clone <repo>
cd comet/apps/server
cp .env.example .env
# Edit .env — at minimum set AUTH_MODE and WORKOS_* (or use dev mode)

# 2. Start
docker compose up -d

# 3. Verify
curl http://localhost:3000/health
# → {"ok":true,"auth":"dev"}
```

## Running locally (without Docker)

```bash
cd apps/server
bun install
AUTH_MODE=dev bun run src/server.ts
```

## Configuration

All config via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Root for SQLite, blobs, KV |
| `PORT` | `3000` | HTTP/WS listen port |
| `AUTH_MODE` | `dev` | `dev` (bearer=userId) or `workos` |
| `WORKOS_CLIENT_ID` | | WorkOS client id |
| `WORKOS_API_KEY` | | WorkOS secret (powers /auth/*) |
| `SETTINGS_ENCRYPTION_KEY` | | Base64 32-byte AES-256 key |
| `PUSH_INTERNAL_SECRET` | | Shared secret for /push/send |

## Data layout

```
data/
├── rooms/          # SQLite files: {roomId}.db (one per room)
├── blobs/          # Attachments, settings, backups
│   ├── att/{userId}/{sha256}
│   ├── settings/{userId}
│   └── backup/{chatId}/latest.loro
├── releases/       # Release artifacts served at /releases/*
└── push-tokens.json
```

## API

Identical to the Cloudflare Worker. See the full route list in `plan.md`.

## Clients

Point clients at the new server:
- **Rust engine**: set `EDGE_URL=http://your-server:3000`
- **Mobile app**: set `EDGE_URL` in `AppConfig.ts`

## Backup

Daily cron on the host:

```bash
0 3 * * * docker exec comet-server bun -e "
  const fs = require('fs');
  const dir = '/app/data/rooms';
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.db')) {
      // SQLite online backup
    }
  }
" && rsync -av /var/comet/data/ backup@storage:/backup/
```

## TLS

The included `Caddyfile` + `docker-compose.yml` provide automatic TLS via
Let's Encrypt. If running behind Cloudflare or a load balancer, remove the
`caddy` service and expose `comet-server` directly.

## Cost

~$5-7/month on a 1-2 vCPU VPS. No rows_written limit.

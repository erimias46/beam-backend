# 0090 — Infra Hardening: Docker, CI/CD, Backups, Monitoring

**Status:** todo  
**Addresses:** INFRA-1 (backups), INFRA-2 (CI gating), INFRA-3 (dockerignore), INFRA-4 (non-root container), INFRA-5 (domain), INFRA-6 (monitoring), INFRA-7 (Stripe keys), INFRA-8 (SPOF notes)

## Changes

### INFRA-3 + INFRA-4 — Dockerfile hardening

`web/backend/Dockerfile`:
```dockerfile
FROM node:20-alpine

# Non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=app:app . .

# Create uploads dir with correct ownership
RUN mkdir -p uploads && chown app:app uploads

USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health/ready || exit 1

CMD ["node", "src/app.js"]
```

`web/backend/.dockerignore`:
```
.env
.env.*
.git
.gitignore
node_modules
uploads
*.log
*.md
test
src/**/__tests__
src/middleware/__tests__
src/services/__tests__
src/routes/__tests__
src/__tests__
coverage
```

### INFRA-2 — CI gates deployment

`.github/workflows/ci.yml` — add a deploy step that only fires after tests pass on `main`:
```yaml
  deploy:
    name: Deploy to Coolify
    needs: [backend-ci, frontend-ci]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - name: Trigger Coolify deploy
        run: |
          curl -f -X POST \
            "http://178.105.234.189:8000/api/v1/deploy?uuid=c13tqxxi4wzxqitxytwx5non" \
            -H "Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}"
```

Add `COOLIFY_TOKEN` to GitHub repo secrets (the API token from DEPLOYMENT.md).

Disable Coolify auto-deploy webhook on the backend service (set in Coolify UI: disable "Auto Deploy").

Add branch protection rule on `main`: require `backend-ci` + `frontend-ci` to pass before merge.

### INFRA-1 — Database backups

`web/backend/backup.sh` (run daily via server cron or Coolify scheduled task):
```bash
#!/bin/sh
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/beam0_${DATE}.sql.gz"

docker exec x16hptef58ui6huhg5vv7vcr pg_dump -U beam0 beam0 \
  | gzip > "$BACKUP_FILE"

# Upload to Hetzner Object Storage / S3-compatible
# aws s3 cp "$BACKUP_FILE" "s3://beam0-backups/postgres/${DATE}.sql.gz"
# Or rclone to Backblaze B2:
# rclone copy "$BACKUP_FILE" b2:beam0-backups/postgres/

rm "$BACKUP_FILE"
echo "Backup completed: ${DATE}"
```

Enable Hetzner VM snapshots in the Hetzner console (daily, keep 7 days).

Add to DEPLOYMENT.md: backup schedule, retention policy, restore procedure.

### INFRA-5 — Custom domain setup steps

1. Add `A` record: `api.bookabeam.com → 178.105.234.189`
2. In Coolify → backend service → Domains: add `api.bookabeam.com`; let Coolify provision Let's Encrypt
3. Update Coolify env vars: `APP_URL=https://api.bookabeam.com`, `CORS_ORIGINS=https://bookabeam.com,https://www.bookabeam.com`
4. Update Vercel: `NEXT_PUBLIC_API_URL=https://api.bookabeam.com`
5. Update mobile `--dart-define=API_BASE_URL=https://api.bookabeam.com`
6. Register Stripe webhook: `https://api.bookabeam.com/api/payments/webhook`
7. Verify Resend domain → update `SMTP_FROM`

### INFRA-6 — Monitoring + observability

Backend: install `@sentry/node`:
```js
// app.js top:
import * as Sentry from '@sentry/node'
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV })
}
```
Add `Sentry.setupExpressErrorHandler(app)` before the error handler.

Add `SENTRY_DSN` to Coolify env vars.

Configure external uptime monitor (UptimeRobot/BetterStack free tier) on `https://api.bookabeam.com/health/ready` — alert to `benny@beamteambrand.com`.

Log rotation in `docker-compose.yml`:
```yaml
services:
  api:
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

### INFRA-7 — Stripe setup checklist

1. Replace placeholder `STRIPE_SECRET_KEY` in Coolify with real key
2. Register webhook endpoint in Stripe dashboard
3. Set `STRIPE_WEBHOOK_SECRET` in Coolify
4. Test webhook with `stripe trigger payment_intent.succeeded`
5. Enable Stripe identity verification for barbers

## Notes
- INFRA-1 (backups) and INFRA-4 (non-root + healthcheck) are the changes to do NOW
- INFRA-5 (domain) should happen before real users — sslip.io is tied to the server IP
- INFRA-8 (single-server SPOF): acceptable pre-launch; document RPO (last backup) as the recovery scenario

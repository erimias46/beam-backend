# Bookabeam Deployment

## Server

| Field | Value |
|-------|-------|
| Provider | Hetzner Cloud |
| Plan | CPX32 (4 vCPU, 8GB RAM, 160GB disk) |
| Location | Nuremberg, Germany (eu-central) |
| OS | Ubuntu 24.04 |
| IP | 178.105.234.189 |
| SSH Key | `~/.ssh/id_ed25519` (on your Mac) |
| SSH Command | `ssh -i ~/.ssh/id_ed25519 root@178.105.234.189` |

---

## Coolify

Self-hosted PaaS running on the Hetzner server. Manages all deployments.

| Field | Value |
|-------|-------|
| UI | http://178.105.234.189:8000 |
| Version | 4.1.1 |
| API Base URL | http://localhost:8000/api/v1 (from inside server) |
| API Token | `[secret — stored in password manager]` |
| Token Name | claude-setup |
| Token Scope | root |

### Coolify Resources

| Name | Type | UUID |
|------|------|------|
| localhost | Server | `bzgqt8dnp92r3vhr0019dc0n` |
| bookabeam | Project | `foq9ir2enfrtxseczmgmwpky` |
| production | Environment | `a6o0b6faolgyq6h54mzptdm3` |

### GitHub App

| Field | Value |
|-------|-------|
| Name | beam-team1 |
| UUID | `u10sklrxrgjhodec61nw331f` |
| GitHub Account | erimias46 |
| Repo | erimias46/beam-backend |

---

## PostgreSQL

| Field | Value |
|-------|-------|
| Coolify UUID | `x16hptef58ui6huhg5vv7vcr` |
| Image | postgres:16-alpine |
| Internal Host | `x16hptef58ui6huhg5vv7vcr` |
| Port | 5432 |
| Database | beam0 |
| Username | beam0 |
| Password | `[secret — see Coolify env vars]` |
| Internal URL | `postgresql://beam0:[password]@x16hptef58ui6huhg5vv7vcr:5432/beam0` |
| Public | No |

Connect via psql (from server):
```bash
docker exec -it x16hptef58ui6huhg5vv7vcr psql -U beam0 -d beam0
```

---

## Redis

| Field | Value |
|-------|-------|
| Coolify UUID | `pgp5sww35gbv22wis6o88phy` |
| Image | redis:7.2 |
| Internal Host | `pgp5sww35gbv22wis6o88phy` |
| Port | 6379 |
| Password | `[secret — see Coolify env vars]` |
| Internal URL | `redis://default:[password]@pgp5sww35gbv22wis6o88phy:6379/0` |
| Public | No |

---

## Backend API

| Field | Value |
|-------|-------|
| Coolify UUID | `c13tqxxi4wzxqitxytwx5non` |
| Repo | https://github.com/erimias46/beam-backend |
| Branch | main |
| Build | Dockerfile |
| Internal Port | 4000 |
| Public URL | https://c13tqxxi4wzxqitxytwx5non.178.105.234.189.sslip.io |
| Status | Running ✓ |
| Git SHA | `be91f21` (test: fix test suite + 6 new route tests) |
| Migrations | All 38 applied (001–075) — current: `075_receipt_token_hex.sql` |

### Environment Variables

| Key | Value | Status |
|-----|-------|--------|
| NODE_ENV | production | Set |
| PORT | 4000 | Set |
| DATABASE_URL | postgresql://beam0:[password]@x16hptef58ui6huhg5vv7vcr:5432/beam0 | Set |
| REDIS_URL | redis://default:[password]@pgp5sww35gbv22wis6o88phy:6379/0 | Set |
| JWT_SECRET | [secret — see Coolify env vars] | Set |
| VAPID_PUBLIC_KEY | BP5L7OXukgLqH1Yo6pwJED3BAczZTvVGLw34THB5UI1K7emzatZdLGGZ0-LJ8qmn3bRIkq9TuTIYmsV5geoLF-E | Set |
| VAPID_PRIVATE_KEY | [secret — see Coolify env vars] | Set |
| VAPID_SUBJECT | mailto:benny@beamteambrand.com | Set |
| SMTP_PORT | 587 | Set |
| SMTP_SECURE | false | Set |
| SMTP_FROM | Beam0 <noreply@gostartdev.com> | Set (temp — swap to bookabeam.com once verified on Resend) |
| SMTP_HOST | smtp.resend.com | Set |
| SMTP_USER | resend | Set |
| SMTP_PASS | [secret — see Coolify env vars] | Set |
| STRIPE_SECRET_KEY | — | Placeholder — needs real value |
| STRIPE_PUBLISHABLE_KEY | — | Placeholder — needs real value |
| STRIPE_WEBHOOK_SECRET | — | Placeholder — needs real value |
| APP_URL | https://c13tqxxi4wzxqitxytwx5non.178.105.234.189.sslip.io | Set |
| CORS_ORIGINS | https://beam-frontend-nu.vercel.app,https://beam-frontend-jooarp068-benny-4860s-projects.vercel.app | Set |

### Auto-deploy
Every push to `main` on `erimias46/beam-backend` triggers a new deployment automatically via Coolify.

To redeploy manually (run from server):
```bash
curl -X POST 'http://localhost:8000/api/v1/deploy?uuid=c13tqxxi4wzxqitxytwx5non' \
  -H 'Authorization: Bearer [coolify-api-token]'
```

---

## Frontend

| Field | Value |
|-------|-------|
| Platform | Vercel |
| Project ID | `prj_uIyKGHi7Tn3IJbBbJ0HDyyk7IFqX` |
| API Token | `[secret — stored in password manager]` |
| Repo | erimias46/beam-frontend |
| Branch | main |
| Status | Ready ✓ |
| Git SHA | `4d22048` (test: fix BookingDetail + Book/BarberPages/AdminDashboard — 162 tests) |
| Vercel URL | https://beam-frontend-nu.vercel.app |
| Custom Domain | Pending (add `bookabeam.com` in Vercel) |
| `NEXT_PUBLIC_API_URL` | https://c13tqxxi4wzxqitxytwx5non.178.105.234.189.sslip.io |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | [set in Vercel env vars] |

> **Note:** The repo was previously listed as `Beneonbizuneh/beam-frontend` — corrected to `erimias46/beam-frontend` (confirmed via Vercel API 2026-05-31).

---

## Mobile App

| Field | Value |
|-------|-------|
| Repo | https://github.com/BeamTeam1/beam-app |
| Branch | main |
| Git SHA | `ab71d4d` (test: add Flutter unit + widget test suite — 46 tests) |
| Platform | Flutter (iOS + Android) |
| Distribution | Manual (TestFlight / direct APK) — no CI yet |

---

## Useful Commands

```bash
# SSH into server
ssh -i ~/.ssh/id_ed25519 root@178.105.234.189

# View API logs
docker logs $(docker ps --format '{{.Names}}' | grep c13tqxxi4wzxqitxytwx5non | head -1) -f

# Check health (DB + migrations + Redis)
curl https://c13tqxxi4wzxqitxytwx5non.178.105.234.189.sslip.io/health/ready

# Run migrations
docker exec $(docker ps --format '{{.Names}}' | grep c13tqxxi4wzxqitxytwx5non | head -1) npm run migrate

# Connect to Postgres
docker exec -it x16hptef58ui6huhg5vv7vcr psql -U beam0 -d beam0

# Connect to Redis
docker exec -it pgp5sww35gbv22wis6o88phy redis-cli -a '[redis-password]'

# Trigger Coolify redeploy (backend) — run from server
curl -X POST 'http://localhost:8000/api/v1/deploy?uuid=c13tqxxi4wzxqitxytwx5non' \
  -H 'Authorization: Bearer [coolify-api-token]'
```

---

## Known Issues Fixed

- Profile page crashed — `getMyReferralCode`, `getCreditsBalance`, `getCreditsHistory`, `listMySessions`, `revokeSession`, `revokeAllSessions`, `exportMyData` were missing from `src/api/client.js`. Fixed in commit `035c4a1`.
- Google Maps showing "For development purposes only" — `NEXT_PUBLIC_GOOGLE_MAPS_KEY` was not set in Vercel. Added. Also requires enabling Maps JavaScript API on the key in GCP console.
- Receipt tokens used base64 encoding (could contain `/`) breaking public receipt URL routing. Fixed in migration `075_receipt_token_hex.sql` — now uses hex encoding.

---

## TODO

- [ ] Point domain `api.bookabeam.com` → `178.105.234.189` (then swap sslip.io URL for real domain everywhere)
- [x] Set up SSL via Coolify (Let's Encrypt via sslip.io)
- [ ] Add real Stripe keys
- [x] Add real SMTP credentials (Resend — sending from gostartdev.com until bookabeam.com verified on Resend)
- [x] Push frontend to erimias46/beam-frontend
- [x] Deploy frontend on Vercel
- [x] Add `NEXT_PUBLIC_API_URL` in Vercel env vars
- [x] Add `NEXT_PUBLIC_GOOGLE_MAPS_KEY` in Vercel env vars
- [ ] Enable Maps JavaScript API on GCP key + add HTTP referrer `beam-frontend-nu.vercel.app/*`
- [ ] Verify `bookabeam.com` on Resend → update `SMTP_FROM` in Coolify
- [ ] Set up Stripe webhook → `https://c13tqxxi4wzxqitxytwx5non.178.105.234.189.sslip.io/api/payments/webhook`
- [ ] Enable Hetzner backups
- [ ] Set up CI for mobile app (GitHub Actions → TestFlight)
- [ ] Update CORS_ORIGINS when custom domain is live

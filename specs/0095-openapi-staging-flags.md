# 0095 — OpenAPI Spec + Staging Environment + Feature Flags

**Status:** todo  
**Addresses:** Feature suggestion #13 (OpenAPI), #16 (feature flags), #17 (staging env)

## Part A: OpenAPI Spec + Typed Client

### Why
Frontend `api/client.js` and mobile `api.dart` have drifted from the backend twice. A single source of truth fixes this.

### Approach
Use `zod-to-openapi` (backend already uses Zod) to generate an OpenAPI 3.1 spec from existing route schemas:

```js
// web/backend/src/openapi.js
import { extendZodWithOpenApi, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { registry } from './routes/registry.js' // all route schemas registered here
const generator = new OpenApiGeneratorV31(registry.definitions)
const spec = generator.generateDocument({ openapi: '3.1.0', info: { title: 'Beam0 API', version: '1.0.0' } })
```

`GET /api/openapi.json` — serves the spec (only in non-production or with an admin token).

Generate typed clients:
- **Frontend**: `openapi-typescript` → `src/api/schema.d.ts` → typed wrapper around existing `client.js`
- **Mobile**: `openapi-generator-cli` with the Dart template → replaces hand-written `api.dart`

Add to CI: `npm run openapi:check` — regenerates and diffs; fails if routes were added without updating the spec.

## Part B: Staging Environment

### Coolify setup
Duplicate the production project in Coolify as a new project `bookabeam-staging`:
- Same `beam-backend` repo, branch `staging` (or a PR preview branch)
- Separate Postgres + Redis containers
- Separate domain: `api-staging.bookabeam.com` or staging sslip.io URL
- `NODE_ENV=staging`, `ALLOW_MASTER_OTP=true`, `SHOW_DEMO=true`
- Real Stripe test-mode keys

Vercel preview deployments already create staging URLs per branch/PR — configure `NEXT_PUBLIC_API_URL` via Vercel environment variable per branch.

### Why staging first
- CORS fails open in `!== production` (SEC-6) — staging is explicitly `staging` not `production`, so this is intentional and safe
- Test the spec 0080 auth changes against a real DB before prod deploy
- Demo/MASTER_OTP enabled in staging without risk

## Part C: Feature Flags

Extend `platform_settings` with structured flag support:

```sql
-- Already have platform_settings (key TEXT, value TEXT)
-- Flag convention: key = 'flag:scheduled_bookings', value = 'true'/'false'/'percentage:50'
```

```js
// services/settings.js — add:
export async function getFlag(flag, defaultValue = false) {
  const val = await getSetting(`flag:${flag}`)
  if (val === null) return defaultValue
  if (val === 'true') return true
  if (val === 'false') return false
  if (val.startsWith('percentage:')) return Math.random() * 100 < parseInt(val.slice(11))
  return defaultValue
}
```

Admin UI: `GET /admin/flags` + `PATCH /admin/flags/:name` — toggle flags from the admin dashboard without a deploy.

Initial flags:
- `flag:credit_spend` — enable credit-at-checkout (spec 0084), off by default until tested
- `flag:scheduled_bookings` — enable future-time slot picker (spec 0092), off by default
- `flag:smart_ranking` — enable ratings-weighted search ranking (spec 0093), off by default
- `flag:waitlist` — enable waitlist flow (spec 0094)
- `flag:eta` — enable ETA display (spec 0093)

## Notes
- OpenAPI generation is non-blocking (generates a snapshot, doesn't replace the runtime)
- Feature flags backed by `platform_settings` means no Redis dependency and no code deploy to toggle
- Staging environment shares nothing with production DB (completely separate Postgres container)

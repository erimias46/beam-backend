# 0080 — Auth Security Hardening

**Status:** todo  
**Addresses:** SEC-1 (admin self-signup), SEC-2 (MASTER_OTP env gating), SEC-3 (JWT revocation)

## Problem

Three confirmed auth vulnerabilities:

1. **Admin self-signup** (`auth.js:19`): signup schema includes `'admin'` in the role enum → anyone can POST `{"role":"admin"}` to `verify-otp` and become admin.
2. **MASTER_OTP ungated** (`auth.js:120`): `MASTER_OTP` bypass has no `NODE_ENV` check. Keeping it for demo purposes but it must only activate in non-production environments.
3. **90-day legacy JWT** (`auth.js:163-169`): `verify-otp` still mints a 90-day token that `requireAuth` accepts. Suspending/demoting a user doesn't revoke it. The correct refresh-token system (spec 0074) exists but is bypassed.

## Changes

### Backend `web/backend/src/routes/auth.js`

**SEC-1:** Drop `'admin'` from the signup enum:
```js
role: z.enum(['customer', 'barber']).optional().default('customer')
```
Admin is only grantable via `PATCH /admin/users/:id/role` by an existing admin.

**SEC-2:** Gate the master OTP with `NODE_ENV`:
```js
const isMaster = process.env.NODE_ENV !== 'production' && masterOtp && code === masterOtp
```
Also add `ALLOW_MASTER_OTP=true` env var as an additional opt-in guard (double safety):
```js
const isMaster = process.env.NODE_ENV !== 'production'
  && process.env.ALLOW_MASTER_OTP === 'true'
  && masterOtp && code === masterOtp
```

**SEC-3:** Stop issuing the 90-day legacy token. The response from `verify-otp` already returns `access_token` + `refresh_token` (spec 0074). Remove the `token` field from the response, or keep it for a migration period but add a `token_valid_after` column to `users` so suspension invalidates it:
- Add migration `076_token_valid_after.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_valid_after timestamptz`
- In `requireAuth` middleware: after verifying JWT, check `payload.iat * 1000 >= user.token_valid_after` (DB lookup — cached per request via middleware context)
- On suspend or role-change: `UPDATE users SET token_valid_after = now() WHERE id = $1`
- Short-term: stop emitting the `token` field and update clients to use `access_token`/`refresh_token`

### Frontend `web/frontend/src/`
- Update `Login.jsx` to use `access_token`/`refresh_token` from the response (not `token`)
- Store only `access_token` in the auth store (SEC-3 companion)
- Gate the demo-accounts UI: `process.env.NEXT_PUBLIC_SHOW_DEMO === 'true'` (avoids shipping `000000` to prod client bundle)

### Mobile `app/lib/`
- Update `auth_provider.dart` to read `access_token`/`refresh_token` from verify-otp response

## Migration
`076_token_valid_after.sql`:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_valid_after timestamptz;
```

## Notes
- MASTER_OTP remains functional for demo/dev — governed by `NODE_ENV !== 'production'` AND `ALLOW_MASTER_OTP=true` env var
- Set `ALLOW_MASTER_OTP=true` in local `.env` and any staging Coolify env; leave unset in production

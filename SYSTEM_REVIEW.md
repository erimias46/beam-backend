# Beam0 — Full System Review

**Date:** 2026-05-31
**Scope:** Backend (Node/Express), Frontend (Next.js), Mobile (Flutter), Database (Postgres), Infra (Coolify/Hetzner + Vercel)
**Method:** Multi-area code audit — security, money-handling logic, schema, client, mobile, deployment.

This document lists **security risks**, **logic/correctness bugs**, **better approaches**, and **feature suggestions**, ordered by priority. Each item cites the file and gives a concrete fix.

---

## 🔴 SHIP-BLOCKERS — fix before any real users / real money

These are confirmed, exploitable, and high-impact. Do these first.

### SEC-1 — Anyone can self-register as `admin` *(CRITICAL, verified)*
**`web/backend/src/routes/auth.js:19, 144`**
The signup schema is `role: z.enum(['customer','barber','admin'])` and the value is written directly into `INSERT INTO users (..., role)`. Sending `{"email":"x@y.com","code":"<otp>","role":"admin"}` to `verify-otp` creates a full admin. Every `/admin/*` route trusts the JWT `role` claim, so this is instant total compromise.
**Fix:** `role: z.enum(['customer','barber']).optional().default('customer')`. Admin is only ever grantable by an existing admin via `PATCH /admin/users/:id/role`.

### SEC-2 — `MASTER_OTP` backdoor is not gated to non-production *(CRITICAL, verified)*
**`web/backend/src/routes/auth.js:120-121`**
`const isMaster = masterOtp && code === masterOtp` — no `NODE_ENV` check. If `MASTER_OTP` is ever set in prod (and `000000` is documented in `seed-demo.js` + shown in the frontend `Login.jsx`), anyone can log in as **any** email — combined with SEC-1, as admin.
**Fix:** `const isMaster = process.env.NODE_ENV !== 'production' && masterOtp && code === masterOtp`. Better: remove entirely; seed a dev OTP into Redis instead. Never document a static master code.

### SEC-3 — 90-day JWTs with no revocation *(HIGH)*
**`web/backend/src/routes/auth.js:163-169`, `middleware/auth.js:8-21`**
`verify-otp` still mints a 90-day JWT that `requireAuth` accepts. Suspending a user, demoting an admin, or "revoke all sessions" does **not** invalidate an already-issued token — only `GET /me` re-checks `is_suspended`; every other route (bookings, payments, admin) does no DB lookup. A suspended user or ex-admin keeps full access for up to 90 days. The correct 15-min-access + rotating-refresh system already exists (`sessions.js`) but the legacy token defeats it.
**Fix:** Stop issuing the 90-day token (clients already receive `access_token`/`refresh_token`). If a rollout window is needed, add a per-user `token_valid_after` column checked in `requireAuth` so suspension/role-change invalidates old tokens.

### MONEY-1 — Captured payments can get stuck forever; no reconciliation *(CRITICAL)*
**`web/backend/src/routes/stripe.js:131-139`, `routes/bookings.js:601-609`, `services/queue.js:245-282`**
`paid` is set **exclusively** by the `payment_intent.succeeded` webhook, gated on `status='completed'`. If that webhook is lost/parked after `MAX_ATTEMPTS`, the booking is stuck in `completed` with money captured at Stripe, the customer can never self-refund (refund requires `status='paid'`), and the payout ledger never reflects it. There is **no reconciliation job** that polls Stripe for captured-but-unpaid bookings. Worse, `/confirm` captures, swallows failures, returns `200 {warning:'capture pending'}` after already committing `completed`, and still tells the barber "Payment released."
**Fix:** Add a reconciliation sweep: for bookings in `completed`/`awaiting_confirmation` older than N minutes, query the PI status and reconcile (`paid` if captured, re-capture/alert otherwise). Don't notify the barber before capture confirms. Base refund eligibility on `payment_state='captured'`, not `status='paid'`.

### MONEY-2 — Critical money timers live only in Redis with no durable fallback *(CRITICAL)*
**`web/backend/src/services/queue.js` (all `scheduleX` are fire-and-forget), callers `.catch()` and ignore**
If Redis is down at schedule time, the job is lost forever: bookings never auto-cancel (orphaned `requested` + dangling card auth), never auto-confirm (money never captured), barber no-shows never refunded.
**Fix:** Back timers with DB columns (`auto_cancel_at`, `auto_confirm_at`) + a periodic sweep over due rows, so Redis loss degrades gracefully instead of losing money events.

### DB-1 / MONEY-3 — Worker `SELECT … FOR UPDATE` locks are a no-op *(CRITICAL)*
**`web/backend/src/services/queue.js:247-256, 286-299`, `db/index.js:16`**
`db.query()` is `pool.query()` — it checks out a connection, runs the statement, and **returns it immediately**, releasing the `FOR UPDATE` lock before the follow-up `UPDATE`. The auto-confirm and barber-no-show workers therefore do an unprotected read-then-write that races the customer's transactional `/confirm` and `/dispute`. Worst case: double-capture attempt or money captured while the customer believes it was released.
**Fix:** Wrap worker logic in `getClient()` + `BEGIN`/`COMMIT`, or use a single atomic `UPDATE … WHERE id=$1 AND status='awaiting_confirmation' RETURNING *` and act only when a row returns.

### INFRA-1 — No database backups *(CRITICAL, operational)*
**`DEPLOYMENT.md` TODO — unchecked**
Single Postgres volume on one Hetzner box, no backups. Disk failure, a bad migration, or `docker volume rm` = total, unrecoverable data loss for a payments product.
**Fix:** Enable Hetzner VM snapshots **and** a daily logical `pg_dump` shipped off-box (S3/Backblaze) with retention. Test a restore. Coolify has scheduled Postgres backups — enable and point off-server.

---

## 🟠 HIGH — fix soon (correctness, money exposure, security hardening)

### MONEY-4 — Booking FSM is enforced only in app code, not the DB; concurrent transitions race *(HIGH)*
**`web/backend/src/middleware/booking-fsm.js`, `routes/bookings.js:466-513`**
`/decline` and `/start` read with plain `query` (no `FOR UPDATE`), check `assertTransition` against the snapshot, then `UPDATE` **unconditionally** (no `AND status=$expected`). Two concurrent requests both pass and both write. The DB enum constrains values, not transitions — nothing blocks `completed → in_progress`.
**Fix:** Make every transition a conditional write: `UPDATE bookings SET status=$new WHERE id=$1 AND status=$expected`; treat `rowCount=0` as a lost race (409). This enforces the FSM atomically at the DB for all endpoints.

### MONEY-5 — Promo-discounted bookings authorize less than `price_cents`, but fees & refunds use `price_cents` *(HIGH)*
**`web/backend/src/routes/bookings.js:759-795`, `routes/refunds.js:53-59`**
The PaymentIntent is authorized for `price_cents − promo_discount_cents`, but the cancellation-fee capture and the refund-remaining guard both compute against full `price_cents`. Result: cancellation-fee captures that exceed the authorized amount get **rejected by Stripe and silently lost** (caught, logged, response still claims the fee was charged); and the admin refund ceiling is wrong.
**Fix:** Compute fees and `remaining` against the actually-authorized/captured amount (`price_cents − promo_discount_cents`, or read the PI's `amount_received`). Clamp `amount_to_capture` to the PI's authorized amount.

### MONEY-6 — Idempotency layer caches actionable 4xx, bricking accept retries *(HIGH)*
**`web/backend/src/middleware/idempotency.js:113-144`, `routes/bookings.js:422`**
A `402 requires_action` (3DS) from `/accept` gets cached. A normal client retry with the same idempotency key replays the cached 402 forever — the booking can never be accepted even after 3DS completes. Also, for multipart `/complete`, `idempotency()` runs **before** multer, so the body-hash is `{}` and concurrent differentiation relies entirely on the key + URL.
**Fix:** Don't cache transient/actionable responses (`402 requires_action`, `409 in_flight`). Place `idempotency()` after multer for multipart routes, or include path params in the request hash.

### MONEY-7 — Refund window keyed off `updated_at` (a moving target) *(HIGH)*
**`web/backend/src/routes/refunds.js:181-185`**
`ageMs = now − booking.updated_at`, but a `BEFORE UPDATE` trigger bumps `updated_at` on **every** write. Any post-payment update (dispute webhook, payment_state mirror, admin edit) silently reopens/shifts the self-service refund window → refunds allowed outside policy.
**Fix:** Add an explicit `paid_at timestamptz` set by the `payment_intent.succeeded` handler; compute the window from it.

### MONEY-8 — Tips charge a possibly-different card, off-session, failures swallowed *(HIGH)*
**`web/backend/src/routes/bookings.js:614-643`**
The tip PI uses `default_payment_method_id`, which may differ from the card the service charge used; off-session with no SCA fallback; failures only `console.warn`'d. Large tips (most likely to trigger SCA) silently vanish — real money lost to the barber, with no record or retry.
**Fix:** Reuse the PM the service PI used (persist `payment_method_id` on the booking at accept). Record failed tips for retry and surface to the customer.

### MONEY-9 — Promo can be consumed without a discount applied; credits never spent *(HIGH)*
**`web/backend/src/routes/bookings.js:184-218`, `routes/promos.js:236-266`**
`redeemPromoIfValid` runs in its **own** transaction, separate from the booking insert. If the subsequent `UPDATE bookings SET promo_code…` fails, the one-time promo is burned with no discount applied. Separately, `credit_applied_cents` and the `user_credits` ledger exist but **nothing in the booking flow ever spends credits** — accrued referral/admin credits can never be used.
**Fix:** Redeem the promo inside the same transaction as the booking insert. Implement credit-spend at checkout (or remove the column + hide balances if it's not a launch feature).

### DB-2 — Credit ledger has no atomic spend path (overdraw race) *(HIGH)*
**`web/backend/src/routes/promos.js` `applyCredit`, `db/migrations/070_promos_credits.sql`**
`applyCredit` reads `SUM(amount_cents)` then inserts `balance_after_cents` at READ COMMITTED with no row lock. Two concurrent debits read the same balance and both succeed → negative balance.
**Fix:** `SELECT … FOR UPDATE` on the user's credit rows (or `pg_advisory_xact_lock(hashtext(user_id))`), reject if the debit goes below 0, and add `CHECK (balance_after_cents >= 0)`.

### DB-3 — Soft-deleted barbers still appear and are bookable *(HIGH)*
**`web/backend/src/routes/barbers.js` (GET `/`, GET `/:id`), `migrations/061_soft_delete.sql`**
Barber search/detail filter only on `is_suspended`, not `deleted_at IS NULL`. A soft-deleted barber stays in search and can be booked. Also `bookings.customer_id/barber_id` FKs have no explicit `ON DELETE` rule, so the hard-delete account path can 500 on users with non-paid bookings.
**Fix:** Add `AND u.deleted_at IS NULL` to barber search/detail and the booking-availability check. Make the `bookings` FK delete policy explicit (`ON DELETE RESTRICT`) and handle the failure in the deletion route.

### DB-4 — `reviews` table defined twice with conflicting schemas *(HIGH)*
**`migrations/001_init.sql` vs `003_admin_reviews.sql`**
Both `CREATE TABLE IF NOT EXISTS reviews` with different column types (`int` vs `smallint`), nullability, and `ON DELETE` behavior. Whichever ran first wins → prod/dev schema divergence.
**Fix:** Make 003 reconcile via `ALTER` (type, NOT NULL, re-add cascade constraint), guarded to be safe on either variant.

### DB-5 — Missing index on `bookings.stripe_payment_intent_id` *(HIGH)*
**Never created; used by 7 webhook handlers in `routes/stripe.js`**
Every Stripe webhook does `WHERE stripe_payment_intent_id = $1` with no index → full table scan, compounding under retry storms.
**Fix:**
```sql
CREATE INDEX IF NOT EXISTS bookings_payment_intent_idx
  ON bookings(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_tip_payment_intent_idx
  ON bookings(tip_payment_intent_id) WHERE tip_payment_intent_id IS NOT NULL;
```

### DB-6 — Missing FK indexes (seq scans on joins + cascade deletes) *(HIGH)*
**Various migrations**
Unindexed FK columns: `reviews.reviewer_id`, `booking_events.actor_id`, `refunds.initiated_by`, `user_reports.reporter_id`, `chat_messages.sender_id`, `promo_redemptions.booking_id`.
**Fix:** Add the six indexes (Postgres does not auto-index FKs).

### SEC-4 — Open redirect in email click-tracking *(HIGH)*
**`web/backend/src/routes/email-campaigns.js:58-68`**
`res.redirect(302, req.query.url)` with no validation — `…/unsubscribe/click?url=https://evil.com` is a working phishing redirect on your trusted domain. The HMAC token doesn't cover `url`.
**Fix:** Sign the destination into the HMAC payload (ignore the query `url`), or validate against an allowlist / require a relative path.

### FE-1 — JWT in localStorage (XSS → token theft) *(HIGH)*
**`web/frontend/src/store/index.js:6-34`**
The bearer token is persisted to `localStorage`. Any XSS can read and exfiltrate it; it's also placed in SSE URLs (FE-3).
**Fix:** Move the session token to an `httpOnly; Secure; SameSite=Strict` cookie set by the backend on `verify-otp`; keep only non-sensitive profile in the store. Add a strict CSP as defense-in-depth.

### FE-2 — No client route guards on customer/barber pages *(HIGH)*
**`web/frontend/src/app/bookings|book|profile|payments|barber/*`**
Only `AdminLayout` guards. Other protected pages render unconditionally (data calls 401 → logout), causing flashes and possible pre-redirect mutations. No `middleware.ts`.
**Fix:** Add a shared `RequireAuth` wrapper or `middleware.ts`. **Defense-in-depth only — the backend must enforce auth/ownership independently** (it largely does; keep it that way).

### FE-3 / FE-4 — SSE: token in URL + three concurrent connections, two without reconnect *(HIGH)*
**`hooks/useBookingStream.js:20`, `components/Chat.jsx:38`, `components/LiveBarberMap.jsx:52`**
Raw JWT in `?token=` (lands in logs/history/referer). On a booking-detail page, three EventSources open to the same stream; Chat and LiveBarberMap have **no reconnection** and silently die on any drop.
**Fix:** Use a short-lived single-use SSE ticket (or cookie auth). Open **one** EventSource in a provider/context and fan out to subscribers; add the backoff reconnection that `useBookingStream` already has.

### MOBILE-1 — Google Maps API key hardcoded & unrestricted *(HIGH; CRITICAL if unrestricted)*
**`app/android/app/src/main/AndroidManifest.xml:32`, `app/ios/Runner/AppDelegate.swift:11`**
Same key `AIzaSyCuk4…` committed in both platforms. Extractable from any APK/IPA; if unrestricted = quota/billing theft.
**Fix:** Create per-platform keys in GCP with Application restrictions (Android package + SHA-1; iOS bundle ID), restricted to only the Maps SDK used. Rotate the current key (it's in git history). Inject via `--dart-define`/xcconfig/gradle placeholders, not committed literals.

### MOBILE-2 — All API traffic is cleartext HTTP to localhost; no prod URL *(HIGH)*
**`app/lib/core/api.dart:50-54`**
`_baseUrl()` only returns `http://localhost:4000` / `http://10.0.2.2:4000`. A release build ships pointing at localhost over plain HTTP — JWT + PII in cleartext, no prod endpoint, no cert pinning.
**Fix:** Drive base URL from `--dart-define=API_BASE_URL=…` (the production HTTPS host); enforce `https://` in release. Consider Dio cert pinning for the payments host.

### MOBILE-3 — No 401 handling / token refresh not wired *(HIGH)*
**`app/lib/core/api.dart` `_AuthInterceptor` (879-888), `auth_provider.dart:76-79`**
The interceptor only attaches the bearer; no `onError`. `refreshSession()`/`setRefreshToken` exist but are never called. On expiry/revocation the user is silently stuck; the stored refresh token is dead weight.
**Fix:** Add an `onError` 401 handler: single refresh attempt (guarded against concurrent storms), persist + retry; on failure, `logout()` + redirect to `/login`.

### INFRA-2 — CI tests but does not gate deployment *(HIGH)*
**`.github/workflows/ci.yml` + Coolify auto-deploy on every push to main**
The two are decoupled — a broken commit deploys to prod regardless of test status.
**Fix:** Disable Coolify auto-deploy; trigger the deploy webhook from a final CI job that runs only after tests pass on `main`. Make CI a required status check.

### INFRA-3 — `COPY . .` with no `.dockerignore` bakes `.env`/secrets into image layers *(HIGH)*
**`web/backend/Dockerfile`, `docker-compose.prod.yml:5`**
No `.dockerignore`, so `.env`, `.git`, `node_modules`, `uploads` get copied into image layers. (Note: the Dockerfile does **not** bake secrets as ARG — that part of the old concern is inaccurate; secrets correctly come from Coolify runtime env.)
**Fix:** Add `.dockerignore` excluding `.env`, `.git`, `node_modules`, `uploads`, `*.log`, tests.

### INFRA-4 — Container runs as root, no healthcheck *(HIGH)*
**`web/backend/Dockerfile`**
No `USER`, no `HEALTHCHECK`, single-stage.
**Fix:** Add a non-root user (`adduser -S app`), `USER app`, `chown uploads`. Add `HEALTHCHECK CMD wget -qO- http://localhost:4000/health/ready || exit 1` (endpoint already exists).

---

## 🟡 MEDIUM — quality, robustness, scale

### Backend / Money
- **MONEY-10** `payment_intent.payment_failed` matches `status IN (…, 'completed')` (`stripe.js:178-185`) — an out-of-order failure event can flip a captured booking to `cancelled`. Exclude `completed`/`paid`; match the exact PI id.
- **MONEY-11** `charge.refunded` reconciliation reads `charge.refunds.data` (`stripe.js:242-268`), which Stripe no longer expands by default → dashboard-initiated refunds never sync to the `refunds` table and `refunded_cents` drifts. Use `expand:['refunds']` / list by PI and upsert unknown refunds.
- **MONEY-12** Referral credit award has no uniqueness guard (`stripe.js:166-171`, `promos.js:270-288`) — concurrent `succeeded` events could double-award. Add `UNIQUE(source, source_ref)` on `user_credits` or `ON CONFLICT DO NOTHING`.
- **SEC-5** No rate limit on `POST /bookings` or payment endpoints (`/setup-intent`, `/methods/*`) — only the global 300/15min floor. An authed user can spam PaymentIntent/SetupIntent creation. Add per-user limiters.
- **SEC-6** CORS fails open: `if (NODE_ENV !== 'production') return cb(null, true)` (`app.js:63`) reflects any origin with credentials. Default to deny; only relax for explicit `NODE_ENV==='development'`.
- **SEC-7** OTP limiter keyed on `req.ip:email` (`auth.js:27`) — bypassable via IP rotation. Add an email-only limiter alongside it. (The Redis 5-attempt email-keyed cap is the real backstop and is correct.)

### Database
- **DB-7** Barber search does per-row `jsonb_array_elements(services)` + per-row Haversine with `ORDER BY distance` and no usable spatial index (`barbers.js`). Fine at current scale; for growth use PostGIS `geography` + GiST and a normalized `barber_services` table or GIN index.
- **DB-8** No overlap protection on bookings — the slot unique index is exact-equality on `(barber_id, scheduled_at)`, so 10:00 and 10:15 both allowed despite a 45-min cut. Use a `tstzrange` + GiST exclusion constraint if overlap matters.
- **DB-9** No `CHECK` guarding total succeeded refunds ≤ captured amount; `user_credits` lacks `CHECK(balance_after_cents >= 0)`. Add both (the latter after DB-2's locking fix).
- **DB-10** `UPDATE users SET last_active_at=NOW()` on every authed request (`auth.js:161`) is write amplification on a hot table. Throttle (e.g. only if >5 min stale).

### Frontend
- **FE-5** `updateBookingStatus` (`store/index.js:127-146`) fires mutations with no idempotency key and no required body (accept needs `payment_method_id`, cancel needs a reason). A double-tap can double-fire; SSE refresh can clobber an optimistic write. Mint per-action keys, pass bodies, guard in-flight per booking.
- **FE-6** `client.js:16-22` logs out on **any** 401 (hard `window.location.href`), and there's no token-refresh flow. Only logout on auth-critical 401s; add a refresh-on-401-once flow with a request queue.
- **FE-7** No `AbortController`/cancellation anywhere; `fetchBarbers` runs twice on Book mount (filter + geolocation callback) and races — slower response wins. Thread abort signals; debounce; drop stale responses via a sequence id.
- **FE-8** No error boundaries / `not-found` / `global-error`; a render throw (e.g. `window.google` accessed before `isLoaded` in `LiveBarberMap.jsx:92`) shows a blank screen. Add segment `error.jsx` + `not-found.jsx`; guard `window.google`.
- **FE-9** Maps + Stripe libs imported statically (`Book.jsx`, `BookingDetail.jsx`) — pulled into the initial chunk even when not visible. Use `next/dynamic({ ssr:false })`.
- **FE-10** All images use raw `<img>` (portfolio galleries load full-res); no `next/image`, no `images` config. Use `next/image` with `remotePatterns`, or at least `loading="lazy"`.
- **FE-11** Barber "transactions" amount is fabricated client-side as `price_cents * 0.85` (`store/index.js:94-103`) — diverges from real Stripe fees. Derive from a backend earnings endpoint.

### Mobile
- **MOBILE-4** SSE in `live_barber_map.dart:75-99` has no `onError`/`onDone` → silently dies on cellular handoff, never reconnects (masked by 15s polling). Add backoff reconnect + re-subscribe on `AppLifecycleState.resumed`.
- **MOBILE-5** Location sharing (`barber_share_location.dart:56-64`): `LocationAccuracy.high` + 5m filter + 10s POST + 1s `setState` tick, never pauses on background, no auto-stop on completion. Battery drain. Lower cadence, pause on background, auto-stop when status leaves `accepted/in_progress`, consider `balanced` accuracy.
- **MOBILE-6** No connectivity handling; Dio errors swallowed with `catch (_) {}` throughout — failed `postBarberLocation` is invisible (barber thinks they're sharing). Add a connectivity banner + visible error/retry; warn on consecutive location-post failures.
- **MOBILE-7** Notifications provider is in-memory only (`providers/notifications_provider.dart`), never hydrated from server/SSE, resets each launch — the nav badge is always empty. Wire to the SSE stream / a backend notifications endpoint; persist unread.

### Infra
- **INFRA-5** Temporary sslip.io TLS domain — fine for staging, not a payments product (cert tied to raw IP; moving servers breaks every client). Point `api.bookabeam.com` → server, issue LE, update mobile/frontend/`APP_URL`/`CORS_ORIGINS`/Stripe webhook.
- **INFRA-6** No monitoring/error capture/log retention — only ephemeral `docker logs`, no rotation. Add Sentry + external uptime monitor on `/health/ready` + log rotation (`max-size`/`max-file`).
- **INFRA-7** Stripe keys are placeholders; webhook unset (`DEPLOYMENT.md`). Set real keys, register the webhook on the custom domain, confirm invalid-signature rejection.

---

## 🟢 LOW — polish, hygiene, future-proofing

- **SEC-8** Public receipt endpoint (`receipts.js:43-61`) is unauthenticated (token-gated, 192-bit — safe) but exposes both parties' **emails** with no expiry. Omit counterparty email or expire tokens.
- **SEC-9** Non-prod leaks raw `err.message` to clients (`app.js:241-244`) — combined with the fail-open CORS default (SEC-6), a misconfigured env leaks internals. Prod is handled correctly.
- **SEC-10** `auth.js` re-implements bearer parsing + `jwt.verify` inline in `/profile`, `/me`, `/account`, `/export`, `/push-prompt`, `/notifications` instead of using `requireAuth` — duplication where the `is_suspended` check is easy to forget. Use the middleware uniformly.
- **SEC-11** Reuse of `JWT_SECRET` for the email-campaign HMAC (`email-campaigns.js:10`) — use a dedicated secret (key separation).
- **FE-12** `dangerouslySetInnerHTML` for JSON-LD (`cities/[slug]/page.jsx:57`) — escape `<` → `<` to be airtight (low risk, own data).
- **FE-13** Demo accounts + `MASTER_OTP=000000` hint shipped in the prod client bundle (`Login.jsx:8-16`). Gate behind `NEXT_PUBLIC_ENV !== 'production'` so it tree-shakes out.
- **FE-14** Book flow allows submit with `address.length >= 5` even if no autocomplete coords picked → booking with null lat/lng. Require `addressCoords`. Modals lack focus-trap/`aria-modal`/Esc; OTP inputs lack labels.
- **FE-15** Failed loads render identical to empty states (store `error` never shown). Render `error` + retry.
- **FE-16** `BarberShareLocation.jsx:24` early `return null` before a `useEffect` — Rules-of-Hooks violation if status toggles across renders. Move the check after hook declarations.
- **MOBILE-8** iOS `Info.plist` declares `NSLocationAlwaysAndWhenInUseUsageDescription` but the app only uses when-in-use — Apple review flags unused background-location. Remove unless background is intended. (Android permissions are correctly minimal.)
- **DB-11** `006_admin_role.sql` `ADD CONSTRAINT` isn't guarded for re-run; wrap in `DO $$ … EXCEPTION WHEN duplicate_object`. `043`/`075` do full-table `UPDATE` of `receipt_token` — fine now, slow at scale.
- **DB-12** Redundant low-value indexes: `barber_profiles_available_idx` (bool), `users_email_notifications_idx` (near-all-rows partial). Candidates for removal.
- **CLEAN-1** `Booking.copyWith` (mobile `models/booking.dart`) only supports 3 fields — fine today, but silently drops intent if callers expect more. Note for future.
- **INFRA-8** Single-server SPOF (API + Postgres + Redis + Coolify on one box). Acceptable pre-launch; document RTO/RPO. When scale justifies: managed/replicated Postgres, Coolify off the app host, API behind a LB on ≥2 nodes.

---

## ✅ Confirmed CORRECT (don't "fix" these)

- **SQL injection:** all queries parameterized; dynamic `${where}`/`${sets}`/`${column}` interpolate only hardcoded identifiers, never request data.
- **IDOR:** bookings, refunds, receipts, payment-methods, sessions all verify ownership (or admin) before acting.
- **File uploads:** randomUUID filenames, 5MB cap, jpeg/png/webp allowlist, no path traversal.
- **Stripe webhook:** signature verified (`constructEvent`), idempotent (`ON CONFLICT DO NOTHING`), raw body before `json()`.
- **OTP storage:** sha256-hashed in Redis, 10-min TTL, timing-safe compare, 5-attempt email-keyed cap, neutral response. (Backdoor SEC-2 aside.)
- **Refresh tokens** (`sessions.js`): random 256-bit, sha256-stored, rotation on use, reuse-detection nukes all sessions — correct design (just bypassed by the legacy 90-day JWT, SEC-3).
- **Money as integer cents** everywhere; **timestamps uniformly `timestamptz`**.
- **Firebase fully removed** (confirmed: no pods, no refs) and **JWT stored in `flutter_secure_storage`** (Keychain/EncryptedSharedPreferences), not shared_preferences.
- **`useBookingStream`** reconnection with exponential backoff + cleanup is well done.
- **Idempotency-key design** in `client.js` is solid (mint-per-action, header-based) — just not used by the store path (FE-5).

---

## 💡 FEATURE & ARCHITECTURE SUGGESTIONS

### Money / trust (highest leverage)
1. **Stripe reconciliation service** (addresses MONEY-1): a scheduled worker that reconciles every non-terminal booking against Stripe's source of truth. This is the single most important reliability investment for a payments app.
2. **Durable job scheduling** (addresses MONEY-2): DB-backed timers + sweep so money events survive Redis loss. Consider `pg_cron` or a lightweight outbox.
3. **Implement credit spend at checkout** (or remove it) — the ledger and `credit_applied_cents` exist but are dead (MONEY-9/DB-2).
4. **Payout dashboard for barbers** sourced from real Stripe data, not the client-side `*0.85` guess (FE-11).
5. **Dispute/chargeback handling** — there's `dispute_state` plumbing; build the admin workflow + customer-facing status around it.

### Product features worth adding
6. **Scheduled (future) bookings** — the schema has `scheduled_at`; surface real future-time booking with reminders (you already have the email/push infra).
7. **Barber availability calendar UX** — weekly schedule + vacation exist server-side (specs 0051); a richer customer-facing "next available slot" picker would lift conversion.
8. **Real-time ETA** — live location exists; compute and show ETA (the spec 0031 name implies it) with map routing.
9. **In-app push notifications** properly wired on mobile (MOBILE-7) — currently the inbox is cosmetic.
10. **Ratings-driven ranking** — you collect two-way ratings; feed `rating_avg` into search ranking (currently distance/price only).
11. **Waitlist / re-request flow** when no barber accepts before auto-cancel — recover otherwise-lost demand.
12. **Promo/referral analytics** for admins — you have the data (PostHog spec 0071); build the funnel view.

### Engineering / platform
13. **OpenAPI spec + typed client** — generate the frontend `api/client.js` and mobile `api.dart` from one source of truth to kill drift (you've already hit endpoint-coverage drift twice).
14. **Shared validation** — Zod schemas on the backend could be mirrored to the client to validate before submit (FE-14).
15. **Integration test for the full money path** — accept→complete→confirm→webhook→paid, with a Stripe mock, to lock in the MONEY-* fixes.
16. **Feature flags** — you have `platform_settings`; formalize flags for risky rollouts (e.g. the new auth model in SEC-3).
17. **Staging environment** distinct from prod (separate Coolify project) so the fail-open CORS/error-leak (SEC-6/9) never bites a public URL.

---

## 📋 SUGGESTED ORDER OF WORK

**Sprint 0 (before any real users):** SEC-1, SEC-2, SEC-3, MONEY-1, MONEY-2, DB-1, INFRA-1. These are the compromise paths and the irrecoverable-data-loss path.

**Sprint 1 (correctness + money exposure):** MONEY-4…9, DB-2…6, SEC-4, FE-1…4, MOBILE-1…3, INFRA-2…4.

**Sprint 2 (hardening + scale):** all MEDIUM items.

**Sprint 3 (polish + features):** LOW items + the feature suggestions, prioritizing the money/trust group (#1–5).

---

*Generated from a 5-agent parallel audit (backend security, payments/logic, database, frontend, mobile+infra). All file:line references are against the working tree as of 2026-05-31. Items SEC-1 and SEC-2 were additionally verified by hand.*

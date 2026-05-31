# 0086 — Security Hardening (CORS, Rate Limits, Key Separation, Open Redirect)

**Status:** todo  
**Addresses:** SEC-4 (open redirect), SEC-5 (rate limits), SEC-6 (CORS), SEC-7 (OTP limiter), SEC-8 (receipt emails), SEC-9 (error leak), SEC-10 (requireAuth duplication), SEC-11 (HMAC key), SEC-2 addendum (MASTER_OTP frontend demo)

## Changes

### `web/backend/src/routes/email-campaigns.js` — SEC-4

Sign the destination URL into the HMAC token; strip raw `url` from query:
```js
// In sign(): include url in payload
function sign(payload) { ... }

// In /click handler: read url from verified payload, not query string
const data = verify(req.query.token)
if (!data?.uid || !data?.campaign || !data?.url) return res.status(400).send('Invalid link.')
const url = data.url
// validate it's on your domain or a relative path
if (!/^https?:\/\/(bookabeam\.com|beam-frontend-nu\.vercel\.app)/.test(url) && !url.startsWith('/')) {
  return res.status(400).send('Invalid redirect.')
}
res.redirect(302, url)
```

### `web/backend/src/app.js` — SEC-6

Default CORS to deny; only allow `NODE_ENV==='development'` explicitly:
```js
// Replace:
if (process.env.NODE_ENV !== 'production') return cb(null, true)
// With:
if (process.env.NODE_ENV === 'development') return cb(null, true)
```

### `web/backend/src/routes/auth.js` — SEC-7

Add an email-only limiter alongside the IP+email one:
```js
const sendOtpEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 sends per email per hour regardless of IP
  keyGenerator: (req) => `email:${req.body?.email?.toLowerCase() || req.ip}`,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many OTP requests for this email. Try again in an hour.' },
})
// Apply both limiters to send-otp route:
router.post('/send-otp', sendOtpLimiter, sendOtpEmailLimiter, async ...)
```

### `web/backend/src/routes/bookings.js` + `routes/payments.js` — SEC-5

```js
const bookingCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20, // 20 booking attempts per user per hour
  keyGenerator: (req) => req.user?.id || req.ip,
})
router.post('/', requireAuth, bookingCreateLimiter, async ...)

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
})
router.post('/setup-intent', requireAuth, paymentLimiter, async ...)
```

### `web/backend/src/routes/email-campaigns.js` — SEC-11

Separate HMAC secret from JWT_SECRET:
```js
const HMAC_SECRET = process.env.EMAIL_HMAC_SECRET || process.env.JWT_SECRET
```
Add `EMAIL_HMAC_SECRET` env var to Coolify. This isolates the key — a JWT compromise doesn't break email links and vice versa.

### `web/backend/src/routes/receipts.js` — SEC-8

Omit counterparty email from the public token-only endpoint:
```js
// publicReceiptRouter response: exclude emails
function publicShape(booking) {
  return {
    ...shape(booking),
    barber:   { id: booking.barber_id, name: booking.barber_name },    // no email
    customer: { id: booking.customer_id, name: booking.customer_name }, // no email
  }
}
```

### `web/backend/src/routes/auth.js` — SEC-10

Replace all inline `jwt.verify` + bearer parsing in individual route handlers with `requireAuth`:
- `/api/auth/profile`, `/api/auth/me`, `/api/auth/account`, `/api/auth/export`, `/api/auth/push-prompt`, `/api/auth/notifications` currently re-implement their own auth inline.
- Add `requireAuth` (and `optionalAuth` where appropriate) as middleware, remove the inline duplicates.

### `web/backend/src/app.js` — SEC-9

Ensure non-prod error messages are always behind an explicit `NODE_ENV === 'development'` check (not `!== 'production'`):
```js
const isDev = process.env.NODE_ENV === 'development'
const msg = status >= 500 && !isDev ? 'Internal server error' : err.message
```

### `web/frontend/src/components/pages/Login.jsx` — Demo accounts gating

```js
const SHOW_DEMO = process.env.NEXT_PUBLIC_SHOW_DEMO === 'true'
// Only render demo accounts UI when SHOW_DEMO is true
{SHOW_DEMO && <DemoAccountsSection />}
```
Set `NEXT_PUBLIC_SHOW_DEMO=true` in local `.env.local` and staging Vercel env; leave unset (or false) in production.

## Env vars added
- `EMAIL_HMAC_SECRET` — separate HMAC key for email campaign tokens
- `ALLOW_MASTER_OTP=true` — enables MASTER_OTP in non-prod (from spec 0080)
- `NEXT_PUBLIC_SHOW_DEMO=true` — shows demo accounts on login (frontend)

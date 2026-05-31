# 0087 — Frontend Security: Cookie Auth, Route Guards, SSE

**Status:** todo  
**Addresses:** FE-1 (JWT localStorage), FE-2 (route guards), FE-3/4 (SSE token + connections), FE-5 (store idempotency), FE-6 (401 handling), FE-13 (demo gating)

## Problem

JWT stored in localStorage (XSS-extractable). No route guards on protected pages. SSE sends JWT in URL query string. Three concurrent EventSources on booking-detail page, two without reconnect.

## Option A (recommended): SSE Ticket endpoint

Rather than full cookie migration (large scope), issue a short-lived SSE ticket for SSE connections. This fixes the token-in-URL problem without restructuring auth.

### Backend: `POST /api/bookings/sse-ticket`
```js
router.post('/sse-ticket', requireAuth, async (req, res) => {
  // Issue a 60-second nonce
  const nonce = randomBytes(32).toString('hex')
  await redis.setex(`sse:${nonce}`, 60, req.user.id)
  res.json({ ticket: nonce })
})
```

### Backend: SSE endpoint validates ticket (not JWT):
```js
// In /events handler:
const ticket = req.query.ticket || req.query.token // fallback for legacy
if (ticket && ticket.length === 64) {
  // new ticket flow
  const userId = await redis.getdel(`sse:${ticket}`)
  if (!userId) return res.status(401).end()
  req.user = { id: userId }
} else {
  // legacy JWT flow — keep temporarily
  try { req.user = jwt.verify(token, JWT_SECRET) } catch { return res.status(401).end() }
}
```

### Frontend: One SSE context + ticket
Create `hooks/useSSE.js` — a singleton context that:
1. Calls `POST /api/bookings/sse-ticket` (authenticated header)
2. Opens ONE `EventSource` with `?ticket=<nonce>`
3. Fan-out to subscribers via a `EventEmitter` or React context
4. Reconnects with backoff on `onerror`/`onclose`

Update `Layout.jsx`, `Chat.jsx`, `LiveBarberMap.jsx` to subscribe to the shared context instead of opening their own EventSource.

### Frontend: Route guards (`middleware.ts`)
```ts
// web/frontend/src/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PROTECTED = ['/bookings', '/book', '/profile', '/payments', '/barber']
const ADMIN_ONLY = ['/admin']

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const hasToken = req.cookies.has('beam0-session') // after cookie migration
    || req.headers.get('x-has-auth') === '1' // interim: set by client layout
  
  if (ADMIN_ONLY.some(p => pathname.startsWith(p))) {
    // Admin check needs a DB call — handle in AdminLayout (already done)
    // Just ensure not unauthenticated
  }
  if (PROTECTED.some(p => pathname.startsWith(p)) && !hasToken) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/bookings/:path*', '/book', '/profile', '/payments', '/barber/:path*'] }
```
Interim: since the token is in localStorage (not a cookie), the middleware check is a client-side guard on mount — add `RequireAuth` wrapper component that checks `isAuthenticated` from the store and redirects if false.

### `web/frontend/src/store/index.js`

**FE-5 — idempotency keys on mutations:**
```js
// Expose a mint function; callers use it:
createBooking: async (payload) => {
  const key = newIdempotencyKey()
  return api.createBooking(payload, key)
}
```
Guard in-flight per booking with a `Set`:
```js
const inFlight = new Set()
acceptBooking: async (id, paymentMethodId) => {
  if (inFlight.has(id)) return
  inFlight.add(id)
  try { ... } finally { inFlight.delete(id) }
}
```

**FE-6 — smarter 401 handling:**
```js
// In api/client.js interceptor:
axiosInstance.interceptors.response.use(null, async (err) => {
  if (err.response?.status === 401) {
    const code = err.response.data?.code
    if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN') {
      // Try refresh once
      const refreshToken = useAuthStore.getState().refreshToken
      if (refreshToken && !err.config._retried) {
        err.config._retried = true
        const res = await axiosInstance.post('/api/auth/refresh', { refresh_token: refreshToken })
        useAuthStore.getState().setToken(res.data.access_token)
        err.config.headers.Authorization = `Bearer ${res.data.access_token}`
        return axiosInstance(err.config)
      }
      useAuthStore.getState().logout()
    }
    // For ownership-check 401s (not session), don't logout
  }
  return Promise.reject(err)
})
```

## Notes
- Cookie migration (FE-1) is the correct long-term fix but requires backend `Set-Cookie` on login — high scope. SSE ticket (this spec) is the pragmatic first step that eliminates the most dangerous vector (token in URL/logs). Track localStorage → cookie migration as a separate spec.
- `middleware.ts` interim guard uses the store's `isAuthenticated` via a client component — not server-enforced (expected; the backend enforces auth). Flash is eliminated by rendering a `<LoadingSpinner />` while checking.

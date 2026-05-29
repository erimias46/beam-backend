import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import { rateLimit } from 'express-rate-limit'
import { fileURLToPath } from 'url'
import path from 'path'
import { logger, captureError } from './services/logger.js'
import { requestId } from './middleware/request-id.js'
import { metricsMiddleware, snapshot } from './services/metrics.js'
import { requireAuth, requireRole } from './middleware/auth.js'
import { query } from './db/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

import authRoutes from './routes/auth.js'
import barbersRoutes from './routes/barbers.js'
import bookingsRoutes from './routes/bookings.js'
import stripeRoutes from './routes/stripe.js'
import paymentsRoutes from './routes/payments.js'
import devicesRoutes from './routes/devices.js'
import reviewsRoutes from './routes/reviews.js'
import adminRoutes from './routes/admin.js'
import configRoutes from './routes/config.js'
import { adminRefundRouter, customerRefundRouter, refundsListRouter } from './routes/refunds.js'
import customerRatingsRoutes from './routes/customer-ratings.js'
import { reportsRouter, blocksRouter, adminReportsRouter } from './routes/reports.js'
import { chatRouter, adminChatRouter } from './routes/chat.js'
import { locationRouter } from './routes/location.js'
import addressesRoutes from './routes/addresses.js'
import { favoritesRouter, barberFavoritesCountRouter, rebookRouter } from './routes/favorites.js'
import portfolioRoutes from './routes/portfolio.js'
import { publicReceiptRouter, authReceiptRouter } from './routes/receipts.js'
import barberOpsRoutes from './routes/barber-ops.js'
import { legalRouter, adminLegalRouter } from './routes/legal.js'
import { promosRouter, creditsRouter, adminPromosRouter } from './routes/promos.js'
import { citiesRouter, adminCitiesRouter } from './routes/cities.js'
import { unsubscribeRouter } from './routes/email-campaigns.js'
import { sessionsRouter } from './routes/sessions.js'
import { startWorker } from './services/queue.js'
import { initSettingsTable } from './services/settings.js'

const app = express()
const PORT = process.env.PORT || 4000

// Trust Railway / Cloudflare proxy so req.ip is the client, not the LB
app.set('trust proxy', 1)

/* ─── Security ───────────────────────────────────────────── */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // API only — frontend sets its own CSP
}))

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use(cors({
  origin(origin, cb) {
    // Allow same-origin / curl / mobile (no Origin header)
    if (!origin) return cb(null, true)
    if (process.env.NODE_ENV !== 'production') return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('CORS not allowed'))
  },
  credentials: true,
}))

/* ─── Rate limiting (broad floor; routes add stricter on top) ─── */
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}))

/* ─── Static uploads ─────────────────────────────────────── */
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

/* ─── Body parsing ───────────────────────────────────────── */
// Stripe webhook needs raw body — mount before json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '1mb' }))

/* ─── Logging ────────────────────────────────────────────── */
// Per-request trace id + structured request log via pino-http. The trace id
// is exposed on the response header `X-Request-Id` for client debugging.
app.use(requestId())
app.use(metricsMiddleware())
if (process.env.NODE_ENV !== 'test') {
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,                  // reuse the id we set above
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error'
      if (res.statusCode >= 400) return 'warn'
      // /health is hit constantly by Railway; tone it down.
      if (req.url === '/health') return 'trace'
      return 'info'
    },
    serializers: {
      req(req) { return { method: req.method, url: req.url, id: req.id } },
      res(res) { return { statusCode: res.statusCode } },
    },
  }))
}

/* ─── Routes ─────────────────────────────────────────────── */
app.use('/api/config',   configRoutes)
app.use('/api/auth',     authRoutes)
app.use('/api/barbers',  barbersRoutes)
app.use('/api/bookings', bookingsRoutes)
app.use('/api/stripe',   stripeRoutes)
app.use('/api/payments', paymentsRoutes)
app.use('/api/devices',  devicesRoutes)
app.use('/api/reviews',  reviewsRoutes)
app.use('/api/customer-ratings', customerRatingsRoutes)
app.use('/api/reports',  reportsRouter)
app.use('/api/blocks',   blocksRouter)
app.use('/api/admin',    adminReportsRouter)
app.use('/api/bookings', chatRouter)
app.use('/api/bookings', locationRouter)
app.use('/api/bookings', rebookRouter)
app.use('/api/bookings', authReceiptRouter)
app.use('/api/admin',    adminChatRouter)
app.use('/api/addresses',  addressesRoutes)
app.use('/api/favorites',  favoritesRouter)
app.use('/api/barbers',    barberFavoritesCountRouter)
app.use('/api',            portfolioRoutes)
app.use('/api/receipts',   publicReceiptRouter)
app.use('/api/barbers',    barberOpsRoutes)
// Phase 6 + 7
app.use('/api/legal',      legalRouter)
app.use('/api/admin',      adminLegalRouter)
app.use('/api/promos',     promosRouter)
app.use('/api/users',      promosRouter)        // exposes /me/referral-code
app.use('/api/credits',    creditsRouter)
app.use('/api/admin',      adminPromosRouter)
app.use('/api/cities',     citiesRouter)
app.use('/api/admin',      adminCitiesRouter)
app.use('/api/unsubscribe', unsubscribeRouter)
app.use('/api/auth',       sessionsRouter)
// Refunds — split routers per spec 0012. Mount the admin one under /api/admin
// so the existing /admin/* route table covers it; the customer router lives
// under /api/bookings so customers can self-refund their own bookings.
app.use('/api/admin',    adminRefundRouter)
app.use('/api/bookings', customerRefundRouter)
app.use('/api',          refundsListRouter)
app.use('/api/admin',    adminRoutes)

/* ─── Health + metrics (spec 0003) ───────────────────────── */
// /health: cheap liveness, used by Railway healthcheck. Always 200 if process up.
app.get('/health', (_, res) => res.json({
  ok: true,
  ts: Date.now(),
  sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'unknown',
  uptime_s: Math.round(process.uptime()),
}))

// /health/ready: deeper readiness — DB, Redis, migrations. Returns 503 if any check fails.
async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise.then(v => ({ ok: true, ...v })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `${label}_timeout` }), ms)),
  ]).catch(err => ({ ok: false, error: err?.message || String(err) }))
}

app.get('/health/ready', async (_, res) => {
  const checks = {}

  // DB
  const dbStart = Date.now()
  checks.db = await withTimeout(
    query('SELECT 1').then(() => ({ latency_ms: Date.now() - dbStart })),
    1000, 'db'
  )

  // Migrations
  checks.migrations = await withTimeout(
    query('SELECT MAX(name) AS current FROM schema_migrations').then(r => ({ current: r.rows[0]?.current })),
    1000, 'migrations'
  )

  // Redis — via the bullmq queue. Lazy-import to avoid pulling the worker
  // into test mode.
  const redisStart = Date.now()
  checks.redis = await withTimeout(
    import('./services/queue.js').then(async ({ default: _ }) => {
      // We don't expose the queue handle; the simplest check is to use ioredis
      // directly with the same URL.
      const { default: Redis } = await import('ioredis')
      const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
      try {
        await r.connect()
        await r.ping()
        return { latency_ms: Date.now() - redisStart }
      } finally { r.disconnect() }
    }),
    1000, 'redis'
  )

  const allOk = Object.values(checks).every(c => c.ok)
  res.status(allOk ? 200 : 503).json({ ok: allOk, checks })
})

// /metrics: admin-only snapshot. Counters reset on process restart.
app.get('/metrics', requireAuth, requireRole('admin'), async (_, res, next) => {
  try {
    // Pull BullMQ job counts at snapshot time (lazy so test mode without Redis still works).
    let getCounts
    try {
      const { getQueueCounts } = await import('./services/queue.js')
      getCounts = getQueueCounts
    } catch { /* queue helper not exported yet; fine */ }
    const snap = await snapshot({ getBullmqCounts: getCounts })
    res.json(snap)
  } catch (err) { next(err) }
})

/* ─── 404 ────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

/* ─── Error handler ──────────────────────────────────────── */
app.use((err, req, res, next) => {
  const status = err.status || 500
  // Capture 5xx and surface to whichever sink ERROR_WEBHOOK_URL points to.
  // 4xx are caller errors — log at warn via pino-http above, don't capture.
  if (status >= 500) {
    captureError(err, {
      req_id:  req.id,
      method:  req.method,
      url:     req.originalUrl,
      user_id: req.user?.id,
    })
  } else {
    req.log?.warn({ err: err.message, status }, 'request failed')
  }
  const msg = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error')
  res.status(status).json({ error: msg })
})

// Side effects gated behind NODE_ENV — tests import `app` for supertest and
// don't want the worker/listener firing on import. See specs/0004-test-harness.md.
if (process.env.NODE_ENV !== 'test') {
  startWorker()
  initSettingsTable().catch(err => logger.warn({ err }, '[settings] table init failed'))
  app.listen(PORT, () => {
    logger.info({ port: PORT }, `Beam0 API listening`)
  })
}

export default app

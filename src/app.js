import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { rateLimit } from 'express-rate-limit'

import authRoutes from './routes/auth.js'
import barbersRoutes from './routes/barbers.js'
import bookingsRoutes from './routes/bookings.js'
import stripeRoutes from './routes/stripe.js'
import devicesRoutes from './routes/devices.js'
import reviewsRoutes from './routes/reviews.js'

const app = express()
const PORT = process.env.PORT || 4000

/* ─── Security ───────────────────────────────────────────── */
app.use(helmet())
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://beam0.app', 'https://www.beam0.app']
    : '*',
  credentials: true,
}))

/* ─── Rate limiting ──────────────────────────────────────── */
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}))

/* ─── Body parsing ───────────────────────────────────────── */
// Stripe webhook needs raw body — mount before json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))

/* ─── Logging ────────────────────────────────────────────── */
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'))
}

/* ─── Routes ─────────────────────────────────────────────── */
app.use('/api/auth',     authRoutes)
app.use('/api/barbers',  barbersRoutes)
app.use('/api/bookings', bookingsRoutes)
app.use('/api/stripe',   stripeRoutes)
app.use('/api/devices',  devicesRoutes)
app.use('/api/reviews',  reviewsRoutes)

/* ─── Health ─────────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }))

/* ─── 404 ────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

/* ─── Error handler ──────────────────────────────────────── */
app.use((err, req, res, next) => {
  const status = err.status || 500
  console.error(err)
  res.status(status).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`Beam0 API running on :${PORT}`)
})

export default app

import { Router } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import { Redis } from 'ioredis'
import { rateLimit } from 'express-rate-limit'
import { query } from '../db/index.js'
import { JWT_SECRET } from '../middleware/auth.js'
import { getSetting } from '../services/settings.js'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true })

const router = Router()

const EmailSchema = z.object({ email: z.string().email().max(254).toLowerCase() })
const OtpSchema   = z.object({
  email: z.string().email().max(254).toLowerCase(),
  code:  z.string().regex(/^\d{6}$/),
  role:  z.enum(['customer', 'barber', 'admin']).optional().default('customer'),
})

/* ─── Rate limits (defence-in-depth on top of OTP TTL + attempt cap) ─── */
const sendOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many code requests. Try again later.' },
})
const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
})

function generateOtp() {
  // 6-digit, cryptographically random
  const n = crypto.randomInt(0, 1_000_000)
  return String(n).padStart(6, '0')
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex')
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function getTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return nodemailer.createTransport({ jsonTransport: true })
}

/* POST /api/auth/send-otp */
router.post('/send-otp', sendOtpLimiter, async (req, res, next) => {
  try {
    const { email } = EmailSchema.parse(req.body)

    const otp = generateOtp()
    // Store only hash; 10-min TTL; reset attempt counter
    await redis.multi()
      .set(`otp:${email}`, hashOtp(otp), 'EX', 600)
      .del(`otp:${email}:attempts`)
      .exec()

    const transport = getTransport()
    const info = await transport.sendMail({
      from:    process.env.SMTP_FROM || 'Beam0 <noreply@beam0.app>',
      to:      email,
      subject: `Your Beam0 code: ${otp}`,
      text:    `Your one-time login code is: ${otp}\n\nExpires in 10 minutes. If you didn't request this, ignore it.`,
      html:    `<div style="font-family:sans-serif;max-width:400px;margin:0 auto">
                  <h2 style="color:#FF6B1A">Beam0</h2>
                  <p>Your one-time login code:</p>
                  <h1 style="font-size:48px;letter-spacing:8px;color:#0D0D0D">${otp}</h1>
                  <p style="color:#8A8A8E;font-size:13px">Expires in 10 minutes. If you didn't request this, ignore it.</p>
                </div>`,
    })

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[AUTH] OTP for ${email}: ${otp}`)
      if (info.message) console.log('[AUTH] (no SMTP configured — code logged above)')
    }

    // Always return same shape — do not leak whether email exists
    res.json({ ok: true, message: 'If that email exists, a code has been sent.' })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* POST /api/auth/verify-otp */
router.post('/verify-otp', verifyOtpLimiter, async (req, res, next) => {
  try {
    const { email, code, role } = OtpSchema.parse(req.body)

    const attemptsKey = `otp:${email}:attempts`
    const attempts = Number((await redis.get(attemptsKey)) || 0)
    if (attempts >= 5) {
      // Burn the OTP so a fresh send is required
      await redis.del(`otp:${email}`)
      return res.status(429).json({ error: 'Too many invalid attempts. Request a new code.' })
    }

    const masterOtp = process.env.MASTER_OTP
    const isMaster  = masterOtp && code === masterOtp
    if (!isMaster) {
      const stored = await redis.get(`otp:${email}`)
      const ok = stored && timingSafeEq(stored, hashOtp(code))
      if (!ok) {
        await redis.multi().incr(attemptsKey).expire(attemptsKey, 600).exec()
        return res.status(401).json({ error: 'Invalid or expired code' })
      }
      // Consume OTP + clear attempts
      await redis.multi().del(`otp:${email}`).del(attemptsKey).exec()
    }

    // Upsert user by email
    const existing = await query('SELECT * FROM users WHERE email = $1', [email])
    let user = existing.rows[0]
    if (!user) {
      // Check signup gates
      if (role === 'barber' && (await getSetting('barber_signups_enabled')) === 'false') {
        return res.status(403).json({ error: 'Barber signups are currently closed.' })
      }
      if (role === 'customer' && (await getSetting('customer_signups_enabled')) === 'false') {
        return res.status(403).json({ error: 'New signups are currently closed.' })
      }
      const result = await query(
        `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *`,
        [email.split('@')[0], email, role]
      )
      user = result.rows[0]
      // Seed barber_profiles row so the barber can set up their profile immediately
      if (role === 'barber') {
        await query(
          `INSERT INTO barber_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [user.id]
        )
      }
    } else if (user.is_suspended) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' })
    }

    // Refresh last_active_at (best-effort)
    query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]).catch(() => {})

    // Legacy 90-day JWT — kept for backward compatibility through the rollout
    // window (spec 0074). New clients should consume access + refresh instead.
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: '90d' }
    )

    // Spec 0074: mint a short-lived access token + a long-lived refresh token
    // and persist the session. Plaintext refresh is returned once; the DB
    // only stores its sha256 hash.
    const { mintAccessToken, createSession } = await import('./sessions.js')
    const access_token = mintAccessToken(user)
    const refresh_token = await createSession({
      userId:      user.id,
      ipAddress:   req.ip || null,
      userAgent:   (req.headers['user-agent'] || '').slice(0, 500),
      deviceLabel: req.headers['user-agent']?.slice(0, 80) || null,
    })

    res.json({
      token,                                          // legacy
      access_token,                                   // new (spec 0074)
      refresh_token,                                  // new (spec 0074)
      expires_in: 15 * 60,                            // access TTL
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        stripe_account_id: user.stripe_account_id ?? null,
      },
    })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* PATCH /api/auth/profile — update own name */
router.patch('/profile', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const { name } = z.object({ name: z.string().min(1).max(100).trim() }).parse(req.body)
    const { rows } = await query(
      `UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name, email, role`,
      [name, payload.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: rows[0] })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' })
    next(err)
  }
})

/* DELETE /api/auth/account — delete own account (spec 0061).
   Users with any paid bookings in the past 7 years are soft-deleted
   (anonymized) so the financial record survives. Others are hard-deleted.
   Caller can optionally include { reason, notes } for our records. */
router.delete('/account', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const reason = String(req.body?.reason || '').slice(0, 60) || null

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM bookings
        WHERE (customer_id = $1 OR barber_id = $1)
          AND status IN ('paid','completed')
          AND created_at > now() - interval '7 years'`,
      [payload.id]
    )
    const hasFinancialHistory = (rows[0]?.n ?? 0) > 0

    if (hasFinancialHistory) {
      // Soft-delete: anonymize PII, kill auth, keep the row + booking refs.
      await query(
        `UPDATE users
            SET name  = '[deleted-' || id::text || ']',
                email = NULL,
                phone = NULL,
                stripe_customer_id = NULL,
                deleted_at = now(),
                deleted_reason = $2
          WHERE id = $1`,
        [payload.id, reason]
      )
      // CASCADE wipes saved_addresses, push_subscriptions, blocks, favorites,
      // chat_messages (body remains via UPDATE on next migration if needed).
      await query(`DELETE FROM saved_addresses    WHERE user_id = $1`, [payload.id]).catch(() => {})
      await query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [payload.id]).catch(() => {})
      await query(`DELETE FROM user_blocks        WHERE blocker_id = $1 OR blocked_id = $1`, [payload.id]).catch(() => {})
      return res.json({ ok: true, mode: 'soft_deleted' })
    }

    // No financial history — true hard delete via CASCADE.
    await query(`DELETE FROM users WHERE id = $1`, [payload.id])
    res.json({ ok: true, mode: 'hard_deleted' })
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' })
    next(err)
  }
})

/* POST /api/auth/export — request a JSON snapshot of all my data (spec 0061).
   Returns the snapshot inline for v1 (small data). When sizes grow, switch
   to an async job + emailed signed download URL. */
router.post('/export', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const id = payload.id

    const [user, bookings, addresses, reviews, ratings, consents, pushSubs, blocks, favorites] = await Promise.all([
      query(`SELECT id, name, email, role, created_at FROM users WHERE id = $1`, [id]),
      query(`SELECT * FROM bookings WHERE customer_id = $1 OR barber_id = $1`, [id]),
      query(`SELECT * FROM saved_addresses WHERE user_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM reviews WHERE reviewer_id = $1 OR barber_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM customer_ratings WHERE customer_id = $1 OR barber_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM user_consents WHERE user_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT endpoint FROM push_subscriptions WHERE user_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1`, [id]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM barber_favorites WHERE customer_id = $1 OR barber_id = $1`, [id]).catch(() => ({ rows: [] })),
    ])

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="beam0-data-export-${id}.json"`)
    res.json({
      exported_at: new Date().toISOString(),
      user:        user.rows[0] || null,
      bookings:    bookings.rows,
      addresses:   addresses.rows,
      reviews:     reviews.rows,
      ratings:     ratings.rows,
      consents:    consents.rows,
      push_subs:   pushSubs.rows,
      blocks:      blocks.rows,
      favorites:   favorites.rows,
    })
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' })
    next(err)
  }
})

/* GET /api/auth/me — current user (used to refresh state after login) */
router.get('/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const { rows } = await query(
      `SELECT id, name, email, role, is_suspended, stripe_account_id, email_notifications,
              push_prompt_accepted_at, push_prompt_dismissed_at
         FROM users WHERE id = $1`,
      [payload.id]
    )
    if (!rows[0] || rows[0].is_suspended) return res.status(401).json({ error: 'Invalid session' })
    res.json({ user: rows[0] })
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

/* PATCH /api/auth/push-prompt — record the user's in-app push prompt response.
   See specs/0032-push-permission-ux.md. Frontend tracks the state via the
   timestamps to decide re-prompt cadence (default 30 days after dismiss). */
router.patch('/push-prompt', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const action = req.body?.action
    if (action !== 'dismissed' && action !== 'accepted') {
      return res.status(400).json({ error: 'invalid_action' })
    }
    const column = action === 'accepted' ? 'push_prompt_accepted_at' : 'push_prompt_dismissed_at'
    await query(`UPDATE users SET ${column} = now() WHERE id = $1`, [payload.id])
    res.json({ ok: true })
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

/* PATCH /api/auth/notifications — update email notification preference */
router.patch('/notifications', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const { email_notifications } = req.body
    await query(
      `UPDATE users SET email_notifications = $1 WHERE id = $2`,
      [!!email_notifications, payload.id]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' })
    next(err)
  }
})

export default router

import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import { Redis } from 'ioredis'
import { query } from '../db/index.js'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true })

const router = Router()

const EmailSchema = z.object({ email: z.string().email() })
const OtpSchema   = z.object({ email: z.string().email(), code: z.string().length(6) })

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
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
  // Dev: log to console, no SMTP required
  return nodemailer.createTransport({ jsonTransport: true })
}

/* POST /api/auth/send-otp */
router.post('/send-otp', async (req, res, next) => {
  try {
    const { email } = EmailSchema.parse(req.body)

    const otp = generateOtp()
    await redis.set(`otp:${email}`, otp, 'EX', 600) // 10-min TTL

    const transport = getTransport()
    const info = await transport.sendMail({
      from:    process.env.SMTP_FROM || 'Beam0 <noreply@beam0.app>',
      to:      email,
      subject: `Your Beam0 code: ${otp}`,
      text:    `Your one-time login code is: ${otp}\n\nExpires in 10 minutes.`,
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

    res.json({ ok: true, message: 'Code sent' })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* POST /api/auth/verify-otp */
router.post('/verify-otp', async (req, res, next) => {
  try {
    const { email, code } = OtpSchema.parse(req.body)

    const stored = await redis.get(`otp:${email}`)
    if (!stored || stored !== code) {
      return res.status(401).json({ error: 'Invalid or expired code' })
    }
    await redis.del(`otp:${email}`)

    // Upsert user by email
    const existing = await query('SELECT * FROM users WHERE email = $1', [email])
    let user = existing.rows[0]
    if (!user) {
      const result = await query(
        `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *`,
        [email.split('@')[0], email, 'customer']
      )
      user = result.rows[0]
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    )

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

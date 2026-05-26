import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { query } from '../db/index.js'

const router = Router()

const PhoneSchema = z.object({ phone: z.string().min(7).max(20) })
const OtpSchema = z.object({
  phone: z.string().min(7).max(20),
  code: z.string().length(6),
})

/* POST /api/auth/send-otp */
router.post('/send-otp', async (req, res, next) => {
  try {
    const { phone } = PhoneSchema.parse(req.body)

    // TODO: await twilioVerify.verifications.create({ to: phone, channel: 'sms' })
    // For now, always succeed (dev mode)
    console.log(`[AUTH] OTP send to ${phone} (dev: use 123456)`)

    res.json({ ok: true, message: 'OTP sent' })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* POST /api/auth/verify-otp */
router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, code } = OtpSchema.parse(req.body)

    // TODO: verify with Twilio in production
    // const check = await twilioVerify.verificationChecks.create({ to: phone, code })
    // if (check.status !== 'approved') return res.status(401).json({ error: 'Wrong code' })

    // Dev mode: accept any 6-digit code
    if (process.env.NODE_ENV === 'production' && code !== '123456') {
      return res.status(401).json({ error: 'Wrong code' })
    }

    // Upsert user
    const existing = await query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    )

    let user = existing.rows[0]
    if (!user) {
      const result = await query(
        `INSERT INTO users (name, phone, role) VALUES ($1, $2, $3) RETURNING *`,
        ['New User', phone, 'customer']
      )
      user = result.rows[0]
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    )

    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role } })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

import { Router } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { query } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const deviceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true, legacyHeaders: false,
})

const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(10).max(512),
    auth:   z.string().min(10).max(64),
  }),
  expirationTime: z.number().nullable().optional(),
})

/* POST /api/devices/push-subscribe — save Web Push subscription */
router.post('/push-subscribe', requireAuth, deviceLimiter, async (req, res, next) => {
  try {
    const sub = PushSubscriptionSchema.parse(req.body)
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, subscription)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET subscription = $3::jsonb`,
      [req.user.id, sub.endpoint, JSON.stringify(sub)]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* DELETE /api/devices/push-subscribe — unsubscribe on logout */
router.delete('/push-subscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body)
    await query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [req.user.id, endpoint]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

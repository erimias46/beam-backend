import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const DeviceSchema = z.object({
  fcm_token: z.string().min(1),
  platform:  z.enum(['web', 'ios', 'android']),
})

/* POST /api/devices/register */
router.post('/register', requireAuth, async (req, res, next) => {
  try {
    const { fcm_token, platform } = DeviceSchema.parse(req.body)
    await query(
      `INSERT INTO user_devices (user_id, fcm_token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, fcm_token) DO NOTHING`,
      [req.user.id, fcm_token, platform]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

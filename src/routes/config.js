import { Router } from 'express'
import { getSettings } from '../services/settings.js'

const router = Router()

/* GET /api/config — public, returns platform settings the mobile app needs */
router.get('/', async (_req, res, next) => {
  try {
    const s = await getSettings()
    const feeBps = parseInt(s.platform_fee_bps)
    res.json({
      platform_fee_bps:     feeBps,
      barber_share_bps:     10_000 - feeBps,
      auto_cancel_minutes:  parseInt(s.auto_cancel_minutes),
      max_advance_days:     parseInt(s.max_advance_days),
      min_notice_hours:     parseInt(s.min_notice_hours),
      max_price_cents:      parseInt(s.max_price_cents),
    })
  } catch (err) { next(err) }
})

/* GET /api/config/vapid-key — public VAPID key for Web Push subscription */
router.get('/vapid-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' })
  res.json({ vapid_public_key: key })
})

export default router

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()

const ProfileSchema = z.object({
  bio: z.string().max(500).optional(),
  years_experience: z.number().int().min(0).max(60).optional(),
  services: z.array(z.object({
    name: z.string().min(1).max(100),
    price_cents: z.number().int().min(100),
    duration_min: z.number().int().min(5).max(480),
  })).optional(),
  profile_photo_url: z.string().url().optional(),
})

/* GET /api/barbers — list available barbers */
router.get('/', async (req, res, next) => {
  try {
    const { lat, lng, radius = 50 } = req.query

    const result = await query(
      `SELECT u.id, u.name, bp.bio, bp.years_experience, bp.services,
              bp.profile_photo_url, bp.is_available, bp.rating_avg, bp.rating_count
       FROM users u
       JOIN barber_profiles bp ON bp.user_id = u.id
       WHERE u.role = 'barber' AND bp.is_available = true
       ORDER BY bp.rating_avg DESC
       LIMIT 50`
    )

    res.json({ barbers: result.rows })
  } catch (err) {
    next(err)
  }
})

/* GET /api/barbers/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, bp.bio, bp.years_experience, bp.services,
              bp.profile_photo_url, bp.is_available, bp.rating_avg, bp.rating_count
       FROM users u
       JOIN barber_profiles bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    )

    if (!result.rows[0]) return res.status(404).json({ error: 'Barber not found' })
    res.json({ barber: result.rows[0] })
  } catch (err) {
    next(err)
  }
})

/* POST /api/barbers/profile — create or update profile */
router.post('/profile', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const data = ProfileSchema.parse(req.body)

    const existing = await query('SELECT id FROM barber_profiles WHERE user_id = $1', [req.user.id])

    if (existing.rows[0]) {
      const fields = []
      const vals = []
      let i = 1
      if (data.bio !== undefined) { fields.push(`bio = $${i++}`); vals.push(data.bio) }
      if (data.years_experience !== undefined) { fields.push(`years_experience = $${i++}`); vals.push(data.years_experience) }
      if (data.services !== undefined) { fields.push(`services = $${i++}`); vals.push(JSON.stringify(data.services)) }
      if (data.profile_photo_url !== undefined) { fields.push(`profile_photo_url = $${i++}`); vals.push(data.profile_photo_url) }
      vals.push(req.user.id)
      await query(`UPDATE barber_profiles SET ${fields.join(', ')} WHERE user_id = $${i}`, vals)
    } else {
      await query(
        `INSERT INTO barber_profiles (user_id, bio, years_experience, services, profile_photo_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, data.bio, data.years_experience, JSON.stringify(data.services || []), data.profile_photo_url]
      )
    }

    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* POST /api/barbers/onboard — Stripe Connect onboarding */
router.post('/onboard', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    // TODO: create Stripe connected account + return onboarding URL
    // const account = await stripe.accounts.create({ type: 'express' })
    // const link = await stripe.accountLinks.create({ account: account.id, ... })
    res.json({ url: 'https://connect.stripe.com/setup/e/mock' })
  } catch (err) {
    next(err)
  }
})

/* PATCH /api/barbers/availability */
router.patch('/availability', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { is_available } = z.object({ is_available: z.boolean() }).parse(req.body)
    await query('UPDATE barber_profiles SET is_available = $1 WHERE user_id = $2', [is_available, req.user.id])
    res.json({ ok: true, is_available })
  } catch (err) {
    next(err)
  }
})

export default router

import { Router } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import multer from 'multer'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { rateLimit } from 'express-rate-limit'
import { query } from '../db/index.js'
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '../../uploads/barbers')
mkdirSync(UPLOADS_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      cb(null, `${randomUUID()}${ext}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPG, PNG and WebP images are allowed'), allowed.includes(file.mimetype))
  },
})

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const router = Router()

const ProfileSchema = z.object({
  bio: z.string().max(500).optional(),
  years_experience: z.number().int().min(0).max(60).optional(),
  services: z.array(z.object({
    name: z.string().min(1).max(100),
    price_cents: z.number().int().min(500).max(100_000),
    duration_min: z.number().int().min(5).max(480),
  })).max(20).optional(),
  profile_photo_url: z.string().url().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  base_address: z.string().max(300).optional(),
  service_radius_km: z.number().min(1).max(500).optional(),
})

// Search filters on GET / — spec 0045 adds min_rating, max_price_cents,
// services (CSV), and favorites_first sort hint.
const NearbySchema = z.object({
  lat:              z.coerce.number().min(-90).max(90).optional(),
  lng:              z.coerce.number().min(-180).max(180).optional(),
  radius:           z.coerce.number().min(1).max(500).optional(),
  min_rating:       z.coerce.number().min(0).max(5).optional(),
  max_price_cents:  z.coerce.number().int().min(0).optional(),
  services:         z.string().optional(),
  favorites_first:  z.coerce.boolean().optional(),
})

const onboardLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true, legacyHeaders: false,
})

/* GET /api/barbers — list available barbers.
   Pass ?lat=&lng= to sort by distance from the customer; add &radius= (km)
   to hide barbers outside that range. Barbers without a set location are
   sorted last, and excluded entirely when a radius is given. */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { lat, lng, radius, min_rating, max_price_cents, services, favorites_first }
      = NearbySchema.parse(req.query)
    const hasGeo = lat != null && lng != null

    // Haversine great-circle distance in km between (lat,lng) and the barber.
    const distanceExpr = `
      6371 * acos(LEAST(1.0, GREATEST(-1.0,
        cos(radians($1)) * cos(radians(bp.lat)) * cos(radians(bp.lng) - radians($2))
        + sin(radians($1)) * sin(radians(bp.lat))
      )))`

    const params = []
    let selectDistance = 'NULL::numeric AS distance_km'
    let whereRadius = ''
    let orderBy = 'bp.rating_avg DESC NULLS LAST, bp.rating_count DESC'

    if (hasGeo) {
      params.push(lat, lng)
      selectDistance = `CASE WHEN bp.lat IS NOT NULL AND bp.lng IS NOT NULL
                              THEN round((${distanceExpr})::numeric, 1) END AS distance_km`
      orderBy = 'distance_km ASC NULLS LAST, bp.rating_avg DESC NULLS LAST'
      if (radius != null) {
        params.push(radius)
        whereRadius = `AND bp.lat IS NOT NULL AND bp.lng IS NOT NULL
                       AND (${distanceExpr}) <= $3`
      }
    }

    // Additional filters from spec 0045
    let filterMinRating = ''
    if (min_rating != null) {
      params.push(min_rating)
      filterMinRating = `AND COALESCE(bp.rating_avg, 0) >= $${params.length}`
    }
    let filterMaxPrice = ''
    if (max_price_cents != null) {
      params.push(max_price_cents)
      // Match if ANY service in the JSON array is <= max_price.
      filterMaxPrice = `AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(bp.services) s
         WHERE (s->>'price_cents')::int <= $${params.length}
      )`
    }
    let filterServices = ''
    if (services) {
      const wanted = services.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      if (wanted.length) {
        params.push(wanted)
        filterServices = `AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(bp.services) s
           WHERE lower(s->>'name') = ANY($${params.length}::text[])
        )`
      }
    }
    // Exclude barbers blocked by / blocking the requesting user, if authed.
    let filterBlocks = ''
    if (req.user?.id) {
      params.push(req.user.id)
      filterBlocks = `AND NOT EXISTS (
        SELECT 1 FROM user_blocks ub
         WHERE (ub.blocker_id = u.id AND ub.blocked_id = $${params.length})
            OR (ub.blocker_id = $${params.length} AND ub.blocked_id = u.id)
      )`
    }
    // Favorites-first sort: shift favorited barbers to the top.
    let favSelect = 'false AS is_favorite'
    if (favorites_first && req.user?.id) {
      params.push(req.user.id)
      favSelect = `EXISTS (
        SELECT 1 FROM barber_favorites f
         WHERE f.customer_id = $${params.length} AND f.barber_id = u.id
      ) AS is_favorite`
      orderBy = `is_favorite DESC, ${orderBy}`
    }

    const { rows } = await query(
      `SELECT u.id, u.name, bp.bio, bp.years_experience, bp.services,
              bp.profile_photo_url, bp.is_available, bp.rating_avg, bp.rating_count,
              ${selectDistance},
              ${favSelect}
         FROM users u
         JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.role = 'barber'
          AND u.is_suspended = false
          AND bp.is_available = true
          ${whereRadius}
          ${filterMinRating}
          ${filterMaxPrice}
          ${filterServices}
          ${filterBlocks}
        ORDER BY ${orderBy}
        LIMIT 50`,
      params
    )
    res.json({ barbers: rows })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/barbers/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, bp.bio, bp.years_experience, bp.services,
              bp.profile_photo_url, bp.is_available, bp.rating_avg, bp.rating_count
         FROM users u
         JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'barber' AND u.is_suspended = false`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Barber not found' })
    res.json({ barber: rows[0] })
  } catch (err) { next(err) }
})

/* POST /api/barbers/profile — create or update profile */
router.post('/profile', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const data = ProfileSchema.parse(req.body)

    await query(
      `INSERT INTO barber_profiles (user_id, bio, years_experience, services, profile_photo_url,
                                    lat, lng, base_address, service_radius_km)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE SET
         bio               = COALESCE(EXCLUDED.bio, barber_profiles.bio),
         years_experience  = COALESCE(EXCLUDED.years_experience, barber_profiles.years_experience),
         services          = COALESCE(EXCLUDED.services, barber_profiles.services),
         profile_photo_url = COALESCE(EXCLUDED.profile_photo_url, barber_profiles.profile_photo_url),
         lat               = COALESCE(EXCLUDED.lat, barber_profiles.lat),
         lng               = COALESCE(EXCLUDED.lng, barber_profiles.lng),
         base_address      = COALESCE(EXCLUDED.base_address, barber_profiles.base_address),
         service_radius_km = COALESCE(EXCLUDED.service_radius_km, barber_profiles.service_radius_km),
         updated_at        = NOW()`,
      [
        req.user.id,
        data.bio ?? null,
        data.years_experience ?? null,
        data.services ? JSON.stringify(data.services) : null,
        data.profile_photo_url ?? null,
        data.lat ?? null,
        data.lng ?? null,
        data.base_address ?? null,
        data.service_radius_km ?? null,
      ]
    )

    const { rows } = await query(
      `SELECT bio, years_experience, services, profile_photo_url,
              is_available, rating_avg, rating_count,
              lat, lng, base_address, service_radius_km,
              stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted
         FROM barber_profiles WHERE user_id = $1`,
      [req.user.id]
    )
    res.json({ profile: rows[0] })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/barbers/me/profile — my profile (barber) */
router.get('/me/profile', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT bio, years_experience, services, profile_photo_url,
              is_available, rating_avg, rating_count,
              lat, lng, base_address, service_radius_km, service_polygon,
              stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted
         FROM barber_profiles WHERE user_id = $1`,
      [req.user.id]
    )
    res.json({ profile: rows[0] || null })
  } catch (err) { next(err) }
})

/* POST /api/barbers/onboard — Stripe Connect onboarding */
router.post('/onboard', requireAuth, requireRole('barber'), onboardLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })

    const user = await query(
      `SELECT id, email, stripe_account_id FROM users WHERE id = $1`,
      [req.user.id]
    )
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' })

    let accountId = user.rows[0].stripe_account_id
    if (!accountId) {
      // Deterministic key: a retry must not create a second Connect account
      // for the same Beam0 barber. See specs/0010.
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.rows[0].email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { user_id: req.user.id },
      }, { idempotencyKey: `connect_acct_${req.user.id}` })
      accountId = account.id
      await query(
        `UPDATE users SET stripe_account_id = $1 WHERE id = $2`,
        [accountId, req.user.id]
      )
      // Ensure barber_profiles row exists
      await query(
        `INSERT INTO barber_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [req.user.id]
      )
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.APP_URL || 'http://localhost:3000'}/barber/onboard`,
      return_url:  `${process.env.APP_URL || 'http://localhost:3000'}/barber/dashboard`,
      type: 'account_onboarding',
    })
    res.json({ url: link.url })
  } catch (err) { next(err) }
})

/* ─── Identity verification (spec 0020) ──────────────────── */
// Stripe Identity gives us a hosted modal to collect government ID + selfie.
// We never see the documents. Webhook fires on the verified / failed event
// and updates barber_profiles.identity_status.

/* POST /api/barbers/identity/start — create or refresh a VerificationSession */
router.post('/identity/start', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { user_id: req.user.id },
    }, { idempotencyKey: `identity_session_${req.user.id}` })

    await query(
      `INSERT INTO barber_profiles (user_id, identity_session_id, identity_status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id) DO UPDATE
         SET identity_session_id = $2,
             identity_status     = CASE
               WHEN barber_profiles.identity_status = 'verified' THEN 'verified'
               ELSE 'pending' END,
             updated_at = NOW()`,
      [req.user.id, session.id]
    )
    res.json({ client_secret: session.client_secret, session_id: session.id })
  } catch (err) { next(err) }
})

/* GET /api/barbers/identity/status — own status */
router.get('/identity/status', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT identity_status, identity_verified_at, identity_failure_reason
         FROM barber_profiles WHERE user_id = $1`,
      [req.user.id]
    )
    res.json({
      status:           rows[0]?.identity_status ?? 'unverified',
      verified_at:      rows[0]?.identity_verified_at ?? null,
      failure_reason:   rows[0]?.identity_failure_reason ?? null,
    })
  } catch (err) { next(err) }
})

/* POST /api/barbers/photo — upload profile photo to local disk */
router.post('/photo', requireAuth, requireRole('barber'), upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' })

    const url = `/uploads/barbers/${req.file.filename}`

    // Delete old photo from disk if it was also a local upload
    const { rows } = await query(`SELECT profile_photo_url FROM barber_profiles WHERE user_id = $1`, [req.user.id])
    const oldUrl = rows[0]?.profile_photo_url
    if (oldUrl?.startsWith('/uploads/barbers/')) {
      const oldFile = path.join(UPLOADS_DIR, path.basename(oldUrl))
      if (existsSync(oldFile)) unlinkSync(oldFile)
    }

    await query(
      `INSERT INTO barber_profiles (user_id, profile_photo_url)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET profile_photo_url = $2, updated_at = NOW()`,
      [req.user.id, url]
    )

    res.json({ url })
  } catch (err) {
    if (err.message?.includes('Only JPG')) return res.status(400).json({ error: err.message })
    next(err)
  }
})

/* PATCH /api/barbers/availability */
router.patch('/availability', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { is_available } = z.object({ is_available: z.boolean() }).parse(req.body)
    // Require onboarding before going available
    await query(
      `INSERT INTO barber_profiles (user_id, is_available) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET is_available = $2, updated_at = NOW()`,
      [req.user.id, is_available]
    )
    res.json({ ok: true, is_available })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

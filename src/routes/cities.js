// City SEO landing pages — see specs/0072-city-seo-landing-pages.md.

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const CitySchema = z.object({
  slug:            z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, hyphens'),
  name:            z.string().min(2).max(120),
  state:           z.string().max(60).optional(),
  country:         z.string().max(40).optional(),
  lat:             z.number().min(-90).max(90),
  lng:             z.number().min(-180).max(180),
  hero_image_url:  z.string().url().max(500).optional(),
  copy_md:         z.string().min(20).max(20_000).optional(),
  is_active:       z.boolean().optional(),
})

export const citiesRouter = Router()

citiesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT slug, name, state, country, lat, lng, hero_image_url
         FROM service_cities WHERE is_active = true
        ORDER BY name ASC`
    )
    res.json({ cities: rows })
  } catch (err) { next(err) }
})

citiesRouter.get('/:slug', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT slug, name, state, country, lat, lng, hero_image_url, copy_md, bounds_polygon
         FROM service_cities WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!rows[0]) return res.status(404).json({ error: 'city_not_found' })

    // Top barbers near this city — reuse existing search via direct query.
    const barbers = await query(
      `SELECT u.id, u.name, bp.profile_photo_url, bp.rating_avg, bp.rating_count,
              round((6371 * acos(LEAST(1.0, GREATEST(-1.0,
                cos(radians($1)) * cos(radians(bp.lat)) * cos(radians(bp.lng) - radians($2))
                + sin(radians($1)) * sin(radians(bp.lat))
              ))))::numeric, 1) AS distance_km
         FROM users u
         JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.role = 'barber' AND u.is_suspended = false
          AND bp.is_available = true
          AND bp.lat IS NOT NULL AND bp.lng IS NOT NULL
        ORDER BY distance_km ASC, bp.rating_avg DESC NULLS LAST
        LIMIT 10`,
      [rows[0].lat, rows[0].lng]
    )
    res.json({ city: rows[0], top_barbers: barbers.rows })
  } catch (err) { next(err) }
})

export const adminCitiesRouter = Router()

adminCitiesRouter.post('/cities', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const data = CitySchema.parse(req.body)
    await query(
      `INSERT INTO service_cities (slug, name, state, country, lat, lng, hero_image_url, copy_md, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, state = EXCLUDED.state, country = EXCLUDED.country,
             lat = EXCLUDED.lat, lng = EXCLUDED.lng,
             hero_image_url = EXCLUDED.hero_image_url, copy_md = EXCLUDED.copy_md,
             is_active = EXCLUDED.is_active`,
      [data.slug, data.name, data.state ?? null, data.country ?? 'US',
       data.lat, data.lng, data.hero_image_url ?? null, data.copy_md ?? null,
       data.is_active ?? true]
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

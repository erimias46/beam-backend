// Barber portfolio — see specs/0045-search-filters-and-portfolio.md.

import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const MAX_PER_BARBER = 20

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '../../uploads/portfolio')
mkdirSync(UPLOADS_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename:    (_, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    cb(allowed.includes(file.mimetype) ? null : new Error('JPG/PNG/WebP only'), allowed.includes(file.mimetype))
  },
})

const ReorderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_PER_BARBER) })
const PatchSchema   = z.object({ caption: z.string().max(200).optional(), display_order: z.number().int().optional() })

const router = Router()

router.get('/barbers/:id/portfolio', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, image_url, caption, display_order, created_at
         FROM barber_portfolio
        WHERE barber_id = $1
        ORDER BY display_order ASC, created_at ASC`,
      [req.params.id]
    )
    res.json({ portfolio: rows })
  } catch (err) { next(err) }
})

router.post('/barbers/portfolio', requireAuth, requireRole('barber'), upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_image' })
    const { rows: count } = await query(`SELECT COUNT(*)::int AS n FROM barber_portfolio WHERE barber_id = $1`, [req.user.id])
    if (count[0].n >= MAX_PER_BARBER) {
      // Delete the just-uploaded file to avoid orphaning.
      try { unlinkSync(req.file.path) } catch { /* ignore */ }
      return res.status(409).json({ error: 'portfolio_cap_reached', max: MAX_PER_BARBER })
    }
    const url = `/uploads/portfolio/${req.file.filename}`
    const caption = String(req.body?.caption || '').slice(0, 200) || null
    const { rows } = await query(
      `INSERT INTO barber_portfolio (barber_id, image_url, caption, display_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(display_order)+1 FROM barber_portfolio WHERE barber_id=$1), 0))
       RETURNING *`,
      [req.user.id, url, caption]
    )
    res.status(201).json({ item: rows[0] })
  } catch (err) { next(err) }
})

router.patch('/barbers/portfolio/:id', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body)
    const sets = []
    const params = [req.params.id, req.user.id]
    if (data.caption !== undefined)        { params.push(data.caption);        sets.push(`caption = $${params.length}`) }
    if (data.display_order !== undefined)  { params.push(data.display_order);  sets.push(`display_order = $${params.length}`) }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' })
    const { rows } = await query(
      `UPDATE barber_portfolio SET ${sets.join(', ')} WHERE id = $1 AND barber_id = $2 RETURNING *`,
      params
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    res.json({ item: rows[0] })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

router.delete('/barbers/portfolio/:id', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `DELETE FROM barber_portfolio WHERE id = $1 AND barber_id = $2 RETURNING image_url`,
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    const url = rows[0].image_url
    if (url?.startsWith('/uploads/portfolio/')) {
      const file = path.join(UPLOADS_DIR, path.basename(url))
      if (existsSync(file)) { try { unlinkSync(file) } catch { /* ignore */ } }
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.post('/barbers/portfolio/reorder', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { ids } = ReorderSchema.parse(req.body)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          `UPDATE barber_portfolio SET display_order = $1 WHERE id = $2 AND barber_id = $3`,
          [i, ids[i], req.user.id]
        )
      }
      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err }
    finally { client.release() }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router

// Legal documents + consent records (0060) + cookie consent (0062).
//
// Document IDs are flat strings ('tos','privacy','cookies') with versioned
// rows. Latest-effective row wins for a given id.

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()
const adminRouter = Router()

router.get('/:doc', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, version, effective_at, content_md
         FROM legal_documents
        WHERE id = $1 AND effective_at <= now()
        ORDER BY effective_at DESC LIMIT 1`,
      [req.params.doc]
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.get('/:doc/versions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT version, effective_at FROM legal_documents WHERE id = $1 ORDER BY effective_at DESC`,
      [req.params.doc]
    )
    res.json({ versions: rows })
  } catch (err) { next(err) }
})

const AcceptSchema = z.object({
  document_id: z.string().min(1).max(40),
  version:     z.string().min(1).max(60),
})
router.post('/accept', requireAuth, async (req, res, next) => {
  try {
    const data = AcceptSchema.parse(req.body)
    await query(
      `INSERT INTO user_consents (user_id, document_id, version, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [req.user.id, data.document_id, data.version, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

// Spec 0062: cookie consent helper. Frontend stores per-category prefs in
// localStorage for anonymous users; authed users also POST here so admin can
// audit.
const CookieSchema = z.object({
  categories: z.object({
    essential:  z.boolean().optional(),
    analytics:  z.boolean().optional(),
    marketing:  z.boolean().optional(),
  }),
})
router.post('/cookie-consent', requireAuth, async (req, res, next) => {
  try {
    const data = CookieSchema.parse(req.body)
    await query(
      `INSERT INTO user_consents (user_id, document_id, version, ip_address, user_agent)
       VALUES ($1, 'cookies', $2, $3, $4)
       ON CONFLICT (user_id, document_id, version) DO NOTHING`,
      [req.user.id, JSON.stringify(data.categories), req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* ─── Admin authoring ────────────────────────────────────── */
const PublishSchema = z.object({
  id:           z.enum(['tos', 'privacy', 'cookies']),
  version:      z.string().min(1).max(60),
  effective_at: z.string().datetime(),
  content_md:   z.string().min(20).max(500_000),
})
adminRouter.post('/legal', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const data = PublishSchema.parse(req.body)
    await query(
      `INSERT INTO legal_documents (id, version, effective_at, content_md)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id, version) DO UPDATE
         SET effective_at = EXCLUDED.effective_at,
             content_md   = EXCLUDED.content_md`,
      [data.id, data.version, data.effective_at, data.content_md]
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export { router as legalRouter, adminRouter as adminLegalRouter }

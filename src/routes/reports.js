// Reports + blocks — see specs/0022-report-and-block-user.md.
//
// Reporting auto-creates a corresponding block from reporter → reported.
// You almost always want to block someone you're reporting, and asking for
// two steps wastes friction at the worst moment. Customer can undo the block
// later via DELETE /api/blocks/:id.

import { Router } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true, legacyHeaders: false,
})

const ReportSchema = z.object({
  reported_id: z.string().uuid(),
  booking_id:  z.string().uuid().optional(),
  category:    z.enum(['harassment','no_show','unsafe_behavior','payment_issue','impersonation','other']),
  description: z.string().min(20).max(2000),
})

const BlockSchema = z.object({
  blocked_id: z.string().uuid(),
  reason:     z.string().max(500).optional(),
})

/* ─── User reports ───────────────────────────────────────── */
export const reportsRouter = Router()

reportsRouter.post('/', requireAuth, reportLimiter, idempotency(), async (req, res, next) => {
  try {
    const data = ReportSchema.parse(req.body)
    if (data.reported_id === req.user.id) return res.status(400).json({ error: 'cannot_report_self' })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO user_reports (reporter_id, reported_id, booking_id, category, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.user.id, data.reported_id, data.booking_id ?? null, data.category, data.description]
      )
      // Auto-block reporter → reported. Reporter can unblock from settings.
      await client.query(
        `INSERT INTO user_blocks (blocker_id, blocked_id, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [req.user.id, data.reported_id, `auto-blocked from report: ${data.category}`]
      )
      await client.query('COMMIT')
      res.status(201).json({ report: inserted.rows[0] })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally { client.release() }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* ─── Blocks ─────────────────────────────────────────────── */
export const blocksRouter = Router()

blocksRouter.post('/', requireAuth, idempotency(), async (req, res, next) => {
  try {
    const data = BlockSchema.parse(req.body)
    if (data.blocked_id === req.user.id) return res.status(400).json({ error: 'cannot_block_self' })
    await query(
      `INSERT INTO user_blocks (blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [req.user.id, data.blocked_id, data.reason ?? null]
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

blocksRouter.delete('/:blockedId', requireAuth, async (req, res, next) => {
  try {
    await query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.blockedId]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

blocksRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.blocked_id, b.reason, b.created_at, u.name AS blocked_name
         FROM user_blocks b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [req.user.id]
    )
    res.json({ blocks: rows })
  } catch (err) { next(err) }
})

/* ─── Admin reports queue ────────────────────────────────── */
export const adminReportsRouter = Router()

adminReportsRouter.get('/reports', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.query.status || 'open'
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
    const { rows } = await query(
      `SELECT r.*,
              rep.name  AS reporter_name, rep.email AS reporter_email,
              rep2.name AS reported_name, rep2.email AS reported_email
         FROM user_reports r
         JOIN users rep  ON rep.id  = r.reporter_id
         JOIN users rep2 ON rep2.id = r.reported_id
        WHERE r.status = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [status, limit]
    )
    res.json({ reports: rows })
  } catch (err) { next(err) }
})

adminReportsRouter.patch('/reports/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { status, resolution } = req.body || {}
    if (!['reviewing','resolved','dismissed','open'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' })
    }
    const { rows } = await query(
      `UPDATE user_reports
          SET status = $2,
              resolution = $3,
              resolved_by = CASE WHEN $2 IN ('resolved','dismissed') THEN $4 ELSE resolved_by END,
              resolved_at = CASE WHEN $2 IN ('resolved','dismissed') THEN now() ELSE resolved_at END
        WHERE id = $1
        RETURNING *`,
      [req.params.id, status, resolution ?? null, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    res.json({ report: rows[0] })
  } catch (err) { next(err) }
})

/** Shared helper for booking routes to check if a block exists in either
 *  direction between two users. */
export async function blockExistsBetween(userA, userB) {
  const { rows } = await query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [userA, userB]
  )
  return rows.length > 0
}

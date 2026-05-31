// Saved addresses — see specs/0040-saved-addresses.md.

import { Router } from 'express'
import { z } from 'zod'
import { query, getClient } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const MAX_PER_USER = 10

const CreateSchema = z.object({
  label:      z.string().min(1).max(40),
  address:    z.string().min(5).max(500),
  lat:        z.number().min(-90).max(90).optional(),
  lng:        z.number().min(-180).max(180).optional(),
  is_default: z.boolean().optional(),
})

const PatchSchema = z.object({
  label:      z.string().min(1).max(40).optional(),
  is_default: z.boolean().optional(),
})

const router = Router()

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, label, address, lat, lng, is_default, created_at
         FROM saved_addresses WHERE user_id = $1
        ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    )
    res.json({ addresses: rows })
  } catch (err) { next(err) }
})

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body)
    const { rows: count } = await query(`SELECT COUNT(*)::int AS n FROM saved_addresses WHERE user_id = $1`, [req.user.id])
    if (count[0].n >= MAX_PER_USER) {
      return res.status(409).json({ error: 'address_cap_reached', max: MAX_PER_USER })
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (data.is_default) {
        await client.query(`UPDATE saved_addresses SET is_default=false WHERE user_id=$1`, [req.user.id])
      }
      const inserted = await client.query(
        `INSERT INTO saved_addresses (user_id, label, address, lat, lng, is_default)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.user.id, data.label, data.address, data.lat ?? null, data.lng ?? null, data.is_default ?? false]
      )
      await client.query('COMMIT')
      res.status(201).json({ address: inserted.rows[0] })
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err }
    finally { client.release() }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (data.is_default) {
        await client.query(`UPDATE saved_addresses SET is_default=false WHERE user_id=$1`, [req.user.id])
      }
      const sets = []
      const params = [req.params.id, req.user.id]
      if (data.label != null)      { params.push(data.label);      sets.push(`label = $${params.length}`) }
      if (data.is_default != null) { params.push(data.is_default); sets.push(`is_default = $${params.length}`) }
      if (!sets.length) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'nothing_to_update' })
      }
      const { rows } = await client.query(
        `UPDATE saved_addresses SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
        params
      )
      await client.query('COMMIT')
      if (!rows[0]) return res.status(404).json({ error: 'not_found' })
      res.json({ address: rows[0] })
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err }
    finally { client.release() }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM saved_addresses WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id])
    if (!rowCount) return res.status(404).json({ error: 'not_found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router

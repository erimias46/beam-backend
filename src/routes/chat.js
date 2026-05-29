// In-app chat — see specs/0030-in-app-chat.md.
//
// Scoped to a booking. Both customer + barber can read/write while booking
// is active (accepted, in_progress, awaiting_confirmation). Closed bookings
// become read-only — useful for re-reading or dispute review.

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'
import { emitToUsers } from '../services/sse.js'
import { sendNotification } from '../services/notifications.js'

const ACTIVE_STATUSES = new Set(['accepted', 'in_progress', 'awaiting_confirmation'])

const SendSchema = z.object({
  body: z.string().min(1).max(2000),
})

const MarkDeliveredSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
})

export const chatRouter = Router({ mergeParams: true })

/** Helper: load booking + 403 if caller isn't a participant. */
async function loadBookingForParticipant(req, res) {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id])
  const booking = rows[0]
  if (!booking) { res.status(404).json({ error: 'booking_not_found' }); return null }
  if (req.user.role !== 'admin'
      && booking.customer_id !== req.user.id
      && booking.barber_id   !== req.user.id) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return booking
}

/* POST /api/bookings/:id/messages — send a message */
chatRouter.post('/:id/messages', requireAuth, idempotency(), async (req, res, next) => {
  try {
    const body = SendSchema.parse(req.body)
    const booking = await loadBookingForParticipant(req, res)
    if (!booking) return
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'admin_read_only', message: 'Admins can read but not send chat.' })
    }
    if (!ACTIVE_STATUSES.has(booking.status)) {
      return res.status(409).json({ error: 'chat_closed', status: booking.status })
    }

    const inserted = await query(
      `INSERT INTO chat_messages (booking_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [booking.id, req.user.id, body.body]
    )
    const msg = inserted.rows[0]

    // Push to the other party — SSE for live, Web Push for offline.
    const receiverId = req.user.id === booking.customer_id ? booking.barber_id : booking.customer_id
    emitToUsers([receiverId], 'message_received', {
      booking_id: booking.id,
      message_id: msg.id,
      sender_id:  msg.sender_id,
      body:       msg.body,
      sent_at:    msg.sent_at,
    })
    // 80-char preview to avoid notification body bloat.
    const preview = body.body.length > 80 ? body.body.slice(0, 77) + '…' : body.body
    sendNotification(receiverId, {
      title: 'New message',
      body:  preview,
      data:  { booking_id: booking.id, type: 'chat_message', message_id: msg.id },
    }).catch(() => {})

    res.status(201).json({ message: msg })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/bookings/:id/messages?since=ISO&limit= — list */
chatRouter.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const booking = await loadBookingForParticipant(req, res)
    if (!booking) return
    const since = req.query.since ? new Date(req.query.since) : null
    const limit = Math.min(parseInt(req.query.limit) || 100, 500)
    const params = [booking.id]
    let where = 'booking_id = $1'
    if (since && !isNaN(since)) {
      params.push(since.toISOString())
      where += ` AND sent_at > $${params.length}`
    }
    params.push(limit)
    const { rows } = await query(
      `SELECT id, booking_id, sender_id, body, sent_at, delivered_at
         FROM chat_messages
        WHERE ${where}
        ORDER BY sent_at ASC
        LIMIT $${params.length}`,
      params
    )
    res.json({ messages: rows })
  } catch (err) { next(err) }
})

/* POST /api/bookings/:id/messages/mark-delivered */
chatRouter.post('/:id/messages/mark-delivered', requireAuth, async (req, res, next) => {
  try {
    const data = MarkDeliveredSchema.parse(req.body)
    const booking = await loadBookingForParticipant(req, res)
    if (!booking) return
    // Only mark deliveries from the OTHER party (you can't deliver your own messages).
    const senderConstraint = req.user.id === booking.customer_id ? booking.barber_id : booking.customer_id
    await query(
      `UPDATE chat_messages
          SET delivered_at = COALESCE(delivered_at, now())
        WHERE booking_id = $1
          AND sender_id  = $2
          AND id = ANY($3::uuid[])`,
      [booking.id, senderConstraint, data.message_ids]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* Admin transcript — full read access for dispute review (spec 0030). */
export const adminChatRouter = Router()
adminChatRouter.get('/bookings/:id/messages', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, u.name AS sender_name, u.role AS sender_role
         FROM chat_messages m
         JOIN users u ON u.id = m.sender_id
        WHERE m.booking_id = $1
        ORDER BY m.sent_at ASC`,
      [req.params.id]
    )
    res.json({ messages: rows })
  } catch (err) { next(err) }
})

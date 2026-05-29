// Receipts — see specs/0043-receipts-and-invoices.md.
//
// Two routes:
//   GET /api/receipts/:token  — public (token gates access). JSON for now;
//     the hosted HTML page lives in the frontend at /r/[token] which calls
//     this endpoint and renders.
//   GET /api/bookings/:id/receipt — authed, same JSON shape, for in-app use.

import { Router } from 'express'
import { query } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

function shape(booking) {
  return {
    booking: {
      id:           booking.id,
      service_type: booking.service_type,
      scheduled_at: booking.scheduled_at,
      address:      booking.address,
      status:       booking.status,
      created_at:   booking.created_at,
    },
    barber: {
      id:    booking.barber_id,
      name:  booking.barber_name,
      email: booking.barber_email,
    },
    customer: {
      id:    booking.customer_id,
      name:  booking.customer_name,
      email: booking.customer_email,
    },
    amounts: {
      service_cents:  booking.price_cents,
      tip_cents:      booking.tip_cents ?? 0,
      refunded_cents: booking.refunded_cents ?? 0,
      net_cents:      (booking.price_cents + (booking.tip_cents ?? 0)) - (booking.refunded_cents ?? 0),
    },
    receipt_token: booking.receipt_token,
  }
}

async function loadByToken(token) {
  const { rows } = await query(
    `SELECT b.*, cu.name AS customer_name, cu.email AS customer_email,
            bu.name AS barber_name,   bu.email AS barber_email
       FROM bookings b
       JOIN users cu ON cu.id = b.customer_id
       JOIN users bu ON bu.id = b.barber_id
      WHERE b.receipt_token = $1`,
    [token]
  )
  return rows[0]
}

export const publicReceiptRouter = Router()
publicReceiptRouter.get('/:token', async (req, res, next) => {
  try {
    const booking = await loadByToken(req.params.token)
    if (!booking) return res.status(404).json({ error: 'receipt_not_found' })
    res.json(shape(booking))
  } catch (err) { next(err) }
})

export const authReceiptRouter = Router()
authReceiptRouter.get('/:id/receipt', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.*, cu.name AS customer_name, cu.email AS customer_email,
              bu.name AS barber_name,   bu.email AS barber_email
         FROM bookings b
         JOIN users cu ON cu.id = b.customer_id
         JOIN users bu ON bu.id = b.barber_id
        WHERE b.id = $1`,
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'booking_not_found' })
    if (req.user.role !== 'admin'
        && booking.customer_id !== req.user.id
        && booking.barber_id   !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' })
    }
    res.json(shape(booking))
  } catch (err) { next(err) }
})

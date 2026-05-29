// Stripe webhook handler — see specs/0011-stripe-webhook-hardening.md.
//
// Flow:
//   1. Verify signature.
//   2. Reserve the event in stripe_webhook_events via ON CONFLICT DO NOTHING.
//      If the row already exists, ack immediately (duplicate delivery).
//   3. Ack Stripe with 200 {received:true}.
//   4. In res.on('finish'), call processEvent(event). On success, mark
//      'processed'. On failure, mark 'failed' + increment attempts.
//   5. A BullMQ recurring job (services/queue.js: stripe-webhook-retry) wakes
//      every 5 min and retries 'failed' events where attempts < 5.

import { Router } from 'express'
import Stripe from 'stripe'
import { query } from '../db/index.js'
import { sendNotification } from '../services/notifications.js'
import { emitToUsers } from '../services/sse.js'

const router = Router()

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const MAX_ATTEMPTS = 5

/* POST /api/stripe/webhook — raw body, signature verified */
router.post('/webhook', async (req, res, next) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })

  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!sig || !webhookSecret) {
    return res.status(400).send('Missing signature or secret')
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.warn('[Stripe webhook] signature check failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Dedupe: insert + only proceed if we took the row. Stripe's "at least once"
  // delivery guarantee means retries are normal — we ack the dup and move on.
  let isNew
  try {
    const result = await query(
      `INSERT INTO stripe_webhook_events (id, type, payload, status)
         VALUES ($1, $2, $3::jsonb, 'received')
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      [event.id, event.type, JSON.stringify(event)]
    )
    isNew = result.rowCount > 0
  } catch (err) {
    console.error('[Stripe webhook] dedupe insert failed:', err)
    // If we can't even write the event row, retrying later is the right move —
    // return 500 so Stripe redelivers.
    return next(err)
  }

  if (!isNew) {
    return res.json({ received: true, duplicate: true, type: event.type })
  }

  // Ack first; process after the response is flushed. res.on('finish') runs
  // synchronously (in the same tick the headers go out) and any errors after
  // ack don't affect the client — Stripe is already satisfied.
  res.json({ received: true, type: event.type })

  res.on('finish', () => {
    processEvent(event).catch(err => {
      console.error('[Stripe webhook] processEvent threw:', err)
    })
  })
})

/* Reprocess a failed event by id. Used by the admin retry endpoint and by the
   BullMQ retry job in services/queue.js. */
export async function reprocessEvent(eventId) {
  const { rows } = await query(
    `SELECT id, type, payload, attempts FROM stripe_webhook_events
      WHERE id = $1 AND status = 'failed' AND attempts < $2`,
    [eventId, MAX_ATTEMPTS]
  )
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_eligible' }

  await query(
    `UPDATE stripe_webhook_events SET status='received' WHERE id = $1`,
    [eventId]
  )
  try {
    // payload was stored as event JSON; pass through to processEvent.
    await processEvent(row.payload)
    return { ok: true }
  } catch (err) {
    // processEvent already updates the row on failure
    return { ok: false, error: err.message }
  }
}

async function processEvent(event) {
  await query(
    `UPDATE stripe_webhook_events SET attempts = attempts + 1 WHERE id = $1`,
    [event.id]
  )
  try {
    await dispatch(event)
    await query(
      `UPDATE stripe_webhook_events
          SET status='processed', processed_at=now(), last_error=null
        WHERE id = $1`,
      [event.id]
    )
  } catch (err) {
    await query(
      `UPDATE stripe_webhook_events
          SET status='failed', last_error=$2
        WHERE id = $1`,
      [event.id, err.message?.slice(0, 1000) ?? String(err).slice(0, 1000)]
    )
    throw err
  }
}

async function dispatch(event) {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object
      const { rows } = await query(
        `UPDATE bookings
            SET status = 'paid', payment_state = 'captured'
          WHERE stripe_payment_intent_id = $1 AND status = 'completed'
          RETURNING id, customer_id, barber_id, price_cents, receipt_token`,
        [pi.id]
      )
      const booking = rows[0]
      if (booking) {
        await query(
          `INSERT INTO booking_events (booking_id, from_status, to_status, meta)
             VALUES ($1, 'completed', 'paid', $2)`,
          [booking.id, JSON.stringify({ stripe_event: event.id, pi: pi.id })]
        ).catch(() => {})

        // Receipt email (spec 0043). Fire-and-forget — failure shouldn't block ack.
        try {
          const { rows: cu } = await query(`SELECT email, name FROM users WHERE id = $1`, [booking.customer_id])
          const customer = cu[0]
          if (customer?.email && booking.receipt_token) {
            const base = process.env.APP_URL || 'http://localhost:3000'
            const link = `${base}/r/${encodeURIComponent(booking.receipt_token)}`
            sendNotification(booking.customer_id, {
              title: 'Receipt — your Beam0 booking',
              body:  `View your receipt: ${link}`,
              data:  { type: 'receipt', booking_id: booking.id, receipt_url: link },
            }).catch(() => {})
          }
        } catch (err) {
          console.warn('[receipt email]', err.message)
        }

        // Spec 0070: referral reward to the inviter when referee first paid booking lands.
        try {
          const { awardReferralCreditIfApplicable } = await import('./promos.js')
          await awardReferralCreditIfApplicable(booking.id)
        } catch (err) {
          console.warn('[referral reward]', err.message)
        }
      }
      return
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object
      const { rows } = await query(
        `UPDATE bookings
            SET status = 'cancelled', payment_state = 'failed'
          WHERE stripe_payment_intent_id = $1
            AND status IN ('requested','accepted','in_progress','completed')
          RETURNING id, customer_id`,
        [pi.id]
      )
      const booking = rows[0]
      if (booking) {
        sendNotification(booking.customer_id, {
          title: 'Payment failed',
          body:  'Your payment could not be processed. Booking cancelled.',
          data:  { booking_id: booking.id, type: 'payment_failed' },
        }).catch(() => {})
      }
      return
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object
      await query(
        `UPDATE bookings
            SET payment_state = 'failed'
          WHERE stripe_payment_intent_id = $1`,
        [pi.id]
      )
      return
    }

    case 'payment_intent.requires_action': {
      // 3DS / step-up. Tell the customer via SSE so the frontend can prompt
      // them to run Stripe.js confirmCardPayment with the next_action data.
      const pi = event.data.object
      const { rows } = await query(
        `UPDATE bookings
            SET payment_state = 'action_required'
          WHERE stripe_payment_intent_id = $1
          RETURNING id, customer_id`,
        [pi.id]
      )
      const booking = rows[0]
      if (booking) {
        emitToUsers([booking.customer_id], 'payment_action_required', {
          booking_id: booking.id,
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          next_action: pi.next_action || null,
        })
      }
      return
    }

    case 'payment_intent.amount_capturable_updated': {
      // Informational — no DB change needed in v1. Row exists in
      // stripe_webhook_events for audit.
      return
    }

    case 'charge.refunded': {
      // Refund is a money event, not a booking-state transition. We mirror
      // payment_state and reconcile any matching refunds row by its
      // stripe_refund_id. The refunds table (spec 0012) is the source of
      // truth for amounts; bookings.refunded_cents is trigger-maintained.
      const charge = event.data.object
      if (!charge.payment_intent) return

      // Stripe gives us the array of refunds on the charge. Reconcile each
      // one our DB might know about.
      const refunds = charge.refunds?.data ?? []
      for (const sr of refunds) {
        await query(
          `UPDATE refunds
              SET status = CASE WHEN $2 = 'succeeded' THEN 'succeeded'
                                WHEN $2 = 'failed' THEN 'failed'
                                ELSE status END,
                  succeeded_at = CASE WHEN $2 = 'succeeded' AND succeeded_at IS NULL
                                      THEN now() ELSE succeeded_at END
            WHERE stripe_refund_id = $1`,
          [sr.id, sr.status]
        )
      }

      const fullyRefunded = charge.amount_refunded >= charge.amount
      await query(
        `UPDATE bookings
            SET payment_state = $2
          WHERE stripe_payment_intent_id = $1`,
        [charge.payment_intent, fullyRefunded ? 'refunded' : 'captured']
      )
      return
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object
      const pi = dispute.payment_intent
      if (!pi) return
      const { rows } = await query(
        `UPDATE bookings
            SET dispute_state = 'open'
          WHERE stripe_payment_intent_id = $1
          RETURNING id, customer_id, barber_id, price_cents`,
        [pi]
      )
      const booking = rows[0]
      if (booking) {
        await notifyAllAdmins({
          title: 'Chargeback opened',
          body:  `$${(booking.price_cents / 100).toFixed(2)} disputed on booking ${booking.id.slice(0,8)}.`,
          data:  { booking_id: booking.id, type: 'dispute_opened', dispute_id: dispute.id },
        }, /* sseEvent */ 'admin_dispute_opened')
      }
      return
    }

    case 'charge.dispute.closed': {
      const dispute = event.data.object
      const pi = dispute.payment_intent
      if (!pi) return
      // dispute.status: 'won' | 'lost' | 'warning_closed' (also: 'warning_needs_response' on open, but that's a different event)
      const newState = ['won','lost','warning_closed'].includes(dispute.status)
        ? dispute.status
        : 'lost'
      await query(
        `UPDATE bookings SET dispute_state = $2
          WHERE stripe_payment_intent_id = $1`,
        [pi, newState]
      )
      return
    }

    case 'payout.paid':
    case 'payout.failed': {
      // Spec 0052 (barber_payouts table) will wire the full ledger; here we
      // just log the event in stripe_webhook_events for audit and notify the
      // barber on failure.
      if (event.type !== 'payout.failed') return
      const payout = event.data.object
      // payout.destination is the bank account; we need to find the connected
      // account that owns it. Stripe doesn't put account on the payout object
      // in webhooks — but `event.account` holds the connected account id.
      const connectedAccount = event.account
      if (!connectedAccount) return
      const { rows } = await query(
        `SELECT id FROM users WHERE stripe_account_id = $1`,
        [connectedAccount]
      )
      const user = rows[0]
      if (!user) return
      sendNotification(user.id, {
        title: 'Payout failed',
        body:  payout.failure_message || 'Your payout could not be processed. Check your bank details in Stripe.',
        data:  { type: 'payout_failed', payout_id: payout.id },
      }).catch(() => {})
      return
    }

    case 'identity.verification_session.verified': {
      // Spec 0020. Stripe Identity has confirmed the barber's ID + selfie.
      const session = event.data.object
      const userId = session.metadata?.user_id
      if (!userId) return
      const { rows } = await query(
        `UPDATE barber_profiles
            SET identity_status='verified',
                identity_verified_at=now(),
                identity_failure_reason=null
          WHERE user_id = $1
          RETURNING user_id`,
        [userId]
      )
      if (rows[0]) {
        sendNotification(userId, {
          title: 'Identity verified',
          body:  "You're cleared to accept bookings.",
          data:  { type: 'identity_verified' },
        }).catch(() => {})
      }
      return
    }

    case 'identity.verification_session.requires_input': {
      const session = event.data.object
      const userId = session.metadata?.user_id
      if (!userId) return
      await query(
        `UPDATE barber_profiles
            SET identity_status='requires_input',
                identity_failure_reason=$2
          WHERE user_id = $1`,
        [userId, session.last_error?.code || 'verification_failed']
      )
      sendNotification(userId, {
        title: 'Identity check needs another try',
        body:  session.last_error?.reason || 'Open the app to retry verification.',
        data:  { type: 'identity_requires_input' },
      }).catch(() => {})
      return
    }

    case 'identity.verification_session.canceled': {
      const session = event.data.object
      const userId = session.metadata?.user_id
      if (!userId) return
      await query(
        `UPDATE barber_profiles SET identity_status='failed' WHERE user_id = $1`,
        [userId]
      )
      return
    }

    case 'account.updated': {
      const account = event.data.object
      const { rows } = await query(
        `SELECT id FROM users WHERE stripe_account_id = $1`,
        [account.id]
      )
      const user = rows[0]
      if (!user) return

      await query(
        `UPDATE barber_profiles
            SET stripe_charges_enabled   = $1,
                stripe_payouts_enabled   = $2,
                stripe_details_submitted = $3
          WHERE user_id = $4`,
        [
          !!account.charges_enabled,
          !!account.payouts_enabled,
          !!account.details_submitted,
          user.id,
        ]
      )

      // Auto-flip availability only if fully onboarded; never auto-disable a
      // barber who was deliberately set unavailable.
      if (account.charges_enabled && account.payouts_enabled) {
        await query(
          `UPDATE barber_profiles SET is_available = true
             WHERE user_id = $1 AND is_available = false`,
          [user.id]
        )
      }
      return
    }

    default:
      // Unhandled events still get persisted in stripe_webhook_events as
      // 'processed' (the dispatch returns cleanly). That's intentional —
      // we have an audit trail of every delivery, even ones we don't act on.
      console.log('[Stripe webhook] no handler for type:', event.type)
  }
}

async function notifyAllAdmins(notification, sseEvent) {
  const { rows } = await query(`SELECT id FROM users WHERE role = 'admin'`)
  const adminIds = rows.map(r => r.id)
  if (!adminIds.length) return
  // Web Push — fan out, ignore individual failures.
  await Promise.all(adminIds.map(id =>
    sendNotification(id, notification).catch(() => {})
  ))
  // SSE — admin dashboards listening on the booking events stream will see this.
  if (sseEvent) {
    try {
      emitToUsers(adminIds, sseEvent, notification.data || {})
    } catch (err) {
      console.warn('[admin notify SSE]', err.message)
    }
  }
}

export default router

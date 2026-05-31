import { Queue, Worker } from 'bullmq'
import { query, getClient } from '../db/index.js'
import { sendNotification } from './notifications.js'
import { emitToUsers } from './sse.js'
import { getBarberShare } from '../config.js'

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' }

let bookingQueue = null
let worker = null

function getQueue() {
  if (!bookingQueue) bookingQueue = new Queue('bookings', { connection })
  return bookingQueue
}

/** Close the queue + worker. Used in test teardown to let the process exit
 *  cleanly. No-op if neither was ever created (e.g. tests that don't touch
 *  any route handlers that fire-and-forget into BullMQ). */
export async function closeQueue() {
  await worker?.close().catch(() => {})
  await bookingQueue?.close().catch(() => {})
  worker = null
  bookingQueue = null
}

/** Snapshot of BullMQ job counts for the /metrics endpoint (spec 0003). */
export async function getQueueCounts() {
  try {
    const counts = await getQueue().getJobCounts('active', 'waiting', 'delayed', 'completed', 'failed')
    return {
      active:    counts.active    ?? 0,
      waiting:   counts.waiting   ?? 0,
      delayed:   counts.delayed   ?? 0,
      completed: counts.completed ?? 0,
      failed:    counts.failed    ?? 0,
    }
  } catch (err) {
    return { error: err.message }
  }
}

/* ─── Auto-cancel (10 min no-response) ──────────────────── */

export async function scheduleAutoCancel(bookingId, delayMs = 600_000) {
  try {
    await getQueue().add('auto-cancel', { bookingId }, {
      delay: delayMs,
      jobId: `auto-cancel-${bookingId}`,
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule auto-cancel:', err.message)
  }
}

export async function cancelAutoCancel(bookingId) {
  try {
    const job = await getQueue().getJob(`auto-cancel-${bookingId}`)
    if (job) await job.remove()
  } catch (err) {
    console.warn('[Queue] Could not cancel auto-cancel job:', err.message)
  }
}

/* ─── Idempotency-key cleanup (24h TTL) ─────────────────── */
// See specs/0010-idempotency-keys.md. Recurring job that prunes rows older
// than 24h so the table stays small. Scheduled once at worker start (below).

async function scheduleIdempotencyCleanup() {
  try {
    await getQueue().add('idempotency-cleanup', {}, {
      jobId: 'idempotency-cleanup-recurring',
      repeat: { every: 60 * 60 * 1000 }, // hourly
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule idempotency-cleanup:', err.message)
  }
}

/* ─── Stripe webhook retry (5-min sweep) ────────────────── */
// See specs/0011-stripe-webhook-hardening.md. Picks up failed webhook events
// with attempts < 5 and reprocesses them. After 5 attempts they sit as failed
// until an admin retries via /api/admin/webhooks/:id/retry.

/* ─── Auto-confirm (spec 0023) ──────────────────────────── */
// Scheduled when barber taps /complete. If the customer doesn't /confirm or
// /dispute in N minutes, capture anyway and mark completed.

export async function scheduleAutoConfirm(bookingId, delayMs) {
  try {
    await getQueue().add('auto-confirm', { bookingId }, {
      delay: delayMs,
      jobId: `auto-confirm-${bookingId}`,
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule auto-confirm:', err.message)
  }
}

export async function cancelAutoConfirm(bookingId) {
  try {
    const job = await getQueue().getJob(`auto-confirm-${bookingId}`)
    if (job) await job.remove()
  } catch (err) {
    console.warn('[Queue] Could not cancel auto-confirm:', err.message)
  }
}

/* ─── Barber no-show watchdog (spec 0013) ───────────────── */
// Scheduled on /accept. Fires at (scheduled_at + barber_no_show_deadline_minutes).
// If booking is still 'accepted' (barber never called /start), we full-refund
// the customer and mark the booking as system-no-show.

export async function scheduleBarberNoShowCheck(bookingId, fireAtMs) {
  const delay = Math.max(0, fireAtMs - Date.now())
  try {
    await getQueue().add('barber-no-show-check', { bookingId }, {
      delay,
      jobId: `barber-no-show-${bookingId}`,
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule barber-no-show-check:', err.message)
  }
}

export async function cancelBarberNoShowCheck(bookingId) {
  try {
    const job = await getQueue().getJob(`barber-no-show-${bookingId}`)
    if (job) await job.remove()
  } catch (err) {
    console.warn('[Queue] Could not cancel barber-no-show-check:', err.message)
  }
}

/* ─── Barber auto-offline sweep (spec 0050) ─────────────── */
// Every 5 min, flip is_available=false for barbers who haven't pinged in N min.

async function scheduleBarberOfflineSweep() {
  try {
    await getQueue().add('barber-offline-sweep', {}, {
      jobId: 'barber-offline-sweep-recurring',
      repeat: { every: 5 * 60 * 1000 },
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule barber-offline-sweep:', err.message)
  }
}

async function scheduleStripeWebhookRetry() {
  try {
    await getQueue().add('stripe-webhook-retry', {}, {
      jobId: 'stripe-webhook-retry-recurring',
      repeat: { every: 5 * 60 * 1000 }, // every 5 min
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule stripe-webhook-retry:', err.message)
  }
}

// Spec 0073: nightly-ish (every 6h) email sweep.
async function scheduleEmailSweep() {
  try {
    await getQueue().add('email-sweep', {}, {
      jobId: 'email-sweep-recurring',
      repeat: { every: 6 * 60 * 60 * 1000 },
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule email-sweep:', err.message)
  }
}

/* ─── Auto-complete (4 hr safety net for in_progress) ───── */

export async function scheduleAutoComplete(bookingId, delayMs = 4 * 60 * 60 * 1000) {
  try {
    await getQueue().add('auto-complete', { bookingId }, {
      delay: delayMs,
      jobId: `auto-complete-${bookingId}`,
      removeOnComplete: true,
      removeOnFail:     true,
    })
  } catch (err) {
    console.warn('[Queue] Could not schedule auto-complete:', err.message)
  }
}

export async function cancelAutoComplete(bookingId) {
  try {
    const job = await getQueue().getJob(`auto-complete-${bookingId}`)
    if (job) await job.remove()
  } catch (err) {
    console.warn('[Queue] Could not cancel auto-complete job:', err.message)
  }
}

/* ─── Worker ─────────────────────────────────────────────── */

export function startWorker() {
  if (worker) return
  try {
    worker = new Worker(
      'bookings',
      async (job) => {
        if (job.name === 'auto-cancel') {
          const { bookingId } = job.data
          const { rows } = await query(
            `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1 AND status = 'requested'
             RETURNING customer_id, barber_id`,
            [bookingId]
          )
          if (rows[0]) {
            const { customer_id, barber_id } = rows[0]
            emitToUsers([customer_id, barber_id], 'booking_updated', { booking_id: bookingId, status: 'cancelled' })
            await sendNotification(customer_id, {
              title: 'No barber responded',
              body:  'Your request was automatically cancelled. Try again.',
            })
          }
          return
        }

        if (job.name === 'idempotency-cleanup') {
          const { rowCount } = await query(
            `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`
          )
          if (rowCount) console.log(`[idempotency] cleanup deleted ${rowCount} stale rows`)
          return
        }

        if (job.name === 'auto-confirm') {
          const { bookingId } = job.data
          // Use atomic conditional UPDATE inside a transaction (spec 0081).
          // The old pool.query FOR UPDATE was a no-op — lock released immediately.
          const client = await getClient()
          let booking
          try {
            await client.query('BEGIN')
            const { rows, rowCount } = await client.query(
              `UPDATE bookings SET status='completed', completion_confirmed_at=now(), auto_confirm_at=NULL
               WHERE id=$1 AND status='awaiting_confirmation'
               RETURNING *`,
              [bookingId]
            )
            await client.query('COMMIT')
            if (!rowCount) return // Already handled by customer or another worker
            booking = rows[0]
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {})
            throw err
          } finally {
            client.release()
          }
          try {
            const Stripe = (await import('stripe')).default
            const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
            if (stripe && booking.stripe_payment_intent_id) {
              await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
                idempotencyKey: `booking_capture_${booking.id}`,
              })
            }
          } catch (err) {
            console.warn('[auto-confirm capture]', err.message)
          }
          emitToUsers([booking.customer_id, booking.barber_id], 'booking_updated', {
            booking_id: booking.id, status: 'completed', auto_confirmed: true,
          })
          await sendNotification(booking.customer_id, {
            title: 'Booking auto-confirmed',
            body:  'Payment released. Tap to leave a review.',
            data:  { booking_id: booking.id, type: 'auto_confirmed' },
          })
          await sendNotification(booking.barber_id, {
            title: 'Payment released (auto-confirmed)',
            body:  `$${((booking.price_cents * (await getBarberShare())) / 100).toFixed(2)} on the way.`,
            data:  { booking_id: booking.id, type: 'payout' },
          })
          return
        }

        if (job.name === 'barber-no-show-check') {
          const { bookingId } = job.data
          // Atomic conditional UPDATE in a real transaction (spec 0081).
          const client = await getClient()
          let booking
          try {
            await client.query('BEGIN')
            const { rows, rowCount } = await client.query(
              `UPDATE bookings
                  SET status='cancelled', cancelled_by='system_no_show', no_show_party='barber'
                WHERE id=$1 AND status='accepted'
                RETURNING *`,
              [bookingId]
            )
            await client.query('COMMIT')
            if (!rowCount) return // Already transitioned elsewhere
            booking = rows[0]
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {})
            throw err
          } finally {
            client.release()
          }
          // Release any authorized hold (no fee, this is the barber's fault).
          try {
            const Stripe = (await import('stripe')).default
            const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
            if (stripe && booking.stripe_payment_intent_id) {
              await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id, {
                idempotencyKey: `booking_cancel_${booking.id}`,
              })
            }
          } catch (err) {
            console.warn('[no-show release]', err.message)
          }
          emitToUsers([booking.customer_id, booking.barber_id], 'booking_updated', {
            booking_id: booking.id, status: 'cancelled', no_show_party: 'barber',
          })
          await sendNotification(booking.customer_id, {
            title: 'Barber did not arrive',
            body:  'We cancelled your booking and released the payment hold.',
            data:  { booking_id: booking.id, type: 'barber_no_show' },
          })
          await sendNotification(booking.barber_id, {
            title: 'Booking cancelled — no-show',
            body:  'You did not start this booking in time. The customer was refunded.',
            data:  { booking_id: booking.id, type: 'barber_no_show' },
          })
          return
        }

        if (job.name === 'email-sweep') {
          const { runEmailSweep } = await import('./email-sweep.js')
          await runEmailSweep()
          return
        }

        if (job.name === 'barber-offline-sweep') {
          // Pull the deadline from settings (default 15 min).
          const { getSetting } = await import('./settings.js')
          const minutes = parseInt(await getSetting('auto_offline_minutes')) || 15
          const { rows } = await query(
            `UPDATE barber_profiles
                SET is_available = false
              WHERE is_available = true
                AND last_online_ping_at IS NOT NULL
                AND last_online_ping_at < now() - ($1 || ' minutes')::interval
              RETURNING user_id`,
            [String(minutes)]
          )
          for (const r of rows) {
            await sendNotification(r.user_id, {
              title: "You're offline",
              body:  'Auto-set to offline after inactivity. Tap to go online again.',
              data:  { type: 'auto_offline' },
            }).catch(() => {})
          }
          if (rows.length) console.log(`[barber-offline-sweep] ${rows.length} barbers auto-offlined`)
          return
        }

        if (job.name === 'stripe-webhook-retry') {
          // Lazy-load to avoid a circular import at module-init time.
          const { reprocessEvent } = await import('../routes/stripe.js')
          const { rows } = await query(
            `SELECT id FROM stripe_webhook_events
              WHERE status = 'failed' AND attempts < 5
              ORDER BY received_at ASC
              LIMIT 25`
          )
          for (const r of rows) {
            const result = await reprocessEvent(r.id)
            if (!result.ok && result.error) {
              console.warn(`[stripe-webhook-retry] ${r.id}: ${result.error}`)
            }
          }
          if (rows.length) console.log(`[stripe-webhook-retry] processed ${rows.length} events`)
          return
        }

        if (job.name === 'auto-complete') {
          const { bookingId } = job.data
          const { rows } = await query(
            `UPDATE bookings SET status = 'completed', updated_at = NOW()
             WHERE id = $1 AND status = 'in_progress'
             RETURNING customer_id, barber_id, price_cents`,
            [bookingId]
          )
          if (rows[0]) {
            const { customer_id, barber_id, price_cents } = rows[0]
            emitToUsers([customer_id, barber_id], 'booking_updated', { booking_id: bookingId, status: 'completed' })
            await Promise.all([
              sendNotification(customer_id, {
                title: 'Booking auto-completed',
                body:  'Your service was marked complete. Leave a review!',
              }),
              sendNotification(barber_id, {
                title: 'Booking auto-completed',
                body:  `$${((price_cents * (await getBarberShare())) / 100).toFixed(2)} payout initiated.`,
              }),
            ])
          }
        }
      },
      { connection }
    )

    worker.on('failed', (job, err) => {
      console.error(`[Queue] Job ${job?.id} failed:`, err)
    })

    console.log('[Queue] Worker started')
    scheduleIdempotencyCleanup().catch(() => {})
    scheduleStripeWebhookRetry().catch(() => {})
    scheduleBarberOfflineSweep().catch(() => {})
    scheduleEmailSweep().catch(() => {})
  } catch (err) {
    console.warn('[Queue] Could not start worker (Redis not available):', err.message)
  }
}

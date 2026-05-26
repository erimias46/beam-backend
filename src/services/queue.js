import { Queue, Worker } from 'bullmq'
import { query } from '../db/index.js'
import { sendNotification } from './notifications.js'

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' }

let bookingQueue = null
let worker = null

function getQueue() {
  if (!bookingQueue) {
    bookingQueue = new Queue('bookings', { connection })
  }
  return bookingQueue
}

export async function scheduleAutoCancel(bookingId, delayMs = 600000) {
  try {
    const q = getQueue()
    await q.add(
      'auto-cancel',
      { bookingId },
      {
        delay: delayMs,
        jobId: `auto-cancel:${bookingId}`,
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
  } catch (err) {
    console.warn('[Queue] Could not schedule auto-cancel:', err.message)
  }
}

export async function cancelAutoCancel(bookingId) {
  try {
    const q = getQueue()
    const job = await q.getJob(`auto-cancel:${bookingId}`)
    if (job) await job.remove()
  } catch (err) {
    console.warn('[Queue] Could not cancel auto-cancel job:', err.message)
  }
}

export function startWorker() {
  if (worker) return
  try {
    worker = new Worker(
      'bookings',
      async (job) => {
        if (job.name !== 'auto-cancel') return

        const { bookingId } = job.data
        const { rows } = await query(
          `UPDATE bookings SET status = 'cancelled'
           WHERE id = $1 AND status = 'requested'
           RETURNING customer_id`,
          [bookingId]
        )

        if (rows[0]) {
          await sendNotification(rows[0].customer_id, {
            title: 'No barber responded',
            body: 'Your request was automatically cancelled. Try again.',
          })
        }
      },
      { connection }
    )

    worker.on('failed', (job, err) => {
      console.error(`[Queue] Job ${job?.id} failed:`, err)
    })

    console.log('[Queue] Worker started')
  } catch (err) {
    console.warn('[Queue] Could not start worker (Redis not available):', err.message)
  }
}

import { Router } from 'express'
import Stripe from 'stripe'
import { query } from '../db/index.js'
import { sendNotification } from '../services/notifications.js'

const router = Router()

/* POST /api/stripe/webhook — raw body, signature verified */
router.post('/webhook', async (req, res, next) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'payment_intent.payment_failed': {
        const pi = event.data.object
        const { rows } = await query(
          `SELECT * FROM bookings WHERE stripe_payment_intent_id = $1`,
          [pi.id]
        )
        const booking = rows[0]
        if (booking) {
          await query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [booking.id])
          await sendNotification(booking.customer_id, {
            title: 'Payment failed',
            body: 'Your payment could not be processed. Booking cancelled.',
          })
        }
        break
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object
        await query(
          `UPDATE bookings SET status = 'paid' WHERE stripe_payment_intent_id = $1`,
          [pi.id]
        )
        break
      }

      case 'account.updated': {
        const account = event.data.object
        const chargesEnabled = account.charges_enabled
        await query(
          'UPDATE users SET stripe_account_id = $1 WHERE stripe_account_id = $1',
          [account.id]
        )
        // If fully onboarded, mark barber profile as verified
        if (chargesEnabled) {
          await query(
            `UPDATE barber_profiles SET is_available = true
             WHERE user_id = (SELECT id FROM users WHERE stripe_account_id = $1)`,
            [account.id]
          )
        }
        break
      }
    }

    res.json({ received: true })
  } catch (err) {
    next(err)
  }
})

export default router

import { Router } from 'express'
import Stripe from 'stripe'
import { query } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const router = Router()

async function ensureCustomer(userId) {
  const { rows } = await query(
    `SELECT id, name, email, stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  )
  const user = rows[0]
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 })
  if (user.stripe_customer_id) return user.stripe_customer_id

  // Deterministic key: a retry must not create a second Stripe customer for
  // the same Beam0 user. See specs/0010.
  const customer = await stripe.customers.create({
    name: user.name,
    email: user.email || undefined,
    metadata: { user_id: user.id },
  }, { idempotencyKey: `stripe_customer_${user.id}` })
  await query(
    `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, user.id]
  )
  return customer.id
}

/* POST /api/payments/setup-intent — start adding a card */
router.post('/setup-intent', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })
    const customerId = await ensureCustomer(req.user.id)
    const intent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    })
    res.json({ client_secret: intent.client_secret })
  } catch (err) { next(err) }
})

/* GET /api/payments/methods — list saved cards, mark which is default */
router.get('/methods', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) return res.json({ methods: [], default_id: null })
    const { rows } = await query(
      `SELECT stripe_customer_id, default_payment_method_id FROM users WHERE id = $1`,
      [req.user.id]
    )
    const customerId = rows[0]?.stripe_customer_id
    const defaultId  = rows[0]?.default_payment_method_id ?? null
    if (!customerId) return res.json({ methods: [], default_id: null })

    const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card' })
    const methods = list.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand,
      last4: pm.card?.last4,
      exp_month: pm.card?.exp_month,
      exp_year: pm.card?.exp_year,
      is_default: pm.id === defaultId,
    }))
    res.json({ methods, default_id: defaultId })
  } catch (err) { next(err) }
})

/* PATCH /api/payments/methods/default — set the user's default card.
   Spec 0041. The /accept booking handler reads this to pick the PM. */
router.patch('/methods/default', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })
    const pmId = String(req.body?.payment_method_id || '').trim()
    if (!pmId.startsWith('pm_')) return res.status(400).json({ error: 'invalid_payment_method_id' })

    const { rows } = await query(`SELECT stripe_customer_id FROM users WHERE id = $1`, [req.user.id])
    const customerId = rows[0]?.stripe_customer_id
    if (!customerId) return res.status(404).json({ error: 'no_stripe_customer' })

    // Verify the PM belongs to this user's Stripe customer.
    const pm = await stripe.paymentMethods.retrieve(pmId)
    if (pm.customer !== customerId) return res.status(403).json({ error: 'forbidden' })

    await query(`UPDATE users SET default_payment_method_id = $1 WHERE id = $2`, [pmId, req.user.id])
    res.json({ ok: true, default_id: pmId })
  } catch (err) { next(err) }
})

/* DELETE /api/payments/methods/:id — detach a card. If it was default, fall
   back to the next-most-recent automatically (spec 0041). */
router.delete('/methods/:id', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })
    const { rows } = await query(
      `SELECT stripe_customer_id, default_payment_method_id FROM users WHERE id = $1`,
      [req.user.id]
    )
    const customerId = rows[0]?.stripe_customer_id
    if (!customerId) return res.status(404).json({ error: 'No customer' })

    const pm = await stripe.paymentMethods.retrieve(req.params.id)
    if (pm.customer !== customerId) return res.status(403).json({ error: 'Forbidden' })

    await stripe.paymentMethods.detach(req.params.id)

    // If this was the default, pick a new one or clear.
    if (rows[0].default_payment_method_id === req.params.id) {
      const fallback = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 })
      const newDefault = fallback.data[0]?.id ?? null
      await query(`UPDATE users SET default_payment_method_id = $1 WHERE id = $2`, [newDefault, req.user.id])
      return res.json({ ok: true, new_default_id: newDefault })
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router

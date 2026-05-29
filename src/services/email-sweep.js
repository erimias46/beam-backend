// Nightly email sweep — see specs/0073-win-back-emails.md.
// Run by BullMQ. Three campaigns at v1:
//   - winback_60d:                 lapsed paid customer, no booking in 60d
//   - first_booking_followup_24h:  24h after first paid booking, ask for review
//   - incomplete_signup_3d:        signed up, no first booking in 3d
//
// Idempotency comes from the UNIQUE (user_id, campaign_id) constraint on
// email_sends.

import { query } from '../db/index.js'
import { sendNotification } from './notifications.js'
import { unsubscribeUrl, openPixelUrl, trackedClickUrl } from '../routes/email-campaigns.js'

const APP_URL = process.env.APP_URL || 'http://localhost:3000'

async function sendCampaign(campaignId, body) {
  // Insert first (idempotent dedupe), then send. If the send fails, the
  // 'attempt' is still recorded — manual replay can clear and retry later.
  const inserted = await query(
    `INSERT INTO email_sends (user_id, campaign_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, campaign_id) DO NOTHING
     RETURNING id`,
    [body.userId, campaignId]
  )
  if (inserted.rowCount === 0) return false
  await sendNotification(body.userId, {
    title: body.subject,
    body:  body.text + `\n\n${unsubscribeUrl(APP_URL, body.userId, campaignId)}`,
    data:  { type: 'email_campaign', campaign: campaignId,
             open_pixel: openPixelUrl(APP_URL, body.userId, campaignId) },
  }).catch(err => console.warn('[email-sweep]', err.message))
  return true
}

export async function runEmailSweep() {
  let count = 0

  // 1. winback_60d
  {
    const { rows } = await query(`
      SELECT u.id, u.name
        FROM users u
       WHERE u.role = 'customer'
         AND u.deleted_at IS NULL
         AND COALESCE(u.email_notifications, true) = true
         AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id AND b.status IN ('paid','completed'))
         AND NOT EXISTS (
           SELECT 1 FROM bookings b WHERE b.customer_id = u.id AND b.created_at > now() - interval '60 days'
         )
         AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.user_id = u.id AND es.campaign_id = 'winback_60d')
       LIMIT 200
    `)
    for (const u of rows) {
      const ok = await sendCampaign('winback_60d', {
        userId: u.id,
        subject: 'We miss you 💈',
        text: `Hey ${u.name?.split(' ')[0] || 'there'} — it's been a while. Book your next cut: ${trackedClickUrl(APP_URL, u.id, 'winback_60d', APP_URL + '/book')}`,
      })
      if (ok) count++
    }
  }

  // 2. first_booking_followup_24h
  {
    const { rows } = await query(`
      SELECT DISTINCT u.id, u.name
        FROM users u
        JOIN bookings b ON b.customer_id = u.id
       WHERE u.role = 'customer'
         AND u.deleted_at IS NULL
         AND COALESCE(u.email_notifications, true) = true
         AND b.status IN ('paid','completed')
         AND b.created_at < now() - interval '24 hours'
         AND b.created_at > now() - interval '36 hours'
         AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.user_id = u.id AND es.campaign_id = 'first_booking_followup_24h')
         AND (SELECT COUNT(*) FROM bookings b2 WHERE b2.customer_id = u.id AND b2.status IN ('paid','completed')) = 1
       LIMIT 200
    `)
    for (const u of rows) {
      const ok = await sendCampaign('first_booking_followup_24h', {
        userId: u.id,
        subject: 'How was your cut?',
        text: `Hope your first Beam0 booking went well. Leave a review: ${trackedClickUrl(APP_URL, u.id, 'first_booking_followup_24h', APP_URL + '/bookings')}`,
      })
      if (ok) count++
    }
  }

  // 3. incomplete_signup_3d
  {
    const { rows } = await query(`
      SELECT u.id, u.name
        FROM users u
       WHERE u.role = 'customer'
         AND u.deleted_at IS NULL
         AND COALESCE(u.email_notifications, true) = true
         AND u.created_at < now() - interval '3 days'
         AND u.created_at > now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.user_id = u.id AND es.campaign_id = 'incomplete_signup_3d')
       LIMIT 200
    `)
    for (const u of rows) {
      const ok = await sendCampaign('incomplete_signup_3d', {
        userId: u.id,
        subject: 'Ready to book your first cut?',
        text: `Find a barber near you: ${trackedClickUrl(APP_URL, u.id, 'incomplete_signup_3d', APP_URL + '/book')}`,
      })
      if (ok) count++
    }
  }

  if (count) console.log(`[email-sweep] sent ${count} emails`)
  return count
}

import webPush from 'web-push'
import { query } from '../db/index.js'

// VAPID keys must be set in .env — generate once with:
//   node -e "const c=require('crypto');const{publicKey:pk,privateKey:sk}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});console.log('VAPID_PUBLIC_KEY='+pk.export({type:'spki',format:'der'}).slice(-65).toString('base64url')+'\nVAPID_PRIVATE_KEY='+sk.export({type:'sec1',format:'der'}).slice(7,39).toString('base64url'))"
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
if (vapidReady) {
  webPush.setVapidDetails(
    `mailto:${process.env.VAPID_SUBJECT || 'admin@beam0.app'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  )
} else {
  console.warn('[Push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled')
}

export async function sendNotification(userId, { title, body, data = {} }) {
  const { rows } = await query(
    `SELECT subscription FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  ).catch(() => ({ rows: [] }))

  if (!rows.length || !vapidReady) {
    console.log(`[Push] would notify ${userId}: ${title} — ${body}`)
    return
  }

  const payload = JSON.stringify({ title, body, data })

  await Promise.allSettled(
    rows.map(async ({ subscription }) => {
      try {
        await webPush.sendNotification(subscription, payload)
      } catch (err) {
        // 410 Gone or 404 = subscription expired — remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          query(
            `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
            [userId, subscription.endpoint]
          ).catch(() => {})
        } else {
          console.warn('[Push] send error:', err.statusCode, err.body)
        }
      }
    })
  )
}

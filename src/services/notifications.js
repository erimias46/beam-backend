import { query } from '../db/index.js'

let messaging = null

async function getMessaging() {
  if (messaging) return messaging
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null
  try {
    const { default: admin } = await import('firebase-admin')
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        ),
      })
    }
    messaging = admin.messaging()
    return messaging
  } catch (err) {
    console.warn('[FCM] Firebase not configured:', err.message)
    return null
  }
}

export async function sendNotification(userId, { title, body, data = {} }) {
  try {
    const { rows } = await query(
      'SELECT fcm_token FROM user_devices WHERE user_id = $1',
      [userId]
    )
    if (!rows.length) return

    const fcm = await getMessaging()
    if (!fcm) {
      console.log(`[FCM] would notify ${userId}: ${title} — ${body}`)
      return
    }

    await Promise.allSettled(
      rows.map((r) =>
        fcm.send({
          token: r.fcm_token,
          notification: { title, body },
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
        })
      )
    )
  } catch (err) {
    console.error('[FCM] send error:', err)
  }
}

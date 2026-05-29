// Win-back emails + lifecycle campaigns — see specs/0073-win-back-emails.md.
//
// One-click unsubscribe link is HMAC-signed (stateless). Open/click pixels
// are also signed redirects so we don't have to store extra state.

import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db/index.js'

const SECRET = process.env.JWT_SECRET   // reuse the JWT secret for HMAC

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32)
  return `${body}.${mac}`
}
function verify(token) {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32)
  if (mac !== expected) return null
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) }
  catch { return null }
}

export const unsubscribeRouter = Router()

unsubscribeRouter.get('/', async (req, res, next) => {
  try {
    const data = verify(req.query.token)
    if (!data?.uid || !data?.campaign) return res.status(400).send('Invalid link.')
    await query(`UPDATE users SET email_notifications = false WHERE id = $1`, [data.uid])
    await query(
      `UPDATE email_sends SET unsubscribed_at = now()
        WHERE user_id = $1 AND campaign_id = $2`,
      [data.uid, data.campaign]
    )
    res.send(`<html><body style="font-family:system-ui;padding:32px;max-width:480px">
      <h2>Unsubscribed</h2>
      <p>You won't receive ${data.campaign} emails again. Re-enable from your profile any time.</p>
    </body></html>`)
  } catch (err) { next(err) }
})

unsubscribeRouter.get('/open', async (req, res) => {
  const data = verify(req.query.token)
  if (data?.uid && data?.campaign) {
    query(
      `UPDATE email_sends SET opened_at = COALESCE(opened_at, now())
        WHERE user_id = $1 AND campaign_id = $2`,
      [data.uid, data.campaign]
    ).catch(() => {})
  }
  // 1x1 transparent gif
  res.set('Content-Type', 'image/gif').send(Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64'))
})

unsubscribeRouter.get('/click', async (req, res) => {
  const data = verify(req.query.token)
  const url  = String(req.query.url || '/')
  if (data?.uid && data?.campaign) {
    query(
      `UPDATE email_sends SET clicked_at = COALESCE(clicked_at, now())
        WHERE user_id = $1 AND campaign_id = $2`,
      [data.uid, data.campaign]
    ).catch(() => {})
  }
  res.redirect(302, url)
})

/** Generator helpers used by the queue worker. */
export function unsubscribeUrl(baseUrl, uid, campaign) {
  return `${baseUrl}/api/unsubscribe?token=${sign({ uid, campaign, t: 'u' })}`
}
export function openPixelUrl(baseUrl, uid, campaign) {
  return `${baseUrl}/api/unsubscribe/open?token=${sign({ uid, campaign, t: 'o' })}`
}
export function trackedClickUrl(baseUrl, uid, campaign, url) {
  return `${baseUrl}/api/unsubscribe/click?token=${sign({ uid, campaign, t: 'c' })}&url=${encodeURIComponent(url)}`
}

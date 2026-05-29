// Refresh tokens + session management — see specs/0074-refresh-tokens-and-session-management.md.
//
// Access tokens stay JWT, now 15 min. Refresh tokens are opaque random 256-bit
// strings stored as sha256 hashes. /refresh rotates the token; reuse of a
// revoked token nukes all the user's sessions (compromise signal).
//
// Backward-compat: existing long-lived 90-day JWTs continue to validate via
// requireAuth (we don't drop the legacy path in this spec).

import { Router } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { query } from '../db/index.js'
import { requireAuth, JWT_SECRET } from '../middleware/auth.js'

const ACCESS_TTL_SECONDS = 15 * 60                  // 15 min
const REFRESH_TTL_DAYS   = 90

function hashRefresh(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex')
}

/** Mint an access JWT for a user object. */
export function mintAccessToken(user) {
  return jwt.sign(
    { id: user.id, sub: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL_SECONDS }
  )
}

/** Create a new session row + return the plaintext refresh token to send back
 *  to the client (only place this is visible — DB only holds the hash). */
export async function createSession({ userId, deviceLabel, ipAddress, userAgent }) {
  const plain = crypto.randomBytes(32).toString('base64url')   // 256-bit
  const hash  = hashRefresh(plain)
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString()
  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, device_label, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, hash, deviceLabel ?? null, ipAddress ?? null, userAgent ?? null, expiresAt]
  )
  return plain
}

export const sessionsRouter = Router()

/* POST /api/auth/refresh — rotate the refresh token, return a new access JWT.
   On a revoked-token reuse, nuke all sessions (compromise signal). */
sessionsRouter.post('/refresh', async (req, res, next) => {
  try {
    const plain = String(req.body?.refresh_token || '')
    if (!plain) return res.status(400).json({ error: 'missing_refresh_token' })
    const hash = hashRefresh(plain)
    const { rows } = await query(
      `SELECT s.*, u.role, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1`,
      [hash]
    )
    const row = rows[0]
    if (!row) return res.status(401).json({ error: 'invalid_refresh_token' })

    // Reuse of a revoked token → revoke everything for this user.
    if (row.revoked_at) {
      await query(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id]
      )
      return res.status(401).json({ error: 'token_reused' })
    }
    if (new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'expired' })
    }

    // Rotate: revoke this row, mint a new session.
    await query(`UPDATE sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1`, [row.id])
    const newPlain = await createSession({
      userId: row.user_id,
      deviceLabel: row.device_label,
      ipAddress:   req.ip || null,
      userAgent:   (req.headers['user-agent'] || '').slice(0, 500),
    })
    const access = mintAccessToken({ id: row.user_id, role: row.role, email: row.email })
    res.json({
      access_token:  access,
      refresh_token: newPlain,
      expires_in:    ACCESS_TTL_SECONDS,
    })
  } catch (err) { next(err) }
})

sessionsRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const plain = String(req.body?.refresh_token || '')
    if (plain) {
      await query(
        `UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND user_id = $2`,
        [hashRefresh(plain), req.user.id]
      )
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

sessionsRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, device_label, ip_address, last_used_at, created_at, expires_at
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_used_at DESC`,
      [req.user.id]
    )
    res.json({ sessions: rows })
  } catch (err) { next(err) }
})

sessionsRouter.delete('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    await query(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

sessionsRouter.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    // Revoke all sessions for this user. (We don't try to spare "current"
    // here because requireAuth uses JWT only — no refresh-token-in-the-request
    // to compare against. The client should re-login after this call.)
    await query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

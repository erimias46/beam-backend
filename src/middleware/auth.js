import jwt from 'jsonwebtoken'
import { query } from '../db/index.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET env var must be set and at least 32 chars. Refusing to start.')
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  // Accept Bearer token (mobile/API clients) or httpOnly cookie (web clients).
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.access_token
  if (!token) {
    return res.status(401).json({ error: 'Missing token', code: 'MISSING_TOKEN' })
  }
  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' })
  }
  // Check token_valid_after — ensures suspended/demoted users can't use old tokens.
  // Gracefully degrades if the column doesn't exist yet (pre-migration 076).
  try {
    const { rows } = await query(
      `SELECT 1 FROM users WHERE id = $1 AND is_suspended = false
         AND (token_valid_after IS NULL OR token_valid_after <= to_timestamp($2))`,
      [payload.id, payload.iat]
    )
    if (!rows[0]) return res.status(401).json({ error: 'Session revoked', code: 'TOKEN_EXPIRED' })
  } catch {
    // Column may not exist yet — allow through without the check
  }
  req.user = payload
  next()
}

/** Soft auth: if a valid token is present, populate req.user; otherwise just
 *  continue. Lets a public route personalize when the caller is logged in
 *  (e.g. filtering blocked barbers out of search results). */
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return next()
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET)
  } catch { /* invalid token → treat as anonymous */ }
  next() // best-effort — doesn't do token_valid_after check (perf)
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}

export { JWT_SECRET }

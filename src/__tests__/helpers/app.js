// Boot the Express app for supertest. Sets NODE_ENV=test BEFORE importing app
// so the listener / worker side effects don't fire. Returns the app and a
// helper to mint a JWT for a seeded user.

process.env.NODE_ENV = 'test'

import jwt from 'jsonwebtoken'

let appPromise = null
export async function getApp() {
  if (!appPromise) appPromise = import('../../app.js').then(m => m.default)
  return appPromise
}

/** Mint an access token for a user object (must contain {id, role, email}).
 *  Secret is read lazily so dotenv (loaded by app.js) has time to populate it. */
export function jwtFor(user) {
  const secret = process.env.JWT_SECRET || 'dev-only-secret-please-override'
  return jwt.sign({ id: user.id, sub: user.id, role: user.role, email: user.email }, secret, { expiresIn: '15m' })
}

// Idempotency middleware — see specs/0010-idempotency-keys.md.
//
// Contract:
//   - Client sends `Idempotency-Key: <16..255 chars>` on a mutating request.
//   - First request: we reserve the row, run the handler, capture the response
//     body + status on `res.on('finish')`, and write it back.
//   - Retry with same key + same body: replay the stored response without
//     invoking the handler.
//   - Retry with same key + different body: 409 `idempotency_key_reused`.
//   - No header: behaves exactly like today. Routes that require protection
//     should be obvious about it via the frontend always sending a key.
//
// Storage is in Postgres (`idempotency_keys`), not Redis. Simpler ops, survives
// a Redis flush, fine at this scale. A 24h TTL job in services/queue.js cleans
// up old rows.

import { createHash, randomUUID } from 'crypto'
import { query } from '../db/index.js'

const MIN_KEY_LEN = 16
const MAX_KEY_LEN = 255

/** Stable sha256 of a request body. Object keys are sorted so equivalent JSON
 *  with shuffled keys still hashes equal. */
export function requestHash(body) {
  const canonical = canonicalize(body ?? {})
  return createHash('sha256').update(canonical).digest('hex')
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
}

/** Generate a new key — used by tests and by code paths that want to mint one
 *  server-side (e.g. internal retries). The frontend mints its own via
 *  `crypto.randomUUID()`. */
export function newIdempotencyKey() {
  return randomUUID()
}

/** Express middleware. Wrap any mutating route that should be safe to retry. */
export function idempotency() {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.header('Idempotency-Key')
    if (!key) {
      // No header → legacy behavior. Routes still work, just without protection.
      return next()
    }
    if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN) {
      return res.status(422).json({
        error: 'idempotency_key_invalid',
        message: `Idempotency-Key must be ${MIN_KEY_LEN}–${MAX_KEY_LEN} chars.`,
      })
    }
    if (!req.user?.id) {
      // Routes that use this middleware are expected to sit behind requireAuth.
      // Defensive: if we somehow got here without a user, fall through unprotected.
      return next()
    }

    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path || req.path}`
    const hash     = requestHash(req.body)

    // Reserve the slot. ON CONFLICT DO NOTHING + RETURNING tells us whether we
    // were first or whether a previous request already exists.
    const reserve = await query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, key) DO NOTHING
         RETURNING key`,
      [key, req.user.id, endpoint, hash]
    )

    if (reserve.rowCount === 0) {
      // Row already exists — replay or reject.
      const existing = await query(
        `SELECT endpoint, request_hash, status_code, response_body
           FROM idempotency_keys
          WHERE user_id = $1 AND key = $2`,
        [req.user.id, key]
      )
      const row = existing.rows[0]
      // Same key reused with a different body is almost always a client bug.
      // Refuse rather than silently corrupt — the client can rotate the key.
      if (row.request_hash !== hash || row.endpoint !== endpoint) {
        return res.status(409).json({
          error: 'idempotency_key_reused',
          message: 'This Idempotency-Key was used with a different request.',
        })
      }
      // Same body — replay the stored response if the original finished.
      if (row.status_code != null) {
        console.log(`[idempotency] hit ${endpoint} key=${key.slice(0, 8)}…`)
        return res.status(row.status_code).json(row.response_body)
      }
      // Original is still in flight. Returning 409 here is safer than waiting
      // (we'd risk holding open connections during retries). Client should retry
      // with backoff; the second call will then hit the cached response.
      return res.status(409).json({
        error: 'idempotency_request_in_flight',
        message: 'A previous request with this key is still being processed.',
      })
    }

    // First time through. Intercept the response so we can store it.
    // We persist BEFORE flushing the response so a sequential retry sees the
    // cached row and replays instead of hitting an "in flight" 409. This costs
    // one extra DB roundtrip per protected mutating request — fine.
    console.log(`[idempotency] miss ${endpoint} key=${key.slice(0, 8)}…`)
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      // Don't cache 5xx — let a real retry actually retry. Body can be null
      // if the route never called res.json (rare, but possible on res.end).
      if (res.statusCode >= 500 || body == null) {
        query(
          `DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status_code IS NULL`,
          [req.user.id, key]
        ).catch(err => console.warn('[idempotency] cleanup failed:', err.message))
        return originalJson(body)
      }
      // Persist synchronously: kick off the UPDATE and stash the promise on
      // the response so we can await it from a finish hook. Then call
      // originalJson — but DELAY it via setImmediate so the persist actually
      // gets a chance to land before the response is flushed.
      const persistPromise = query(
        `UPDATE idempotency_keys
            SET status_code = $1, response_body = $2::jsonb, completed_at = now()
          WHERE user_id = $3 AND key = $4`,
        [res.statusCode, JSON.stringify(body), req.user.id, key]
      ).catch(err => {
        console.warn('[idempotency] persist failed:', err.message)
      })

      // Block the response until persistence completes. This serialises:
      //   1) row updated with response
      //   2) HTTP response sent
      // so any retry (sequential or near-simultaneous-after-this-returns) gets
      // the cached row. We use a wrapper Promise resolved after originalJson.
      persistPromise.then(() => originalJson(body))
      return res
    }

    next()
  }
}

# 0081 — FSM Atomic Transitions + Worker Transaction Fix

**Status:** todo  
**Addresses:** MONEY-4 (FSM races), DB-1 (worker FOR UPDATE no-op)

## Problem

1. **FSM app-only enforcement**: `/decline` and `/start` do a plain `query()` read, check state, then `UPDATE` unconditionally — no `AND status=$expected` guard. Two concurrent requests both pass `assertTransition` and both write. DB enum constrains values but not transitions.

2. **Worker locks are no-ops**: `queue.js` auto-confirm and barber-no-show workers use `await query('SELECT ... FOR UPDATE', ...)` via the pool helper. `pool.query()` auto-commits immediately → lock is released before the follow-up UPDATE. The `FOR UPDATE` is silently ignored.

## Changes

### `web/backend/src/routes/bookings.js`

Make **every** status transition a conditional UPDATE:
```js
// Instead of unconditional UPDATE + separate assertTransition:
const { rows, rowCount } = await query(
  `UPDATE bookings SET status = $1, updated_at = now()
   WHERE id = $2 AND status = $3
   RETURNING *`,
  [newStatus, bookingId, expectedStatus]
)
if (!rowCount) return res.status(409).json({ error: 'booking_state_changed', message: 'Booking status changed — please refresh.' })
```

Apply to ALL transition endpoints: `/decline`, `/start`, `/complete`, `/confirm`, `/dispute`, `/cancel`, `/no-show`. The transactional endpoints already use `FOR UPDATE` inside a transaction — they get the conditional UPDATE added too for defense-in-depth.

### `web/backend/src/services/queue.js`

Replace the pooled `FOR UPDATE` pattern with proper transactions in both workers:

**auto-confirm worker:**
```js
const client = await getClient()
try {
  await client.query('BEGIN')
  const { rows } = await client.query(
    `UPDATE bookings SET status = 'completed', completion_confirmed_at = now()
     WHERE id = $1 AND status = 'awaiting_confirmation'
     RETURNING *`,
    [bookingId]
  )
  await client.query('COMMIT')
  if (!rows[0]) return // already handled
  // then Stripe capture (outside txn)
} catch (err) { await client.query('ROLLBACK').catch(()=>{}); throw err }
finally { client.release() }
```

**barber-no-show-check worker:** same pattern with `status = 'accepted'`.

## Notes
- Conditional UPDATE is the minimal, most robust fix — DB enforces the invariant atomically
- All callers now get 409 on a lost race instead of silent double-write
- Existing `assertTransition` middleware remains as a fast pre-check that returns 422 for invalid transitions — keep it; the conditional UPDATE is the atomic guard behind it

// In-process SSE broker. Maps userId → Set<res>.
// Works in single-process mode. For multi-process deployments, swap to Redis Pub/Sub.

/** @type {Map<string, Set<import('express').Response>>} */
const clients = new Map()

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set())
  clients.get(userId).add(res)
}

export function removeClient(userId, res) {
  const set = clients.get(userId)
  if (!set) return
  set.delete(res)
  if (set.size === 0) clients.delete(userId)
}

/**
 * Emit an SSE event to one or more users.
 * @param {string|string[]} userIds
 * @param {string} event
 * @param {object} data
 */
export function emitToUsers(userIds, event, data) {
  const ids = Array.isArray(userIds) ? userIds : [userIds]
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const uid of ids) {
    const set = clients.get(uid)
    if (!set) continue
    for (const res of set) {
      try { res.write(payload) } catch { /* connection dropped */ }
    }
  }
}

export function clientCount() {
  let n = 0
  for (const s of clients.values()) n += s.size
  return n
}

// Alias used by services/metrics.js. Kept as a separate name to match the
// metrics-side import without renaming the original.
export const activeClientCount = clientCount

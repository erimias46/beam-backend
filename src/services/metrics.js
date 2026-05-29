// In-memory metrics — see specs/0003-health-and-metrics-endpoints.md.
//
// Counter / histogram primitives, plus a wrapper that hooks into Express
// responses to record HTTP stats. Resets on process restart (acceptable at
// this scale). Switch to a Prometheus exposition later if/when scraping is
// needed.

import { activeClientCount } from './sse.js'

const startTime = Date.now()

const counters = {
  requests_total:        0,
  requests_4xx:          0,
  requests_5xx:          0,
  stripe_calls_total:    0,
  stripe_failures_total: 0,
}

// Histogram: store the last N latency samples and compute percentiles on demand.
const LATENCY_WINDOW = 1024
const latencies = []

export function bumpCounter(name, n = 1) {
  if (counters[name] != null) counters[name] += n
}

export function recordLatency(ms) {
  latencies.push(ms)
  if (latencies.length > LATENCY_WINDOW) latencies.shift()
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return Math.round(sorted[idx])
}

/** Express middleware: record per-request stats. Mount near the top of the
 *  middleware chain so it sees the full response lifecycle. */
export function metricsMiddleware() {
  return function (req, res, next) {
    const t0 = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      recordLatency(ms)
      counters.requests_total++
      if (res.statusCode >= 500) counters.requests_5xx++
      else if (res.statusCode >= 400) counters.requests_4xx++
    })
    next()
  }
}

/** Snapshot of current values for the /metrics endpoint. */
export async function snapshot({ getBullmqCounts } = {}) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const bullmq = getBullmqCounts ? await getBullmqCounts().catch(() => null) : null
  return {
    uptime_s:               Math.round((Date.now() - startTime) / 1000),
    requests_total:         counters.requests_total,
    requests_4xx:           counters.requests_4xx,
    requests_5xx:           counters.requests_5xx,
    request_latency_ms: {
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    },
    active_sse_clients:     activeClientCount?.() ?? null,
    bullmq,
    stripe_calls_total:     counters.stripe_calls_total,
    stripe_failures_total:  counters.stripe_failures_total,
  }
}

export function getStartTime() { return startTime }

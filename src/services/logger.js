// Structured logger + error capture — see specs/0002-pino-logger-and-error-capture.md.
//
// Singleton pino instance. `pino-pretty` formats output in dev; in prod it's
// raw single-line JSON to stdout. captureError is the abstraction over any
// future error sink (Sentry, Better Stack, simple webhook) — today it just
// logs at error level and optionally POSTs to ERROR_WEBHOOK_URL.

import pino from 'pino'

const isProd = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

const transport = isProd || isTest
  ? undefined
  : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : isTest ? 'silent' : 'debug'),
  transport,
  // Redact common secret fields if they accidentally make it into a log.
  redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', '*.password', '*.token'],
  base: { service: 'beam0-api' },
})

/** Log a captured error with structured context. Optionally POST to a webhook
 *  sink if ERROR_WEBHOOK_URL is configured. */
export function captureError(err, context = {}) {
  const payload = {
    err: { message: err?.message, stack: err?.stack, code: err?.code },
    ...context,
  }
  logger.error(payload, err?.message || 'captured error')

  const url = process.env.ERROR_WEBHOOK_URL
  if (!url) return
  // Fire-and-forget. Don't await — error sinks shouldn't add latency to the
  // request path. fetch() is global in Node 18+.
  try {
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        ...payload,
        ts: new Date().toISOString(),
      }),
    }).catch(() => {})
  } catch { /* webhook isn't critical */ }
}

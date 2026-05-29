// Per-request UUID + child logger. See specs/0002-pino-logger-and-error-capture.md.
// Attach a stable id so all log lines from one HTTP request share a trace.

import { randomUUID } from 'crypto'
import { logger } from '../services/logger.js'

export function requestId() {
  return function (req, res, next) {
    req.id = req.headers['x-request-id'] || randomUUID()
    res.setHeader('X-Request-Id', req.id)
    req.log = logger.child({ req_id: req.id })
    next()
  }
}

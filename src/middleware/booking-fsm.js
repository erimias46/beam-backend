/* Booking state machine — enforces valid transitions */
const TRANSITIONS = {
  requested:   ['accepted', 'declined', 'cancelled'],
  accepted:    ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed:   ['paid'],
  declined:    [],
  cancelled:   [],
  paid:        [],
}

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from, to, res) {
  if (!canTransition(from, to)) {
    res.status(422).json({
      error: `Invalid transition: ${from} → ${to}`,
      allowed: TRANSITIONS[from] || [],
    })
    return false
  }
  return true
}

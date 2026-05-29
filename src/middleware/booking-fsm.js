/* Booking state machine — enforces valid transitions.
   Spec 0023 introduces awaiting_confirmation between in_progress and completed.
   Barber tap on /complete → awaiting_confirmation. Customer /confirm or
   auto-confirm timeout → completed. Customer /dispute → cancelled. */
const TRANSITIONS = {
  requested:             ['accepted', 'declined', 'cancelled'],
  accepted:              ['in_progress', 'cancelled'],
  in_progress:           ['awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['completed', 'cancelled'],
  completed:             ['paid'],
  declined:              [],
  cancelled:             [],
  paid:                  [],
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

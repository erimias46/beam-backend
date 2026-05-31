# 0092 — Scheduled Bookings + Availability Calendar

**Status:** todo  
**Addresses:** Feature suggestion #6 (scheduled bookings), #7 (availability calendar UX)

## Problem

The schema already has `scheduled_at` and barber weekly schedule + vacation (spec 0051). But customers can only book "now" conceptually — there's no UX for picking a future date/time from the barber's actual availability, and no reminders fire for upcoming bookings.

## Changes

### Backend: `GET /api/barbers/:id/slots`

New endpoint returning available 30-min time slots for a given barber over the next N days:
```
GET /api/barbers/:id/slots?from=2026-06-01&to=2026-06-07
```

Logic:
1. Fetch barber's `weekly_schedule` (day_of_week, start_minute, end_minute)
2. Fetch barber's `vacation_until`
3. Fetch existing accepted/in_progress/awaiting_confirmation bookings in the range (to exclude taken slots)
4. Generate 30-min slots within schedule windows, exclude taken ones
5. Return array of ISO datetime strings

```js
router.get('/:id/slots', async (req, res, next) => {
  try {
    const { from, to } = SlotQuerySchema.parse(req.query)
    const schedule = await getBarberSchedule(req.params.id)
    const takenSlots = await getTakenSlots(req.params.id, from, to)
    const slots = generateSlots(schedule, from, to, takenSlots)
    res.json({ slots })
  } catch (err) { next(err) }
})
```

### Frontend: Availability picker in Book flow

Step 1 (barber selected) → step 1.5 "Pick a time" using the new `/slots` endpoint:
- Calendar grid showing the next 7 days
- Time chips for available slots
- Show "Next available" if today has no slots

### Reminders

Existing queue infrastructure: add `scheduleBookingReminder` calls:
- **24h before**: email + push to customer ("Your cut with Marcus is tomorrow at 2 PM")
- **1h before**: push to both customer and barber
- **15min before**: push to barber only ("Customer is waiting")

```js
// In bookings.js at accept:
await scheduleReminder(booking.id, 'customer', scheduledAt - 24*3600*1000, '24h')
await scheduleReminder(booking.id, 'customer', scheduledAt - 3600*1000, '1h')
await scheduleReminder(booking.id, 'barber', scheduledAt - 900*1000, '15min')
```

Add `booking_reminders` to DB timers column (spec 0082 pattern) for durability.

### Mobile: Calendar view in `book_screen.dart`

Replace the date/time text input with a `TableCalendar` or custom scroll-wheel picker that shows slots from the API. Mark unavailable days in grey.

## API additions
- `GET /api/barbers/:id/slots?from=&to=` — public, no auth
- `POST /api/bookings` — `scheduled_at` already accepted; now validated against available slots server-side (soft validation — no exclusive lock on the slot until accept)

## Notes
- Slot validation at booking creation is soft (customer sees available, books, barber accepts). Hard lock happens at accept via the `bookings_barber_active_slot_idx` unique constraint.
- Duration: use `service.duration_min` from barber's services list to block out the right amount of time (not just 30 min)
- Barber time zone: use `barber_profiles.timezone` when generating slots (already stored from spec 0051)

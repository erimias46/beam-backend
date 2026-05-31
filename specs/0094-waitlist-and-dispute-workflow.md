# 0094 — Waitlist + Re-request Flow + Dispute/Chargeback Workflow

**Status:** todo  
**Addresses:** Feature suggestion #5 (dispute workflow), #11 (waitlist)

## Part A: Waitlist / Re-request Flow

When a barber declines or auto-cancel fires, customers currently lose the booking with no recovery path.

### Backend

Migration:
```sql
CREATE TABLE IF NOT EXISTS booking_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     text NOT NULL,
  lat         numeric(10,7) NOT NULL,
  lng         numeric(10,7) NOT NULL,
  service_type text NOT NULL,
  max_price_cents int,
  radius_km   numeric(5,2) DEFAULT 10,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON booking_waitlist(expires_at) WHERE expires_at > now();
```

`POST /api/waitlist` — customer joins waitlist after a declined/cancelled booking.  
`GET /api/waitlist/matches` — (background worker) finds available barbers near waitlist entries and sends a push/email: "A barber is available for your cut request. [Book now]".  
`DELETE /api/waitlist/:id` — customer removes themselves.

Worker: runs every 5 min, finds waitlist entries + available barbers within radius + sends notifications.

### Frontend/Mobile
After a booking is declined/cancelled: show a "Join waitlist — we'll alert you when a barber is available" CTA.

---

## Part B: Dispute/Chargeback Admin Workflow

The `dispute_state` column and `/dispute` endpoint exist. Build the admin workflow around them.

### Backend additions

`GET /api/admin/disputes` — list bookings where `dispute_state IS NOT NULL OR dispute_state = 'open'`, with customer/barber details and the completion photo (evidence).

`PATCH /api/admin/disputes/:id` — admin resolves:
```json
{ "resolution": "customer_wins" | "barber_wins" | "split", "notes": "..." }
```

Actions per resolution:
- `customer_wins`: full refund via `executeRefund(...)` with reason `admin_other`
- `barber_wins`: release the hold (capture the full amount, flip status to `paid`) 
- `split`: partial refund of specified `amount_cents`

`POST /api/admin/disputes/:id/evidence` — admin uploads notes/photos.

### Stripe chargeback handler

`charge.dispute.created` webhook → flip `dispute_state = 'chargeback'`, alert admin, auto-gather evidence (completion photo URL, booking metadata) and submit to Stripe:
```js
await stripe.disputes.update(event.data.object.id, {
  evidence: {
    customer_name: booking.customer_name,
    product_description: `Barber service: ${booking.service_type} on ${booking.scheduled_at}`,
    service_documentation: booking.completion_photo_url,
  },
  submit: false, // admin reviews before submitting
})
```

### Frontend: Admin Disputes page

`/admin/disputes` — table showing open disputes with:
- Booking details, amount, completion photo thumbnail
- Customer vs barber version (chat transcript link)
- Resolve buttons (Refund / Release / Split)
- Stripe dispute status and deadline

### Mobile: Customer dispute flow

Customer on `awaiting_confirmation` can tap "Something was wrong" → opens a form → calls `PATCH /api/bookings/:id/dispute` (existing endpoint) with a description → creates the dispute in DB → notifies admin.

## Notes
- Waitlist entries expire after 24h automatically (the `expires_at` index supports efficient cleanup)
- Chargeback workflow requires Stripe keys to be set (spec 0090 INFRA-7)
- Evidence submission is admin-reviewed before submission to Stripe to avoid premature disclosure

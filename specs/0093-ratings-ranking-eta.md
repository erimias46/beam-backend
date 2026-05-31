# 0093 — Ratings-Driven Ranking + Real-Time ETA

**Status:** todo  
**Addresses:** Feature suggestion #8 (ETA), #10 (ratings ranking)

## Problem

Barber search ranks by distance/price only, ignoring the rating data collected. Live location exists but ETA is never computed or shown.

## Changes

### Backend: Rating-weighted search ranking

`GET /api/barbers` — add a `sort` query param: `distance` (default), `rating`, `smart`:

**Smart ranking formula:**
```sql
-- Score = 0.6 * (1 - distance_km / max_radius) + 0.3 * (rating_avg / 5) + 0.1 * min(rating_count, 50) / 50
-- Only applied when sort=smart
ORDER BY
  (0.6 * (1.0 - (distance_km / $radius_km))
 + 0.3 * (COALESCE(bp.rating_avg, 3.0) / 5.0)
 + 0.1 * LEAST(bp.rating_count, 50) / 50.0) DESC
```

Frontend Book page: add a "Sort" selector chip row: Distance / Top Rated / Smart.

Mobile `book_screen.dart`: add sort chips above the barber list.

### Backend: ETA endpoint

`GET /api/bookings/:id/eta` — returns estimated travel time from barber's last-known location to booking address:

```js
router.get('/:id/eta', requireAuth, async (req, res, next) => {
  try {
    // Check user is customer on this booking
    const booking = await getBooking(req.params.id, req.user.id)
    // Get barber's last location
    const loc = await query(`SELECT lat, lng FROM barber_location_live WHERE barber_id = $1`, [booking.barber_id])
    if (!loc.rows[0]) return res.json({ eta: null })
    
    const { lat: bLat, lng: bLng } = loc.rows[0]
    const { lat: dLat, lng: dLng } = booking

    // Use Google Maps Distance Matrix API
    const etaData = await getETA(bLat, bLng, dLat, dLng)
    res.json({
      eta_seconds: etaData.duration.value,
      eta_text:    etaData.duration.text,       // "12 mins"
      distance_m:  etaData.distance.value,
      updated_at:  new Date().toISOString(),
    })
  } catch (err) { next(err) }
})
```

ETA service (`services/maps.js`):
```js
import { Client } from '@googlemaps/google-maps-services-js'
const mapsClient = new Client()

export async function getETA(originLat, originLng, destLat, destLng) {
  const res = await mapsClient.distancematrix({
    params: {
      origins:       [`${originLat},${originLng}`],
      destinations:  [`${destLat},${destLng}`],
      mode:          'driving',
      key:           process.env.GOOGLE_MAPS_SERVER_KEY,
    }
  })
  return res.data.rows[0].elements[0]
}
```

Add `GOOGLE_MAPS_SERVER_KEY` (server-side key with no referrer restriction, restricted to Distance Matrix API only) to Coolify env vars.

### Frontend: ETA display in BookingDetail

Poll `GET /api/bookings/:id/eta` every 60s when booking is `in_progress` or `accepted`, show above the map:
```jsx
<div className="card mb-4 flex items-center gap-3">
  <span className="text-2xl">🚗</span>
  <div>
    <p className="font-bold">{eta.eta_text} away</p>
    <p className="text-xs text-[var(--text-secondary)]">Updated {timeAgo(eta.updated_at)}</p>
  </div>
</div>
```

### Mobile: ETA in `booking_detail_screen.dart`

Same polling pattern, show in a `GlassCard` above the map.

## Notes
- Server-side Maps key for ETA avoids exposing a key with Distance Matrix API access in the mobile bundle
- ETA is approximate (driving mode); actual barber travel mode may vary — add a disclaimer
- Cache ETA results for 30s server-side to limit Maps API calls during the 60s poll
- Smart ranking formula weights are configurable via `platform_settings`

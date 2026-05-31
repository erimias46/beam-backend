# 0088 — Frontend Robustness: Error Boundaries, Performance, UX

**Status:** todo  
**Addresses:** FE-7 (abort/race), FE-8 (error boundaries), FE-9 (lazy loading), FE-10 (next/image), FE-11 (earnings), FE-14 (form validation), FE-15 (error states), FE-16 (hooks violation)

## Changes

### Error Boundaries + Not Found (`FE-8`)

`web/frontend/src/app/error.jsx` — global error boundary:
```jsx
'use client'
export default function GlobalError({ error, reset }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="text-[var(--text-secondary)] text-sm">{error.message}</p>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  )
}
```

Segment error boundaries in `app/bookings/[id]/error.jsx`, `app/book/error.jsx`, `app/barber/error.jsx`.

`web/frontend/src/app/not-found.jsx`:
```jsx
export default function NotFound() {
  return <div className="min-h-screen flex items-center justify-center">
    <div className="text-center"><h1 className="text-4xl font-bold">404</h1><p>Page not found.</p><a href="/" className="btn mt-4">Go home</a></div>
  </div>
}
```

Guard `window.google` in `LiveBarberMap.jsx`:
```jsx
if (!isLoaded || !window.google) return <div data-testid="map-loading">...</div>
```

### Lazy Loading (`FE-9`)

In `Book.jsx` and `BookingDetail.jsx`, lazy-load heavy components:
```js
const LiveBarberMap = dynamic(() => import('@/components/LiveBarberMap'), { ssr: false, loading: () => <MapSkeleton /> })
const PaymentMethodManager = dynamic(() => import('@/components/PaymentMethodManager'), { ssr: false })
const GoogleMapComponent = dynamic(() => import('@react-google-maps/api').then(m => m.GoogleMap), { ssr: false })
```

### `next/image` migration (`FE-10`)

`web/frontend/next.config.js`:
```js
images: {
  remotePatterns: [
    { protocol: 'https', hostname: '**.sslip.io' },  // uploads served from API
    { protocol: 'https', hostname: 'bookabeam.com' },
  ],
}
```

Replace `<img>` in portfolio, booking detail, barber profile with `<Image>` from `next/image`. For uploads served from the API (relative `/uploads/...` URLs), use `unoptimized` until a CDN is set up, but always add `loading="lazy"` and `decoding="async"`.

### Abort controller / race prevention (`FE-7`)

In `store/index.js`:
```js
let fetchBarbersController = null
fetchBarbers: async (params) => {
  fetchBarbersController?.abort()
  fetchBarbersController = new AbortController()
  try {
    const data = await api.getBarbers(params, { signal: fetchBarbersController.signal })
    set({ barbers: data.barbers || data })
  } catch (err) {
    if (err.name === 'CanceledError') return // ignore abort
    set({ error: err.message })
  }
}
```
In `api/client.js`, pass `signal` to axios:
```js
getBarbers: (params, opts) => axiosInstance.get('/api/barbers', { params, signal: opts?.signal }).then(r => r.data)
```

In `Book.jsx`, don't call `fetchBarbers` twice — remove the geolocation callback re-call; let the lat/lng update flow through the store `fetchBarbers` debounced:
```js
useEffect(() => {
  if (userLat && userLng) fetchBarbers({ lat: userLat, lng: userLng })
}, [userLat, userLng])
```

### Error states in store (`FE-15`)

In `Bookings.jsx` and `Book.jsx`, render `error`:
```jsx
{error && (
  <div className="card text-center py-8">
    <p className="text-red-500 mb-3">Failed to load</p>
    <button className="btn" onClick={fetchBookings}>Retry</button>
  </div>
)}
```

### Form validation (`FE-14`)

In `Book.jsx` — require address coordinates before advancing:
```js
const canAdvance = step === 0
  ? selectedBarber !== null
  : step === 1
  ? address.length >= 5 && addressCoords !== null  // require coords
  : paymentMethod !== null
```

Show inline error: `{!addressCoords && address.length > 0 && <p className="text-red-500 text-xs">Please select an address from the suggestions.</p>}`

### Hooks violation (`FE-16`)

In `BarberShareLocation.jsx` — move the early `return null` after all hooks:
```jsx
export default function BarberShareLocation({ booking }) {
  const [coords, setCoords] = useState(null)
  const busy = useRef(false)
  const timer = useRef(null)

  useEffect(() => {
    if (!['accepted', 'in_progress'].includes(booking.status)) return // guard inside effect
    // ... location logic
    return () => clearInterval(timer.current)
  }, [booking.status])

  // Early return AFTER all hooks
  if (!['accepted', 'in_progress'].includes(booking.status)) return null
  return <LocationUI coords={coords} />
}
```

### Barber earnings from backend (`FE-11`)

Remove the `price_cents * 0.85` fabrication from the store. The earnings endpoint `GET /api/barbers/me/earnings` already exists (spec 0052). Update the Earnings page and `useBookingsStore` to derive `transactions` from the backend response:
```js
// Remove from store:
amount_cents: Math.floor((b.price_cents || 0) * 0.85)
// Fetch from:
api.getBarberEarnings({ period, from, to })
```

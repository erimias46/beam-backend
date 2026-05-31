# 0089 — Mobile Hardening

**Status:** todo  
**Addresses:** MOBILE-1 (Maps key), MOBILE-2 (API URL), MOBILE-3 (401/refresh), MOBILE-4 (SSE reconnect), MOBILE-5 (battery), MOBILE-6 (connectivity), MOBILE-7 (notifications), MOBILE-8 (iOS plist)

## Changes

### MOBILE-2 — Production API URL via `--dart-define`

`app/lib/core/api.dart`:
```dart
static String _baseUrl() {
  // Injected at build time: flutter run --dart-define=API_BASE_URL=https://...
  const apiUrl = String.fromEnvironment('API_BASE_URL');
  if (apiUrl.isNotEmpty) return apiUrl;
  // Development fallbacks
  if (kReleaseMode) throw StateError('API_BASE_URL must be set in release builds');
  return kIsWeb ? 'http://localhost:4000' : 'http://10.0.2.2:4000';
}
```

Build commands:
```bash
# Dev
flutter run

# Release (iOS)
flutter build ios --dart-define=API_BASE_URL=https://api.bookabeam.com

# Release (Android)
flutter build apk --dart-define=API_BASE_URL=https://api.bookabeam.com
```

Add to README/Makefile.

### MOBILE-1 — Maps API key via build config

Remove hardcoded key from `AndroidManifest.xml` and `AppDelegate.swift`.

**Android** — `android/app/build.gradle`:
```groovy
manifestPlaceholders = [mapsApiKey: MAPS_API_KEY]
```
`android/local.properties` (gitignored):
```
MAPS_API_KEY=AIza...dev-key
```
`AndroidManifest.xml`:
```xml
<meta-data android:name="com.google.android.geo.API_KEY" android:value="${mapsApiKey}"/>
```

**iOS** — `ios/Runner/AppDelegate.swift`:
```swift
GMSServices.provideAPIKey(ProcessInfo.processInfo.environment["MAPS_API_KEY"] ?? "")
```
Set via Xcode `Edit Scheme → Environment Variables` for dev; CI/CD injects the prod key.

Rotate the current key in GCP console. Create separate dev and prod keys, each restricted to the appropriate platform.

### MOBILE-3 — 401 handling + token refresh

`app/lib/core/api.dart` — add `onError` interceptor:
```dart
_dio.interceptors.add(InterceptorsWrapper(
  onError: (DioException err, handler) async {
    if (err.response?.statusCode == 401 && !err.requestOptions.extra['_retried']) {
      // Try refresh once
      final refreshToken = await _storage.read(key: 'refresh_token');
      if (refreshToken != null) {
        try {
          final resp = await _dio.post('/api/auth/refresh',
            data: {'refresh_token': refreshToken},
            options: Options(extra: {'_retried': true}),
          );
          final newToken = resp.data['access_token'];
          await _storage.write(key: 'jwt', value: newToken);
          err.requestOptions.headers['Authorization'] = 'Bearer $newToken';
          err.requestOptions.extra['_retried'] = true;
          return handler.resolve(await _dio.fetch(err.requestOptions));
        } catch (_) {
          await _clearAuth();
          // Navigate to login via GlobalKey<NavigatorState> or using a stream
        }
      }
    }
    handler.next(err);
  },
));
```

### MOBILE-4 — SSE reconnect in `live_barber_map.dart`

```dart
void _subscribe() {
  _sseSubscription?.cancel();
  _sseSubscription = SSEClient.subscribeToSSE(
    url: ..., header: ...,
  ).listen(
    (event) { ... },
    onError: (_) => _scheduleReconnect(),
    onDone:  ()  => _scheduleReconnect(),
  );
}

Timer? _reconnectTimer;
void _scheduleReconnect() {
  _reconnectTimer?.cancel();
  _reconnectTimer = Timer(const Duration(seconds: 5), _subscribe);
}

// Re-subscribe on app resume:
@override void didChangeAppLifecycleState(AppLifecycleState state) {
  if (state == AppLifecycleState.resumed) _subscribe();
}
```

### MOBILE-5 — Battery drain reduction

`app/lib/widgets/barber_share_location.dart`:
- Change `LocationAccuracy.high` → `LocationAccuracy.balanced`
- Increase `distanceFilter` from `5` → `15` meters
- Change the `setState` tick from 1s → 10s (only updates the "Xs ago" label)
- Pause sharing on background: use `WidgetsBindingObserver` → pause stream on `AppLifecycleState.paused`, resume on `resumed`
- Auto-stop: check in the timer callback if `booking.status` is no longer `accepted`/`in_progress` and cancel

### MOBILE-6 — Connectivity handling

Add `connectivity_plus` to `pubspec.yaml`.

Create `lib/widgets/connectivity_banner.dart`:
```dart
class ConnectivityBanner extends StatefulWidget { ... }
// Shows a red banner "No internet connection" when offline
```

Replace silent `catch (_) {}` in critical paths with user-visible error:
```dart
// barber_share_location.dart:
} catch (e) {
  _consecutiveFailures++;
  if (_consecutiveFailures >= 3) {
    setState(() => _shareError = 'Location sharing interrupted');
  }
}
```

### MOBILE-7 — Notifications wired to SSE

`app/lib/providers/notifications_provider.dart`:
```dart
// Wire SSE booking events → addNotification()
// Hydrate on launch from GET /api/notifications (if endpoint exists, or use booking status changes)
// Persist unread count to SharedPreferences
```

On each SSE event of type `booking_accepted`, `booking_declined`, `chat_message`, `booking_completed`:
```dart
ref.read(notificationsProvider.notifier).addNotification(
  NotificationItem(title: ..., body: ..., bookingId: event.data['booking_id']),
)
```

### MOBILE-8 — iOS Info.plist cleanup

Remove `NSLocationAlwaysAndWhenInUseUsageDescription` from `ios/Runner/Info.plist` — the app only uses when-in-use. Only keep `NSLocationWhenInUseUsageDescription`.

## Notes
- MOBILE-2 (API URL) and MOBILE-1 (Maps key) are the two changes needed before any real release
- Add `make build-ios` and `make build-android` targets to a root Makefile with the `--dart-define` flags

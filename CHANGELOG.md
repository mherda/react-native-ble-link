# Changelog

## 0.1.0 (unreleased)

First version, extracted from the `ble-beacons` demo apps.

- Hub (`createPeripheral`) and phone (`createCentral`) roles on iOS and Android, as a TurboModule (New Architecture).
- Framed JSON messages up to 4 KB over any MTU; requests, responses and events.
- Hub state with live `stateChanged` pushes, sessions and exclusive claims.
- `FakeRadio` in-memory transport for tests.
- Renamed from the demo's `tabletId` / `NearbyTablet` / `TabletInfo` / `advertisedTabletId` / `onTablets` to `hubId` / `NearbyHub` / `HubInfo` / `advertisedHubId` / `onHubs`.
- `Central.connections`, `Central.getConnection(deviceId)` and `Central.isScanning`.
- `enableBluetooth()`: the system "turn on Bluetooth" dialog on Android; reports whether it's on, on iOS.
- Request IDs are a per-connection counter instead of random, so concurrent requests can never collide. Hubs treat IDs as opaque, so this is wire-compatible.
- `docs/troubleshooting.md`.
- The `UNKNOWN_TYPE` error message names the request type: `Unknown request type "echo"`.
- Expo config plugin (`"plugins": ["react-native-ble-link"]`) with the options `roles`, `bluetoothAlwaysPermission`, `neverForLocation` and `isBleRequired`. `expo` is an optional peer dependency.
- `example/`: an Expo app that can act as either the hub or the phone.
- Native names made unique: the pod `ReactNativeBleLink` (was `BleLink`), the TurboModule and Objective-C class `ReactNativeBleLink`, the Codegen library `ReactNativeBleLinkSpec`, and the Android package `com.mherda.blelink` (was `com.blelink`). After updating, apps need `pod install`. On Android, they need to delete `android/build/generated/autolinking` and `android/app/build/generated/autolinking`, then rebuild.
- New error code `NOT_CLAIMABLE` for claiming a session that isn't claimable (was `INVALID_BODY`).

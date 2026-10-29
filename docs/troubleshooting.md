# Troubleshooting

Common problems, roughly in the order people hit them. For the API, see the [README](../README.md). For what goes over the air, see [protocol.md](./protocol.md).

**First, a general tip.** Install a BLE inspection app such as **nRF Connect** (iOS and Android) on a spare phone. It shows whether the hub is advertising, its hub ID, its service UUID and its four characteristics. That quickly tells you whether a problem is on the hub side or the phone side.

---

## The phone finds no hubs

Work through these in order:

1. **Real devices only.** The iOS Simulator has no Bluetooth, and Android emulators have no usable BLE by default. Both the hub and the phone must be physical devices.
2. **Bluetooth is on.** Check `getBluetoothState()`. On Android, `enableBluetooth()` asks the user to turn it on.
3. **Permissions.** Call `requestPermissions('central')` on the phone and `requestPermissions('peripheral')` on the hub *before* `scan()` / `start()`, and check the result.
   - On Android, the permissions must also be in `AndroidManifest.xml`; see the README's install section. A runtime request for a permission that isn't declared is silently denied.
4. **Android 11 and older: Location must be switched on.** Scanning needs the location permission *and* the system Location setting. If Location is off, scans start without error but find nothing. Android 12+ doesn't have this problem, because of `neverForLocation`.
5. **Android scan throttling.** Android allows about 5 scan starts per 30 seconds per app. After that it silently returns no results until the window passes. Many `scan()` → `connect()` → `scan()` cycles in quick succession, e.g. while testing, can trigger it. Wait 30 seconds, and avoid stopping and restarting scans in a loop.
6. **The hub is advertising.**
   - `hub.start()` resolved without error.
   - The hub app is in the foreground. An iOS hub stops being discoverable in the background.
   - On Android, `isPeripheralSupported()` is `true`. Some budget devices can't advertise at all.
7. **The same UUIDs on both sides.** If you pass `uuids` to `createPeripheral`, pass the same ones to `createCentral`.
8. **`minRssi` isn't too strict.** −65 dBm means roughly "within a metre or two", and phone cases, bodies and walls all weaken the signal. Try without `minRssi` first.

## `hubId` is `null` for a moment

This is expected. The hub ID is in the **scan response**, which arrives a little after the main advertisement: in the local name for an iOS hub, in the service data for an Android hub. `NearbyHub.hubId` fills in within a second. Filter on `hubId` rather than assuming it's there on the first result.

## Connecting fails or times out

- **Android `GATT error 133` / random first-attempt failures.** This is a long-standing Android stack issue. `connect()` already retries once (`retries: 1`); raise it to 2 for flaky devices.
  - If a phone keeps failing, toggling its Bluetooth off and on usually clears it.
- **The hub is at its connection limit.** Hubs typically manage 4–10 simultaneous phones, depending on the chip. Have phones disconnect when they're done instead of staying connected.
- **The phone is moving away.** Connections near the edge of range time out. Use `minRssi` to only offer hubs that are clearly close.
- **The hub was restarted.** After a hub app restart, an old `deviceId` might not work. Use `central.reconnect({ hubId })`, which rescans.

## Requests time out

- **The hub app went to the background, or its screen locked.** An iOS hub stops answering. Keep the hub app in the foreground, using guided access or kiosk mode for real deployments.
- **The handler is slow.** The default request timeout is 10 s. If your handler calls a slow backend, pass `{ timeoutMs }` to `request()` or reply quickly and send the result later as an event.
- **The handler never returns.** An unresolved promise in a handler causes a `TIMEOUT` on the phone. Make sure every code path returns or throws.

## Unexpected `SESSION_EXPIRED` or `SESSION_BUSY`

- **`SESSION_EXPIRED`:** the phone's session is older than the hub's.
  - Call `readState()` after connecting and after every reconnect, before sending requests. Requests carry the session from the last state read.
  - Something on the hub may have called `setState(…, { newSession: true })` more often than you meant. Only start a new session when the *thing being acted on* changes.
- **`SESSION_BUSY`:** another phone holds a claim. Claims last until released, until a new session starts, or until `claimTtlMs` passes (default 5 minutes). If a phone abandoned a flow, have it call `release()`, or use a shorter `claimTtlMs`.
- For requests that don't depend on the hub's screen, register the handler with `{ requireSession: false }`.

## The iOS app crashes the first time it uses Bluetooth

`NSBluetoothAlwaysUsageDescription` is missing from `Info.plist`. iOS ends any app that uses Bluetooth without it. Add it to every target and configuration that uses the library.

## It works in Debug but not in a release build

- **Android:** check that the permissions are in the `main` manifest, not only a `debug` one. With `minSdkVersion` or `maxSdkVersion` changes, recheck which permissions apply.
- **iOS:** check the usage description is in the `Info.plist` the Release configuration actually uses.
- Make sure both sides are on the same version of this library. A hub and phone on different protocol versions fail with `UNSUPPORTED_VERSION`.

## Android phone sees an old layout after a hub update

Android caches a device's GATT layout (services and characteristics). If a hub app update changes its UUIDs, an Android phone may keep using the cached layout and fail with read or write errors. To clear the cache:
- toggle Bluetooth off and on on the phone;
- or forget the device in the Bluetooth settings, if it appears there.

There's a [TODO](../TODO.md) item for handling this automatically.

## Seeing what's going on

- `central.on('received', …)` and `hub.on('received', …)` report every message, read and event on each side. Log them in a debug screen.
- `hub.on('centralConnected' | 'centralDisconnected', …)` shows phones coming and going.
- `conn.on('disconnected', error => …)` says why a link dropped. `error` is `null` for a clean disconnect.
- To debug at the protocol level, nRF Connect can subscribe to `tx` and write frames to `rx` by hand. See [protocol.md](./protocol.md) for the byte format.

# TODO / roadmap

What's still needed, roughly in priority order. Everything here is about the library itself, not any particular app built on it.

## Before the first public release

- [x] **Repository and metadata.** `repository`, `homepage` and `bugs` are in `package.json`, and the podspec reads them.
- [ ] **Native names that won't collide.**
  - The pod is called `BleLink` and the Android package is `com.blelink`. Both are generic enough to clash with another library.
  - Rename them to something like `ReactNativeBleLink` and `com.<owner>.blelink`. That's a breaking change, so do it before 1.0.
- [ ] **Test Android as the hub on real devices.** So far: iOS ↔ iOS, and an Android phone ↔ iOS hub. Still to test:
  - an Android hub with iPhone and Android phones;
  - several vendors (Samsung, Pixel, a budget tablet).
- [ ] **Supported React Native range.**
  - The peer dependency says `>=0.88.0` because that's the only version tested. The API used (`CodegenTypes.EventEmitter` TurboModule events) exists from about 0.80, so test 0.80–0.87 and widen the range.
  - Decide whether the old architecture will ever be supported. Probably not: document "New Architecture only".
- [ ] **CI.** Typecheck, unit tests, `bob build`, `npm pack` contents, plus compiling iOS and Android in an example app.
- [ ] **Expo support.** Many React Native apps use Expo, so this matters for adoption:
  - **A config plugin** (`app.plugin.js`, `"plugins": ["react-native-ble-link"]` in `app.json`). It should add `NSBluetoothAlwaysUsageDescription`, and the Android permissions for the roles chosen with an option such as `{ roles: ['central', 'peripheral'] }`, including `neverForLocation` and `maxSdkVersion`. It could also add the `bluetooth-central` / `bluetooth-peripheral` background modes once those are supported.
  - **Test with a development build** (`expo prebuild` + `expo run:ios|android`) on the current Expo SDK, and confirm autolinking and Codegen work without manual steps.
  - **Plugin options,** following the same pattern as `react-native-ble-manager`'s:
    - `neverForLocation` (default `true` for us, since we never derive location);
    - `isBleRequired`, which sets `<uses-feature android:required>` and so whether the Play Store hides the app on devices without BLE;
    - a custom iOS permission text.
  - Add `app.plugin.js` to `files` in `package.json`.
  - **Docs:** an Expo install section in the README, and a note that Expo Go can't load it.
  - `react-native-ble-manager`'s plugin is a reference for how to structure this.
- [ ] **Example app inside the repo** (`example/`, the usual layout for RN libraries), so contributors can run both roles without the separate demo apps.
- [x] **Troubleshooting page:** [`docs/troubleshooting.md`](./docs/troubleshooting.md). Add to it as real-world reports come in.
- [ ] **Lint and format config** (ESLint, Prettier, ktlint, SwiftFormat).
- [ ] **Release process,** such as changesets or release-it, with a changelog generated from it. Publish with npm provenance.

## Robustness

- [ ] **Android scan throttling.** Android allows about 5 scan starts per 30 s per app and silently returns no results beyond that. Repeated `scan()` / `connect()` / `reconnect()` cycles can hit it. Keep one long-running native scan and fan it out in JS, which `Central` partly does already. Then add a test for rapid reconnects.
- [ ] **Bluetooth turned off and on.** Make sure the hub restarts advertising and its GATT server, and that phones get clean `disconnected` events and can scan again. Test on both platforms.
- [ ] **Hub-side limits against misbehaving phones:**
  - a cap on simultaneous connections;
  - a per-phone limit on request rate and concurrency;
  - a maximum request body size per handler;
  - dropping phones that stay idle too long. Android can disconnect a phone (`cancelConnection`). iOS hubs can't, so they can only ignore it.
- [ ] **`Peripheral.disconnect(centralId)`** on Android. It can't be done on iOS, so expose it as best-effort.
- [ ] **Faster Android connections:** request `CONNECTION_PRIORITY_HIGH` during an exchange, and check the MTU request timing.
- [ ] **Android GATT cache.** When a hub's GATT layout changes (a new library version), Android phones may use a cached service table. Use the Service Changed characteristic, or `BluetoothGatt.refresh()` via reflection, as a fallback.
- [ ] **Deprecation warning** in `CentralController.kt` (`connectGatt` overload). Move to the current API on newer SDK levels.
- [x] **Request ID collisions.** Request IDs are now a per-connection counter, so two pending requests can't share one.
- [x] **"Turn on Bluetooth" helper.**
  - Android: `enableBluetooth()` shows the system dialog (`ACTION_REQUEST_ENABLE`) and resolves with the user's choice.
  - iOS has no API for this, so it reports whether Bluetooth is on.
  - Still to do: test the dialog on a real device, and consider exposing iOS's `CBCentralManagerOptionShowPowerAlertKey` system alert as an option.
- [ ] **Native unit tests** (XCTest / JUnit) for the parts that can be tested without a radio: base64, event payloads, operation queues.

## Security

The link is currently plaintext and unauthenticated (see README → Security). Options, which can be combined:

- [ ] **Encrypt each connection.** An X25519 key exchange through `link.hello`, then AES-GCM-encrypted envelopes. That stops passive eavesdropping, but on its own it doesn't stop a fake hub.
- [ ] **Authenticate the hub.** The hub gets a key pair signed by the app's backend and signs its state or handshake with it. Phones check against a public key built into the app, so a fake hub can't pose as a real one.
- [ ] **Bind requests to the handshake,** so a recorded request can't be replayed on another connection.
- [ ] **Optional BLE pairing/bonding** (encrypted characteristic permissions) for setups where a one-time pairing prompt is acceptable.
- [ ] **A `validate` option on `handle()`.** A schema check, e.g. zod, before the handler runs, rejecting with `INVALID_BODY`.

## API extensions

- [ ] **React hooks:** `useBluetoothState`, `useNearbyHubs`, `useConnection`, `usePeripheral`. Every app ends up writing these.
- [ ] **Built-in auto-connect** on `Central`: connect to the nearest hub with a given ID once it's been above an RSSI threshold for a dwell time, with a cooldown. That's a common pattern that's easy to get wrong.
- [ ] **Typed contracts.** Declare request/response/event types once and get typed `request()`, `handle()`, `emit()` and `on('event')`:
  ```ts
  const contract = defineContract<{
    requests: { checkin: { req: { name: string }; res: { welcome: string } } };
    events: { 'order.ready': { orderId: string } };
  }>();
  ```
- [ ] **Messages beyond 4 KB, and binary data.** Chunked transfer with progress, a binary envelope (CBOR or raw bytes) instead of JSON over base64. Raise the 255-frame limit. Use **write without response** for the bulk of the frames: it's several times faster than acknowledged writes. Flow control would rely on Android's `onCharacteristicWrite` / iOS's `canSendWriteWithoutResponse`, with an acknowledged write at the end.
- [ ] **Phone → hub events** (fire-and-forget) and **hub → phone requests** (the hub asks the phone and waits for a reply). Currently requests only go phone → hub and events only hub → phone.
- [ ] **More than one claimable thing per hub.** Claims keyed by a resource, e.g. `claim('locker-3')`, so one hub can run several exclusive flows in parallel.
- [ ] **A built-in queue:** waiting phones get a position and a `your turn` event when the claim is released, instead of polling for `SESSION_BUSY`.
- [ ] **Scan options:** scan mode (low latency vs low power), raw advertisement data, TX power for better distance estimates, filtering by hub ID in native code. On Android, also `matchMode`, `callbackType` and `reportDelay` (batched results save battery while waiting in the background).
- [ ] **Signal strength while connected:** `conn.readRssi()` and an optional `rssi` event every N seconds. Use it to detect "the user walked away" and disconnect or release a claim, or to show a "move closer" hint. Possibly an auto-release policy on the hub.
- [ ] **Long range (LE Coded PHY).** About 4× the range on Bluetooth 5 hardware: extended advertising on the hub, a `phy` option on scan and connect. Android only; iOS doesn't expose it. Useful for car parks, warehouses and large venues. The opposite (LE 2M PHY) gives faster transfers.
- [x] **Introspection on `Central`:** `connections`, `isScanning`, and `getConnection(deviceId)`, so an app can recover after a screen remounts instead of keeping its own bookkeeping.
- [ ] **Android Companion Device Manager (client side, optional).** A system dialog pairs the phone with a hub once. After that, the app can find it without scan or location permission, and Android 12+ can wake the app when the hub comes into range (`CompanionDeviceService`). This is the closest Android gets to background "arriving at the hub" detection.
- [ ] **Several services per app** (one app acting as two kinds of hub), and several `Peripheral` instances.
- [ ] **Debug logging hook and metrics** (connect time, MTU, retries, frame counts), off by default.

## Platform reach

- [ ] **iOS background.**
  - Keep phone connections alive in the background: the `bluetooth-central` background mode and state restoration.
  - Document what still works for hubs in the background (very little).
  - Optionally, an iBeacon companion that wakes the phone app as it approaches a hub, after which the normal link takes over.
- [ ] **Web Bluetooth client** (central role only, Chrome/Android/desktop). The protocol is plain TypeScript, so it only needs a `CentralTransport` built on `navigator.bluetooth`.
- [ ] **Node client/hub** (e.g. `@abandonware/noble` / `bleno`) for test rigs and hubs without a screen, such as a Raspberry Pi as a hub.

## Testing

- [ ] **A more realistic `FakeRadio`:** MTU negotiation, latency and jitter, dropped frames, several hubs with separate RSSI values, connection limits.
- [ ] **Tests for many concurrent phones,** both for requests and for claims racing each other.
- [ ] **An on-device test harness:** a small script that runs the same scenarios against real hardware and reports timings.

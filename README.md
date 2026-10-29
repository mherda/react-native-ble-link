# react-native-ble-link

Two-way messaging over Bluetooth Low Energy between React Native apps, with no backend and no pairing.

One package gives you **both ends of the link** and **the messaging between them**:

1. **Hub:** an app that other devices connect to.
2. **Client:** an app that finds hubs and connects to them.
3. **The communication layer:** a small, flexible message protocol on top of BLE, so your code deals with JSON messages instead of bytes and GATT characteristics.

You could think of it as a tiny HTTP API over Bluetooth: the hub is the server and phones are the clients. Unlike HTTP, the hub can also push to its clients.

## Two roles, one library

| | **Hub** | **Client** |
|---|---|---|
| BLE term | Peripheral (advertiser + GATT server) | Central (scanner + GATT client) |
| Created with | `createPeripheral({ hubId })` | `createCentral()` |
| Typical device | Tablet at a desk, kiosk, a phone on a stand, a host's phone | Customers' or users' phones |
| What it does | Advertises a short **hub ID**, accepts connections from several clients at once, publishes its **state**, handles **requests**, pushes **events** | Scans for hubs (sorted by signal strength), connects, reads state, sends requests, listens for events, reconnects |

- **Any combination of platforms:** an iPad hub with Android phones, an Android hub with iPhones, and so on.
- **One app can play either role, or both.** A host's phone can be the hub for a game while guests' phones are clients, using the same app and package.
- Most BLE libraries for React Native (`react-native-ble-plx`, `react-native-ble-manager`) only cover the **client** side, with raw read and write operations. They can't make a phone or tablet *be* the thing others connect to. This library can, and gives both sides the same protocol.

> This README mostly says **phone** for the client, because that's the usual device. The code uses the BLE names `Peripheral` and `Central`.

## The communication layer

The native code is only a byte pipe. Everything above it is TypeScript, shared by both platforms:

| Building block | Direction | What it's for |
|---|---|---|
| **Discovery** | hub → nearby phones | Hub ID and signal strength *before* connecting: "which device am I standing next to?" |
| **State** | hub → phones | A small JSON object saying what the hub is doing now (`screen` + `data`). Phones read it on connect and get live updates. |
| **Requests** | phone → hub → phone | `conn.request(type, body)` → `hub.handle(type, fn)`, with exactly one reply or a typed error. Timeouts included. |
| **Events** | hub → one phone or all | `hub.emit(type, body)` for "your order is ready", "round over", and so on. No reply. |
| **Sessions** | — | Each new screen can start a session. Requests made for an old one are rejected, so a stale phone can't act on something the hub has moved on from. |
| **Claims** | — | One phone can take exclusive hold of a session (e.g. paying an invoice). Others get `SESSION_BUSY`. The claim survives reconnects. |
| **Framing** | both | Messages up to 4 KB are split and reassembled to fit any MTU. Several phones are handled concurrently, each on its own channel. |

**It's flexible because it doesn't know what your app does:**

- **You define the vocabulary.** Request and event types are any strings, bodies are any JSON, and state is whatever describes your screen. Nothing about check-ins, payments or any other scenario is built in.
- **Use only the parts you need.** State alone gives you a live info display. Requests alone give you "tap to do X here". Events give you a pager. Claims are opt-in per session, and session checks are opt-out per handler (`requireSession: false`).
- **Your own namespace.** Configure your own service and characteristic UUIDs per product or environment, so your hubs only ever see your phones.
- **Pluggable transport.** The protocol runs over a small transport interface. `FakeRadio` runs both ends in memory for tests, and the same seam allows future Web Bluetooth or Node clients (see [TODO](./TODO.md)).
- **Open wire format.** It's documented in [docs/protocol.md](./docs/protocol.md), so a client or hub could be written in another language.

See [docs/use-cases.md](./docs/use-cases.md) for nine scenarios built from these pieces.

## At a glance

```
Hub app (tablet, kiosk, any phone)              Phone app
──────────────────────────────────              ─────────
createPeripheral({ hubId: 'DESK-1' })            createCentral()
  .setState({ screen: 'checkin', … })  ── read ──▶  conn.readState()
  .handle('checkin', handler)          ◀── req ───  conn.request('checkin', { name })
                                       ─── res ──▶  { welcome: 'Hi Anna' }
  .emit('order.ready', …)              ─── evt ──▶  conn.on('event', …)
```

- **iOS and Android, both roles.**
- **Plain BLE.** No iBeacon or Eddystone. The hub sends a normal connectable advertisement with a custom service UUID, which every BLE device supports.
- **Native code is a thin byte pipe.** Framing, messages, sessions and claims are in TypeScript and shared by both platforms, so they can be tested without devices (`FakeRadio`).
- **Content-agnostic.** You define the message types, payloads and hub state. The library just moves them.
- **New Architecture only.** It's a TurboModule (React Native ≥ 0.88; see [TODO](./TODO.md) about older versions).
- **Expo:** it should work in a development build (`expo prebuild`) if you add the permissions below yourself, through `app.json`. That's untested so far. It can't work in Expo Go, which only contains Expo's own native modules. A config plugin is [planned](./TODO.md).

> **Status: 0.x, early.** Tested on real devices iOS ↔ iOS and Android (phone) ↔ iOS (hub). See [TODO.md](./TODO.md) for what's still missing.

## Contents

- [Two roles, one library](#two-roles-one-library)
- [The communication layer](#the-communication-layer)
- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [API](#api)
- [Errors](#errors)
- [Testing without devices](#testing-without-devices)
- [Limits and platform notes](#limits-and-platform-notes)
- [Security](#security)
- More docs: [use cases](./docs/use-cases.md) · [troubleshooting](./docs/troubleshooting.md) · [wire protocol](./docs/protocol.md) · [TODO / roadmap](./TODO.md)

---

## Install

```sh
npm install react-native-ble-link
cd ios && pod install
```

Autolinking picks up the native code. There's no extra setup in `MainApplication` or `AppDelegate`.

### iOS: `Info.plist`

Both roles need a usage description. iOS shows it the first time Bluetooth is used:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Bluetooth lets you connect to the device next to you.</string>
```

### Android: `AndroidManifest.xml`

Declare the permissions for the role(s) your app uses. The library doesn't add any itself.

```xml
<!-- Both roles, Android ≤ 11 -->
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />

<!-- Phone (central) -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<!-- Hub (peripheral) -->
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

Then ask for the runtime permissions before starting:

```ts
import { requestPermissions } from 'react-native-ble-link';

const granted = await requestPermissions('central'); // or 'peripheral'
```

On iOS, `requestPermissions` returns `true` right away. iOS prompts on first use instead.

---

## Quick start

### Hub

```ts
import { createPeripheral, isPeripheralSupported } from 'react-native-ble-link';

type HubState =
  | { screen: 'idle' }
  | { screen: 'checkin'; data: { locationId: string } };

if (!(await isPeripheralSupported())) {
  throw new Error('This device cannot act as a Bluetooth hub');
}

const hub = createPeripheral<HubState>({
  hubId: 'DESK-1',            // ≤ 8 ASCII chars, advertised
  displayName: 'Front desk',  // read after connecting
});

await hub.start();

// What phones see when they connect. newSession: true invalidates requests
// meant for the previous screen.
hub.setState(
  { screen: 'checkin', data: { locationId: 'loc-42' } },
  { newSession: true },
);

hub.handle('checkin', async (body: { name: string }, ctx) => {
  console.log(`${body.name} checked in from ${ctx.centralId}`);
  return { welcome: `Hi ${body.name}` };
});

hub.on('centralConnected', id => console.log('phone connected', id));
hub.on('error', e => console.warn(e));
```

### Phone

```ts
import { createCentral } from 'react-native-ble-link';

const central = createCentral();

const stop = central.scan({
  minRssi: -70,
  onHubs: async hubs => {
    const nearest = hubs[0];              // sorted strongest first
    if (nearest?.hubId !== 'DESK-1') return;
    stop();

    const conn = await central.connect(nearest.deviceId);
    const state = await conn.readState<HubState>(); // also picks up the session
    if (state.screen === 'checkin') {
      const res = await conn.request<{ welcome: string }>('checkin', { name: 'Anna' });
      console.log(res.welcome);
    }
    await conn.disconnect();
  },
});
```

**Call `readState()` before sending requests.** That's how the phone learns the current session ID, and requests carry it. After that, `state.changed` pushes keep it up to date.

---

## Concepts

### Hub ID

Up to 8 printable ASCII characters, broadcast in the advertisement so phones can tell hubs apart before connecting. It doesn't have to be unique: giving every hub of one kind the same ID ("any front-desk tablet") works well with "connect to the nearest".

All hubs and phones using the same **service UUID** see each other. Use different `uuids` per product, or per environment such as staging and production, to keep them apart. See [`createPeripheral`](#createperipheralconfig).

### State

The hub's state is a small JSON object (≤ 512 bytes encoded) that answers "what is this hub doing right now?". It must have a `screen` string and may have `data`.
- Phones can read it at any time with `readState()`.
- Connected phones get a `stateChanged` event whenever the hub calls `setState()`.

The library adds a few fields of its own: `v`, `hubId`, `displayName`, `session`, `claimable` and `claimed`.

Keep it small. Put IDs in the state, not documents, and fetch details from your backend when you need them.

### Requests and events

- **Requests** go phone → hub and always get exactly one reply, or an error/timeout. The hub registers a handler per type with `hub.handle(type, fn)`. Types are any strings except the reserved `link.*` and `session.*`.
- **Events** go hub → phone and get no reply. They're sent with `hub.emit(type, body, centralId?)`, to one phone or to every connected phone.

Messages are JSON, up to 4 KB, split into frames to fit any MTU automatically.

### Sessions

Every `setState(…, { newSession: true })` starts a new **session** with a random ID.
- Requests carry the session they were made for.
- By default, a handler rejects requests for an old session with `SESSION_EXPIRED`. So a phone that read the "pay £12" screen can't complete a payment after the hub has moved on to a different invoice.
- Opt out per handler with `{ requireSession: false }` for things that don't depend on the screen, such as "send me the menu".

### Claims: one phone at a time

A session started with `{ newSession: true, claimable: true }` can be **claimed** by one phone:

```ts
// Hub
hub.setState({ screen: 'payment', data: { invoiceId } }, { newSession: true, claimable: true });
hub.handle('payment.completed', handler, { requireClaim: true });

// Phone
await conn.readState();
await conn.claim();   // others now get SESSION_BUSY
```

- While a session is claimed, *any* session-checked request from another phone fails with `SESSION_BUSY`, not just `requireClaim` handlers.
- A claim belongs to the phone's **client token**, not the BLE connection, so it survives disconnecting and reconnecting, for example while the user is in a payment sheet.
- Claims are released by `conn.release()`, by a new session, or after `claimTtlMs` (default 5 minutes).

Sessions that aren't claimable can be used by many phones at once. That's the normal case for harmless actions like check-ins.

### Connections and concurrency

A hub can be connected to several phones at once: typically 4–10 or more, depending on the Bluetooth chip. Each phone gets its own message channel, and handlers for different phones run concurrently. A connection takes about 0.3–2 s to set up, so for one-off actions, connect, do it, and disconnect.

---

## API

### `createPeripheral(config)`

Creates a hub. Returns `Peripheral<S>`.

| Option | Type | |
|---|---|---|
| `hubId` | `string` | 1–8 printable ASCII chars, advertised |
| `displayName` | `string` | Returned by `info` / `hello` and in the state |
| `uuids?` | `GattUuids` | Service and characteristic UUIDs. Default `DEFAULT_UUIDS`. Use your own per product. |
| `transport?` | `PeripheralTransport` | For tests: `new FakeRadio().createPeripheralTransport()` |

**`Peripheral<S>`**

| Member | |
|---|---|
| `start(): Promise<void>` | Opens the GATT server and starts advertising |
| `stop(): Promise<void>` | Stops advertising, closes the server, drops claims |
| `setState(state: S, options?)` | Options: `newSession`, `claimable`, `claimTtlMs` |
| `getState(): S` | |
| `snapshot: StateSnapshot<S>` | Exactly what phones read |
| `info: HubInfo` | `{ v, hubId, displayName }` |
| `handle(type, handler, options?): () => void` | Registers a request handler. Returns a function that unregisters it. Options: `requireSession` (default `true`), `requireClaim` (default `false`). |
| `emit(type, body, centralId?): Promise<void>` | Sends an event to one phone, or to all subscribed phones |
| `connectedCentrals: string[]` | IDs of connected phones |
| `on(event, listener): () => void` | See the events below |

Handler signature: `(body, ctx) => result | Promise<result>`. `ctx` has `centralId`, `clientToken`, `session` and `isClaimOwner`. Whatever the handler returns becomes the response body. If it throws, the phone gets `HANDLER_ERROR` with the error's message, or the error's own code if it throws a `BleLinkError`.

Events:
- `received (message, centralId)`
- `centralConnected (centralId)` and `centralDisconnected (centralId)`
- `sessionClaimed (clientToken)` and `sessionReleased (clientToken, reason)`, where `reason` is `'released' | 'expired' | 'newSession'`
- `error (error)`

### `createCentral(config?)`

Creates the phone side. Returns `Central`. Options: `uuids?`, `transport?`.

**`Central`**

| Member | |
|---|---|
| `scan({ onHubs, onError?, minRssi? }): () => void` | Calls `onHubs(NearbyHub[])` every 500 ms with hubs sorted by signal, strongest first. Hubs not seen for 5 s drop out. Returns a function that stops the scan. |
| `connect(deviceId, { timeoutMs?, retries? }): Promise<Connection>` | Defaults: 8 s timeout, 1 retry. Stops scanning while connecting. |
| `reconnect({ hubId, deviceIdHint?, scanTimeoutMs? }): Promise<Connection>` | Reconnects to a hub seen before. Tries `deviceIdHint` first, then rescans for `hubId`. Useful after a deliberate disconnect. |
| `connections: Connection[]` | Open connections. Handy for picking one up again after a screen remounts. |
| `getConnection(deviceId): Connection \| undefined` | The open connection to that device, if any |
| `isScanning: boolean` | Whether the radio is scanning. Connecting pauses any scan. |
| `clientToken: string` | Random ID sent with every request; claims belong to it |
| `newClientToken(): string` | Start a fresh identity |
| `destroy(): Promise<void>` | Stops scanning and disconnects everything |
| `on('received', (message, deviceId) => …)` | Everything received on any connection, for logging and debug UI |

`NearbyHub` is `{ deviceId, hubId: string | null, rssi, lastSeen }`. The RSSI is smoothed. `hubId` can be `null` for a moment until the scan response arrives.

**`Connection`**

| Member | |
|---|---|
| `readState<S>(): Promise<StateSnapshot<S>>` | Reads the state and remembers its session |
| `readInfo(): Promise<HubInfo>` / `hello()` | Static hub info, by a characteristic read or a request |
| `request<T>(type, body, { timeoutMs? }): Promise<T>` | Default timeout 10 s |
| `claim()` / `release()` | See [Claims](#claims-one-phone-at-a-time) |
| `disconnect(): Promise<void>` | |
| `deviceId`, `isConnected`, `currentSession` | |
| `on('stateChanged', state => …)` | The hub called `setState` |
| `on('event', (type, body) => …)` | The hub called `emit` |
| `on('disconnected', error => …)` | `error` is `null` for a clean disconnect |
| `on('received', message => …)` | Everything received, for logging |

### Helpers

| | |
|---|---|
| `requestPermissions(role)` / `checkPermissions(role)` | Android runtime permissions for `'central'` or `'peripheral'`. Return `true` on iOS. |
| `getBluetoothState()` | `'poweredOn' \| 'poweredOff' \| 'unauthorized' \| 'unsupported' \| 'resetting' \| 'unknown'` |
| `onBluetoothStateChange(listener): () => void` | |
| `enableBluetooth(): Promise<boolean>` | **Android:** if Bluetooth is off, shows the system "Turn on Bluetooth?" dialog and resolves with the user's answer. On Android 12+ it needs the `BLUETOOTH_CONNECT` permission first. **iOS:** apps can't turn Bluetooth on, so it resolves with whether it's already on. Show your own message pointing to Settings or Control Centre when it isn't. |
| `isPeripheralSupported()` | `false` on Android devices whose chip can't advertise. Always `true` on iOS. |
| `advertisedHubId(scanResult)` | Low-level: extracts the hub ID from a raw scan result |
| `DEFAULT_UUIDS`, `PROTOCOL_VERSION` | |
| `FakeRadio` | In-memory transport for tests, see below |

---

## Errors

Everything the library throws or rejects with is a `BleLinkError` with a `code`:

```ts
import { isBleLinkError } from 'react-native-ble-link';

try {
  await conn.request('payment.completed', body);
} catch (e) {
  if (isBleLinkError(e, 'SESSION_EXPIRED')) showMessage('The hub has moved on');
  else if (isBleLinkError(e, 'SESSION_BUSY')) showMessage('Someone else is using it');
  else throw e;
}
```

| Code | Meaning |
|---|---|
| `SESSION_EXPIRED` | The request was for an older session. Read the state again. |
| `SESSION_BUSY` | Another phone holds the claim |
| `NOT_CLAIMED` | The handler requires a claim and this phone doesn't hold it |
| `NOT_CLAIMABLE` | `claim()` on a session that isn't claimable |
| `UNKNOWN_TYPE` | No handler for that request type |
| `HANDLER_ERROR` | The hub's handler threw |
| `TIMEOUT` | No reply in time |
| `DISCONNECTED` | The connection dropped while waiting |
| `NOT_FOUND` | `reconnect()` didn't find the hub |
| `MESSAGE_TOO_LARGE` | Message > 4 KB, or state > 512 bytes |
| `INVALID_BODY` | Malformed message or frame |
| `UNSUPPORTED_VERSION` | The other side speaks a different protocol version |
| `BLUETOOTH_UNAVAILABLE`, `NATIVE_ERROR` | Errors reported by the platform's Bluetooth stack |

---

## Testing without devices

`FakeRadio` is an in-memory "air" that hubs and phones can share, so you can test your own app logic in Jest:

```ts
import { createCentral, createPeripheral, FakeRadio } from 'react-native-ble-link';

const radio = new FakeRadio();
const hub = createPeripheral({
  hubId: 'T-1',
  displayName: 'Test',
  transport: radio.createPeripheralTransport('hub-1'),
});
const phone = createCentral({ transport: radio.createCentralTransport('phone-1') });

await hub.start();
hub.handle('ping.app', () => ({ ok: true }));
// …scan, connect, request as in the quick start
```

`radio.maxValueLength` (default 20, the smallest MTU) and `radio.rssi` can be changed. `radio.dropConnection(centralId)` simulates a link loss.

In Jest, the TurboModule doesn't exist. If your app imports the library without passing a `transport`, mock the native spec:

```js
jest.mock('react-native-ble-link/src/NativeBleLink', () => ({
  __esModule: true,
  default: {
    getBluetoothState: jest.fn(async () => 'poweredOn'),
    isPeripheralSupported: jest.fn(async () => true),
    enableBluetooth: jest.fn(async () => true),
    onEvent: jest.fn(() => ({ remove: jest.fn() })),
    // …other methods as jest.fn()
  },
}));
```

---

## Limits and platform notes

| | |
|---|---|
| Hub ID | ≤ 8 ASCII chars (it has to fit next to a 128-bit UUID in the 31-byte advertisement) |
| State | ≤ 512 bytes of JSON |
| Message | ≤ 4 KB of JSON |
| Simultaneous phones per hub | Chip-dependent, typically 4–10+ |
| Range | Roughly 1–30 m, depending on devices and walls. Use `minRssi` for "close by". About −65 dBm is "within a metre or two". |
| Speed | Fine for small JSON messages, not for files. Send a URL or ID and fetch the content instead. |

**iOS**
- A hub app must stay **in the foreground**. In the background, iOS strips the local name (the hub ID) from the advertisement. A kiosk under Guided Access is fine.
- Phones scan in the foreground only. Background scanning isn't supported (see [TODO](./TODO.md)).
- On iOS hubs, `centralId` is a per-app random UUID for each phone, not a stable identity.

**Android**
- Some budget tablets can't act as a hub. Check `isPeripheralSupported()`.
- The hub ID goes in the scan response as service data, because Android can't set a per-app local name.
- Connections can fail with the generic GATT error `133`. The library retries.
- Some vendors' battery savers stop Bluetooth for background apps.

---

## Security

The link is **not encrypted or authenticated**. Anyone with a BLE tool (nRF Connect, for example) can scan, connect, read the state and send requests, just like your phone app.

- **Never trust a request on its own for anything that matters.** For example, a "payment completed" request should make the hub *check with your backend or payment provider*, not just show "paid".
- **Never send secrets,** such as access tokens, passwords or card data. Send IDs and one-time references, and let each side talk to your backend with its own credentials.
- **Sessions and claims prevent accidents, not attacks.** They stop the wrong phone or a stale screen from completing an action. They don't stop someone malicious.

Encryption and hub authentication are on the [roadmap](./TODO.md).

---

## Licence

MIT. See [LICENSE](./LICENSE).

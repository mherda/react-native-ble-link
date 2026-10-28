# Wire protocol (v1)

This is what goes over the air between a hub and a phone. You don't need it to use the library. It's for debugging with BLE tools, and for anyone who wants to write a compatible client or hub in something other than React Native, such as native iOS/Android, a web page using Web Bluetooth, or a microcontroller.

Source of truth: [`src/protocol/`](../src/protocol), [`src/peripheral/`](../src/peripheral), [`src/constants.ts`](../src/constants.ts).

---

## 1. Advertising

The hub sends a normal, connectable BLE advertisement:

| Field | Content |
|---|---|
| Flags | `0x06` (LE General Discoverable, BR/EDR not supported) |
| Complete list of 128-bit service UUIDs | The **service UUID** (default `6E1A0001-4B7C-4F5E-9A2D-3C8B1F0E7D21`) |
| **iOS hub:** Complete local name | The **hub ID**, e.g. `DESK-1` (iOS may move it to the scan response) |
| **Android hub:** service data for the service UUID (scan response) | The hub ID as UTF-8 bytes |

Phones filter scans by the service UUID. They read the hub ID from the service data if present, otherwise from the local name (`advertisedHubId()`). The hub ID is limited to 8 ASCII chars, because it has to fit with the 128-bit UUID into 31 bytes.

---

## 2. GATT layout

One primary service with four characteristics. All UUIDs can be configured; the defaults are:

| Characteristic | Default UUID | Properties | Content |
|---|---|---|---|
| `info` | `6E1A0002-…` | Read | UTF-8 JSON `{ "v": 1, "hubId": "…", "displayName": "…" }`. Fixed while the hub runs. |
| `state` | `6E1A0003-…` | Read | UTF-8 JSON state snapshot (§5), ≤ 512 bytes |
| `rx` | `6E1A0004-…` | Write (with response) | Phone → hub frames (§3) |
| `tx` | `6E1A0005-…` | Notify (+ CCCD `0x2902`) | Hub → phone frames (§3) |

`info` and `state` are plain reads. Values longer than one packet are fetched with read offsets, which the platforms' GATT clients do automatically.

A client has to **subscribe to `tx`** (write `01 00` to its CCCD) before sending requests, or it won't get the replies. The hub treats the subscription as "this phone is connected".

---

## 3. Framing on `rx` / `tx`

Every message is UTF-8 JSON, up to **4096 bytes**, split into frames that each fit in one write or notification (`MTU − 3` bytes):

```
byte 0     messageId    0–255, rolling, per direction per connection
byte 1     chunkIndex   0-based
byte 2     chunkCount   1–255
byte 3…    payload slice
```

- With the default MTU of 23, each frame carries 17 bytes of payload. With a typical negotiated MTU of 185, it carries 179.
- Frames are sent strictly in order, one message at a time per direction. GATT preserves ordering on a characteristic, so the receiver expects `chunkIndex` 0, 1, 2… of one `messageId`. When it has `chunkCount` of them, it parses the JSON.
- A frame with `chunkIndex` 0 always starts a new message and discards any incomplete one.
- A frame that's out of sequence (wrong `messageId`, `chunkCount` or index) drops the partial message.
- A message that hasn't completed within **2 s** of its first frame is dropped.

---

## 4. Envelopes

Every reassembled message is a JSON object with `v` (protocol version, currently `1`) and `kind`.

**Request (phone → hub)**

```json
{
  "v": 1,
  "kind": "req",
  "id": "a1b2c3d4",
  "type": "checkin",
  "session": "9b2e…",
  "client": "5f0c…",
  "body": { "name": "Anna" }
}
```

| Field | |
|---|---|
| `id` | Random string, unique per pending request on this connection. The reply echoes it in `re`. |
| `type` | Request type. `link.*` and `session.*` are reserved. |
| `session` | Session ID from the last state the phone read, or `null` |
| `client` | The phone's client token: a random string that stays the same across reconnects. Claims belong to it. |
| `body` | Any JSON |

**Response (hub → phone)**, exactly one per request:

```json
{ "v": 1, "kind": "res", "re": "a1b2c3d4", "ok": true, "body": { "welcome": "Hi Anna" } }
{ "v": 1, "kind": "res", "re": "a1b2c3d4", "ok": false, "error": { "code": "SESSION_EXPIRED", "message": "…" } }
```

**Event (hub → phone)**, with no reply:

```json
{ "v": 1, "kind": "evt", "type": "state.changed", "body": { …state snapshot… } }
```

If `v` doesn't match, the receiver responds with `UNSUPPORTED_VERSION` when it can tell the request ID, and otherwise ignores the message.

---

## 5. State snapshot

The app's state plus fields added by the library:

```json
{
  "screen": "payment",
  "data": { "invoiceId": "INV-48213" },
  "v": 1,
  "hubId": "DESK-1",
  "displayName": "Front desk",
  "session": "9b2e7c…",
  "claimable": true,
  "claimed": false
}
```

The hub serves it on the `state` characteristic. It also sends it as a `state.changed` event to every subscribed phone whenever it changes, including when a claim is taken or released.

---

## 6. Built-in requests

| Type | Body | Reply | Notes |
|---|---|---|---|
| `link.hello` | `null` | `info` JSON | Same as reading `info` |
| `link.ping` | `null` | `{ "pong": true }` | |
| `session.claim` | `null` | `{ "claimed": true }` | Errors: `SESSION_EXPIRED` (wrong `session`), `NOT_CLAIMABLE`, `SESSION_BUSY` |
| `session.release` | `null` | `{ "released": boolean }` | `false` if this client doesn't hold the claim |

---

## 7. Hub-side checks for app requests

When a request arrives for an app-registered type, the hub checks, in order:

1. **Is there a handler for the type?** If not, `UNKNOWN_TYPE`.
2. If the handler has `requireSession` (the default):
   - `session` ≠ the current session → `SESSION_EXPIRED`;
   - the session is claimed by another `client` → `SESSION_BUSY`.
3. If the handler has `requireClaim` and this `client` doesn't hold the claim → `NOT_CLAIMED`.
4. Run the handler:
   - return value → `ok: true` with that body;
   - it throws → `HANDLER_ERROR`, or the code of a thrown `BleLinkError`.

A claim lasts until:
- the owner releases it;
- a new session starts;
- or its time limit runs out (default 5 minutes).

It's tied to the `client` token, not the connection, so it survives a reconnect.

---

## 8. Versioning

`v` is bumped for incompatible changes to framing, envelopes or built-ins. New request or event types, or new state fields, don't bump it. Both sides should ignore unknown fields.

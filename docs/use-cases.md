# Example use cases

These are patterns the library fits, each with the features it uses and a code sketch. The sketches leave out error handling, permissions and UI. See the [README](../README.md) for the full API.

The common shape is **a device that stays in one place, or one person's device, plus phones that come close and want to do something with it**, where:
- the exchange is small JSON;
- the phone app is open;
- you don't want pairing, QR codes or a server round trip just to find out "which device am I next to?".

| # | Use case | State | Requests | Events | Claims |
|---|---|---|---|---|---|
| 1 | [Check-in at a desk or room](#1-check-in-at-a-desk-or-room) | ✓ | ✓ | | |
| 2 | [Pay at the counter](#2-pay-at-the-counter) | ✓ | ✓ | | ✓ |
| 3 | [Hand off a booking to a kiosk](#3-hand-off-a-booking-to-a-kiosk) | ✓ | ✓ | | ✓ |
| 4 | ["Your order is ready" pager](#4-your-order-is-ready-pager) | | ✓ | ✓ | |
| 5 | [Exhibit or room info](#5-exhibit-or-room-info) | ✓ | | ✓ | |
| 6 | [Attendance in a class or meeting](#6-attendance-in-a-class-or-meeting) | ✓ | ✓ | | |
| 7 | [Set up a device from a staff phone](#7-set-up-a-device-from-a-staff-phone) | ✓ | ✓ | | ✓ |
| 8 | [Local multiplayer or a live poll](#8-local-multiplayer-or-a-live-poll) | ✓ | ✓ | ✓ | |
| 9 | [Unlock a door or locker](#9-unlock-a-door-or-locker) | ✓ | ✓ | | ✓ |

---

## 1. Check-in at a desk or room

A tablet at reception, a meeting room or a gym door. A member walks up with the app open, the phone connects to the nearest hub automatically, and one tap checks them in.

- **Many phones at once:** the session isn't claimable, so anyone in range can check in at the same time.
- **Location without a lookup:** the state says *where* the hub is, so the phone knows which location it's checking in to.

```ts
// Hub
hub.setState({ screen: 'checkin', data: { locationId: 'gym-3' } }, { newSession: true });
hub.handle('checkin', async ({ memberId }, ctx) => {
  await api.recordCheckIn(memberId, 'gym-3');   // hub's own backend call
  return { welcome: await api.memberName(memberId) };
});

// Phone: auto-connect to the nearest hub with this ID when it's close
central.scan({
  minRssi: -65,
  onHubs: async ([nearest]) => {
    if (nearest?.hubId !== 'GYM') return;
    const conn = await central.connect(nearest.deviceId);
    const state = await conn.readState();
    // show "Check in at Gym 3?" → on tap:
    await conn.request('checkin', { memberId: me.id });
  },
});
```

**Watch out:** on its own, `memberId` from the phone is just a claim. If check-ins matter, have the phone send a short-lived signed token from your backend instead (see [Security](../README.md#security)).

---

## 2. Pay at the counter

The hub shows an invoice and the customer pays on their own phone. The hub then says "paid, come in".

- **Claims** keep a second phone in the queue from paying the same invoice, or completing it.
- **Sessions** stop a payment for the previous customer's invoice from landing on the next one.

```ts
// Hub
hub.setState(
  { screen: 'payment', data: { invoiceId } },
  { newSession: true, claimable: true, claimTtlMs: 3 * 60_000 },
);
hub.handle('payment.completed', async ({ paymentRef }) => {
  const ok = await api.verifyPayment(invoiceId, paymentRef);   // never trust the phone
  if (ok) hub.setState({ screen: 'paid' }, { newSession: true });
  return { confirmed: ok };
}, { requireClaim: true });

// Phone
const conn = await central.connect(deviceId);
const { session, data } = await conn.readState();
await conn.claim();                       // others now see "busy"
await conn.disconnect();                  // the payment sheet can take a while
const paymentRef = await payments.pay(data.invoiceId);
const again = await central.reconnect({ hubId: 'DESK-1', deviceIdHint: deviceId });
if ((await again.readState()).session !== session) throw new Error('Moved on');
await again.request('payment.completed', { paymentRef });
```

**Watch out:**
- Claim at "Pay", not when the screen opens, or someone who backs out holds up the queue until the claim expires.
- Start a new session once the invoice is paid.

## 3. Hand off a booking to a kiosk

The customer has a booking in the app. Standing at a kiosk, they "send" it, and the kiosk takes over: print a badge, show directions, open a gate.

```ts
// Hub (kiosk)
hub.setState({ screen: 'welcome' }, { newSession: true, claimable: true });
hub.handle('booking.present', async ({ bookingRef }) => {
  const booking = await api.redeemBookingRef(bookingRef);   // one-time ref, not the user's login
  hub.setState({ screen: 'badge', data: { name: booking.guestName } }, { newSession: true });
  return { ok: true };
}, { requireClaim: true });

// Phone
await conn.readState();
await conn.claim();
const bookingRef = await api.createOneTimeRef(bookingId);    // phone's own backend call
await conn.request('booking.present', { bookingRef });
```

## 4. "Your order is ready" pager

Replaces buzzer pagers in a café or a pickup counter. The customer's phone stays connected while they wait, and the hub pushes an event to that one phone when the order is ready.

- **Events to one phone:** `emit(type, body, centralId)`.
- **Long-lived connections:** the hub can only hold a handful of them, so this suits a few waiting customers, not a stadium.

```ts
// Hub
const waiting = new Map<string, string>();   // orderId → centralId
hub.handle('order.wait', ({ orderId }, ctx) => {
  waiting.set(orderId, ctx.centralId);
  return { position: waiting.size };
}, { requireSession: false });
function orderReady(orderId: string) {
  const centralId = waiting.get(orderId);
  if (centralId) void hub.emit('order.ready', { orderId }, centralId);
}

// Phone
await conn.request('order.wait', { orderId });
conn.on('event', (type, body) => {
  if (type === 'order.ready') notifyUser('Your order is ready');
});
conn.on('disconnected', () => central.reconnect({ hubId: 'CAFE' }));
```

**Watch out:** iOS only keeps the connection while the app is in the foreground (see [TODO: background mode](../TODO.md)).

## 5. Exhibit or room info

A tablet next to an exhibit, a product display or a meeting room. Phones nearby show what's on it right now, such as the current talk, the next meeting, or today's specials, and update live as it changes. This is read-only: no requests needed.

```ts
// Hub
hub.setState({ screen: 'talk', data: { talkId: 't-17', title: 'BLE in practice' } });

// Phone
const conn = await central.connect(deviceId);
render(await conn.readState());
conn.on('stateChanged', render);       // live updates while connected
```

**Watch out:** for content that's the same for everyone and doesn't need to be live, a plain iBeacon or Eddystone tag is cheaper and doesn't need connections. This library fits when the content changes or the phone needs to act on it.

## 6. Attendance in a class or meeting

The teacher's or organiser's phone or tablet is the hub. Attendees' phones register themselves, so being physically close is part of the proof.

- Rotate the session every 30–60 s with `setState(…, { newSession: true })`. A session ID copied to someone outside the room then quickly stops working.
- Include the session in what the attendee's phone signs with its backend token. The backend can then tie the attendance to the room at that time.

```ts
// Hub
setInterval(() => hub.setState({ screen: 'attendance', data: { classId } }, { newSession: true }), 45_000);
hub.handle('attend', async ({ proof }, ctx) => api.recordAttendance(classId, proof, ctx.session));

// Phone
const { session } = await conn.readState();
const proof = await api.signAttendance(classId, session);   // backend signs with the user's identity
await conn.request('attend', { proof });
```

## 7. Set up a device from a staff phone

A new tablet or kiosk boots into "unconfigured". A staff member's phone connects and sends its configuration: location, display name, environment. This replaces typing settings on a kiosk screen.

```ts
// Hub (unconfigured device)
hub.setState({ screen: 'setup' }, { newSession: true, claimable: true, claimTtlMs: 10 * 60_000 });
hub.handle('setup.apply', async ({ enrolmentCode }) => {
  const config = await api.enrolDevice(enrolmentCode);       // backend decides the config
  await saveConfig(config);
  return { ok: true };
}, { requireClaim: true });

// Staff phone
await conn.readState();
await conn.claim();
await conn.request('setup.apply', { enrolmentCode: await api.createEnrolmentCode(site) });
```

**Watch out:** send a short-lived enrolment code, not credentials. The device then fetches its real configuration from your backend.

## 8. Local multiplayer or a live poll

One device hosts a quiz, a poll or a party game, and players join with their phones nearby. The hub's state is the current question. Answers are requests, and results are pushed as events to all players.

```ts
// Hub
hub.setState({ screen: 'question', data: { q: 3, text: 'Which planet…?', options } }, { newSession: true });
hub.handle('answer', ({ option }, ctx) => {
  answers.set(ctx.clientToken, option);    // one answer per player
  return { accepted: true };
});
void hub.emit('round.result', { correct: 2, scores });   // to every connected player

// Phone
conn.on('stateChanged', showQuestion);
conn.on('event', (type, body) => type === 'round.result' && showResult(body));
await conn.request('answer', { option: 2 });
```

**Watch out:** this is limited to the hub's simultaneous connection count (often 4–10). For bigger audiences, use a server.

## 9. Unlock a door or locker

A tablet or a phone mounted by a door, a locker bank or a vending machine acts as the hub. The user's phone asks it to unlock.

- Proximity: only phones that are physically close can connect.
- Exclusivity: a claim, so two people don't open the same locker.
- **Your backend decides who may unlock.** The hub only carries it out.

```ts
// Hub
hub.setState({ screen: 'locker-bank', data: { bankId } }, { newSession: true, claimable: true });
hub.handle('unlock', async ({ grant }) => {
  const { lockerId } = await api.redeemUnlockGrant(grant, bankId);   // single-use, short-lived
  await hardware.open(lockerId);
  return { opened: lockerId };
}, { requireClaim: true });

// Phone
await conn.readState();
await conn.claim();
const grant = await api.requestUnlockGrant(bookingId);   // user's own backend call
await conn.request('unlock', { grant });
```

**Watch out:** without encryption, someone nearby could record a grant. That's why it must be single-use and expire within seconds. End-to-end protection is on the [roadmap](../TODO.md).

---

## When *not* to use it

- **Broadcasting to crowds or tracking indoor positions:** use iBeacon or Eddystone tags. They need no connections and have no limit on listeners.
- **Waking the app in the background on iOS:** use iBeacon region monitoring, possibly as well as this library (see [TODO](../TODO.md)).
- **Large data, such as photos, files or long lists:** send an ID and fetch the content over the internet.
- **Talking to existing BLE hardware,** such as heart-rate straps, locks or beacon tags: use a general BLE library such as `react-native-ble-plx`. This library only talks to itself.
- **Anything secret, without your own end-to-end protection:** see [Security](../README.md#security).

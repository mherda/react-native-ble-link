# Changelog

## 0.1.0 (unreleased)

First version, extracted from the `ble-beacons` demo apps.

- Hub (`createPeripheral`) and phone (`createCentral`) roles on iOS and Android, as a TurboModule (New Architecture).
- Framed JSON messages up to 4 KB over any MTU; requests, responses and events.
- Hub state with live `stateChanged` pushes, sessions and exclusive claims.
- `FakeRadio` in-memory transport for tests.
- Renamed from the demo's `tabletId` / `NearbyTablet` / `TabletInfo` / `advertisedTabletId` / `onTablets` to `hubId` / `NearbyHub` / `HubInfo` / `advertisedHubId` / `onHubs`.
- New error code `NOT_CLAIMABLE` for claiming a session that isn't claimable (was `INVALID_BODY`).

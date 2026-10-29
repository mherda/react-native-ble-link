# Example app

An Expo (SDK 58) app that can act as either side of the link. Pick a role with the switch at the top:
- **Phone:** scan, connect to a hub, read its state live, send any request, claim/release, and see events.
- **Hub:** advertise, edit the state, start new sessions, make the session claimable, push an event, and see what phones send.

It uses the library from the repo root (`"react-native-ble-link": "file:.."`) and sets it up with the [config plugin](../README.md#expo) in `app.json`, the same way an app installing it from npm would.

The hub answers three request types:

| Type | Reply | Needs the current session |
|---|---|---|
| `echo` | The request body | no |
| `time` | `{ "now": "<ISO time>" }` | no |
| `counter` | `{ "value": n }`, counting up | yes |

Both roles use the default UUIDs, so the example also works with any other app built on the library, such as a hub app on a tablet.

## Run it

Bluetooth needs real devices: the iOS Simulator and Android emulators have none. You'll need two devices, one per role.

```sh
cd example
npm install
npm run android      # or: npm run ios
```

`npm run android` / `ios` runs `expo run`, which generates the native projects (`ios/`, `android/`, not committed), builds, installs and starts Metro.
- To build for an iPhone, set your signing team: `npx expo run:ios --device` will ask for it.
- The first build takes a few minutes.

After changing the plugin or `app.json`, regenerate the native projects with `npm run prebuild`.

## Working on the library

Metro watches the repo root, so edits to `../src` reload in the app straight away. Changes to native code (`../ios`, `../android`) need a rebuild (`npm run android` / `ios`). `metro.config.js` makes sure the root's own `node_modules` isn't bundled, so there's only one copy of React.

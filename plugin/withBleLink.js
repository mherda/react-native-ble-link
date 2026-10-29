// Expo config plugin: adds the iOS usage description and the Android
// permissions each role needs. Used from app.json:
//
//   "plugins": [["react-native-ble-link", { "roles": ["central"] }]]
//
// The edits are plain functions over Info.plist / AndroidManifest objects so
// they can be tested without Expo; only `withBleLink` needs config-plugins.

/**
 * @typedef {'central' | 'peripheral'} Role
 * @typedef {{
 *   roles?: Role[],
 *   bluetoothAlwaysPermission?: string | false,
 *   neverForLocation?: boolean,
 *   isBleRequired?: boolean,
 * }} BleLinkPluginOptions
 */

const DEFAULT_PERMISSION_TEXT =
  'Allow $(PRODUCT_NAME) to connect to nearby devices using Bluetooth.';
const ROLES = ['central', 'peripheral'];

/** @param {BleLinkPluginOptions | undefined} options */
function resolveOptions(options = {}) {
  const roles = options.roles ?? ROLES;
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(r => !ROLES.includes(r))) {
    throw new Error(
      `react-native-ble-link plugin: "roles" must be a non-empty array of ${ROLES.map(r => `"${r}"`).join(' / ')}`,
    );
  }
  return {
    roles,
    bluetoothAlwaysPermission: options.bluetoothAlwaysPermission ?? DEFAULT_PERMISSION_TEXT,
    neverForLocation: options.neverForLocation ?? true,
    isBleRequired: options.isBleRequired ?? false,
  };
}

/** Sets NSBluetoothAlwaysUsageDescription unless the app already has its own text. */
function applyInfoPlist(infoPlist, options) {
  const { bluetoothAlwaysPermission } = resolveOptions(options);
  if (bluetoothAlwaysPermission !== false && !infoPlist.NSBluetoothAlwaysUsageDescription) {
    infoPlist.NSBluetoothAlwaysUsageDescription = bluetoothAlwaysPermission;
  }
  return infoPlist;
}

/**
 * The <uses-permission> entries for the chosen roles, as manifest attributes.
 * Matches the README's manual setup.
 */
function permissionsFor(options) {
  const { roles, neverForLocation } = resolveOptions(options);
  const P = 'android.permission.';
  const list = [
    { 'android:name': P + 'BLUETOOTH', 'android:maxSdkVersion': '30' },
    { 'android:name': P + 'BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' },
    { 'android:name': P + 'BLUETOOTH_CONNECT' },
  ];
  if (roles.includes('central')) {
    // Android ≤ 11 needs location to scan. With neverForLocation we promise
    // not to derive location, so 12+ doesn't need it at all.
    list.push(
      neverForLocation
        ? { 'android:name': P + 'ACCESS_FINE_LOCATION', 'android:maxSdkVersion': '30' }
        : { 'android:name': P + 'ACCESS_FINE_LOCATION' },
      neverForLocation
        ? { 'android:name': P + 'BLUETOOTH_SCAN', 'android:usesPermissionFlags': 'neverForLocation' }
        : { 'android:name': P + 'BLUETOOTH_SCAN' },
    );
  }
  if (roles.includes('peripheral')) {
    list.push({ 'android:name': P + 'BLUETOOTH_ADVERTISE' });
  }
  return list;
}

/** Adds permissions and the bluetooth_le feature, replacing any existing entries for them. */
function applyAndroidManifest(androidManifest, options) {
  const { isBleRequired } = resolveOptions(options);
  const manifest = androidManifest.manifest;

  const wanted = permissionsFor(options);
  const names = new Set(wanted.map(p => p['android:name']));
  manifest['uses-permission'] = [
    ...(manifest['uses-permission'] ?? []).filter(p => !names.has(p.$?.['android:name'])),
    ...wanted.map(attributes => ({ $: attributes })),
  ];

  const feature = 'android.hardware.bluetooth_le';
  manifest['uses-feature'] = [
    ...(manifest['uses-feature'] ?? []).filter(f => f.$?.['android:name'] !== feature),
    { $: { 'android:name': feature, 'android:required': String(isBleRequired) } },
  ];
  return androidManifest;
}

// Resolve config-plugins from the app when the library is linked from
// elsewhere (npm `file:` installs, monorepos), where a plain require fails.
function loadConfigPlugins() {
  try {
    return require('expo/config-plugins');
  } catch {
    return require(require.resolve('expo/config-plugins', { paths: [process.cwd()] }));
  }
}

/** @type {(config: any, options?: BleLinkPluginOptions) => any} */
function withBleLink(config, options) {
  resolveOptions(options); // fail early on bad options
  const { withInfoPlist, withAndroidManifest, createRunOncePlugin } = loadConfigPlugins();
  const plugin = (cfg, opts) => {
    cfg = withInfoPlist(cfg, c => {
      c.modResults = applyInfoPlist(c.modResults, opts);
      return c;
    });
    return withAndroidManifest(cfg, c => {
      c.modResults = applyAndroidManifest(c.modResults, opts);
      return c;
    });
  };
  const pkg = require('../package.json');
  return createRunOncePlugin(plugin, pkg.name, pkg.version)(config, options);
}

module.exports = withBleLink;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.permissionsFor = permissionsFor;

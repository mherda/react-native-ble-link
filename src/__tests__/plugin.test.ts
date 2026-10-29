// The Expo config plugin's edits, tested on plain objects (no Expo needed).
const plugin = require('../../plugin/withBleLink');

type Entry = { $: Record<string, string> };
type Manifest = { manifest: { 'uses-permission'?: Entry[]; 'uses-feature'?: Entry[] } };

const P = 'android.permission.';
const names = (m: Manifest) => (m.manifest['uses-permission'] ?? []).map(p => p.$['android:name']);
const entry = (m: Manifest, name: string) =>
  m.manifest['uses-permission']?.find(p => p.$['android:name'] === P + name)?.$;
const emptyManifest = (): Manifest => ({ manifest: {} });

describe('Expo config plugin', () => {
  it('adds permissions for both roles by default', () => {
    const m = plugin.applyAndroidManifest(emptyManifest());
    expect(names(m).sort()).toEqual(
      [
        'ACCESS_FINE_LOCATION',
        'BLUETOOTH',
        'BLUETOOTH_ADMIN',
        'BLUETOOTH_ADVERTISE',
        'BLUETOOTH_CONNECT',
        'BLUETOOTH_SCAN',
      ].map(n => P + n),
    );
    expect(entry(m, 'BLUETOOTH_SCAN')).toEqual({
      'android:name': P + 'BLUETOOTH_SCAN',
      'android:usesPermissionFlags': 'neverForLocation',
    });
    expect(entry(m, 'ACCESS_FINE_LOCATION')?.['android:maxSdkVersion']).toBe('30');
    expect(m.manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } },
    ]);
  });

  it('only adds what each role needs', () => {
    const hub = plugin.applyAndroidManifest(emptyManifest(), { roles: ['peripheral'] });
    expect(names(hub)).toContain(P + 'BLUETOOTH_ADVERTISE');
    expect(names(hub)).not.toContain(P + 'BLUETOOTH_SCAN');
    expect(names(hub)).not.toContain(P + 'ACCESS_FINE_LOCATION');

    const phone = plugin.applyAndroidManifest(emptyManifest(), { roles: ['central'] });
    expect(names(phone)).toContain(P + 'BLUETOOTH_SCAN');
    expect(names(phone)).not.toContain(P + 'BLUETOOTH_ADVERTISE');
  });

  it('keeps location on all versions without neverForLocation', () => {
    const m = plugin.applyAndroidManifest(emptyManifest(), {
      roles: ['central'],
      neverForLocation: false,
    });
    expect(entry(m, 'ACCESS_FINE_LOCATION')?.['android:maxSdkVersion']).toBeUndefined();
    expect(entry(m, 'BLUETOOTH_SCAN')?.['android:usesPermissionFlags']).toBeUndefined();
  });

  it('replaces existing entries instead of duplicating them, and keeps others', () => {
    const m: Manifest = {
      manifest: {
        'uses-permission': [
          { $: { 'android:name': P + 'INTERNET' } },
          { $: { 'android:name': P + 'BLUETOOTH_SCAN' } },
        ],
        'uses-feature': [{ $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'true' } }],
      },
    };
    plugin.applyAndroidManifest(m, { roles: ['central'], isBleRequired: true });
    plugin.applyAndroidManifest(m, { roles: ['central'], isBleRequired: true });
    expect(names(m).filter(n => n === P + 'BLUETOOTH_SCAN')).toHaveLength(1);
    expect(names(m)).toContain(P + 'INTERNET');
    expect(m.manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'true' } },
    ]);
  });

  it('sets the iOS usage description, without overwriting the app’s own', () => {
    expect(plugin.applyInfoPlist({}).NSBluetoothAlwaysUsageDescription).toMatch(/Bluetooth/);
    expect(
      plugin.applyInfoPlist({}, { bluetoothAlwaysPermission: 'Find the desk' })
        .NSBluetoothAlwaysUsageDescription,
    ).toBe('Find the desk');
    expect(
      plugin.applyInfoPlist({ NSBluetoothAlwaysUsageDescription: 'Mine' })
        .NSBluetoothAlwaysUsageDescription,
    ).toBe('Mine');
    expect(plugin.applyInfoPlist({}, { bluetoothAlwaysPermission: false })).toEqual({});
  });

  it('rejects invalid roles', () => {
    expect(() => plugin.applyAndroidManifest(emptyManifest(), { roles: [] })).toThrow(/roles/);
    expect(() => plugin.applyAndroidManifest(emptyManifest(), { roles: ['hub'] })).toThrow(/roles/);
  });
});

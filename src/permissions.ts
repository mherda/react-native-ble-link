import { PermissionsAndroid, Platform, type Permission } from 'react-native';

export type Role = 'peripheral' | 'central';

/**
 * Android runtime permissions per role. iOS has no runtime request: the system
 * prompts on first Bluetooth use (NSBluetoothAlwaysUsageDescription).
 */
function androidPermissions(role: Role): Permission[] {
  const P = PermissionsAndroid.PERMISSIONS;
  if (Number(Platform.Version) >= 31) {
    return role === 'peripheral'
      ? [P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT]
      : [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT];
  }
  // Android ≤ 11 needs location to scan; advertising needs nothing at runtime.
  return role === 'central' ? [P.ACCESS_FINE_LOCATION] : [];
}

export async function checkPermissions(role: Role): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const results = await Promise.all(
    androidPermissions(role).map(p => PermissionsAndroid.check(p)),
  );
  return results.every(Boolean);
}

export async function requestPermissions(role: Role): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const permissions = androidPermissions(role);
  if (permissions.length === 0) return true;
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every(p => results[p] === PermissionsAndroid.RESULTS.GRANTED);
}

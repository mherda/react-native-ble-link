import {
  enableBluetooth,
  getBluetoothState,
  requestPermissions,
  type Role,
} from 'react-native-ble-link';

/**
 * Permissions, then Bluetooth on. Returns null when ready, otherwise a reason
 * to show the user.
 */
export async function prepareBluetooth(role: Role): Promise<string | null> {
  if (!(await requestPermissions(role))) {
    return 'Bluetooth permission was denied. Allow it in Settings.';
  }
  const state = await getBluetoothState();
  if (state === 'poweredOn') return null;
  if (state === 'poweredOff') {
    // Android shows the system dialog; iOS can only report.
    return (await enableBluetooth()) ? null : 'Bluetooth is off. Turn it on in Settings or Control Centre.';
  }
  if (state === 'unauthorized') return 'Bluetooth access is not allowed for this app.';
  if (state === 'unsupported') return "This device doesn't support Bluetooth LE.";
  return `Bluetooth isn't ready yet (${state}). Try again in a moment.`;
}

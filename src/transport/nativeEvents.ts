/**
 * Events emitted by native code through `NativeBleLink.onEvent`.
 * `payload` is JSON; binary `value` fields are base64.
 *
 * | type                     | payload                                                       |
 * |--------------------------|---------------------------------------------------------------|
 * | bluetoothState           | { state: BluetoothState }                                     |
 * | peripheral.subscribed    | { centralId, maxValueLength }  central enabled notify on tx   |
 * | peripheral.mtu           | { centralId, maxValueLength }  Android only, MTU changed      |
 * | peripheral.write         | { centralId, value }           write to rx                    |
 * | peripheral.disconnected  | { centralId }                  disconnect or unsubscribe      |
 * | central.scanResult       | { deviceId, name, rssi, serviceData }  name/serviceData may be null |
 * | central.notification     | { deviceId, value }            notification on tx             |
 * | central.disconnected     | { deviceId, error }            error may be null              |
 * | error                    | { message }                                                   |
 */
export type BluetoothState =
  | 'unknown'
  | 'resetting'
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'poweredOn';

export type NativeEventMap = {
  'bluetoothState': { state: BluetoothState };
  'peripheral.subscribed': { centralId: string; maxValueLength: number };
  'peripheral.mtu': { centralId: string; maxValueLength: number };
  'peripheral.write': { centralId: string; value: string };
  'peripheral.disconnected': { centralId: string };
  'central.scanResult': {
    deviceId: string;
    name: string | null;
    rssi: number;
    serviceData: string | null;
  };
  'central.notification': { deviceId: string; value: string };
  'central.disconnected': { deviceId: string; error: string | null };
  'error': { message: string };
};

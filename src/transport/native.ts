import NativeBleLink from '../NativeBleLink';
import { BleLinkError } from '../errors';
import { base64Decode, base64Encode } from '../protocol/codec';
import type { BluetoothState, NativeEventMap } from './nativeEvents';
import type {
  CentralTransport,
  CentralTransportEvent,
  GattUuids,
  PeripheralTransport,
  PeripheralTransportEvent,
} from './types';

type AnyNativeEvent = {
  [K in keyof NativeEventMap]: { type: K; payload: NativeEventMap[K] };
}[keyof NativeEventMap];

type NativeListener = (event: AnyNativeEvent) => void;

const listeners = new Set<NativeListener>();
let subscription: { remove(): void } | null = null;

function addNativeListener(listener: NativeListener): () => void {
  listeners.add(listener);
  if (!subscription) {
    subscription = NativeBleLink.onEvent(({ type, payload }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const event = { type, payload: parsed } as AnyNativeEvent;
      listeners.forEach(l => l(event));
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscription) {
      subscription.remove();
      subscription = null;
    }
  };
}

/** Maps native promise rejections (codes like E_TIMEOUT) to BleLinkError. */
async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = (error as Error).message ?? String(error);
    switch (code) {
      case 'E_TIMEOUT':
        throw new BleLinkError('TIMEOUT', message);
      case 'E_NOT_CONNECTED':
        throw new BleLinkError('DISCONNECTED', message);
      case 'E_NOT_FOUND':
        throw new BleLinkError('NOT_FOUND', message);
      case 'E_BLUETOOTH_OFF':
      case 'E_UNAUTHORIZED':
      case 'E_UNSUPPORTED':
        throw new BleLinkError('BLUETOOTH_UNAVAILABLE', message);
      default:
        throw new BleLinkError('NATIVE_ERROR', message);
    }
  }
}

export function getBluetoothState(): Promise<BluetoothState> {
  return NativeBleLink.getBluetoothState() as Promise<BluetoothState>;
}

/**
 * Android: shows the system "turn on Bluetooth?" dialog if it's off, and
 * resolves with whether the user agreed. `onBluetoothStateChange` reports
 * `poweredOn` shortly after. iOS can't do this: it resolves with whether
 * Bluetooth is already on, so show your own prompt when it isn't.
 */
export function enableBluetooth(): Promise<boolean> {
  return call(NativeBleLink.enableBluetooth());
}

export function isPeripheralSupported(): Promise<boolean> {
  return NativeBleLink.isPeripheralSupported();
}

export function onBluetoothStateChange(
  listener: (state: BluetoothState) => void,
): () => void {
  return addNativeListener(event => {
    if (event.type === 'bluetoothState') {
      listener(event.payload.state);
    }
  });
}

export function createNativePeripheralTransport(): PeripheralTransport {
  return {
    start: (uuids: GattUuids, advertisedId: string, info: Uint8Array) =>
      call(NativeBleLink.peripheralStart(uuids, advertisedId, base64Encode(info))),
    stop: () => call(NativeBleLink.peripheralStop()),
    setState: (value: Uint8Array) =>
      NativeBleLink.peripheralSetState(base64Encode(value)),
    notify: (centralId: string, value: Uint8Array) =>
      call(NativeBleLink.peripheralNotify(centralId, base64Encode(value))),
    addListener: (listener: (event: PeripheralTransportEvent) => void) =>
      addNativeListener(event => {
        switch (event.type) {
          case 'bluetoothState':
            listener({ type: 'bluetoothState', state: event.payload.state });
            break;
          case 'peripheral.subscribed':
            listener({ type: 'subscribed', ...event.payload });
            break;
          case 'peripheral.mtu':
            listener({ type: 'mtu', ...event.payload });
            break;
          case 'peripheral.write':
            listener({
              type: 'write',
              centralId: event.payload.centralId,
              value: base64Decode(event.payload.value),
            });
            break;
          case 'peripheral.disconnected':
            listener({ type: 'disconnected', centralId: event.payload.centralId });
            break;
          case 'error':
            listener({ type: 'error', message: event.payload.message });
            break;
        }
      }),
  };
}

export function createNativeCentralTransport(): CentralTransport {
  return {
    startScan: (serviceUuid: string) =>
      call(NativeBleLink.centralStartScan(serviceUuid)),
    stopScan: () => call(NativeBleLink.centralStopScan()),
    connect: (deviceId: string, uuids: GattUuids, timeoutMs: number) =>
      call(NativeBleLink.centralConnect(deviceId, uuids, timeoutMs)),
    disconnect: (deviceId: string) =>
      call(NativeBleLink.centralDisconnect(deviceId)),
    read: async (deviceId: string, characteristicUuid: string) =>
      base64Decode(await call(NativeBleLink.centralRead(deviceId, characteristicUuid))),
    write: (deviceId: string, characteristicUuid: string, value: Uint8Array) =>
      call(
        NativeBleLink.centralWrite(deviceId, characteristicUuid, base64Encode(value)),
      ),
    addListener: (listener: (event: CentralTransportEvent) => void) =>
      addNativeListener(event => {
        switch (event.type) {
          case 'bluetoothState':
            listener({ type: 'bluetoothState', state: event.payload.state });
            break;
          case 'central.scanResult':
            listener({
              type: 'scanResult',
              deviceId: event.payload.deviceId,
              name: event.payload.name,
              rssi: event.payload.rssi,
              serviceData: event.payload.serviceData
                ? base64Decode(event.payload.serviceData)
                : null,
            });
            break;
          case 'central.notification':
            listener({
              type: 'notification',
              deviceId: event.payload.deviceId,
              value: base64Decode(event.payload.value),
            });
            break;
          case 'central.disconnected':
            listener({ type: 'disconnected', ...event.payload });
            break;
          case 'error':
            listener({ type: 'error', message: event.payload.message });
            break;
        }
      }),
  };
}

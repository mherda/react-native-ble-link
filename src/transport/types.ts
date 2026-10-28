import type { BluetoothState } from './nativeEvents';

export type { BluetoothState };

export type GattUuids = {
  service: string;
  info: string;
  state: string;
  rx: string;
  tx: string;
};

export type PeripheralTransportEvent =
  | { type: 'bluetoothState'; state: BluetoothState }
  | { type: 'subscribed'; centralId: string; maxValueLength: number }
  | { type: 'mtu'; centralId: string; maxValueLength: number }
  | { type: 'write'; centralId: string; value: Uint8Array }
  | { type: 'disconnected'; centralId: string }
  | { type: 'error'; message: string };

export interface PeripheralTransport {
  start(uuids: GattUuids, advertisedId: string, info: Uint8Array): Promise<void>;
  stop(): Promise<void>;
  /** Value served for reads of the state characteristic. */
  setState(value: Uint8Array): void;
  notify(centralId: string, value: Uint8Array): Promise<void>;
  addListener(listener: (event: PeripheralTransportEvent) => void): () => void;
}

export type ScanResult = {
  deviceId: string;
  name: string | null;
  rssi: number;
  serviceData: Uint8Array | null;
};

export type CentralTransportEvent =
  | { type: 'bluetoothState'; state: BluetoothState }
  | ({ type: 'scanResult' } & ScanResult)
  | { type: 'notification'; deviceId: string; value: Uint8Array }
  | { type: 'disconnected'; deviceId: string; error: string | null }
  | { type: 'error'; message: string };

export interface CentralTransport {
  startScan(serviceUuid: string): Promise<void>;
  stopScan(): Promise<void>;
  /** Connects, discovers and subscribes to tx. Resolves with max write length. */
  connect(deviceId: string, uuids: GattUuids, timeoutMs: number): Promise<number>;
  disconnect(deviceId: string): Promise<void>;
  read(deviceId: string, characteristicUuid: string): Promise<Uint8Array>;
  write(deviceId: string, characteristicUuid: string, value: Uint8Array): Promise<void>;
  addListener(listener: (event: CentralTransportEvent) => void): () => void;
}

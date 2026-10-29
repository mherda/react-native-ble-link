/**
 * TurboModule spec for the native BLE transport.
 *
 * Native code is a thin byte pipe: advertising, GATT server, scanning, GATT
 * client and operation queueing. Framing, messages, sessions and RPC live in
 * TypeScript. Binary values cross the bridge as base64 strings.
 *
 * All asynchronous native callbacks arrive through `onEvent` as
 * `{ type, payload }`, where `payload` is a JSON string. See
 * `transport/nativeEvents.ts` for the event catalogue.
 */
import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type GattUuids = {
  service: string;
  info: string;
  state: string;
  rx: string;
  tx: string;
};

export type NativeEvent = {
  type: string;
  payload: string;
};

export interface Spec extends TurboModule {
  // Shared
  getBluetoothState(): Promise<string>;
  isPeripheralSupported(): Promise<boolean>;
  /** Android: system "turn on Bluetooth" dialog. iOS: can't prompt, reports state only. */
  enableBluetooth(): Promise<boolean>;

  // Peripheral (hub)
  peripheralStart(
    uuids: GattUuids,
    advertisedId: string,
    info: string,
  ): Promise<void>;
  peripheralStop(): Promise<void>;
  peripheralSetState(value: string): void;
  peripheralNotify(centralId: string, value: string): Promise<void>;

  // Central (phone)
  centralStartScan(serviceUuid: string): Promise<void>;
  centralStopScan(): Promise<void>;
  centralConnect(
    deviceId: string,
    uuids: GattUuids,
    timeoutMs: number,
  ): Promise<number>;
  centralDisconnect(deviceId: string): Promise<void>;
  centralRead(deviceId: string, characteristicUuid: string): Promise<string>;
  centralWrite(
    deviceId: string,
    characteristicUuid: string,
    value: string,
  ): Promise<void>;

  readonly onEvent: CodegenTypes.EventEmitter<NativeEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ReactNativeBleLink');

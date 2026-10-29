import { Central, type CentralConfig } from './central/Central';
import { Peripheral, type PeripheralConfig } from './peripheral/Peripheral';
import {
  createNativeCentralTransport,
  createNativePeripheralTransport,
} from './transport/native';
import type { CentralTransport, PeripheralTransport } from './transport/types';
import type { AppState } from './types';

export function createPeripheral<S extends AppState = AppState>(
  config: PeripheralConfig & { transport?: PeripheralTransport },
): Peripheral<S> {
  return new Peripheral<S>(config, config.transport ?? createNativePeripheralTransport());
}

export function createCentral(
  config: CentralConfig & { transport?: CentralTransport } = {},
): Central {
  return new Central(config, config.transport ?? createNativeCentralTransport());
}

export { Central, advertisedHubId } from './central/Central';
export type {
  CentralConfig,
  ConnectOptions,
  NearbyHub,
  ScanOptions,
} from './central/Central';
export { Connection } from './central/Connection';
export { Peripheral } from './peripheral/Peripheral';
export type {
  HandlerOptions,
  PeripheralConfig,
  RequestContext,
  RequestHandler,
  SetStateOptions,
} from './peripheral/Peripheral';
export type { ReleaseReason } from './peripheral/sessions';
export { BleLinkError, isBleLinkError } from './errors';
export type { BleLinkErrorCode } from './errors';
export { DEFAULT_UUIDS, PROTOCOL_VERSION } from './constants';
export {
  enableBluetooth,
  getBluetoothState,
  isPeripheralSupported,
  onBluetoothStateChange,
} from './transport/native';
export { FakeRadio } from './transport/fake';
export { checkPermissions, requestPermissions } from './permissions';
export type { Role } from './permissions';
export type {
  BluetoothState,
  CentralTransport,
  GattUuids,
  PeripheralTransport,
} from './transport/types';
export type {
  AppState,
  ReceivedMessage,
  StateSnapshot,
  HubInfo,
} from './types';

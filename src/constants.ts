import type { GattUuids } from './transport/types';

export const PROTOCOL_VERSION = 1;

/** Default GATT layout. Override per deployment via `uuids` in the config. */
export const DEFAULT_UUIDS: GattUuids = {
  service: '6E1A0001-4B7C-4F5E-9A2D-3C8B1F0E7D21',
  info: '6E1A0002-4B7C-4F5E-9A2D-3C8B1F0E7D21',
  state: '6E1A0003-4B7C-4F5E-9A2D-3C8B1F0E7D21',
  rx: '6E1A0004-4B7C-4F5E-9A2D-3C8B1F0E7D21',
  tx: '6E1A0005-4B7C-4F5E-9A2D-3C8B1F0E7D21',
};

/** Advertised hub ID must fit next to a 128-bit UUID in 31 bytes. */
export const MAX_ADVERTISED_ID_LENGTH = 8;

/** ATT maximum attribute value length; caps the state snapshot. */
export const MAX_STATE_BYTES = 512;
export const MAX_MESSAGE_BYTES = 4096;

/** Value length guaranteed by the default ATT MTU of 23. */
export const DEFAULT_MAX_VALUE_LENGTH = 20;

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
/** TS-level retries; Android native also retries GATT 133 errors internally. */
export const DEFAULT_CONNECT_RETRIES = 1;
export const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
export const REASSEMBLY_TIMEOUT_MS = 2_000;
export const SCAN_STALE_MS = 5_000;

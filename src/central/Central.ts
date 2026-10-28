import {
  DEFAULT_CONNECT_RETRIES,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_UUIDS,
  SCAN_STALE_MS,
} from '../constants';
import { Emitter } from '../emitter';
import { BleLinkError } from '../errors';
import { randomId, utf8Decode } from '../protocol/codec';
import type {
  CentralTransport,
  CentralTransportEvent,
  GattUuids,
  ScanResult,
} from '../transport/types';
import type { ReceivedMessage } from '../types';
import { Connection } from './Connection';

export type CentralConfig = {
  uuids?: GattUuids;
};

export type NearbyHub = {
  deviceId: string;
  /** Advertised hub ID; null until the advertisement carried it. */
  hubId: string | null;
  /** Smoothed RSSI (dBm). Higher is closer. */
  rssi: number;
  lastSeen: number;
};

export type ScanOptions = {
  onHubs: (hubs: NearbyHub[]) => void;
  onError?: (error: Error) => void;
  /** Ignore hubs weaker than this. */
  minRssi?: number;
};

export type ConnectOptions = {
  timeoutMs?: number;
  /** Extra attempts after the first one fails. */
  retries?: number;
};

const RSSI_SMOOTHING = 0.3;
const RETRY_DELAY_MS = 400;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function advertisedHubId(result: ScanResult): string | null {
  if (result.serviceData && result.serviceData.length > 0) {
    return utf8Decode(result.serviceData);
  }
  return result.name;
}

type CentralEvents = {
  /** A message received on any connection. */
  received: [message: ReceivedMessage, deviceId: string];
};

export class Central extends Emitter<CentralEvents> {
  private readonly uuids: GattUuids;
  private readonly connections = new Map<string, Connection>();
  private readonly scanListeners = new Set<(result: ScanResult) => void>();
  private unsubscribe: (() => void) | null = null;
  private scanning = false;
  private token = randomId(16);

  constructor(
    config: CentralConfig,
    private readonly transport: CentralTransport,
  ) {
    super();
    this.uuids = config.uuids ?? DEFAULT_UUIDS;
  }

  /** Identifies this phone to hubs across reconnects (used for claims). */
  get clientToken(): string {
    return this.token;
  }

  /** Start a fresh identity, e.g. at the start of a new flow. */
  newClientToken(): string {
    this.token = randomId(16);
    return this.token;
  }

  /** Scans for hubs. Returns a function that stops the scan. */
  scan(options: ScanOptions): () => void {
    const hubs = new Map<string, NearbyHub>();
    const publish = () => {
      const now = Date.now();
      for (const [id, t] of hubs) {
        if (now - t.lastSeen > SCAN_STALE_MS) hubs.delete(id);
      }
      options.onHubs(
        [...hubs.values()]
          .filter(t => options.minRssi === undefined || t.rssi >= options.minRssi)
          .sort((a, b) => b.rssi - a.rssi),
      );
    };
    const onResult = (result: ScanResult) => {
      const previous = hubs.get(result.deviceId);
      hubs.set(result.deviceId, {
        deviceId: result.deviceId,
        hubId: advertisedHubId(result) ?? previous?.hubId ?? null,
        rssi: previous
          ? previous.rssi + RSSI_SMOOTHING * (result.rssi - previous.rssi)
          : result.rssi,
        lastSeen: Date.now(),
      });
    };
    const interval = setInterval(publish, 500);
    const stopListening = this.startScan(onResult, options.onError);
    return () => {
      clearInterval(interval);
      stopListening();
    };
  }

  async connect(deviceId: string, options: ConnectOptions = {}): Promise<Connection> {
    const existing = this.connections.get(deviceId);
    if (existing?.isConnected) return existing;

    this.listen();
    await this.stopScanIfIdle(true);
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_CONNECT_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAY_MS * attempt);
      try {
        const maxWriteLength = await this.transport.connect(
          deviceId,
          this.uuids,
          timeoutMs,
        );
        const connection = new Connection(
          deviceId,
          this.transport,
          this.uuids,
          () => this.token,
          maxWriteLength,
        );
        this.connections.set(deviceId, connection);
        connection.on('received', message => this.fire('received', message, deviceId));
        connection.on('disconnected', () => {
          if (this.connections.get(deviceId) === connection) {
            this.connections.delete(deviceId);
          }
        });
        return connection;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Connects to a hub seen before. Tries the known device ID first, then
   * rescans by hub ID (BLE addresses rotate, so the device ID may change).
   */
  async reconnect(options: {
    hubId: string;
    deviceIdHint?: string;
    scanTimeoutMs?: number;
  }): Promise<Connection> {
    if (options.deviceIdHint) {
      try {
        return await this.connect(options.deviceIdHint, {
          timeoutMs: 4_000,
          retries: 0,
        });
      } catch {
        // Fall through to scanning.
      }
    }
    const deviceId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(
          new BleLinkError('NOT_FOUND', `Hub ${options.hubId} not found nearby`),
        );
      }, options.scanTimeoutMs ?? 8_000);
      const stop = this.startScan(
        result => {
          if (advertisedHubId(result) === options.hubId) {
            clearTimeout(timer);
            stop();
            resolve(result.deviceId);
          }
        },
        error => {
          clearTimeout(timer);
          stop();
          reject(error);
        },
      );
    });
    return this.connect(deviceId);
  }

  async destroy(): Promise<void> {
    this.scanListeners.clear();
    await this.stopScanIfIdle();
    await Promise.all([...this.connections.values()].map(c => c.disconnect()));
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private listen(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.addListener(e => this.onTransportEvent(e));
  }

  private startScan(
    onResult: (result: ScanResult) => void,
    onError?: (error: Error) => void,
  ): () => void {
    this.listen();
    this.scanListeners.add(onResult);
    if (!this.scanning) {
      this.scanning = true;
      this.transport.startScan(this.uuids.service).catch(error => {
        this.scanning = false;
        onError?.(error as Error);
      });
    }
    return () => {
      this.scanListeners.delete(onResult);
      void this.stopScanIfIdle();
    };
  }

  private async stopScanIfIdle(force = false): Promise<void> {
    if (!this.scanning || (!force && this.scanListeners.size > 0)) return;
    this.scanning = false;
    await this.transport.stopScan().catch(() => undefined);
  }

  private onTransportEvent(event: CentralTransportEvent): void {
    switch (event.type) {
      case 'scanResult':
        this.scanListeners.forEach(listener => listener(event));
        break;
      case 'notification':
        this.connections.get(event.deviceId)?.receiveFrame(event.value);
        break;
      case 'disconnected':
        this.connections.get(event.deviceId)?.close(event.error);
        break;
    }
  }
}

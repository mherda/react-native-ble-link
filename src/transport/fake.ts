import { BleLinkError } from '../errors';
import { utf8Encode } from '../protocol/codec';
import type {
  CentralTransport,
  CentralTransportEvent,
  GattUuids,
  PeripheralTransport,
  PeripheralTransportEvent,
} from './types';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type FakePeripheralState = {
  deviceId: string;
  uuids: GattUuids;
  advertisedId: string;
  info: Uint8Array;
  state: Uint8Array;
  listeners: Set<(e: PeripheralTransportEvent) => void>;
};

type FakeCentralState = {
  centralId: string;
  scanning: boolean;
  connectedTo: string | null;
  listeners: Set<(e: CentralTransportEvent) => void>;
};

/**
 * In-memory BLE "air" linking fake peripherals and centrals. Used by tests and
 * to run the whole protocol without devices.
 */
export class FakeRadio {
  maxValueLength = 20;
  rssi = -55;
  private readonly peripherals = new Map<string, FakePeripheralState>();
  private readonly centrals = new Map<string, FakeCentralState>();

  createPeripheralTransport(deviceId = 'hub-device'): PeripheralTransport {
    const listeners = new Set<(e: PeripheralTransportEvent) => void>();
    return {
      start: async (uuids, advertisedId, info) => {
        await tick();
        const p: FakePeripheralState = {
          deviceId,
          uuids,
          advertisedId,
          info,
          state: new Uint8Array(),
          listeners,
        };
        this.peripherals.set(deviceId, p);
        this.centrals.forEach(c => {
          if (c.scanning) this.advertiseTo(p, c);
        });
      },
      stop: async () => {
        await tick();
        this.peripherals.delete(deviceId);
        this.centrals.forEach(c => {
          if (c.connectedTo === deviceId) this.dropConnection(c.centralId);
        });
      },
      setState: value => {
        const p = this.peripherals.get(deviceId);
        if (p) p.state = value;
      },
      notify: async (centralId, value) => {
        await tick();
        const c = this.centrals.get(centralId);
        if (!c || c.connectedTo !== deviceId) {
          throw new BleLinkError('DISCONNECTED', 'Central not connected');
        }
        if (value.length > this.maxValueLength) {
          throw new BleLinkError('NATIVE_ERROR', 'Notification too long');
        }
        c.listeners.forEach(l =>
          l({ type: 'notification', deviceId, value: value.slice() }),
        );
      },
      addListener: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  createCentralTransport(centralId = 'phone-device'): CentralTransport {
    const c: FakeCentralState = {
      centralId,
      scanning: false,
      connectedTo: null,
      listeners: new Set(),
    };
    this.centrals.set(centralId, c);
    const connected = (deviceId: string) => {
      const p = this.peripherals.get(deviceId);
      if (!p || c.connectedTo !== deviceId) {
        throw new BleLinkError('DISCONNECTED', 'Not connected');
      }
      return p;
    };
    return {
      startScan: async () => {
        await tick();
        c.scanning = true;
        this.peripherals.forEach(p => this.advertiseTo(p, c));
      },
      stopScan: async () => {
        c.scanning = false;
      },
      connect: async deviceId => {
        await tick();
        const p = this.peripherals.get(deviceId);
        if (!p) throw new BleLinkError('TIMEOUT', 'Device not found');
        c.connectedTo = deviceId;
        p.listeners.forEach(l =>
          l({
            type: 'subscribed',
            centralId,
            maxValueLength: this.maxValueLength,
          }),
        );
        return this.maxValueLength;
      },
      disconnect: async deviceId => {
        await tick();
        if (c.connectedTo === deviceId) this.dropConnection(centralId, false);
      },
      read: async (deviceId, characteristicUuid) => {
        await tick();
        const p = connected(deviceId);
        if (characteristicUuid === p.uuids.info) return p.info.slice();
        if (characteristicUuid === p.uuids.state) return p.state.slice();
        throw new BleLinkError('NATIVE_ERROR', 'Characteristic not readable');
      },
      write: async (deviceId, characteristicUuid, value) => {
        await tick();
        const p = connected(deviceId);
        if (characteristicUuid !== p.uuids.rx) {
          throw new BleLinkError('NATIVE_ERROR', 'Characteristic not writable');
        }
        if (value.length > this.maxValueLength) {
          throw new BleLinkError('NATIVE_ERROR', 'Write too long');
        }
        p.listeners.forEach(l =>
          l({ type: 'write', centralId, value: value.slice() }),
        );
      },
      addListener: listener => {
        c.listeners.add(listener);
        return () => c.listeners.delete(listener);
      },
    };
  }

  /** Simulates a link loss between a central and its peripheral. */
  dropConnection(centralId: string, notifyCentral = true): void {
    const c = this.centrals.get(centralId);
    if (!c || !c.connectedTo) return;
    const deviceId = c.connectedTo;
    c.connectedTo = null;
    this.peripherals
      .get(deviceId)
      ?.listeners.forEach(l => l({ type: 'disconnected', centralId }));
    if (notifyCentral) {
      c.listeners.forEach(l =>
        l({ type: 'disconnected', deviceId, error: 'Link lost' }),
      );
    }
  }

  private advertiseTo(p: FakePeripheralState, c: FakeCentralState): void {
    c.listeners.forEach(l =>
      l({
        type: 'scanResult',
        deviceId: p.deviceId,
        name: null,
        rssi: this.rssi,
        serviceData: utf8Encode(p.advertisedId),
      }),
    );
  }
}

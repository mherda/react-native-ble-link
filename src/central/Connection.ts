import { DEFAULT_REQUEST_TIMEOUT_MS, PROTOCOL_VERSION } from '../constants';
import { Emitter } from '../emitter';
import { BleLinkError } from '../errors';
import { MessageChannel } from '../protocol/channel';
import { decodeJson, randomId } from '../protocol/codec';
import type { ParseResult } from '../protocol/envelope';
import type { CentralTransport, GattUuids } from '../transport/types';
import type {
  AppState,
  ReceivedMessage,
  StateSnapshot,
  HubInfo,
} from '../types';

type ConnectionEvents = {
  received: [message: ReceivedMessage];
  event: [type: string, body: unknown];
  stateChanged: [state: StateSnapshot];
  disconnected: [error: string | null];
};

type PendingRequest = {
  type: string;
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A live link from the phone to one hub. Create via `Central.connect`. */
export class Connection extends Emitter<ConnectionEvents> {
  private readonly channel: MessageChannel;
  private readonly pending = new Map<string, PendingRequest>();
  private session: string | null = null;
  private closed = false;

  constructor(
    readonly deviceId: string,
    private readonly transport: CentralTransport,
    private readonly uuids: GattUuids,
    private readonly clientToken: () => string,
    maxWriteLength: number,
  ) {
    super();
    this.channel = new MessageChannel({
      sendFrame: frame => this.transport.write(deviceId, uuids.rx, frame),
      maxFrameLength: () => maxWriteLength,
      onEnvelope: result => this.onEnvelope(result),
    });
  }

  get isConnected(): boolean {
    return !this.closed;
  }

  /** Session ID from the last state read or `state.changed` event. */
  get currentSession(): string | null {
    return this.session;
  }

  hello(): Promise<HubInfo> {
    return this.request<HubInfo>('link.hello', null);
  }

  async readInfo(): Promise<HubInfo> {
    const info = decodeJson<HubInfo>(
      await this.transport.read(this.deviceId, this.uuids.info),
    );
    this.fire('received', { kind: 'read', type: 'info', body: info });
    return info;
  }

  async readState<S extends AppState = AppState>(): Promise<StateSnapshot<S>> {
    const state = decodeJson<StateSnapshot<S>>(
      await this.transport.read(this.deviceId, this.uuids.state),
    );
    this.session = state.session;
    this.fire('received', { kind: 'read', type: 'state', body: state });
    return state;
  }

  claim(): Promise<{ claimed: true }> {
    return this.request('session.claim', null);
  }

  release(): Promise<{ released: boolean }> {
    return this.request('session.release', null);
  }

  /** Sends a request tagged with the current session and client token. */
  request<T = unknown>(
    type: string,
    body: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new BleLinkError('DISCONNECTED', 'Connection closed'));
    }
    const id = randomId(4);
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BleLinkError('TIMEOUT', `"${type}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        type,
        resolve: resolve as (body: unknown) => void,
        reject,
        timer,
      });
      this.channel
        .send({
          v: PROTOCOL_VERSION,
          kind: 'req',
          id,
          type,
          session: this.session,
          client: this.clientToken(),
          body,
        })
        .catch(error => this.settle(id, undefined, error as Error));
    });
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.close(null);
    await this.transport.disconnect(this.deviceId).catch(() => undefined);
  }

  /** @internal Called by Central when the transport reports activity. */
  receiveFrame(frame: Uint8Array): void {
    this.channel.receiveFrame(frame);
  }

  /** @internal */
  close(error: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.reset();
    for (const id of [...this.pending.keys()]) {
      this.settle(
        id,
        undefined,
        new BleLinkError('DISCONNECTED', error ?? 'Disconnected'),
      );
    }
    this.fire('disconnected', error);
    this.removeAllListeners();
  }

  private settle(id: string, body: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(body);
  }

  private onEnvelope(result: ParseResult): void {
    if (!result.ok) return;
    const envelope = result.envelope;
    if (envelope.kind === 'res') {
      const type = this.pending.get(envelope.re)?.type;
      if (type) {
        this.fire(
          'received',
          envelope.ok
            ? { kind: 'res', type, ok: true, body: envelope.body }
            : { kind: 'res', type, ok: false, error: envelope.error },
        );
      }
      this.settle(
        envelope.re,
        envelope.ok ? envelope.body : undefined,
        envelope.ok
          ? undefined
          : new BleLinkError(envelope.error.code, envelope.error.message),
      );
    } else if (envelope.kind === 'evt') {
      this.fire('received', { kind: 'evt', type: envelope.type, body: envelope.body });
      if (envelope.type === 'state.changed') {
        const state = envelope.body as StateSnapshot;
        this.session = state.session;
        this.fire('stateChanged', state);
      } else {
        this.fire('event', envelope.type, envelope.body);
      }
    }
  }
}

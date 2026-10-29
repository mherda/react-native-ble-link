import {
  DEFAULT_MAX_VALUE_LENGTH,
  DEFAULT_UUIDS,
  MAX_ADVERTISED_ID_LENGTH,
  MAX_STATE_BYTES,
  PROTOCOL_VERSION,
} from '../constants';
import { Emitter } from '../emitter';
import { BleLinkError, type BleLinkErrorCode } from '../errors';
import { MessageChannel } from '../protocol/channel';
import { encodeJson } from '../protocol/codec';
import type { ParseResult, RequestEnvelope } from '../protocol/envelope';
import type {
  GattUuids,
  PeripheralTransport,
  PeripheralTransportEvent,
} from '../transport/types';
import type {
  AppState,
  ReceivedMessage,
  StateSnapshot,
  HubInfo,
} from '../types';
import { SessionManager, type ReleaseReason, type SessionOptions } from './sessions';

export type PeripheralConfig = {
  /** ≤ 8 ASCII chars; advertised so phones can tell hubs apart. */
  hubId: string;
  displayName: string;
  uuids?: GattUuids;
};

export type RequestContext = {
  centralId: string;
  clientToken: string;
  session: string | null;
  isClaimOwner: boolean;
};

export type RequestHandler = (
  body: any,
  context: RequestContext,
) => unknown | Promise<unknown>;

export type HandlerOptions = {
  /** Reject requests for an old session with SESSION_EXPIRED. Default true. */
  requireSession?: boolean;
  /** Only the phone holding the claim may call this. Default false. */
  requireClaim?: boolean;
};

export type SetStateOptions = SessionOptions & {
  /** Start a new session: old requests are rejected and claims dropped. */
  newSession?: boolean;
};

type PeripheralEvents = {
  received: [message: ReceivedMessage, centralId: string];
  centralConnected: [centralId: string];
  centralDisconnected: [centralId: string];
  sessionClaimed: [clientToken: string];
  sessionReleased: [clientToken: string, reason: ReleaseReason];
  error: [error: Error];
};

type CentralLink = {
  channel: MessageChannel;
  maxValueLength: number;
  subscribed: boolean;
};

export class Peripheral<S extends AppState = AppState> extends Emitter<PeripheralEvents> {
  private readonly uuids: GattUuids;
  private readonly sessions: SessionManager;
  private readonly handlers = new Map<
    string,
    { handler: RequestHandler; options: HandlerOptions }
  >();
  private readonly centrals = new Map<string, CentralLink>();
  private state: S = { screen: 'idle' } as S;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: PeripheralConfig,
    private readonly transport: PeripheralTransport,
  ) {
    super();
    if (
      config.hubId.length === 0 ||
      config.hubId.length > MAX_ADVERTISED_ID_LENGTH ||
      !/^[\x20-\x7e]+$/.test(config.hubId)
    ) {
      throw new Error(
        `hubId must be 1–${MAX_ADVERTISED_ID_LENGTH} printable ASCII chars`,
      );
    }
    this.uuids = config.uuids ?? DEFAULT_UUIDS;
    this.sessions = new SessionManager((clientToken, reason) => {
      this.fire('sessionReleased', clientToken, reason);
      if (reason !== 'newSession') this.publishState();
    });
  }

  get info(): HubInfo {
    return {
      v: PROTOCOL_VERSION,
      hubId: this.config.hubId,
      displayName: this.config.displayName,
    };
  }

  get snapshot(): StateSnapshot<S> {
    return {
      ...this.state,
      v: PROTOCOL_VERSION,
      hubId: this.config.hubId,
      displayName: this.config.displayName,
      session: this.sessions.sessionId,
      claimable: this.sessions.claimable,
      claimed: this.sessions.claimed,
    };
  }

  get connectedCentrals(): string[] {
    return [...this.centrals.keys()];
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.addListener(e => this.onTransportEvent(e));
    try {
      await this.transport.start(
        this.uuids,
        this.config.hubId,
        encodeJson(this.info),
      );
      this.publishState();
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.centrals.clear();
    this.sessions.dispose();
    await this.transport.stop();
  }

  /**
   * Updates what phones read from the hub and pushes `state.changed` to
   * connected phones.
   */
  setState(state: S, options: SetStateOptions = {}): void {
    if (options.newSession) {
      this.sessions.newSession(options);
    }
    this.state = state;
    this.publishState();
  }

  getState(): S {
    return this.state;
  }

  handle(type: string, handler: RequestHandler, options: HandlerOptions = {}): () => void {
    if (type.startsWith('link.') || type.startsWith('session.')) {
      throw new Error(`"${type}" uses a reserved prefix`);
    }
    this.handlers.set(type, { handler, options });
    return () => {
      if (this.handlers.get(type)?.handler === handler) this.handlers.delete(type);
    };
  }

  /** Sends an event to one phone, or to every connected phone. */
  async emit(type: string, body: unknown, centralId?: string): Promise<void> {
    const targets = centralId ? [centralId] : [...this.centrals.keys()];
    await Promise.all(
      targets.map(id => {
        const link = this.centrals.get(id);
        if (!link?.subscribed) return Promise.resolve();
        return link.channel
          .send({ v: PROTOCOL_VERSION, kind: 'evt', type, body })
          .catch(error => this.fire('error', error as Error));
      }),
    );
  }

  private publishState(): void {
    const snapshot = this.snapshot;
    const bytes = encodeJson(snapshot);
    if (bytes.length > MAX_STATE_BYTES) {
      this.fire(
        'error',
        new BleLinkError(
          'MESSAGE_TOO_LARGE',
          `State is ${bytes.length} bytes, max is ${MAX_STATE_BYTES}`,
        ),
      );
      return;
    }
    if (!this.unsubscribe) return;
    this.transport.setState(bytes);
    void this.emit('state.changed', snapshot);
  }

  private link(centralId: string): CentralLink {
    let link = this.centrals.get(centralId);
    if (!link) {
      const created: CentralLink = {
        maxValueLength: DEFAULT_MAX_VALUE_LENGTH,
        subscribed: false,
        channel: new MessageChannel({
          sendFrame: frame => this.transport.notify(centralId, frame),
          maxFrameLength: () => created.maxValueLength,
          onEnvelope: result => void this.onEnvelope(centralId, result),
        }),
      };
      link = created;
      this.centrals.set(centralId, link);
    }
    return link;
  }

  private onTransportEvent(event: PeripheralTransportEvent): void {
    switch (event.type) {
      case 'subscribed': {
        const link = this.link(event.centralId);
        link.maxValueLength = event.maxValueLength;
        if (!link.subscribed) {
          link.subscribed = true;
          this.fire('centralConnected', event.centralId);
        }
        break;
      }
      case 'mtu':
        this.link(event.centralId).maxValueLength = event.maxValueLength;
        break;
      case 'write':
        this.link(event.centralId).channel.receiveFrame(event.value);
        break;
      case 'disconnected':
        if (this.centrals.delete(event.centralId)) {
          this.fire('centralDisconnected', event.centralId);
        }
        break;
      case 'error':
        this.fire('error', new BleLinkError('NATIVE_ERROR', event.message));
        break;
    }
  }

  private async onEnvelope(centralId: string, result: ParseResult): Promise<void> {
    if (!result.ok) {
      if (result.requestId) {
        await this.respondError(centralId, result.requestId, result.code, result.message);
      }
      return;
    }
    if (result.envelope.kind !== 'req') return;
    const request = result.envelope;
    this.fire(
      'received',
      { kind: 'req', type: request.type, body: request.body },
      centralId,
    );
    try {
      const body = await this.dispatch(centralId, request);
      await this.link(centralId).channel.send({
        v: PROTOCOL_VERSION,
        kind: 'res',
        re: request.id,
        ok: true,
        body: body ?? null,
      });
    } catch (error) {
      const code: BleLinkErrorCode =
        error instanceof BleLinkError ? error.code : 'HANDLER_ERROR';
      await this.respondError(centralId, request.id, code, (error as Error).message);
    }
  }

  private async dispatch(centralId: string, request: RequestEnvelope): Promise<unknown> {
    const { client, session } = request;
    const reject = (code: BleLinkErrorCode | null) => {
      if (code) throw new BleLinkError(code, messages[code] ?? code);
    };

    switch (request.type) {
      case 'link.hello':
        return this.info;
      case 'link.ping':
        return { pong: true };
      case 'session.claim':
        if (session !== this.sessions.sessionId) reject('SESSION_EXPIRED');
        reject(this.sessions.tryClaim(client));
        this.fire('sessionClaimed', client);
        this.publishState();
        return { claimed: true };
      case 'session.release':
        return { released: this.sessions.release(client) };
    }

    const entry = this.handlers.get(request.type);
    if (!entry) {
      throw new BleLinkError('UNKNOWN_TYPE', `Unknown request type "${request.type}"`);
    }
    const { handler, options } = entry;
    if (options.requireSession !== false) {
      reject(this.sessions.check(session, client));
    }
    if (options.requireClaim && !this.sessions.isOwner(client)) {
      reject('NOT_CLAIMED');
    }
    return handler(request.body, {
      centralId,
      clientToken: client,
      session,
      isClaimOwner: this.sessions.isOwner(client),
    });
  }

  private async respondError(
    centralId: string,
    requestId: string,
    code: BleLinkErrorCode,
    message: string,
  ): Promise<void> {
    try {
      await this.link(centralId).channel.send({
        v: PROTOCOL_VERSION,
        kind: 'res',
        re: requestId,
        ok: false,
        error: { code, message },
      });
    } catch (error) {
      this.fire('error', error as Error);
    }
  }
}

const messages: Partial<Record<BleLinkErrorCode, string>> = {
  SESSION_EXPIRED: 'The hub has moved on to a different session',
  SESSION_BUSY: 'Another device is using this hub',
  NOT_CLAIMED: 'Claim the session first',
  NOT_CLAIMABLE: 'This session cannot be claimed',
};

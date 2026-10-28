import { DEFAULT_CLAIM_TTL_MS } from '../constants';
import type { BleLinkErrorCode } from '../errors';
import { randomId } from '../protocol/codec';

export type SessionOptions = {
  /** Allow one phone to claim the session exclusively. */
  claimable?: boolean;
  claimTtlMs?: number;
};

export type ReleaseReason = 'released' | 'expired' | 'newSession';

type Claim = { clientToken: string; timer: ReturnType<typeof setTimeout> };

/**
 * Session IDs and exclusive claims. A claim belongs to a client token (not a
 * BLE connection), so it survives the phone disconnecting mid-flow.
 */
export class SessionManager {
  sessionId: string = randomId(16);
  claimable = false;
  private claimTtlMs = DEFAULT_CLAIM_TTL_MS;
  private claim: Claim | null = null;

  constructor(
    private readonly onReleased: (clientToken: string, reason: ReleaseReason) => void,
  ) {}

  get claimed(): boolean {
    return this.claim !== null;
  }

  newSession(options: SessionOptions = {}): void {
    this.dropClaim('newSession');
    this.sessionId = randomId(16);
    this.claimable = options.claimable ?? false;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  isOwner(clientToken: string): boolean {
    return this.claim?.clientToken === clientToken;
  }

  /** Returns an error code if `clientToken` may not act on `session`. */
  check(session: string | null, clientToken: string): BleLinkErrorCode | null {
    if (session !== this.sessionId) return 'SESSION_EXPIRED';
    if (this.claim && !this.isOwner(clientToken)) return 'SESSION_BUSY';
    return null;
  }

  tryClaim(clientToken: string): BleLinkErrorCode | null {
    if (!this.claimable) return 'NOT_CLAIMABLE';
    if (this.claim && !this.isOwner(clientToken)) return 'SESSION_BUSY';
    if (this.claim) clearTimeout(this.claim.timer);
    const timer = setTimeout(() => this.dropClaim('expired'), this.claimTtlMs);
    this.claim = { clientToken, timer };
    return null;
  }

  release(clientToken: string): boolean {
    if (!this.isOwner(clientToken)) return false;
    this.dropClaim('released');
    return true;
  }

  dispose(): void {
    if (this.claim) clearTimeout(this.claim.timer);
    this.claim = null;
  }

  private dropClaim(reason: ReleaseReason): void {
    if (!this.claim) return;
    const { clientToken, timer } = this.claim;
    clearTimeout(timer);
    this.claim = null;
    this.onReleased(clientToken, reason);
  }
}

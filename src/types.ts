/** App-defined part of the hub state. Keep it small: the encoded snapshot
 * must fit in 512 bytes. */
export type AppState = {
  screen: string;
  data?: unknown;
};

/** What a phone reads from the state characteristic. */
export type StateSnapshot<S extends AppState = AppState> = S & {
  v: number;
  hubId: string;
  displayName: string;
  session: string;
  claimable: boolean;
  claimed: boolean;
};

/** What a phone reads from the info characteristic / gets from `hello`. */
export type HubInfo = {
  v: number;
  hubId: string;
  displayName: string;
};

export type ClaimResult = { claimed: true };

/**
 * Everything one side received from the other, for logging/debug UI.
 * - `req`: hub received a request from a phone
 * - `res`: phone received the reply to its request `type`
 * - `evt`: phone received an event pushed by the hub
 * - `read`: phone read the hub's `state` or `info` characteristic
 */
export type ReceivedMessage =
  | { kind: 'req'; type: string; body: unknown }
  | { kind: 'res'; type: string; ok: true; body: unknown }
  | { kind: 'res'; type: string; ok: false; error: { code: string; message: string } }
  | { kind: 'evt'; type: string; body: unknown }
  | { kind: 'read'; type: 'state' | 'info'; body: unknown };

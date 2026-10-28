export type BleLinkErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'SESSION_EXPIRED'
  | 'SESSION_BUSY'
  | 'NOT_CLAIMED'
  | 'NOT_CLAIMABLE'
  | 'UNKNOWN_TYPE'
  | 'INVALID_BODY'
  | 'HANDLER_ERROR'
  | 'MESSAGE_TOO_LARGE'
  | 'TIMEOUT'
  | 'DISCONNECTED'
  | 'NOT_FOUND'
  | 'BLUETOOTH_UNAVAILABLE'
  | 'NATIVE_ERROR';

export class BleLinkError extends Error {
  constructor(
    readonly code: BleLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BleLinkError';
  }
}

export function isBleLinkError(
  error: unknown,
  code?: BleLinkErrorCode,
): error is BleLinkError {
  return (
    error instanceof BleLinkError && (code === undefined || error.code === code)
  );
}

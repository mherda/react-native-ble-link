import { MAX_MESSAGE_BYTES, REASSEMBLY_TIMEOUT_MS } from '../constants';
import { BleLinkError } from '../errors';

/**
 * Frame layout on rx/tx characteristics:
 *   byte 0  messageId   rolling 0–255 per direction per connection
 *   byte 1  chunkIndex  0-based
 *   byte 2  chunkCount  1–255
 *   3..     payload slice
 */
export const FRAME_HEADER_LENGTH = 3;

export function splitIntoFrames(
  messageId: number,
  payload: Uint8Array,
  maxFrameLength: number,
): Uint8Array[] {
  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new BleLinkError(
      'MESSAGE_TOO_LARGE',
      `Message is ${payload.length} bytes, max is ${MAX_MESSAGE_BYTES}`,
    );
  }
  const chunkSize = maxFrameLength - FRAME_HEADER_LENGTH;
  if (chunkSize < 1) {
    throw new BleLinkError('INVALID_BODY', `Frame length ${maxFrameLength} too small`);
  }
  const chunkCount = Math.max(1, Math.ceil(payload.length / chunkSize));
  if (chunkCount > 255) {
    throw new BleLinkError('MESSAGE_TOO_LARGE', `Message needs ${chunkCount} frames`);
  }
  const frames: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const slice = payload.subarray(index * chunkSize, (index + 1) * chunkSize);
    const frame = new Uint8Array(FRAME_HEADER_LENGTH + slice.length);
    frame[0] = messageId & 0xff;
    frame[1] = index;
    frame[2] = chunkCount;
    frame.set(slice, FRAME_HEADER_LENGTH);
    frames.push(frame);
  }
  return frames;
}

type Pending = {
  messageId: number;
  chunkCount: number;
  nextIndex: number;
  parts: Uint8Array[];
  startedAt: number;
};

/**
 * Reassembles frames from one sender. BLE delivers writes and notifications on
 * a characteristic in order, so frames are expected sequentially; anything out
 * of order drops the partial message.
 */
export class Reassembler {
  private pending: Pending | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length < FRAME_HEADER_LENGTH) {
      return null;
    }
    const messageId = frame[0];
    const index = frame[1];
    const chunkCount = frame[2];
    const body = frame.subarray(FRAME_HEADER_LENGTH);

    if (
      this.pending &&
      this.now() - this.pending.startedAt > REASSEMBLY_TIMEOUT_MS
    ) {
      this.pending = null;
    }

    if (index === 0) {
      this.pending = {
        messageId,
        chunkCount,
        nextIndex: 0,
        parts: [],
        startedAt: this.now(),
      };
    }
    const p = this.pending;
    if (
      !p ||
      p.messageId !== messageId ||
      p.chunkCount !== chunkCount ||
      p.nextIndex !== index
    ) {
      this.pending = null;
      return null;
    }

    p.parts.push(body.slice());
    p.nextIndex++;
    if (p.nextIndex < p.chunkCount) {
      return null;
    }

    this.pending = null;
    const total = p.parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of p.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  reset(): void {
    this.pending = null;
  }
}

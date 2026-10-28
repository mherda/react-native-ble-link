import { decodeJson, encodeJson } from './codec';
import { parseEnvelope, type Envelope, type ParseResult } from './envelope';
import { Reassembler, splitIntoFrames } from './framing';

type ChannelOptions = {
  sendFrame: (frame: Uint8Array) => Promise<void>;
  maxFrameLength: () => number;
  onEnvelope: (result: ParseResult) => void;
  now?: () => number;
};

/**
 * One direction-pair of framed JSON messages over a BLE link: frames outgoing
 * envelopes and reassembles incoming ones. Sends are serialised so frames of
 * different messages never interleave.
 */
export class MessageChannel {
  private nextMessageId = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly reassembler: Reassembler;

  constructor(private readonly options: ChannelOptions) {
    this.reassembler = new Reassembler(options.now);
  }

  send(envelope: Envelope): Promise<void> {
    const payload = encodeJson(envelope);
    const messageId = this.nextMessageId;
    this.nextMessageId = (this.nextMessageId + 1) & 0xff;

    const run = async () => {
      const frames = splitIntoFrames(
        messageId,
        payload,
        this.options.maxFrameLength(),
      );
      for (const frame of frames) {
        await this.options.sendFrame(frame);
      }
    };
    const result = this.sendQueue.then(run, run);
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  receiveFrame(frame: Uint8Array): void {
    const message = this.reassembler.push(frame);
    if (!message) {
      return;
    }
    let value: unknown;
    try {
      value = decodeJson(message);
    } catch {
      this.options.onEnvelope({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Invalid JSON',
      });
      return;
    }
    this.options.onEnvelope(parseEnvelope(value));
  }

  reset(): void {
    this.reassembler.reset();
  }
}

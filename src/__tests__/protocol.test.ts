import {
  base64Decode,
  base64Encode,
  utf8Decode,
  utf8Encode,
} from '../protocol/codec';
import { Reassembler, splitIntoFrames } from '../protocol/framing';

describe('codec', () => {
  it.each(['', 'a', 'ab', 'abc', 'Zażółć gęślą jaźń', 'emoji 🎉 ok'])(
    'round-trips %j through utf8 and base64',
    text => {
      const bytes = utf8Encode(text);
      expect(utf8Decode(base64Decode(base64Encode(bytes)))).toBe(text);
    },
  );

  it('matches the standard base64 alphabet', () => {
    expect(base64Encode(utf8Encode('hello?'))).toBe('aGVsbG8/');
    expect(base64Encode(Uint8Array.from([0xfb, 0xff]))).toBe('+/8=');
  });
});

describe('framing', () => {
  const payload = utf8Encode('x'.repeat(100));

  it('splits into frames that fit and reassembles them', () => {
    const frames = splitIntoFrames(7, payload, 20);
    expect(frames).toHaveLength(Math.ceil(100 / 17));
    expect(frames.every(f => f.length <= 20)).toBe(true);
    const r = new Reassembler();
    const results = frames.map(f => r.push(f));
    expect(results.slice(0, -1).every(x => x === null)).toBe(true);
    expect(utf8Decode(results[results.length - 1]!)).toBe('x'.repeat(100));
  });

  it('drops a message when a frame is missing', () => {
    const frames = splitIntoFrames(1, payload, 20);
    const r = new Reassembler();
    r.push(frames[0]);
    expect(r.push(frames[2])).toBeNull();
    // A new message still works afterwards.
    const single = splitIntoFrames(2, utf8Encode('ok'), 20);
    expect(utf8Decode(r.push(single[0])!)).toBe('ok');
  });

  it('drops a stale partial message', () => {
    let now = 0;
    const frames = splitIntoFrames(1, payload, 20);
    const r = new Reassembler(() => now);
    r.push(frames[0]);
    now = 10_000;
    expect(r.push(frames[1])).toBeNull();
  });

  it('rejects oversized messages', () => {
    expect(() => splitIntoFrames(0, new Uint8Array(5000), 20)).toThrow(
      /max is 4096/,
    );
  });
});

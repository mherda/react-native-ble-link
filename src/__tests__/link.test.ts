import { Central } from '../central/Central';
import type { Connection } from '../central/Connection';
import { BleLinkError } from '../errors';
import { Peripheral } from '../peripheral/Peripheral';
import { FakeRadio } from '../transport/fake';

type HubState =
  | { screen: 'idle' }
  | { screen: 'location'; data: { locationId: string } }
  | { screen: 'payment'; data: { invoiceId: string } };

async function setup() {
  const radio = new FakeRadio();
  const hub = new Peripheral<HubState>(
    { hubId: 'T-1', displayName: 'Front desk' },
    radio.createPeripheralTransport('hub-1'),
  );
  await hub.start();
  const phoneA = new Central({}, radio.createCentralTransport('phone-a'));
  const phoneB = new Central({}, radio.createCentralTransport('phone-b'));
  return { radio, hub, phoneA, phoneB };
}

async function findHub(central: Central): Promise<string> {
  return new Promise(resolve => {
    const stop = central.scan({
      onHubs: hubs => {
        if (hubs.length > 0) {
          stop();
          resolve(hubs[0].deviceId);
        }
      },
    });
  });
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BleLinkError ? e.code : String(e)),
  );

describe('hub ↔ phone link', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const open: Connection[] = [];

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map(c => c.disconnect()));
    await ctx.hub.stop();
  });

  async function connect(central: Central) {
    const conn = await central.connect(await findHub(central));
    open.push(conn);
    return conn;
  }

  it('scans by advertised hub ID and reads info', async () => {
    const hubs = await new Promise<{ hubId: string | null }[]>(resolve => {
      const stop = ctx.phoneA.scan({
        onHubs: t => {
          if (t.length) {
            stop();
            resolve(t);
          }
        },
      });
    });
    expect(hubs[0].hubId).toBe('T-1');
    const conn = await connect(ctx.phoneA);
    expect(await conn.hello()).toEqual({
      v: 1,
      hubId: 'T-1',
      displayName: 'Front desk',
    });
  });

  it('lists open connections and scan status', async () => {
    const { phoneA } = ctx;
    expect(phoneA.isScanning).toBe(false);
    const stop = phoneA.scan({ onHubs: () => undefined });
    expect(phoneA.isScanning).toBe(true);
    stop();
    expect(phoneA.isScanning).toBe(false);

    const conn = await connect(phoneA);
    expect(phoneA.isScanning).toBe(false);
    expect(phoneA.connections).toEqual([conn]);
    expect(phoneA.getConnection(conn.deviceId)).toBe(conn);

    await conn.disconnect();
    expect(phoneA.connections).toEqual([]);
    expect(phoneA.getConnection(conn.deviceId)).toBeUndefined();
  });

  it('check-in: reads location and gets a reply to a long request', async () => {
    ctx.hub.setState(
      { screen: 'location', data: { locationId: 'L-12' } },
      { newSession: true },
    );
    ctx.hub.handle('checkin.request', (body: { userName: string }) => ({
      welcome: `Welcome, ${body.userName}`,
    }));

    const conn = await connect(ctx.phoneA);
    const state = await conn.readState<HubState>();
    expect(state.screen).toBe('location');

    // Long enough to need many 20-byte frames in both directions.
    const userName = 'Anna '.repeat(40).trim();
    const res = await conn.request<{ welcome: string }>('checkin.request', {
      userName,
    });
    expect(res.welcome).toBe(`Welcome, ${userName}`);
  });

  it('reports every received message on both sides', async () => {
    ctx.hub.handle('checkin.request', () => ({ welcome: 'hi' }));
    const hubReceived = jest.fn();
    const phoneReceived = jest.fn();
    ctx.hub.on('received', hubReceived);
    ctx.phoneA.on('received', phoneReceived);

    const conn = await connect(ctx.phoneA);
    await conn.readState();
    await conn.request('checkin.request', { userName: 'Anna' });
    await errorCode(conn.request('nope', null));

    expect(hubReceived.mock.calls.map(([m]) => [m.kind, m.type])).toEqual([
      ['req', 'checkin.request'],
      ['req', 'nope'],
    ]);
    expect(hubReceived.mock.calls[0][0].body).toEqual({ userName: 'Anna' });
    expect(phoneReceived.mock.calls.map(([m]) => [m.kind, m.type, m.ok])).toEqual([
      ['read', 'state', undefined],
      ['res', 'checkin.request', true],
      ['res', 'nope', false],
    ]);
    expect(phoneReceived.mock.calls[1][0].body).toEqual({ welcome: 'hi' });
  });

  it('pushes state changes to connected phones', async () => {
    const conn = await connect(ctx.phoneA);
    await conn.readState();
    const changed = new Promise<string>(resolve =>
      conn.on('stateChanged', s => resolve(s.screen)),
    );
    ctx.hub.setState(
      { screen: 'payment', data: { invoiceId: 'INV-1' } },
      { newSession: true },
    );
    expect(await changed).toBe('payment');
  });

  it('payment: claim survives disconnect; other phones are locked out', async () => {
    ctx.hub.setState(
      { screen: 'payment', data: { invoiceId: 'INV-1' } },
      { newSession: true, claimable: true },
    );
    const completed = jest.fn((body: { invoiceId: string }) => ({
      confirmed: body.invoiceId === 'INV-1',
    }));
    ctx.hub.handle('payment.completed', completed, { requireClaim: true });

    // Phone A reads and claims, then disconnects to pay.
    let a = await connect(ctx.phoneA);
    await a.readState();
    await a.claim();
    expect(ctx.hub.snapshot.claimed).toBe(true);
    await a.disconnect();

    // Phone B is locked out meanwhile.
    const b = await connect(ctx.phoneB);
    const bState = await b.readState();
    expect(bState.claimed).toBe(true);
    expect(await errorCode(b.claim())).toBe('SESSION_BUSY');
    expect(
      await errorCode(b.request('payment.completed', { invoiceId: 'INV-1' })),
    ).toBe('SESSION_BUSY');

    // Phone A comes back and reports payment.
    a = await ctx.phoneA.reconnect({ hubId: 'T-1' });
    open.push(a);
    await a.readState();
    const res = await a.request('payment.completed', { invoiceId: 'INV-1' });
    expect(res).toEqual({ confirmed: true });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('rejects requests for an old session', async () => {
    ctx.hub.setState(
      { screen: 'payment', data: { invoiceId: 'INV-1' } },
      { newSession: true },
    );
    ctx.hub.handle('payment.completed', () => ({ confirmed: true }));
    const conn = await connect(ctx.phoneA);
    await conn.readState();

    // Hub moves on; simulate a request that raced the state push.
    const staleSession = conn.currentSession;
    const changed = new Promise(resolve => conn.on('stateChanged', resolve));
    ctx.hub.setState({ screen: 'idle' }, { newSession: true });
    await changed;
    expect(conn.currentSession).not.toBe(staleSession);
    (conn as unknown as { session: string | null }).session = staleSession;
    expect(await errorCode(conn.request('payment.completed', {}))).toBe(
      'SESSION_EXPIRED',
    );
  });

  it('reports unknown request types and handler errors', async () => {
    ctx.hub.handle('boom', () => {
      throw new Error('kaput');
    });
    const conn = await connect(ctx.phoneA);
    await conn.readState();
    expect(await errorCode(conn.request('nope', null))).toBe('UNKNOWN_TYPE');
    expect(await errorCode(conn.request('boom', null))).toBe('HANDLER_ERROR');
  });

  it('matches concurrent replies to their requests, including out of order', async () => {
    ctx.hub.handle(
      'echo',
      async ({ n, waitMs }: { n: number; waitMs: number }) => {
        await new Promise<void>(r => setTimeout(r, waitMs));
        return { n };
      },
      { requireSession: false },
    );
    const conn = await connect(ctx.phoneA);
    const replies = await Promise.all(
      [30, 0, 15].map((waitMs, n) => conn.request<{ n: number }>('echo', { n, waitMs })),
    );
    expect(replies.map(r => r.n)).toEqual([0, 1, 2]);
  });

  it('fails pending requests when the link drops', async () => {
    ctx.hub.handle('slow', () => new Promise(() => undefined));
    const conn = await connect(ctx.phoneA);
    await conn.readState();
    const pending = errorCode(conn.request('slow', null));
    await new Promise<void>(r => setTimeout(r, 5));
    ctx.radio.dropConnection('phone-a');
    expect(await pending).toBe('DISCONNECTED');
    expect(conn.isConnected).toBe(false);
  });
});

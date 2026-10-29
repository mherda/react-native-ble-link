import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  createPeripheral,
  isPeripheralSupported,
  type Peripheral,
  type StateSnapshot,
} from 'react-native-ble-link';
import { prepareBluetooth } from './bluetooth';
import { Button, Card, Code, Field, Log, Muted, Row, Toggle, describeMessage, parseJson, useLog } from './ui';

const short = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/**
 * The hub role: advertise, publish a state, answer requests, push events.
 * Built-in request types for phones to try: `echo`, `time`, `counter`.
 */
export function HubScreen() {
  const hubRef = useRef<Peripheral | null>(null);
  const [running, setRunning] = useState(false);
  const [hubId, setHubId] = useState('EXAMPLE');
  const [displayName, setDisplayName] = useState('Example hub');
  const [screen, setScreen] = useState('home');
  const [data, setData] = useState('{ "message": "Hello from the hub" }');
  const [claimable, setClaimable] = useState(false);
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [phones, setPhones] = useState<string[]>([]);
  const [claimedBy, setClaimedBy] = useState<string | null>(null);
  const log = useLog();

  useEffect(() => () => void hubRef.current?.stop(), []);

  async function start() {
    try {
      if (!(await isPeripheralSupported())) {
        return Alert.alert('Not supported', "This device's Bluetooth chip can't act as a hub.");
      }
      const problem = await prepareBluetooth('peripheral');
      if (problem) return Alert.alert('Bluetooth', problem);

      const hub = createPeripheral({ hubId: hubId.trim(), displayName: displayName.trim() });
      let counter = 0;
      hub.handle('echo', body => body, { requireSession: false });
      hub.handle('time', () => ({ now: new Date().toISOString() }), { requireSession: false });
      hub.handle('counter', () => ({ value: ++counter }));

      hub.on('received', (m, centralId) => log.add(`${short(centralId)} ${describeMessage(m)}`));
      hub.on('centralConnected', id => {
        log.add(`+ phone ${short(id)} connected`, 'ok');
        setPhones([...hub.connectedCentrals]);
      });
      hub.on('centralDisconnected', id => {
        log.add(`− phone ${short(id)} disconnected`);
        setPhones([...hub.connectedCentrals]);
      });
      hub.on('sessionClaimed', token => {
        log.add(`claimed by client ${short(token)}`, 'ok');
        setClaimedBy(token);
        setSnapshot(hub.snapshot);
      });
      hub.on('sessionReleased', (token, reason) => {
        log.add(`claim released (${reason})`);
        setClaimedBy(null);
        setSnapshot(hub.snapshot);
      });
      hub.on('error', e => log.add(`error: ${e.message}`, 'error'));

      hub.setState({ screen, data: parseJson(data, 'Data') }, { newSession: true, claimable });
      await hub.start();
      hubRef.current = hub;
      setSnapshot(hub.snapshot);
      setRunning(true);
      log.add(`advertising as ${hubId}`, 'ok');
    } catch (e) {
      Alert.alert("Couldn't start", (e as Error).message);
    }
  }

  async function stop() {
    await hubRef.current?.stop();
    hubRef.current = null;
    setRunning(false);
    setPhones([]);
    setClaimedBy(null);
    log.add('stopped');
  }

  function applyState(newSession: boolean) {
    const hub = hubRef.current;
    if (!hub) return;
    try {
      hub.setState({ screen, data: parseJson(data, 'Data') }, { newSession, claimable });
      setSnapshot(hub.snapshot);
      log.add(newSession ? 'new session started' : 'state updated');
    } catch (e) {
      Alert.alert('State', (e as Error).message);
    }
  }

  async function broadcast() {
    await hubRef.current?.emit('hello', { from: displayName, at: new Date().toISOString() });
    log.add('→ event hello to all phones');
  }

  return (
    <>
      <Card title="Hub">
        <Field label="Hub ID (advertised, ≤ 8 characters)" value={hubId} onChangeText={setHubId} maxLength={8} editable={!running} />
        <Field label="Display name" value={displayName} onChangeText={setDisplayName} editable={!running} />
        <Row>
          {running ? <Button title="Stop" kind="danger" onPress={stop} /> : <Button title="Start hub" onPress={start} />}
        </Row>
        {running && (
          <Muted>
            {phones.length} phone{phones.length === 1 ? '' : 's'} connected
            {claimedBy ? ` · claimed by ${short(claimedBy)}` : ''}
          </Muted>
        )}
      </Card>

      <Card title="State">
        <Field label="Screen" value={screen} onChangeText={setScreen} />
        <Field label="Data (JSON)" value={data} onChangeText={setData} multiline />
        <Toggle label="Claimable (one phone at a time)" value={claimable} onChange={setClaimable} />
        <Row>
          <Button title="Update state" kind="secondary" onPress={() => applyState(false)} disabled={!running} />
          <Button title="New session" kind="secondary" onPress={() => applyState(true)} disabled={!running} />
          <Button title="Send event" kind="secondary" onPress={broadcast} disabled={!running} />
        </Row>
        {snapshot && <Code value={snapshot} />}
        <Muted>Phones can call: echo (any body), time, counter (needs the current session).</Muted>
      </Card>

      <Card title="Log" right={<Button title="Clear" kind="secondary" onPress={log.clear} />}>
        <Log entries={log.entries} />
      </Card>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  createCentral,
  isBleLinkError,
  type Connection,
  type HubInfo,
  type NearbyHub,
  type StateSnapshot,
} from 'react-native-ble-link';
import { prepareBluetooth } from './bluetooth';
import { Button, Card, Code, Field, Log, Muted, Row, describeMessage, parseJson, useColors, useLog } from './ui';

/**
 * The phone role: scan for hubs, connect, read the state, send requests and
 * receive events. Works with any hub using the default UUIDs, including the
 * Hub screen of this app on another device.
 */
export function PhoneScreen() {
  const c = useColors();
  const central = useMemo(() => createCentral(), []);
  const stopScanRef = useRef<(() => void) | null>(null);
  const [hubs, setHubs] = useState<NearbyHub[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [type, setType] = useState('echo');
  const [body, setBody] = useState('{ "hello": "hub" }');
  const [reply, setReply] = useState<unknown>(undefined);
  const log = useLog();

  useEffect(() => {
    const off = central.on('received', m => log.add(describeMessage(m)));
    return () => {
      off();
      stopScanRef.current?.();
      void central.destroy();
    };
  }, [central]);

  async function startScan() {
    const problem = await prepareBluetooth('central');
    if (problem) return Alert.alert('Bluetooth', problem);
    setHubs([]);
    stopScanRef.current = central.scan({
      onHubs: setHubs,
      onError: e => {
        log.add(`scan error: ${e.message}`, 'error');
        setScanning(false);
      },
    });
    setScanning(true);
  }

  function stopScan() {
    stopScanRef.current?.();
    stopScanRef.current = null;
    setScanning(false);
  }

  async function connect(hub: NearbyHub) {
    stopScan();
    setConnecting(hub.deviceId);
    try {
      const connection = await central.connect(hub.deviceId);
      connection.on('stateChanged', setState);
      connection.on('event', (eventType, eventBody) => log.add(`event ${eventType} ${JSON.stringify(eventBody)}`, 'ok'));
      connection.on('disconnected', error => {
        log.add(error ? `disconnected: ${error}` : 'disconnected', error ? 'error' : undefined);
        setConn(null);
        setState(null);
        setInfo(null);
      });
      setConn(connection);
      log.add(`connected to ${hub.hubId ?? hub.deviceId}`, 'ok');
      setInfo(await connection.readInfo());
      setState(await connection.readState());
    } catch (e) {
      Alert.alert("Couldn't connect", (e as Error).message);
    } finally {
      setConnecting(null);
    }
  }

  async function run(label: string, action: (c: Connection) => Promise<unknown>) {
    if (!conn) return;
    try {
      const result = await action(conn);
      setReply(result);
      log.add(`${label} ok`, 'ok');
    } catch (e) {
      const message = isBleLinkError(e) ? `${e.code}: ${e.message}` : (e as Error).message;
      setReply({ error: message });
      log.add(`${label} failed: ${message}`, 'error');
    }
  }

  return (
    <>
      {!conn && (
        <Card
          title="Nearby hubs"
          right={scanning ? <Button title="Stop" kind="secondary" onPress={stopScan} /> : <Button title="Scan" onPress={startScan} />}
        >
          {hubs.length === 0 ? (
            <Muted>{scanning ? 'Looking for hubs…' : 'Tap Scan to look for hubs nearby.'}</Muted>
          ) : (
            hubs.map(hub => (
              <Pressable
                key={hub.deviceId}
                onPress={() => connect(hub)}
                disabled={connecting !== null}
                style={({ pressed }) => [styles.hub, { borderColor: c.border }, pressed && { opacity: 0.6 }]}
              >
                <View style={styles.hubText}>
                  <Text style={[styles.hubId, { color: c.text }]}>{hub.hubId ?? '(reading ID…)'}</Text>
                  <Muted>{hub.deviceId}</Muted>
                </View>
                <Text style={{ color: c.muted }}>
                  {connecting === hub.deviceId ? 'connecting…' : `${Math.round(hub.rssi)} dBm`}
                </Text>
              </Pressable>
            ))
          )}
        </Card>
      )}

      {conn && (
        <>
          <Card title={`Connected · ${info?.displayName ?? info?.hubId ?? conn.deviceId}`}>
            <Row>
              <Button title="Read state" kind="secondary" onPress={() => run('read state', async c => setState(await c.readState()))} />
              <Button title="Ping" kind="secondary" onPress={() => run('ping', c => c.request('link.ping', null))} />
              <Button title="Claim" kind="secondary" onPress={() => run('claim', c => c.claim())} />
              <Button title="Release" kind="secondary" onPress={() => run('release', c => c.release())} />
              <Button title="Disconnect" kind="danger" onPress={() => conn.disconnect()} />
            </Row>
            {state && <Code value={state} />}
          </Card>

          <Card title="Send a request">
            <Field label="Type" value={type} onChangeText={setType} />
            <Field label="Body (JSON)" value={body} onChangeText={setBody} multiline />
            <Row>
              <Button title="Send" onPress={() => run(type, c => c.request(type, parseJson(body, 'Body')))} />
            </Row>
            {reply !== undefined && <Code value={reply} />}
            <Muted>The example hub answers echo, time and counter.</Muted>
          </Card>
        </>
      )}

      <Card title="Log" right={<Button title="Clear" kind="secondary" onPress={log.clear} />}>
        <Log entries={log.entries} />
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  hub: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    gap: 12,
  },
  hubText: { flex: 1, gap: 2 },
  hubId: { fontSize: 16, fontWeight: '600' },
});

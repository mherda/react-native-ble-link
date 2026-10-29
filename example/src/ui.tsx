import { useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useColorScheme,
  type TextInputProps,
} from 'react-native';
import type { ReceivedMessage } from 'react-native-ble-link';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const light = {
  bg: '#f4f5f7',
  card: '#ffffff',
  text: '#16181d',
  muted: '#6b7280',
  border: '#e2e4e9',
  accent: '#2f6fed',
  accentText: '#ffffff',
  danger: '#c93a3a',
  ok: '#1f8a4c',
  code: '#f0f2f5',
};
const dark: typeof light = {
  bg: '#0f1115',
  card: '#181b21',
  text: '#eceef2',
  muted: '#9aa1ad',
  border: '#2a2f38',
  accent: '#5b8dff',
  accentText: '#0f1115',
  danger: '#ff6b6b',
  ok: '#4cd38a',
  code: '#20242c',
};
export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.cardHeader}>
        <Text style={[styles.cardTitle, { color: c.muted }]}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  const c = useColors();
  const bg = kind === 'primary' ? c.accent : 'transparent';
  const fg = kind === 'primary' ? c.accentText : kind === 'danger' ? c.danger : c.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'danger' ? c.danger : c.accent },
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 },
      ]}
    >
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={c.muted}
        {...props}
        style={[
          styles.input,
          { color: c.text, borderColor: c.border, backgroundColor: c.code },
          props.multiline && styles.multiline,
        ]}
      />
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <View style={styles.toggle}>
      <Text style={{ color: c.text }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.small, { color: c.muted }]}>{children}</Text>;
}

export function Code({ value }: { value: unknown }) {
  const c = useColors();
  return (
    <ScrollView horizontal style={[styles.code, { backgroundColor: c.code }]}>
      <Text style={[styles.mono, { color: c.text }]}>{JSON.stringify(value, null, 2)}</Text>
    </ScrollView>
  );
}

export type LogEntry = { id: number; at: Date; text: string; tone?: 'ok' | 'error' };

/** A short log of what happened, newest first. */
export function useLog(limit = 60) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const add = (text: string, tone?: LogEntry['tone']) =>
    setEntries(prev => [{ id: Date.now() + Math.random(), at: new Date(), text, tone }, ...prev].slice(0, limit));
  return { entries, add, clear: () => setEntries([]) };
}

export function Log({ entries }: { entries: LogEntry[] }) {
  const c = useColors();
  if (entries.length === 0) return <Muted>Nothing yet.</Muted>;
  return (
    <View>
      {entries.map(e => (
        <Text
          key={e.id}
          style={[styles.mono, styles.logLine, { color: e.tone === 'error' ? c.danger : e.tone === 'ok' ? c.ok : c.text }]}
        >
          <Text style={{ color: c.muted }}>{e.at.toLocaleTimeString()} </Text>
          {e.text}
        </Text>
      ))}
    </View>
  );
}

export function describeMessage(m: ReceivedMessage): string {
  const body = (v: unknown) => (v === undefined ? '' : ' ' + JSON.stringify(v));
  switch (m.kind) {
    case 'req':
      return `← request ${m.type}${body(m.body)}`;
    case 'res':
      return m.ok ? `← reply ${m.type}${body(m.body)}` : `← error ${m.type}: ${m.error.code}`;
    case 'evt':
      return `← event ${m.type}${m.type === 'state.changed' ? '' : body(m.body)}`;
    case 'read':
      return `← read ${m.type}`;
  }
}

/** Parses JSON typed into a text field; throws a readable error. */
export function parseJson(text: string, field: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${field} isn't valid JSON`);
  }
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, marginBottom: 12, gap: 10 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignItems: 'center' },
  buttonText: { fontWeight: '600', fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  field: { gap: 4 },
  label: { fontSize: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  multiline: { minHeight: 64, textAlignVertical: 'top', fontFamily: MONO },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  small: { fontSize: 13 },
  code: { borderRadius: 8, padding: 10, maxHeight: 220 },
  mono: { fontFamily: MONO, fontSize: 12 },
  logLine: { paddingVertical: 2 },
});

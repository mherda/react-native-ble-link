import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { HubScreen } from './src/HubScreen';
import { PhoneScreen } from './src/PhoneScreen';
import { useColors } from './src/ui';

type Role = 'phone' | 'hub';

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const c = useColors();
  const [role, setRole] = useState<Role>('phone');

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.bg }]} edges={['top', 'left', 'right']}>
      <StatusBar style="auto" />
      <View style={styles.header}>
        <Text style={[styles.title, { color: c.text }]}>BLE Link</Text>
        <View style={[styles.segment, { borderColor: c.border, backgroundColor: c.card }]}>
          {(['phone', 'hub'] as const).map(r => (
            <Pressable
              key={r}
              onPress={() => setRole(r)}
              style={[styles.segmentItem, role === r && { backgroundColor: c.accent }]}
            >
              <Text style={[styles.segmentText, { color: role === r ? c.accentText : c.text }]}>
                {r === 'phone' ? 'Phone' : 'Hub'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Switching role unmounts the other one, which stops its hub or scan. */}
          {role === 'phone' ? <PhoneScreen /> : <HubScreen />}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { fontSize: 22, fontWeight: '700' },
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 2 },
  segmentItem: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 7 },
  segmentText: { fontWeight: '600' },
  content: { padding: 16, paddingBottom: 40, width: '100%', maxWidth: 720, alignSelf: 'center' },
});

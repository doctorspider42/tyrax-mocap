// TyraX Mocap: point the phone at somebody, watch the skeleton land on them,
// record, hand the take to the editor. One screen on purpose - the phone is a
// capture device, not a DAW.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, FlatList, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import * as Body from './modules/tyrax-body';

const TAKES_DIR = FileSystem.documentDirectory + 'takes/';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// "AVCaptureDeviceTypeBuiltInUltraWideCamera" -> "ultra wide". The lens is the
// only part of a format that changes how you have to stand, so it leads.
function lensName(raw) {
  if (!raw) return '';
  const m = /BuiltIn(\w+?)Camera$/.exec(raw);
  if (!m) return '';
  return m[1]
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/Dual Wide/i, 'dual wide')
    .toLowerCase();
}

function formatLabel(f) {
  const lens = lensName(f.lens);
  return `${lens ? lens + ' · ' : ''}${f.width}×${f.height} · ${f.fps} fps`;
}

export default function App() {
  const [supported] = useState(() => Body.available && Body.isSupported());
  const [status, setStatus] = useState({ tracking: 'idle', body: false, frames: 0, elapsed: 0 });
  const [recording, setRecording] = useState(false);
  const [takes, setTakes] = useState([]);
  const [note, setNote] = useState('');
  const [formats, setFormats] = useState([]);
  const [formatIndex, setFormatIndex] = useState(-1);
  const [showFormats, setShowFormats] = useState(false);
  const counter = useRef(1);

  const refreshTakes = useCallback(async () => {
    try {
      const info = await FileSystem.getInfoAsync(TAKES_DIR);
      if (!info.exists) return setTakes([]);
      const names = await FileSystem.readDirectoryAsync(TAKES_DIR);
      const rows = await Promise.all(
        names
          .filter((n) => n.endsWith('.tmocap'))
          .map(async (n) => {
            const st = await FileSystem.getInfoAsync(TAKES_DIR + n, { size: true });
            return { name: n, uri: TAKES_DIR + n, size: st.size || 0, at: st.modificationTime || 0 };
          }),
      );
      rows.sort((a, b) => b.at - a.at);
      setTakes(rows);
    } catch (e) {
      setNote(String(e));
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    const sub = Body.addStatusListener(setStatus);
    Body.start();
    setFormats(Body.videoFormats());
    refreshTakes();
    return () => {
      sub.remove();
      Body.stop();
    };
  }, [supported, refreshTakes]);

  const pickFormat = useCallback((index) => {
    // Switching restarts tracking, so refuse mid-take rather than splicing a
    // discontinuity into the recording.
    if (recording) {
      setNote('Stop the recording before changing the lens.');
      return;
    }
    Body.setVideoFormat(index);
    setFormatIndex(index);
    setShowFormats(false);
  }, [recording]);

  const toggleRecord = useCallback(async () => {
    if (!recording) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      const name = `take-${stamp}-${counter.current++}`;
      if (!Body.startRecording(name, 30)) {
        setNote('Could not start - is the session running?');
        return;
      }
      setNote('');
      setRecording(true);
      // A take is useless if the screen sleeps halfway through it.
      activateKeepAwakeAsync('recording').catch(() => {});
      return;
    }
    setRecording(false);
    deactivateKeepAwake('recording').catch(() => {});
    const take = await Body.stopRecording();
    if (!take) {
      setNote('Nothing recorded - the camera never saw a whole body.');
      return;
    }
    setNote(`Saved ${take.name}: ${take.frames} frames, ${take.duration.toFixed(1)} s, ` +
            `${take.joints} joints, ${formatBytes(take.bytes)}`);
    refreshTakes();
  }, [recording, refreshTakes]);

  const share = useCallback(async (take) => {
    if (!(await Sharing.isAvailableAsync())) {
      setNote('Sharing is not available on this device.');
      return;
    }
    // AirDrop to the machine running the editor is the shortest route; "Save to
    // Files" and any cloud drive work just as well.
    await Sharing.shareAsync(take.uri, {
      dialogTitle: 'Send the take to the editor',
      UTI: 'public.data',
      mimeType: 'application/octet-stream',
    });
  }, []);

  const remove = useCallback((take) => {
    Alert.alert('Delete take?', take.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await FileSystem.deleteAsync(take.uri, { idempotent: true });
          refreshTakes();
        },
      },
    ]);
  }, [refreshTakes]);

  if (!supported) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={styles.centered}>
          <Text style={styles.title}>Body tracking unavailable</Text>
          <Text style={styles.body}>
            ARKit body tracking needs an A12 chip or newer - iPhone XS and up.
            {'\n\n'}
            {Body.available
              ? 'This device reports no support for it.'
              : 'The native module is missing from this build.'}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const trackingOk = status.tracking === 'normal';
  const current = formats.find((f) => f.index === formatIndex);
  const Preview = Body.BodyPreview;
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>TyraX Mocap</Text>
        <Text style={[styles.pill, trackingOk ? styles.pillOk : styles.pillWarn]}>
          {status.tracking}
        </Text>
      </View>

      <View style={styles.stage}>
        {Preview ? <Preview style={StyleSheet.absoluteFill} /> : null}
        <View style={styles.overlay} pointerEvents="none">
          <Text style={[styles.bodyState, status.body ? styles.ok : styles.warn]}>
            {status.body ? 'body in frame' : 'no body in frame'}
          </Text>
          {recording ? (
            <Text style={styles.counterText}>
              {status.frames} frames · {Number(status.elapsed || 0).toFixed(1)} s
            </Text>
          ) : (
            <Text style={styles.hint}>Get the WHOLE body in frame.</Text>
          )}
        </View>
      </View>

      {/* Lens picker. Body tracking is rear-camera only - ARKit has no front
          option - so what this really chooses is which rear lens and at what
          rate, and the wide one is how you film in a small room. */}
      {formats.length > 1 && (
        <Pressable onPress={() => setShowFormats((s) => !s)} style={styles.formatBar}>
          <Text style={styles.formatLabel}>
            {current ? formatLabel(current) : 'Camera: ARKit default'}
          </Text>
          <Text style={styles.formatChevron}>{showFormats ? '▲' : '▼'}</Text>
        </Pressable>
      )}
      {showFormats && (
        <View style={styles.formatList}>
          <Pressable onPress={() => pickFormat(-1)} style={styles.formatRow}>
            <Text style={[styles.formatRowText, formatIndex === -1 && styles.formatRowOn]}>
              ARKit default
            </Text>
          </Pressable>
          {formats.map((f) => (
            <Pressable key={f.index} onPress={() => pickFormat(f.index)} style={styles.formatRow}>
              <Text style={[styles.formatRowText, formatIndex === f.index && styles.formatRowOn]}>
                {formatLabel(f)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable
        onPress={toggleRecord}
        style={({ pressed }) => [
          styles.record,
          recording ? styles.recordOn : styles.recordOff,
          pressed && styles.pressed,
        ]}>
        <Text style={styles.recordLabel}>{recording ? 'Stop' : 'Record'}</Text>
      </Pressable>

      {!!note && <Text style={styles.note}>{note}</Text>}

      <Text style={styles.section}>TAKES</Text>
      <FlatList
        style={styles.list}
        data={takes}
        keyExtractor={(t) => t.name}
        ListEmptyComponent={<Text style={styles.hint}>Nothing recorded yet.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowName}>{item.name}</Text>
              <Text style={styles.rowMeta}>{formatBytes(item.size)}</Text>
            </View>
            <Pressable onPress={() => share(item)} style={styles.action}>
              <Text style={styles.actionLabel}>Send</Text>
            </Pressable>
            <Pressable onPress={() => remove(item)} style={styles.action}>
              <Text style={[styles.actionLabel, styles.danger]}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101216', paddingHorizontal: 18 },
  centered: { flexGrow: 1, justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  title: { color: '#f2f4f8', fontSize: 24, fontWeight: '700' },
  pill: { overflow: 'hidden', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12 },
  pillOk: { backgroundColor: '#1d3b26', color: '#7fe0a0' },
  pillWarn: { backgroundColor: '#3b331d', color: '#e8cf7f' },
  // The viewfinder gets the room: framing a whole person is the hard part.
  stage: { flex: 1, marginTop: 10, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, alignItems: 'center' },
  bodyState: { fontSize: 15, fontWeight: '600', textShadowColor: '#000', textShadowRadius: 6 },
  ok: { color: '#7fe0a0' },
  warn: { color: '#e8cf7f' },
  counterText: { color: '#fff', fontSize: 26, fontVariant: ['tabular-nums'], textShadowColor: '#000', textShadowRadius: 6 },
  hint: { color: '#c8ced8', fontSize: 13, marginTop: 4, textAlign: 'center', textShadowColor: '#000', textShadowRadius: 6 },
  body: { color: '#c3c9d4', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  formatBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  formatLabel: { color: '#9fb4cc', fontSize: 13 },
  formatChevron: { color: '#6f7787', fontSize: 11 },
  formatList: { backgroundColor: '#171a21', borderRadius: 10, marginBottom: 8, paddingVertical: 4 },
  formatRow: { paddingVertical: 9, paddingHorizontal: 12 },
  formatRowText: { color: '#c3c9d4', fontSize: 13 },
  formatRowOn: { color: '#7fb2e0', fontWeight: '700' },
  record: { borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  recordOff: { backgroundColor: '#2b6cb0' },
  recordOn: { backgroundColor: '#b03a2b' },
  pressed: { opacity: 0.75 },
  recordLabel: { color: '#fff', fontSize: 19, fontWeight: '700' },
  note: { color: '#9fb4cc', fontSize: 12, marginTop: 10 },
  section: { color: '#8b93a1', fontSize: 11, letterSpacing: 1, marginTop: 16, marginBottom: 4 },
  list: { maxHeight: 170 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#1c2029' },
  rowText: { flex: 1 },
  rowName: { color: '#e6eaf2', fontSize: 14 },
  rowMeta: { color: '#6f7787', fontSize: 12 },
  action: { paddingHorizontal: 10, paddingVertical: 6 },
  actionLabel: { color: '#7fb2e0', fontSize: 14 },
  danger: { color: '#e08080' },
});

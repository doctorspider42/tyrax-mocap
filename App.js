// TyraX Mocap: point the phone at somebody, watch the skeleton land on them,
// record, hand the take to the editor. One screen on purpose - the phone is a
// capture device, not a DAW.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, FlatList, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text,
  TextInput, View,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import * as Body from './modules/tyrax-body';
import { Link } from './src/link';
import { base64ToBytes } from './src/protocol';

const TAKES_DIR = FileSystem.documentDirectory + 'takes/';
// Typing an IP on a phone once is fine; typing it every session is not.
const LINK_FILE = FileSystem.documentDirectory + 'link.json';

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
  const [address, setAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [linkState, setLinkState] = useState('idle');
  const [linkError, setLinkError] = useState('');
  const [sent, setSent] = useState(0);
  const counter = useRef(1);
  const link = useRef(null);
  if (!link.current) link.current = new Link();

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
    FileSystem.readAsStringAsync(LINK_FILE)
      .then((raw) => {
        const saved = JSON.parse(raw);
        setAddress(saved.address || '');
        setPairCode(saved.code || '');
      })
      .catch(() => {});
    return () => {
      sub.remove();
      Body.stop();
    };
  }, [supported, refreshTakes]);

  // The pump: every frame the native side packs goes straight out. The skeleton
  // leads - the editor throws away frames that arrive before it, since there is
  // nothing to say which rotation belongs to which joint.
  useEffect(() => {
    const l = link.current;
    l.onState = (s, err) => {
      setLinkState(s);
      setLinkError(err || '');
      if (s !== 'connected') {
        Body.setStreaming(false);
        setSent(0);
      }
    };
    const sub = Body.addFrameListener((f) => {
      if (!l.connected) return;
      if (!l.sentSkeleton) {
        const sk = Body.skeleton();
        if (!sk) return;   // ARKit has not handed over its definition yet
        l.sendSkeleton(sk, base64ToBytes(sk.rest));
        if (!l.sentSkeleton) return;
      }
      l.sendFrame(f.ts, base64ToBytes(f.rot), f.hips);
      setSent((n) => n + 1);
    });
    return () => {
      sub.remove();
      l.close();
    };
  }, []);

  const toggleLink = useCallback(() => {
    const l = link.current;
    if (l.state === 'connecting' || l.connected) {
      l.close();
      return;
    }
    l.connect(address, pairCode, {
      name: 'iPhone',
      model: Platform.constants?.systemName ? `iOS ${Platform.Version}` : '',
      client: 'TyraX Mocap',
    });
    Body.setStreaming(true, 30);
    FileSystem.writeAsStringAsync(LINK_FILE, JSON.stringify({ address, code: pairCode }))
      .catch(() => {});
  }, [address, pairCode]);

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
        {Preview ? (
          <Preview style={StyleSheet.absoluteFill} />
        ) : (
          <View style={styles.noPreview}>
            <Text style={styles.body}>
              No viewfinder on this build
              {Body.previewError ? `: ${Body.previewError}` : ''}.
            </Text>
            <Text style={styles.hint}>
              Recording still works - aim by eye and watch the status below.
            </Text>
          </View>
        )}
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

      {/* Live link. The editor is the host - it has the fixed address and the
          screen showing the pairing code - so the phone joins, exactly as the
          camera app does, and to the same port. Streaming is independent of
          recording: watch the character move, then hit Record when the take is
          worth keeping. */}
      <Text style={styles.section}>LIVE LINK</Text>
      <View style={styles.linkRow}>
        <TextInput
          style={[styles.input, styles.inputWide]}
          value={address}
          onChangeText={setAddress}
          placeholder="editor address"
          placeholderTextColor="#5b6373"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          editable={linkState !== 'connected'}
        />
        <TextInput
          style={styles.input}
          value={pairCode}
          onChangeText={setPairCode}
          placeholder="code"
          placeholderTextColor="#5b6373"
          keyboardType="number-pad"
          maxLength={6}
          editable={linkState !== 'connected'}
        />
        <Pressable
          onPress={toggleLink}
          style={({ pressed }) => [
            styles.linkButton,
            linkState === 'connected' ? styles.linkOn : styles.linkOff,
            pressed && styles.pressed,
          ]}>
          <Text style={styles.linkLabel}>
            {linkState === 'connected' ? 'Stop' : linkState === 'connecting' ? '…' : 'Link'}
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.note, linkState === 'error' && styles.danger]}>
        {linkState === 'error'
          ? linkError
          : linkState === 'connected'
            ? `streaming · ${sent} frames sent`
            : 'The editor shows its address and code in Tools ▸ Phone Camera.'}
      </Text>

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
  noPreview: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
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
  linkRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    backgroundColor: '#171a21', borderRadius: 8, color: '#e6eaf2', fontSize: 14,
    paddingHorizontal: 10, paddingVertical: 9, marginRight: 8, width: 74,
  },
  inputWide: { flex: 1, width: undefined },
  linkButton: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  linkOff: { backgroundColor: '#2b6cb0' },
  linkOn: { backgroundColor: '#b03a2b' },
  linkLabel: { color: '#fff', fontSize: 14, fontWeight: '700' },
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

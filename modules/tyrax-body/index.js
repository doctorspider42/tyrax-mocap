// JS face of the ARKit body-tracking module. Optional on purpose: the app must
// still run on a device (or a simulator) without body tracking, telling the
// user what it cannot do rather than crashing on import.
// Imported from `expo` rather than `expo-modules-core`: SDK 51+ re-exports it,
// so the app needs no direct dependency on the core package.
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo';

const native = requireOptionalNativeModule('TyraxBody');

export const available = !!native;

// ARBodyTrackingConfiguration needs an A12 or later - iPhone XS and up.
export function isSupported() {
  return !!native && native.isSupported();
}

export function start() {
  if (native) native.start();
}

export function stop() {
  if (native) native.stop();
}

// Buffering happens natively: a take is ~5.8 KB per frame and does not belong
// on the JS bridge. `hz` caps the capture rate (ARKit solves at 60).
export function startRecording(name, hz = 30) {
  return native ? native.startRecording(name, hz) : false;
}

// Resolves to { path, uri, name, frames, duration, joints, bytes }, or null
// when nothing was recording or no frame ever saw a body.
export function stopRecording() {
  return native ? native.stopRecording() : Promise.resolve(null);
}

export function isRecording() {
  return native ? native.isRecording() : false;
}

// listener({ tracking, body, frames, elapsed, recording }) -> subscription
export function addStatusListener(listener) {
  return native ? native.addListener('onStatus', listener) : { remove() {} };
}

// The capture formats ARKit accepts for body tracking:
// [{ index, width, height, fps, lens, selected }]. There is no front/rear
// choice - body tracking is rear-camera only - but on a phone with several
// rear lenses this is where the wide one appears, which decides how far back
// the performer has to stand.
export function videoFormats() {
  return native ? native.videoFormats() : [];
}

// Restarts tracking on that format; -1 gives the choice back to ARKit.
export function setVideoFormat(index) {
  if (native) native.setVideoFormat(index);
}

// The live viewfinder: the camera with the tracked skeleton drawn over it.
// Null when the native module is absent, so the app can render around it.
export const BodyPreview = native ? requireNativeViewManager('TyraxBody') : null;

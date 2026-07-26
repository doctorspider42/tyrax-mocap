// JS face of the ARKit body-tracking module. Optional on purpose: the app must
// still run on a device (or a simulator) without body tracking, telling the
// user what it cannot do rather than crashing on import.
// Imported from `expo` rather than `expo-modules-core`: SDK 51+ re-exports it,
// so the app needs no direct dependency on the core package.
import { requireOptionalNativeModule } from 'expo';
// requireNativeViewManager comes from expo-modules-core, which `expo` does NOT
// re-export - importing it from `expo` yields undefined and the call below
// then throws while this module is still loading, which reads as a crash on
// launch. (It is always installed: `expo` depends on it.)
import { requireNativeViewManager } from 'expo-modules-core';

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

// The skeleton the editor needs once per session:
// { joints: string[], parents: number[], rest: base64 } - null until ARKit has
// handed over its definition.
export function skeleton() {
  return native ? native.skeleton() : null;
}

// Start/stop packing frames for the socket. `hz` caps the rate; the pose is
// packed natively and arrives as base64 through addFrameListener.
export function setStreaming(on, hz = 30) {
  if (native) native.setStreaming(!!on, hz);
}

// listener({ ts, rot, hips, root }) -> subscription. `rot` is base64 of 4 floats
// per joint in the skeleton's order; `hips` is the anchor's position and `root`
// its rotation - the body's heading, which is not in the skeleton at all.
export function addFrameListener(listener) {
  return native ? native.addListener('onFrame', listener) : { remove() {} };
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
//
// Resolved defensively. This runs at import time, so anything thrown here takes
// the whole app down before it draws a pixel - and a missing viewfinder is not
// worth an app that will not start, when recording works without one. If it
// fails, `previewError` says why and the UI shows it.
export let previewError = '';
export const BodyPreview = (() => {
  if (!native) return null;
  try {
    const view = requireNativeViewManager('TyraxBody');
    if (!view) previewError = 'the native view is not registered';
    return view || null;
  } catch (e) {
    previewError = String(e?.message || e);
    return null;
  }
})();

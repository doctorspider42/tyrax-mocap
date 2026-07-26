// The TyraX phone wire format, shared with tyrax-cam and with the editor's
// src/wire.cpp.
//
// One WebSocket BINARY message = one editor frame:
//   [u32 jsonLen][u32 binLen][jsonLen bytes UTF-8 JSON][binLen bytes raw]
// both lengths little-endian. The JSON part carries the message ("t" = type),
// the binary trailer the bulk payload. Keeping bytes out of the JSON is
// deliberate on the editor side - its JSON reader collapses \u escapes, so
// binary must never pass through it.

export const PROTO_VERSION = 1;

const textEncoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

export function encodeFrame(obj, bin) {
  const json = textEncoder.encode(JSON.stringify(obj));
  const body = bin || EMPTY;
  const out = new Uint8Array(8 + json.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, body.length, true);
  out.set(json, 8);
  out.set(body, 8 + json.length);
  return out;
}

// Returns { msg, bin } or null when the buffer is not a whole frame.
export function decodeFrame(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 8) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jsonLen = view.getUint32(0, true);
  const binLen = view.getUint32(4, true);
  if (u8.length < 8 + jsonLen + binLen) return null;
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jsonLen)));
  } catch (e) {
    return null;
  }
  return { msg, bin: u8.subarray(8 + jsonLen, 8 + jsonLen + binLen) };
}

// base64 -> bytes. The native side hands frames over as base64 because the JS
// bridge does not carry binary: 91 joints of rotations is ~1.5 KB, which is
// 2 KB of base64 at 30 Hz - a fifth of what the raw 4x4 matrices would cost,
// and the bulk still never touches JavaScript in any other form.
export function base64ToBytes(b64) {
  const bin = global.atob ? global.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) out[i] = bin.charCodeAt(i);
  return out;
}

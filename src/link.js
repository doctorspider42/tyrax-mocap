// The link to the editor: one WebSocket, the frame codec in protocol.js, and a
// hello the editor answers with `ok` or `deny`.
//
// The editor hosts (it is the thing with a fixed address and a screen showing
// the pairing code); the phone joins. That is the same way tyrax-cam works, and
// the same server on the same port - the editor tells the two apart by what
// they send after hello.
import { encodeFrame, decodeFrame, PROTO_VERSION } from './protocol';

const DEFAULT_PORT = 7798;

export class Link {
  constructor() {
    this.ws = null;
    this.state = 'idle';       // idle | connecting | connected | error
    this.error = '';
    this.project = '';         // filled from the editor's welcome
    this.onState = () => {};
    this.onCommand = () => {};
    this.sentSkeleton = false;
  }

  // `address` is "192.168.1.20" or "192.168.1.20:7798" - the editor's Phone
  // Camera window prints both forms, so accept either.
  connect(address, pairCode, device) {
    this.close();
    const [host, port] = String(address).trim().split(':');
    if (!host) return this.fail('type the editor address');
    const url = `ws://${host}:${port || DEFAULT_PORT}`;
    this.sentSkeleton = false;
    this.setState('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return this.fail(String(e && e.message ? e.message : e));
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        t: 'hello',
        proto: PROTO_VERSION,
        code: pairCode || '',
        name: device.name || 'iPhone',
        model: device.model || '',
        client: device.client || 'TyraX Mocap',
        // No 6DoF camera pose from this app - it sends bodies. The editor uses
        // this to know which half of the link it is talking to.
        body: true,
      });
    };
    ws.onmessage = (ev) => {
      const frame = decodeFrame(ev.data);
      if (!frame) return;
      const t = frame.msg && frame.msg.t;
      if (t === 'welcome') {
        this.project = frame.msg.project || '';
        this.setState('connected');
      } else if (t === 'deny') this.fail(frame.msg.reason || 'the editor refused the connection');
      else if (t === 'cmd') this.onCommand(frame.msg.cmd || '');
      else if (t === 'bye') this.fail(frame.msg.reason || 'the editor closed the link');
    };
    ws.onerror = () => {
      // A browser-style WebSocket error carries nothing useful; the common
      // cause by far is the wrong address or a firewall, so say that instead of
      // "undefined".
      this.fail('cannot reach the editor - check the address and that its link is started');
    };
    ws.onclose = () => {
      if (this.state !== 'error') this.setState('idle');
      this.ws = null;
    };
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* already gone */
      }
    }
    this.ws = null;
    this.sentSkeleton = false;
    if (this.state !== 'error') this.setState('idle');
  }

  get connected() {
    return this.state === 'connected';
  }

  send(obj, bin) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(encodeFrame(obj, bin));
      return true;
    } catch (e) {
      this.fail(String(e && e.message ? e.message : e));
      return false;
    }
  }

  // The skeleton goes once per session: names and the tree in the JSON, the
  // rest pose in the trailer. The editor needs the rest pose because
  // retargeting is a delta against it - a stream of absolute rotations cannot
  // be moved onto a body of different proportions.
  sendSkeleton(skeleton, restBytes) {
    if (this.sentSkeleton || !this.connected) return;
    if (this.send({ t: 'bodyrest', joints: skeleton.joints, parents: skeleton.parents },
                  restBytes))
      this.sentSkeleton = true;
  }

  // `vision` is whatever the native side saw beyond the skeleton - the camera's
  // orientation, the face's angles, palm landmarks. It is forwarded key for key
  // without being read here: this end of the link is a pipe, and every one of
  // those numbers means something only to the editor's solver.
  sendFrame(ts, rotBytes, hips, root, vision) {
    if (!this.connected || !this.sentSkeleton) return;
    const msg = { t: 'body', ts };
    if (hips) msg.h = hips;
    // The heading. Small enough to ride the JSON, and it has to: the skeleton
    // does not contain it - ARKit keeps the whole body orientation on the
    // anchor and leaves the hips joint's own rotation constant.
    if (root) msg.r = root;
    if (vision) for (const k of Object.keys(vision)) msg[k] = vision[k];
    this.send(msg, rotBytes);
  }

  // A button the performer presses themselves. They are the one standing in the
  // T-pose and the one who knows when they are ready - running back to a
  // keyboard mid-pose defeats the point of calibrating on that pose.
  sendCommand(cmd) {
    return this.send({ t: 'cmd', cmd });
  }

  setState(s) {
    this.state = s;
    if (s !== 'error') this.error = '';
    this.onState(s, this.error);
  }

  fail(why) {
    this.error = why;
    this.state = 'error';
    this.onState('error', why);
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* already gone */
      }
      this.ws = null;
    }
  }
}

# TyraX Mocap

Record somebody moving with an iPhone, and put that motion on a character in
the [TyraX](https://github.com/doctorspider42/tyra-editor) PlayStation 2 editor.

No suit, no markers, no cloud service: ARKit's body tracking solves a 91-joint
skeleton from the rear camera, this app writes it into a take file, and the
editor retargets that onto its own 23-bone rig — the same retarget path a
Mixamo download goes through.

Sibling app: [tyrax-cam](https://github.com/doctorspider42/tyrax-cam) turns the
phone into a camera viewfinder. Same build story, same sideload story.

## What you need

- **iPhone XS or newer** (an A12 chip). ARKit body tracking does not exist
  below that, and the app says so on launch rather than failing later.
- Room to stand back: the **whole body** has to be in frame, so about three
  metres, and enough light for the camera to see detail.
- A way to sideload — see below.

## Recording

The app is a viewfinder: it shows the camera with the tracked skeleton drawn
on top, so you can try framings and see whether ARKit has actually found the
body *before* pressing record rather than after.

1. Stand the phone up (a tripod, a mug, anything) so it can see the performer
   head to foot.
2. Wait for the status pill to read **normal** and for the skeleton to land
   on them - "body in frame" turns green.
3. **Record**, perform, **Stop**. The take appears in the list.
4. **Send** opens the iOS share sheet — AirDrop it to the machine running the
   editor, or drop it in any cloud folder.

Everything that is not the viewfinder lives behind the **gear** in the corner -
lens, live link, recorded takes. Framing a person is what the screen is for, and
the settings used to take half of it. The two pills next to the gear are the
whole state with the panel shut: whether ARKit is tracking, and whether the
editor is getting frames.

The overlay draws the joints **the editor will actually use**, not all 91 ARKit
reports: fingers and face are noise at this distance, and this way what you see
on screen is exactly what gets retargeted.

### Choosing a camera

Body tracking is **rear camera only** - the front one does faces, not bodies,
and ARKit offers no choice about it. What the picker under the viewfinder does
choose is the capture format, and on a phone with more than one rear lens that
includes **which lens**: the ultra-wide is the difference between needing three
metres to fit a whole person in and needing half of that. Higher frame rates
are there too; the take is resampled on import either way.

Switching restarts tracking, so it is refused during a recording.

Takes are `.tmocap` files, about 5.8 KB per frame (a 10-second take is ~1.7 MB).
The format is one page: [PROTOCOL.md](PROTOCOL.md).

## Live link

You do not have to record blind. Point the phone at somebody, link it to the
editor, and the generated character copies them **as they move** — the same
pose pipeline the import uses, just fed a frame at a time.

1. In the editor, *Tools > Phone Camera* > **Start link**. It prints its address
   and a six-digit code.
2. Open the app's **gear**, type both into the **LIVE LINK** row and press
   **Link**. (The panel opens by itself the first time, when there is nothing
   saved yet.)
3. Open *Tools > Mocap* in the editor and pick the character. It moves.

The phone joins the editor (the editor is the thing with a fixed address and a
screen), on the same port and with the same handshake as
[tyrax-cam](https://github.com/doctorspider42/tyrax-cam) — the editor tells the
two apart by what they send after hello. Rotations only, 30 Hz, ~1.5 KB a frame:
bone lengths do not change during a take, so the rest pose sent once at connect
covers everything else.

### Head and hands

ARKit's body tracker reports a head joint and two wrists and **solves none of
them** - measured over a real take, they did not move by a single float bit in
277 frames. Hand and face tracking on iOS live in Vision instead, a different
framework, and it is happy to run over the same camera frames this session
already produces. So it does, at 12 Hz, and the landmarks go out with each
streamed frame.

The geometry that turns those landmarks into joint rotations is **in the
editor**, not here. Two reasons, and both are practical: it can be tested there
against synthetic data without a device in the loop, and getting a convention
wrong then costs an edit rather than a build, a tag, an AltStore round trip and
a reinstall.

What it needs is size in the frame. A face across the room is plenty; a hand at
four metres is about ninety pixels and the wrist gets noisy. Step closer and the
hands come alive.

Streaming and recording are independent. Line the shot up live, then press
**Record** when the take is worth keeping — the file is written on the phone
exactly as before.

## Getting it onto the character

In the editor: *Tools > Character Generator* > **Import clips...** and pick the
`.tmocap`. It lands as a clip on the generated character, resampled and cut
down to the bones that rig actually has.

The honest part: this is monocular pose estimation from one camera. Gross body
motion reads well; feet slide, depth wobbles, and self-occlusion (an arm behind
the back) breaks the solve. For a 1500-triangle character seen from five metres
on a PlayStation 2 that is the right fidelity tier. For a close-up cutscene it
is not — that is what hand-keyed animation is still for.

## Installing it

The CI builds an **unsigned** `.ipa`: there are no Apple credentials in this
repo, and there is no App Store listing. You sign it yourself with your own
Apple ID.

**AltStore source (the good way - updates arrive on their own)**

Add this URL as a source in AltStore (Browse → Sources → **+**):

```
https://raw.githubusercontent.com/doctorspider42/tyrax-mocap/main/altstore.json
```

TyraX Mocap then shows up in AltStore like any other app, and every new release
appears there as an Update - no download, no share sheet, no cable. The manifest
is regenerated by CI on each tagged release and carries the full version
history, which is what lets AltStore match what you have installed.

**AltStore, one-off (no source)**

1. Set up [AltStore](https://altstore.io/) once.
2. Download the `.ipa` from the [latest release](../../releases/latest).
3. Open it in AltStore → it signs with your Apple ID and installs.

A free Apple ID means the app stops working after **7 days** and has to be
refreshed — AltStore does that by itself while it can reach your computer. A
paid developer account gets a year. A free account also caps you at **three**
sideloaded apps at a time.

The source is AltStore **Classic**, not PAL: a PAL source points at an
Alternative Distribution Package, which needs a paid developer account, Apple
notarization of every build and the EU Alternative Terms Addendum. This one
points at a plain unsigned `.ipa`.

**Sideloadly (from a computer)** — plug the phone in, drop the `.ipa` on
[Sideloadly](https://sideloadly.io/), sign in with your Apple ID, install.

**From source** — needs a Mac with Xcode:

```
npm install
npx expo prebuild -p ios
npx expo run:ios --device
```

## How it is built

Expo (React Native) for the screen, a small **native Expo module** in Swift for
everything that matters:

```
modules/tyrax-body/ios/BodySession.swift       the one ARKit session
modules/tyrax-body/ios/TakeRecorder.swift      the .tmocap writer
modules/tyrax-body/ios/TyraxBodyPreview.swift  the viewfinder + skeleton overlay
modules/tyrax-body/ios/VisionPass.swift        face + hand landmarks
modules/tyrax-body/ios/TyraxBodyModule.swift   the JS-facing module
modules/tyrax-body/index.js                    the JS face of it
App.js                                         one screen: viewfinder, record, takes
```

Body anchors reach the recorder two ways and never both at once: headless (the
module is the session delegate) or through the preview. That split is not
decoration - `ARSCNView` takes `session.delegate` for itself when a session is
assigned to it, so fighting it for that slot loses the video feed. The view
therefore feeds the recorder from its own `ARSCNViewDelegate`, and the headless
delegate stands down while a view is attached. Either way the take is the same
file.

The recording is buffered and written **in Swift**, not in JavaScript. A take
is 91 joints × a 4×4 matrix per frame; pushing that across the JS bridge 30
times a second would cost more than the tracking does. JavaScript gets a
throttled status line and nothing else.

`.github/workflows/ios.yml` builds it: a fast Linux job that bundles the JS
(catching the ordinary mistakes without a macOS runner) and then a macOS job
that runs `expo prebuild` and `xcodebuild archive` unsigned. A `v*` tag also
publishes the `.ipa` as a release asset.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

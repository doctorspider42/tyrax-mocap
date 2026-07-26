# The `.tmocap` take format

One file is one recording: the skeleton it was captured with, its rest pose,
and a frame per sample. Little-endian throughout, no padding, no compression.

The editor reads it in `src/mocap.cpp` (TyraX repo). **Both sides carry a
"keep in sync" note - the layout lives in two files.**

```
magic     4 bytes   "TMCP"
version   u32       1
flags     u32       0
fps       f32       effective capture rate (frames / duration)
joints    u32       joint count (ARKit's body skeleton: 91)
frames    u32       frame count
duration  f32       seconds

joint table, `joints` entries:
  nameLen u16
  name    nameLen bytes, UTF-8, no terminator   e.g. "left_shoulder_1_joint"
  parent  i16       index into this table, -1 for the root

rest pose, `joints` entries:
  mat4    16 f32    LOCAL transform, column-major

frames, `frames` entries:
  t       f32       seconds from the start of the take
  root    16 f32    the body anchor's WORLD transform, column-major
  joint   `joints` * 16 f32   LOCAL transforms, column-major
```

## Why the rest pose is in every file

Retargeting is *"apply this joint's rotation relative to its own bind pose"*.
Without the skeleton's neutral pose there is nothing to take the delta against,
and a stream of absolute joint transforms cannot be applied to a body with
different proportions. ARKit hands it over as
`ARSkeletonDefinition.defaultBody3D.neutralBodySkeleton3D`, and it is written
into every take rather than assumed, so a file stays readable if Apple ever
revises the skeleton.

## Why full 4x4 matrices

They are what ARKit reports, and storing them unchanged means the file cannot
be wrong in a way that is hard to see. It costs about 5.8 KB per frame (91
joints), so a 10-second take at 30 fps is ~1.7 MB - large for a wire, fine for
a file you AirDrop. A quaternion-and-translation form would be a quarter of
that and is the obvious v2 if takes ever stream live.

## Conventions

ARKit's body space is right-handed, **Y up**, metres, with the hips at the
origin - the same conventions the editor's rigs use, so **nothing is
converted** on either side. The root transform is the body anchor in ARKit
world space; the editor uses it for the hips' motion and ignores its rotation
about the vertical unless the take is imported with root motion enabled.

Joint names are ARKit's own (`hips_joint`, `left_upLeg_joint`,
`spine_7_joint`, ...). The editor maps them onto its Mixamo-named rig; joints
it has no bone for (the 40-odd finger, toe and face joints) are simply not
sampled, which is most of why a 91-joint take lands as a 23-channel clip.

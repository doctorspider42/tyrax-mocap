// Regenerates altstore.json - the AltStore **Classic** "source" manifest, so the
// app can be added to AltStore by URL and updates itself from then on.
//
// Classic, not PAL: a PAL source points at an Alternative Distribution Package's
// manifest.json, which requires a paid Apple Developer account, Apple
// notarization of every build and the EU Alternative Terms Addendum. This one
// points at a plain .ipa, which PAL does not consume - see the README.
//
// Usage: node scripts/altstore-source.mjs <releases.json>
//   releases.json = the GitHub releases API payload (array, newest first). CI
//   pipes `gh api repos/<repo>/releases` into it; that is the authoritative
//   record of what exists, so the history cannot drift from reality.
//
// THE VERSION HISTORY IS THE POINT. AltStore resolves the INSTALLED version
// against this array, so a latest-only list lets "add source" work while every
// later Update fails with "The data couldn't be read because it isn't in the
// correct format". AltStore's own official source carries its full history,
// newest first - match that. (This, and the two notes below, are scars from
// tyrax-cam; they cost several releases to find there and are not worth
// rediscovering here.)
//
// `buildVersion` IS emitted, despite the official source not having one.
// Removing it breaks installing while leaving the source displayable - the
// install path decodes the chosen version entry in full.
//
// Both `version` and `buildVersion` are read from app.json AT THAT TAG rather
// than from the tag name, so the manifest describes what is actually inside
// each .ipa. A release whose two disagree is skipped rather than advertised.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [releasesPath] = process.argv.slice(2);
if (!releasesPath) {
  console.error('usage: node scripts/altstore-source.mjs <releases.json>');
  process.exit(1);
}

const REPO = 'doctorspider42/tyrax-mocap';
const IPA = 'TyraXMocap.ipa';
const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url)));
const bundleId = appJson.expo.ios.bundleIdentifier;

const releases = JSON.parse(readFileSync(releasesPath, 'utf8'));
if (!Array.isArray(releases)) {
  console.error('releases.json must be an array (the GitHub releases payload)');
  process.exit(1);
}

// What the app built at a tag actually reports to iOS. Read from the committed
// app.json, which is what Expo turns into CFBundleShortVersionString /
// CFBundleVersion - guessing either would let the manifest promise a build that
// identifies itself differently, which AltStore is entitled to reject.
const appAtTag = (tag) => {
  try {
    const raw = execFileSync('git', ['show', `${tag}:app.json`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const e = JSON.parse(raw).expo;
    return { version: e.version, build: String(e.ios?.buildNumber ?? '1') };
  } catch {
    return null;   // tag not fetched (shallow clone) or app.json absent
  }
};

// One entry per release that actually carries the .ipa, newest first. Each
// points at ITS OWN asset, not at /releases/latest/ - an older entry aimed at
// "latest" would hand out the wrong build.
const versions = [];
const skipped = [];
for (const r of releases) {
  if (r.draft) continue;
  const asset = (r.assets || []).find((a) => a.name === IPA);
  if (!asset) continue;                       // a release with no build yet
  const tag = r.tag_name;
  const tagVersion = tag.replace(/^v/, '');
  const app = appAtTag(tag);
  if (!app) {
    skipped.push(`${tag}: cannot read app.json at that tag (shallow clone?)`);
    continue;
  }
  if (app.version !== tagVersion) {
    skipped.push(`${tag}: the build reports ${app.version}, not ${tagVersion}`);
    continue;
  }
  versions.push({
    version: app.version,
    buildVersion: app.build,
    date: r.published_at || r.created_at,     // full ISO 8601 with timezone
    localizedDescription: (r.body || `Release ${tag}.`).trim().slice(0, 1000),
    downloadURL: `https://github.com/${REPO}/releases/download/${tag}/${IPA}`,
    size: asset.size,
    minOSVersion: '15.1',
  });
}
for (const s of skipped) console.log(`skipped ${s}`);
if (versions.length === 0) {
  console.error(`no release carries a ${IPA} asset yet - nothing to advertise`);
  process.exit(1);
}
// Newest first. The API returns them that way, but sort by date so a manually
// created release cannot land in the middle.
versions.sort((a, b) => new Date(b.date) - new Date(a.date));
const newest = versions[0];

const description = [
  'Record motion capture with an iPhone and put it on a character in the TyraX',
  'PlayStation 2 editor.',
  '',
  'No suit and no markers: ARKit body tracking solves a 91-joint skeleton from',
  'the rear camera, the app writes it into a take file, and the editor retargets',
  'that onto its own rig - the same path a Mixamo download takes.',
  '',
  'Stand the phone up so it sees the whole body, record, then AirDrop the take',
  'to the machine running the editor.',
  '',
  'Needs an iPhone XS or newer (ARKit body tracking wants an A12 chip).',
].join('\n');

const source = {
  name: 'TyraX Mocap',
  identifier: `${bundleId}.source`,
  subtitle: 'Phone motion capture for the TyraX PS2 editor',
  description: 'Releases of TyraX Mocap, the body-capture app for the TyraX editor.',
  website: `https://github.com/${REPO}`,
  apps: [
    {
      name: 'TyraX Mocap',
      bundleIdentifier: bundleId,
      developerName: 'doctorspider42',
      subtitle: 'ARKit body capture into editor takes',
      localizedDescription: description,
      iconURL: `https://raw.githubusercontent.com/${REPO}/main/assets/icon.png`,
      tintColor: '2B6CB0',
      screenshots: [],
      // Legacy mirror of the newest entry - older AltStore builds read these
      // directly instead of walking `versions`. The official source keeps them
      // too. Here alone the /latest/ permalink is right: it always means newest.
      version: newest.version,
      versionDate: newest.date,
      versionDescription: newest.localizedDescription,
      downloadURL: `https://github.com/${REPO}/releases/latest/download/${IPA}`,
      size: newest.size,
      minOSVersion: '15.1',
      versions,
      appPermissions: {
        entitlements: [],
        privacy: {
          NSCameraUsageDescription:
            'ARKit body tracking needs the camera to work out how a person moves. No image is recorded, shown or transmitted - only the skeleton.',
        },
      },
    },
  ],
  news: [],
};

// Check before writing. AltStore decodes a source with a strict Swift decoder and
// reports ANY shortfall as the singularly unhelpful "The data couldn't be read
// because it isn't in the correct format" - on the phone, after an install
// attempt. Assert the shape here instead of discovering it there.
const problems = [];
const req = (obj, keys, where) => {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') problems.push(`${where}: missing ${k}`);
  }
};
req(source, ['apps'], 'source');
for (const [i, app] of source.apps.entries()) {
  req(app, ['name', 'bundleIdentifier', 'developerName', 'localizedDescription',
            'iconURL', 'versions'], `apps[${i}]`);
  if (!Array.isArray(app.versions) || app.versions.length === 0) {
    problems.push(`apps[${i}]: versions must be a non-empty array`);
  }
  for (const [k, v] of (app.versions || []).entries()) {
    const at = `apps[${i}].versions[${k}]`;
    req(v, ['version', 'buildVersion', 'date', 'downloadURL', 'size'], at);
    if (typeof v.size !== 'number' || v.size <= 0) problems.push(`${at}: size must be a positive number`);
    if (isNaN(new Date(v.date))) problems.push(`${at}: date "${v.date}" is unparseable`);
    if (!String(v.downloadURL).includes(`/${IPA}`)) problems.push(`${at}: downloadURL does not point at ${IPA}`);
  }
  // The installed build must always be findable here, which is the whole reason
  // this array carries a history - see the header.
  const seen = new Set();
  for (const v of app.versions || []) {
    if (seen.has(v.version)) problems.push(`apps[${i}]: duplicate version ${v.version}`);
    seen.add(v.version);
  }
  if (app.version !== app.versions?.[0]?.version)
    problems.push(`apps[${i}]: legacy version ${app.version} disagrees with versions[0] ${app.versions?.[0]?.version}`);
  const ap = app.appPermissions;
  if (ap && (!Array.isArray(ap.entitlements) || typeof ap.privacy !== 'object'))
    problems.push(`apps[${i}].appPermissions has the wrong shape`);
}
if (problems.length) {
  console.error('altstore.json would be invalid:\n  ' + problems.join('\n  '));
  process.exit(1);
}

writeFileSync(new URL('../altstore.json', import.meta.url),
              JSON.stringify(source, null, 2) + '\n');
console.log(`altstore.json: ${bundleId}, ${versions.length} version(s), newest ` +
            `${newest.version} (${newest.size} bytes)`);
for (const v of versions) console.log(`  ${v.version.padEnd(8)} ${v.date}  ${v.size}`);

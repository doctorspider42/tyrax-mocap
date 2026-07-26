// Does every download the manifest advertises actually exist, at the size it
// promises?
//
// The generator already checks the manifest's SHAPE. This checks it against
// reality, which is a different question and the one that bites: a manifest can
// be perfectly well formed and still point at an asset that has been replaced
// since - exactly what re-pushing a tag does, and what deleting a release does
// more brutally. A phone handed a length that disagrees with the file fails at
// install with "The data couldn't be read because it isn't in the correct
// format", which says nothing about any of this.
//
// Usage: node scripts/check-source.mjs <altstore.json> <releases.json>
import { readFileSync } from 'node:fs';

const [manifestPath, releasesPath] = process.argv.slice(2);
if (!manifestPath || !releasesPath) {
  console.error('usage: node scripts/check-source.mjs <altstore.json> <releases.json>');
  process.exit(1);
}

const IPA = 'TyraXMocap.ipa';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const releases = JSON.parse(readFileSync(releasesPath, 'utf8'));

// tag -> the .ipa asset that tag really carries, right now.
const assets = new Map();
for (const r of releases) {
  if (r.draft) continue;
  const a = (r.assets || []).find((x) => x.name === IPA);
  if (a) assets.set(r.tag_name, a);
}

const problems = [];
const app = manifest.apps?.[0];
if (!app) {
  console.error('the manifest has no apps');
  process.exit(1);
}

for (const v of app.versions || []) {
  const tag = `v${v.version}`;
  const asset = assets.get(tag);
  if (!asset) {
    problems.push(`${v.version}: no release ${tag} carries a ${IPA} any more`);
    continue;
  }
  if (asset.size !== v.size) {
    problems.push(
      `${v.version}: the manifest promises ${v.size} bytes, ${tag} has ${asset.size} - ` +
        'the asset was replaced after the manifest was written',
    );
    continue;
  }
  if (!String(v.downloadURL).endsWith(`/${tag}/${IPA}`)) {
    problems.push(`${v.version}: downloadURL ${v.downloadURL} does not point at ${tag}`);
    continue;
  }
  console.log(`ok  ${v.version.padEnd(8)} ${asset.size} bytes  ${tag}`);
}

// The legacy top-level fields mirror the newest entry and are what older
// AltStore builds read instead of walking `versions` - a mismatch here breaks
// exactly those clients and nothing else, which is a miserable thing to debug.
const newest = app.versions?.[0];
if (newest && app.size !== newest.size)
  problems.push(`the legacy size ${app.size} disagrees with versions[0] ${newest.size}`);
if (newest && app.version !== newest.version)
  problems.push(`the legacy version ${app.version} disagrees with versions[0] ${newest.version}`);

if (problems.length) {
  console.error('the published source does not match reality:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`all ${(app.versions || []).length} advertised downloads check out`);

// Asserts that every symbol the app imports by name from expo / expo-modules-core
// actually exists in the installed package.
//
// Why this is not the bundler's job: Metro RESOLVES `import { foo } from 'expo'`
// happily whether or not `expo` exports `foo`. The import simply lands as
// undefined and blows up at the call site - at runtime, on the device. If that
// call is at module scope (a `requireNativeViewManager` at import time, say)
// the app dies before it draws a pixel, and the green bundle job says nothing.
// v1.0.2 shipped exactly that.
//
// Usage: node scripts/check-imports.mjs
//
// Deliberately crude: it greps the packages' .d.ts output for the name rather
// than loading them, because requiring React Native code in plain Node does not
// work. That can pass a symbol that exists under a different guise, but it
// cannot fail one that is really exported - and the failure mode it guards is
// "this name is nowhere in the package at all".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['expo', 'expo-modules-core'];
const SOURCES = ['App.js', 'index.js', 'modules/tyrax-body/index.js'];

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.d.ts') || e.endsWith('.js')) out.push(p);
  }
  return out;
};

const haystacks = new Map();
for (const pkg of PACKAGES) {
  const files = walk(join('node_modules', pkg, 'build'));
  haystacks.set(pkg, files.map((f) => readFileSync(f, 'utf8')).join('\n'));
  if (!files.length) console.warn(`warning: no build output found for ${pkg}`);
}

const problems = [];
for (const src of SOURCES) {
  let text;
  try {
    text = readFileSync(src, 'utf8');
  } catch {
    continue;
  }
  // import { a, b as c } from 'pkg'
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const pkg = m[2];
    if (!PACKAGES.includes(pkg)) continue;
    const hay = haystacks.get(pkg) || '';
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      // A word-boundary match: `requireNativeViewManager` must appear as a name,
      // not as a fragment of a longer identifier.
      if (!new RegExp(`\\b${name}\\b`).test(hay)) {
        problems.push(`${src}: '${pkg}' does not export ${name}`);
      }
    }
  }
}

if (problems.length) {
  console.error('imports that would be undefined at runtime:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('ok: every named import from ' + PACKAGES.join(', ') + ' exists');

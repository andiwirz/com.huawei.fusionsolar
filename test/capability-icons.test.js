'use strict';

// Capability icons must be filled shapes, not line drawings.
//
// Homey colours a capability icon by filling its shapes and ignoring strokes. An icon drawn
// with fill="none" and stroke="currentColor" therefore shows up on the phone as solid
// blocks: the battery capacity and software-version tiles were plain white rectangles, the
// backup-time clock a disc, the SDongle's Wi-Fi symbol a wedge. Eleven of thirty-nine icons
// had this. They were converted to outlines — every stroke turned into the area it covers,
// rings and capsules drawn as filled contours with holes — which is how the icons that did
// look right were already built (meter_power.svg).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));

// Every icon file a capability points at, from the capability itself or a driver override.
function referencedIcons() {
  const icons = new Set();
  for (const cap of Object.values(app.capabilities || {})) if (cap.icon) icons.add(cap.icon);
  for (const d of app.drivers || []) {
    for (const opt of Object.values(d.capabilitiesOptions || {})) if (opt && opt.icon) icons.add(opt.icon);
  }
  return [...icons].map((i) => path.join(ROOT, i.replace(/^\//, '')));
}

const allCapabilityIcons = () => fs.readdirSync(path.join(ROOT, 'assets', 'capabilities'))
  .filter((f) => f.endsWith('.svg'))
  .map((f) => path.join(ROOT, 'assets', 'capabilities', f));

test('no capability icon draws with strokes', () => {
  const offenders = [];
  for (const file of new Set([...allCapabilityIcons(), ...referencedIcons()])) {
    if (!fs.existsSync(file)) continue;
    const svg = fs.readFileSync(file, 'utf8');
    // stroke="none" is fine and appears in filled icons exported from design tools.
    if (/\sstroke="(?!none")[^"]+"/.test(svg) || /\sstroke-width="/.test(svg) && !/\sstroke="none"/.test(svg)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepStrictEqual(offenders, [],
    `line-drawn icons render as solid blocks on the Homey app: ${offenders.join(', ')}`);
});

test('every capability icon fills something', () => {
  // The other half of the same mistake: an icon whose only shapes are unfilled draws nothing
  // useful once its strokes are dropped.
  const empty = [];
  for (const file of allCapabilityIcons()) {
    const svg = fs.readFileSync(file, 'utf8');
    const shapes = svg.match(/<(path|rect|circle|ellipse|polygon|polyline|line)\b[^>]*>/g) || [];
    if (!shapes.length) empty.push(path.relative(ROOT, file));
  }
  assert.deepStrictEqual(empty, []);
});

test('every icon a capability references exists', () => {
  const missing = referencedIcons().filter((f) => !fs.existsSync(f)).map((f) => path.relative(ROOT, f));
  assert.deepStrictEqual(missing, []);
});

test('the converted icons keep the 24×24 box and carry no fixed size', () => {
  // A width/height on the root would pin the icon to a pixel size; Homey scales by viewBox.
  for (const n of ['battery_rated_capacity', 'sun2000_software_version', 'sdongle_type',
    'isitepower_remaining_backup_time', 'isitepower_discharge_cycles']) {
    const svg = fs.readFileSync(path.join(ROOT, 'assets', 'capabilities', `${n}.svg`), 'utf8');
    const root = svg.match(/<svg\b[^>]*>/)[0];
    assert.match(root, /viewBox="0 0 24 24"/, `${n}: viewBox changed`);
    assert.doesNotMatch(root, /\s(width|height)="/, `${n}: fixed size on the root element`);
    assert.match(svg, /fill="currentColor"/, `${n}: not filled with the theme colour`);
  }
});

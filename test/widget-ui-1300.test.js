'use strict';

// Widget review of 2026-10-09 on the dashboard side (1.2.300): Homey's styling guide, one
// shared block for formatting and polling, heights that do not jump, and taps that answer.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGETS = fs.readdirSync(path.join(ROOT, 'widgets')).sort();
const page = (w) => fs.readFileSync(path.join(ROOT, 'widgets', w, 'public', 'index.html'), 'utf8');
const app = require('../app.json');

const KIT_START = "/* ── Shared by this app's widgets";
const KIT_END = '/* ── end of the shared block ── */';
function kitOf(html) {
  const a = html.indexOf(KIT_START);
  const b = html.indexOf(KIT_END);
  if (a < 0 || b < a) return null;
  // the same block, wherever it is indented
  return html.slice(a, b + KIT_END.length).split('\n').map((l) => l.trim()).join('\n');
}

const KIT_USERS = WIDGETS.filter((w) => w !== 'ems-history');

test('every widget that polls through the shared block carries the same copy of it', () => {
  assert.strictEqual(WIDGETS.length, 12);
  const first = kitOf(page(KIT_USERS[0]));
  assert.ok(first, `${KIT_USERS[0]} has no shared block`);
  for (const w of KIT_USERS) {
    assert.strictEqual(kitOf(page(w)), first, `${w}: the shared block differs from ${KIT_USERS[0]}`);
  }
});

// ── the styling guide ────────────────────────────────────────────────────────────────

function styleOf(html) {
  return (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
}

test('no widget text is smaller than Homey\'s smallest size (14 px)', () => {
  for (const w of WIDGETS) {
    const html = page(w);
    for (const m of styleOf(html).matchAll(/font-size:\s*([\d.]+)px/g)) {
      assert.ok(Number(m[1]) >= 14, `${w}: font-size ${m[1]}px in the stylesheet`);
    }
    // SVG text drawn from script (the chart axes were 7 and 8 px)
    for (const m of html.matchAll(/font-size="([\d.]+)"/g)) {
      assert.ok(Number(m[1]) >= 14, `${w}: an SVG font-size of ${m[1]}`);
    }
  }
});

test('no shadows inside the widgets — Homey\'s frame carries the only one', () => {
  for (const w of WIDGETS) {
    const html = page(w);
    assert.ok(!/box-shadow\s*:/.test(styleOf(html)), `${w}: box-shadow in the stylesheet`);
    assert.ok(!/drop-shadow\(/.test(html), `${w}: a drop-shadow glow`);
    assert.ok(!/\.boxShadow\s*=/.test(html.replace(/boxShadow\s*=\s*'none'/g, '')), `${w}: a shadow set from script`);
  }
});

test('every widget uses Homey\'s body padding class and Homey\'s font', () => {
  for (const w of WIDGETS) {
    const html = page(w);
    assert.match(html, /<body class="[^"]*\bhomey-widget(-small)?\b/, `${w}: no homey-widget class on the body`);
    assert.ok(!/font-family\s*:/.test(styleOf(html)), `${w}: its own font-family`);
  }
});

// ── numbers in the dashboard's language ───────────────────────────────────────────────

test('figures are written through fmtNum, not toFixed with a unit glued on', () => {
  for (const w of WIDGETS) {
    const html = page(w);
    assert.ok(!/toFixed\(\d\)\s*\+\s*' ?(k?Wh?|MWh|%|A|kg|kW)'/.test(html), `${w}: toFixed + unit`);
    if (KIT_USERS.includes(w)) assert.ok((html.match(/fmtNum\(/g) || []).length >= 3, `${w}: fmtNum is not used`);
  }
});

function kitContext(lang) {
  const intervals = [];
  const listeners = {};
  const body = { classes: new Set(), classList: null };
  body.classList = {
    add: (c) => body.classes.add(c), remove: (c) => body.classes.delete(c), contains: (c) => body.classes.has(c),
  };
  const ctx = {
    activeLang: lang, Intl, isFinite, Promise,
    document: { hidden: false, body, addEventListener: (e, f) => { listeners[e] = f; } },
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; },
    clearInterval: () => {},
    requestAnimationFrame: (f) => f(),
  };
  vm.createContext(ctx);
  vm.runInContext(kitOf(page('netzampel')), ctx);
  return { ctx, intervals, body };
}

test('fmtNum writes the decimal comma where the dashboard language has one', () => {
  assert.strictEqual(vm.runInContext('fmtNum(8.83, 1)', kitContext('de').ctx), '8,8');
  assert.strictEqual(vm.runInContext('fmtNum(8.83, 1)', kitContext('en').ctx), '8.8');
  assert.strictEqual(vm.runInContext('fmtNum(null, 1)', kitContext('nl').ctx), '—');
});

test('the poller: one request at a time, a first failure said, two misses dimmed', async () => {
  const { ctx, intervals, body } = kitContext('de');
  let answers = [];
  const log = [];
  let release;
  ctx.run = () => new Promise((resolve, reject) => { const a = answers.shift(); release = () => (a === 'fail' ? reject(new Error('x')) : resolve(a)); });
  ctx.onOk = (d) => log.push(['ok', d]);
  ctx.onFail = (first) => log.push(['fail', first]);
  const settle = () => new Promise((r) => setImmediate(r));

  answers = ['fail'];
  vm.runInContext('var p = poller({ ms: 15000, run: run, onOk: onOk, onFail: onFail });', ctx);
  assert.strictEqual(intervals[0].ms, 15000);
  await settle();                             // the first request is under way
  vm.runInContext('p.now()', ctx);            // still busy: ignored
  release(); await settle();
  assert.deepStrictEqual(log, [['fail', true]], 'a first load that fails says so');

  const step = async () => { vm.runInContext('p.now()', ctx); await settle(); release(); await settle(); };
  answers = [{ v: 1 }]; await step();
  answers = ['fail'];   await step();
  assert.ok(!body.classes.has('stale'), 'one miss is not yet stale');
  answers = ['fail'];   await step();
  assert.ok(body.classes.has('stale'), 'two misses must dim the values');
  answers = [{ v: 2 }]; await step();
  assert.ok(!body.classes.has('stale'));
  assert.deepStrictEqual(log.map((l) => l[0]), ['fail', 'ok', 'fail', 'ok']);
});

// ── how often each widget asks ─────────────────────────────────────────────────────────

test('each widget asks as often as its data changes, and no more', () => {
  const expected = {
    'solar-power-flow': 15000, 'netzampel': 15000, 'battery-status': 15000,
    'energy-balance': 60000, 'daily-yield': 60000,
    'charger-status': 10000, 'session-history': 30000,
    'ems-device': 15000, 'ems-battery': 15000, 'ems-forecast': 60000,
  };
  for (const [w, ms] of Object.entries(expected)) {
    const m = page(w).match(/poller\(\{\s*ms:\s*(\d+)/);
    assert.ok(m, `${w}: does not poll through the shared poller`);
    assert.strictEqual(Number(m[1]), ms, `${w} polls every ${m[1]} ms`);
  }
});

// ── heights ─────────────────────────────────────────────────────────────────────────────

test('a widget announces one height: the manifest\'s, or the one it measured', () => {
  for (const w of WIDGETS) {
    const html = page(w);
    const fixed = [...html.matchAll(/Homey\.ready\(\{\s*height:\s*(\d+)\s*\}\)/g)].map((m) => Number(m[1]));
    for (const h of fixed) {
      // A literal height is only allowed where it is the manifest's; the "no series" and
      // "no device" paths of two widgets announce a smaller fixed one on purpose.
      if (h !== app.widgets[w].height) {
        assert.ok(['sensor-chart'].includes(w), `${w} announces ${h} px under a manifest of ${app.widgets[w].height}`);
      }
    }
  }
  assert.strictEqual(app.widgets['ems-forecast'].height <= 420, true, 'the forecast is back to a phone-unfriendly height');
});

test('the dead widget.compose.json copies are gone', () => {
  for (const w of WIDGETS) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'widgets', w, 'widget.compose.json')), `${w}/widget.compose.json is back`);
  }
});

test('every widget has both previews, at Homey\'s 1024 × 1024', () => {
  for (const w of WIDGETS) {
    for (const mode of ['light', 'dark']) {
      const buf = fs.readFileSync(path.join(ROOT, 'widgets', w, `preview-${mode}.png`));
      assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR', `${w} ${mode} is not a PNG`);
      assert.deepStrictEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [1024, 1024], `${w} ${mode}`);
    }
  }
});

// ── taps that answer ────────────────────────────────────────────────────────────────────

test('the controls give haptic feedback where Homey offers it', () => {
  for (const w of ['ems-device', 'sensor-chart', 'ems-forecast', 'ems-history']) {
    assert.match(page(w), /Homey\.hapticFeedback\(\)/, `${w}: no haptic feedback`);
  }
});

test('the EMS device widget sends one write per tap and ignores answers from before it', () => {
  const html = page('ems-device');
  assert.match(html, /if \(controlSwitch\.disabled\) return;/);
  assert.match(html, /if \(chargeNowSwitch\.disabled\) return;/);
  assert.match(html, /if \(writing \|\| r\.started < lastWriteDoneAt\) return;/);
  assert.ok(!/flashError\(\(err && err\.message\)/.test(html), 'a raw error code reaches the screen again');
});

test('the charging widgets say phases, stop reasons and dates in the dashboard language', () => {
  const chg = page('charger-status');
  assert.match(chg, /phases: \{ 1: '1-phasig'/);
  assert.ok(!/\+ s\.phaseLabel/.test(chg), 'the driver\'s English phase label is drawn again');
  const sess = page('session-history');
  assert.match(sess, /EVDisconnected: 'Auto getrennt'/);
  assert.match(sess, /toLocaleDateString\(activeLang/);
  assert.ok(!/months: \[/.test(sess), 'the month-day list is back');
  assert.match(sess, /Array\.isArray\(data\.currents\)/, 'only the first running session is drawn');
});

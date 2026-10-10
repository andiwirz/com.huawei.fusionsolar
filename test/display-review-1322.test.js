'use strict';

// Two display findings from the review of 2026-10-10 (1.2.322).
//
//   1. The status dropdown of "Inverter status changed" and "Inverter status is" lacked seven
//      states statusLabel() names — among them "Standby: battery empty", the state a hybrid
//      inverter is in every night once its battery reaches the discharge cutoff. The trigger
//      fired for them, but no card could be set to match.
//   2. The sensor chart's tooltip pasted the series names into innerHTML unescaped. The names
//      are device names or labels typed into the widget settings.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const { statusLabel } = require('../lib/modbus-registers');
const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

// ── 1. the status dropdowns ────────────────────────────────────────────────────

// Every name statusLabel can produce. A code no table lists comes back as its range plus the
// number, "Shutdown (0x030D)" — those cannot be offered in a dropdown and are left out.
const NAMED = new Set();
for (let code = 0; code <= 0xFFFF; code++) {
  const label = statusLabel(code);
  if (!/\(0x[0-9A-F]{4}\)$/.test(label)) NAMED.add(label);
}

const dropdown = (kind, id) => {
  const card = APP.flow[kind].find((c) => c.id === id);
  assert.ok(card, `${id} is gone`);
  return card.args.find((a) => a.name === 'status').values;
};

for (const [kind, id] of [['triggers', 'sun2000_status_changed'], ['conditions', 'sun2000_status_is']]) {
  test(`${id}: every state the inverter is named in can be chosen`, () => {
    const ids = new Set(dropdown(kind, id).map((v) => v.id));
    const missing = [...NAMED].filter((l) => !ids.has(l));
    assert.deepStrictEqual(missing, [], 'states a flow cannot react to');
    assert.ok(ids.has('Standby: battery empty'));
  });

  test(`${id}: nothing in the dropdown that the inverter is never called`, () => {
    const stale = dropdown(kind, id).map((v) => v.id).filter((v) => !NAMED.has(v));
    assert.deepStrictEqual(stale, [], 'a choice no status will ever match');
  });

  test(`${id}: each choice is labelled in all three languages, and the English is the value`, () => {
    for (const v of dropdown(kind, id)) {
      assert.strictEqual(v.label.en, v.id, v.id);
      assert.ok(v.label.de && v.label.nl, `${v.id} has no German or Dutch label`);
    }
  });
}

test('both cards offer the same states, in the same order', () => {
  assert.deepStrictEqual(
    dropdown('triggers', 'sun2000_status_changed').map((v) => v.id),
    dropdown('conditions', 'sun2000_status_is').map((v) => v.id),
  );
});

// ── 2. the sensor chart tooltip ────────────────────────────────────────────────

const CHART = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'sensor-chart', 'public', 'index.html'), 'utf8');

function fnSource(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} is not in the page`);
  let depth = 0, inStr = null;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// showHover as the page has it, over a stubbed DOM.
function hover(names) {
  const el = () => ({ style: {}, innerHTML: '', offsetWidth: 100, offsetHeight: 60, clientWidth: 400 });
  const ctx = {
    activeLang: 'en', _nf: {}, CHART_H: 200, M: { top: 8, right: 8, bottom: 26, left: 46 },
    COLORS: ['#22C55E', '#3B82F6', '#8B5CF6', '#EF4444'],
    xhairEl: el(), tipEl: el(),
    document: { querySelector: () => null, getElementById: () => el() },
    G: {
      ready: true, tMin: 0, tRange: 3600_000, innerW: 300, hours: 1, names,
      series: names.map(() => ({ points: [{ t: 1800_000, v: 1234 }], current: 1234 })),
    },
  };
  vm.createContext(ctx);
  for (const f of ['escHtml', 'fmtNum', 'fmt', 'fmtDay', 'fmtTime', 'valuesOf', 'findNearest', 'hideHover', 'showHover']) {
    vm.runInContext(fnSource(CHART, f), ctx);
  }
  vm.runInContext('showHover(196)', ctx);
  return ctx.tipEl.innerHTML;
}

test('a name with markup in it is shown as text in the tooltip, not run', () => {
  const html = hover(['<img src=x onerror="alert(1)">', 'Tom & Jerry']);
  assert.ok(!html.includes('<img'), `the name went in as a tag: ${html}`);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(html.includes('Tom &amp; Jerry'));
  assert.strictEqual((html.match(/class="tt-row"/g) || []).length, 2, 'a row went missing');
});

test('an ordinary name is unchanged, and the tooltip still carries its value', () => {
  const html = hover(['PV-Leistung']);
  assert.match(html, /<span class="tt-name">PV-Leistung<\/span>/);
  assert.match(html, /1[.,']?2 kW|1234 W/);
});

test('escHtml escapes the five characters that matter in markup and attributes', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSource(CHART, 'escHtml'), ctx);
  assert.strictEqual(vm.runInContext(`escHtml('<a href="x" title=\\'y\\'>&</a>')`, ctx),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(vm.runInContext('escHtml(42)', ctx), '42');
});

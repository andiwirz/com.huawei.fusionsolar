'use strict';

// Two flow cards for settings that used to need the settings page (1.3.14, issues #37/#38).
//
// RickD-CH wanted the forecast threshold of his battery's price control set by a flow (#38),
// and the correction factor from #37 changes with the season. "Set solar forecast correction
// factor" and "Set battery price control value" write the value into ems_config, where the
// settings page keeps it — not an override beside it — so the page, the plan preview and the
// widget show the same number the EMS decides with. Out of range fails the flow: a token gone
// wrong must not be clamped into a value nobody chose.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const app  = JSON.parse(read('app.json'));
const LOCALES = Object.fromEntries(['en', 'de', 'nl'].map((l) => [l, JSON.parse(read(`locales/${l}.json`))]));
const { BATTERY_PRICE_SETTINGS, PV_FORECAST_FACTOR_MIN, PV_FORECAST_FACTOR_MAX } = require('../lib/ems/constants');

const HOUR = 3600e3;
const card = (id) => app.flow.actions.find((c) => c.id === id);
const lookup = (lang, key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), LOCALES[lang]);

function requireDeviceClass() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(ROOT, 'drivers', 'energy_management', 'device.js'));
  } finally {
    Module._load = origLoad;
  }
}

// The real device class with a Homey that keeps ems_config, the cards and the texts.
function makeDevice(cfg, lang = 'en') {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  const state = { cfg, writes: 0, ticks: 0, caps: {}, logs: [], cards: {} };
  d.id = 'ems-1';
  d.log = (m) => state.logs.push(m);
  d.error = () => {};
  d.homey = {
    settings: {
      get: (k) => (k === 'ems_config' ? JSON.parse(JSON.stringify(state.cfg)) : undefined),
      set: (k, v) => { if (k === 'ems_config') { state.cfg = JSON.parse(JSON.stringify(v)); state.writes += 1; } },
    },
    clock: { getTimezone: () => 'Europe/Zurich' },
    i18n: { getLanguage: () => lang },
    __: (key, tokens = {}) => {
      const t = lookup(lang, key);
      if (typeof t !== 'string') throw new Error(`no text for ${key}`);
      return t.replace(/\{\{(\w+)\}\}/g, (_, k) => tokens[k]);
    },
    flow: {
      getActionCard: (id) => (state.cards[id] = state.cards[id] || {
        registerRunListener(fn) { this.run = fn; return this; },
        registerArgumentAutocompleteListener(arg, fn) { (this.auto = this.auto || {})[arg] = fn; return this; },
      }),
    },
  };
  d._applyWidgetChange = () => { state.ticks += 1; };
  d._widgetDeviceName = async (id) => ({ 'bat-a': 'LUNA2000 West', 'bat-b': 'LUNA2000 Ost' })[id];
  d.hasCapability = () => true;
  d.setCapabilityValue = async (c, v) => { state.caps[c] = v; };
  return { d, state };
}

function luna(extra = {}) {
  return { id: 'bat-a', price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, price_discharge_reserve_hours: 10, price_solar_forecast_max_kwh: 22, ...extra };
}

test('the cards: the battery card offers exactly the four values, the factor card the factor range', () => {
  const f = card('ems_set_pv_forecast_factor');
  const b = card('ems_set_battery_price_value');
  assert.ok(f && b, 'a card is missing from app.json');
  const factor = f.args.find((a) => a.name === 'factor');
  assert.deepStrictEqual([factor.type, factor.min, factor.max], ['number', PV_FORECAST_FACTOR_MIN, PV_FORECAST_FACTOR_MAX]);
  assert.deepStrictEqual(b.args.map((a) => [a.name, a.type]),
    [['device', 'device'], ['battery', 'autocomplete'], ['setting', 'dropdown'], ['value', 'number']]);
  const setting = b.args.find((a) => a.name === 'setting');
  assert.deepStrictEqual(setting.values.map((v) => v.id), Object.keys(BATTERY_PRICE_SETTINGS));
  const value = b.args.find((a) => a.name === 'value');
  assert.strictEqual(value.min, 0);
  assert.strictEqual(value.max, Math.max(...Object.values(BATTERY_PRICE_SETTINGS).map((s) => s.max)),
    'the number field must admit the largest range, the listener checks each one');
  for (const c of [f, b]) assert.strictEqual(c.args[0].filter, 'driver_id=energy_management');
});

test('the dropdown names each value as the settings page does, and the hint gives the page\'s ranges', () => {
  const b = card('ems_set_battery_price_value');
  const setting = b.args.find((a) => a.name === 'setting');
  for (const lang of ['en', 'de', 'nl']) {
    for (const v of setting.values) {
      const label = lookup(lang, BATTERY_PRICE_SETTINGS[v.id].label);
      assert.ok(v.label[lang].startsWith(`${label} (`), `${lang} ${v.id}: "${v.label[lang]}" is not the page's "${label}"`);
    }
    for (const s of Object.values(BATTERY_PRICE_SETTINGS)) {
      assert.ok(b.hint[lang].includes(`${s.min}–${s.max}`), `${lang}: the hint lacks ${s.min}–${s.max}`);
    }
    assert.match(card('ems_set_pv_forecast_factor').hint[lang], /0[.,]3–1[.,]5/);
  }
});

test('the ranges and whole-number fields are the settings page\'s own', () => {
  const page = read('settings/index.html');
  const cls = { price_target_soc: 'target', price_charge_power_kw: 'power', price_discharge_reserve_hours: 'reserve', price_solar_forecast_max_kwh: 'solarmax' };
  for (const s of Object.values(BATTERY_PRICE_SETTINGS)) {
    const field = page.match(new RegExp(`'ems-battery-price-${cls[s.key]}', 'number',\\s*\\n?[^\\n]*\\{ min: '(\\d+)', max: '(\\d+)'`));
    assert.ok(field, `no input for ${s.key}`);
    assert.deepStrictEqual([Number(field[1]), Number(field[2])], [s.min, s.max], `${s.key}: range differs from the page`);
    const save = page.match(new RegExp(`d\\.${s.key}\\s*=\\s*[^\\n]*?(parseInt|parseFloat)\\(`));
    assert.ok(save, `the page does not save ${s.key}`);
    assert.strictEqual(save[1] === 'parseInt', s.integer, `${s.key}: whole number or not, unlike the page`);
  }
});

test('every key the card writes is one the price control reads', () => {
  const src = read('lib/ems/priceForecast.js') + read('drivers/energy_management/device.js');
  for (const s of Object.values(BATTERY_PRICE_SETTINGS)) {
    assert.ok(new RegExp(`\\b(bd|device)\\.${s.key}\\b`).test(src), `${s.key} is written but never read`);
  }
});

test('battery value: written into that battery\'s settings, the next tick asked for, nothing else touched', async () => {
  const other = { id: 'bat-b', price_target_soc: 70 };
  const { d, state } = makeDevice({ min_battery_soc: 20, battery_devices: [luna(), other] });
  d._registerSettingCards();
  const run = state.cards.ems_set_battery_price_value.run;

  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'solar_max_kwh', value: 12.5 });
  assert.strictEqual(state.cfg.battery_devices[0].price_solar_forecast_max_kwh, 12.5);
  assert.deepStrictEqual(state.cfg.battery_devices[1], other, 'the other battery is untouched');
  assert.strictEqual(state.cfg.min_battery_soc, 20, 'the rest of the config is kept');
  assert.strictEqual(state.ticks, 1);
  assert.match(state.logs.join('\n'), /flow sets price_solar_forecast_max_kwh of battery bat-a: 22 → 12\.5/);

  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'target_soc', value: 79.6 });
  assert.strictEqual(state.cfg.battery_devices[0].price_target_soc, 80, 'the page stores whole percent');
  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'reserve_hours', value: 0 });
  assert.strictEqual(state.cfg.battery_devices[0].price_discharge_reserve_hours, 0, '0 is a value (reserve off), not empty');
  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'charge_power', value: 2.5 });
  assert.strictEqual(state.cfg.battery_devices[0].price_charge_power_kw, 2.5);
  assert.strictEqual(state.writes, 4);

  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'charge_power', value: 2.5 });
  await run({ device: { id: 'ems-1' }, battery: { id: 'bat-a' }, setting: 'reserve_hours', value: 0 });
  assert.strictEqual(state.writes, 4, 'the same value again writes nothing — an hourly flow need not rewrite the config, a 0 included');

  await run({ device: { id: 'other-ems' }, battery: { id: 'bat-a' }, setting: 'charge_power', value: 4 });
  assert.strictEqual(state.cfg.battery_devices[0].price_charge_power_kw, 2.5, 'a card for another EMS device is not ours');
});

test('battery value: a field never saved gets its value; price control off stays off', async () => {
  const { d, state } = makeDevice({ battery_devices: [{ id: 'bat-a' }] });
  await d.setBatteryPriceSetting('bat-a', 'target_soc', 85);
  assert.deepStrictEqual(state.cfg.battery_devices[0], { id: 'bat-a', price_target_soc: 85 });
  assert.match(state.logs.join('\n'), /price_target_soc of battery bat-a: — → 85/);
});

test('battery value: out of range, empty, unknown battery or setting fails the flow and writes nothing', async () => {
  const { d, state } = makeDevice({ battery_devices: [luna()] }, 'de');
  await assert.rejects(d.setBatteryPriceSetting('bat-a', 'target_soc', 101), { message: 'Ziel-SOC muss zwischen 0 und 100 liegen.' });
  await assert.rejects(d.setBatteryPriceSetting('bat-a', 'charge_power', 50.5), /Ladeleistung muss zwischen 0 und 50/);
  await assert.rejects(d.setBatteryPriceSetting('bat-a', 'reserve_hours', -1), /Spitzenzeit-Reserve muss zwischen 0 und 24/);
  await assert.rejects(d.setBatteryPriceSetting('bat-a', 'solar_max_kwh', 600), /muss zwischen 0 und 500/);
  for (const v of ['', null, undefined, 'abc', NaN]) {
    await assert.rejects(d.setBatteryPriceSetting('bat-a', 'target_soc', v), /Ziel-SOC muss/, `${v} must not become 0 %`);
  }
  await assert.rejects(d.setBatteryPriceSetting('gone', 'target_soc', 80), { message: 'Diese Batterie ist im EMS nicht mehr eingerichtet. Wähle sie in der Flow-Karte neu.' });
  await assert.rejects(d.setBatteryPriceSetting('bat-a', 'price_charge_enabled', 1), /Unknown battery price setting/);
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.ticks, 0);
});

test('battery picker: the configured batteries by their Homey name, filtered by what is typed', async () => {
  const { d, state } = makeDevice({ battery_devices: [luna(), { id: 'bat-b' }, { cap_soc: 'x' }] });
  d._registerSettingCards();
  const auto = state.cards.ems_set_battery_price_value.auto.battery;
  assert.deepStrictEqual(await auto(''), [{ id: 'bat-a', name: 'LUNA2000 West' }, { id: 'bat-b', name: 'LUNA2000 Ost' }]);
  assert.deepStrictEqual(await auto('ost'), [{ id: 'bat-b', name: 'LUNA2000 Ost' }]);
  await assert.rejects(state.cards.ems_set_battery_price_value.run({ device: { id: 'ems-1' }, battery: null, setting: 'target_soc', value: 80 }),
    /no longer set up/);
});

test('factor: saved like a typed one and applied at once, forecast values included', async () => {
  const now = Date.now();
  const { d, state } = makeDevice({ pv_forecast_factor: 1, battery_devices: [luna()] });
  d._pvForecastRaw = [1, 2, 3, 4].map((i) => ({ end: now + i * 0.5 * HOUR, kw: 4, kw10: 2, kw90: 5, h: 0.5 }));
  d._pvForecastFetchedAt = now;
  d._applyPvForecastFactor(state.cfg);
  d._registerSettingCards();

  await state.cards.ems_set_pv_forecast_factor.run({ device: { id: 'ems-1' }, factor: 0.744 });
  assert.strictEqual(state.cfg.pv_forecast_factor, 0.74, 'two decimals, as the field has');
  assert.deepStrictEqual(state.cfg.battery_devices, [luna()], 'the rest of the config is kept');
  assert.strictEqual(d._pvForecastNextKwh(3, now), 8 * 0.74, 'the EMS decides with it right away');
  assert.strictEqual(state.caps.pv_forecast_now, 4 * 0.74, 'the "now" value follows without waiting for a tick');
  assert.strictEqual(state.cfg.battery_devices[0].price_solar_forecast_max_kwh, 22);

  await d.setPvForecastFactor(0.74);
  assert.strictEqual(state.writes, 1, 'the same factor again writes nothing');
  await d.setPvForecastFactor(1.5);
  await d.setPvForecastFactor(0.3);
  assert.strictEqual(state.cfg.pv_forecast_factor, 0.3, 'both ends are allowed');
});

test('factor: outside 0.3..1.5 or empty fails the flow in the user\'s language and writes nothing', async () => {
  for (const [lang, text] of [['en', 'Correction factor must be between 0.3 and 1.5.'],
    ['de', 'Korrekturfaktor muss zwischen 0,3 und 1,5 liegen.'],
    ['nl', 'Correctiefactor moet tussen 0,3 en 1,5 liggen.']]) {
    const { d, state } = makeDevice({ pv_forecast_factor: 0.8 }, lang);
    d._pvForecastRaw = null;
    for (const v of [0.29, 1.51, 0, -1, '', null, 'x']) {
      await assert.rejects(d.setPvForecastFactor(v), { message: text }, `${lang}: ${v}`);
    }
    assert.strictEqual(state.writes, 0);
    assert.strictEqual(state.cfg.pv_forecast_factor, 0.8);
  }
});

test('the error texts exist in all three languages, with the three placeholders', () => {
  for (const lang of ['en', 'de', 'nl']) {
    const e = LOCALES[lang].errors;
    assert.ok(e.emsBatteryUnknown, `${lang}: emsBatteryUnknown missing`);
    for (const p of ['{{name}}', '{{min}}', '{{max}}']) assert.ok(e.emsSettingRange.includes(p), `${lang}: ${p} missing`);
    assert.ok(!/ß/.test(e.emsBatteryUnknown + e.emsSettingRange));
  }
});

test('the release: a changelog entry 1.3.14 naming both cards, in a version from 1.3.14 on', () => {
  assert.ok(app.version.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0) >= 1003014, `version ${app.version} is older than the cards`);
  const entry = JSON.parse(read('.homeychangelog.json'))['1.3.14'];
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(entry && entry[lang], `${lang} changelog missing`);
    assert.ok(entry[lang].includes(card('ems_set_pv_forecast_factor').title[lang]), `${lang}: factor card title not in the changelog`);
    assert.ok(entry[lang].includes(card('ems_set_battery_price_value').title[lang]), `${lang}: battery card title not in the changelog`);
  }
});

'use strict';

// The session-history widget was written for the OCPP charger, which keeps its own
// per-session log. Anyone steering an Easee, a go-e or a Zaptec through the EMS — that is
// to say most installations — got "No charger registered" and an empty card, while the
// same sessions were listed in the app settings. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const widgetApi = require('../widgets/session-history/api.js');

// homey.drivers.getDriver(id).getDevices() is what lib/widget-data.getDevice walks.
function makeHomey({ ocpp = null, ems = null } = {}) {
  const byId = {};
  if (ocpp) byId.smartcharger_ocpp = ocpp;
  if (ems)  byId.energy_management = ems;
  return {
    i18n: { getLanguage: () => 'de' },
    drivers: {
      getDriver(id) {
        if (!byId[id]) throw new Error('no such driver');
        return { getDevices: () => [byId[id]] };
      },
    },
  };
}

const T0 = 1_770_000_000_000;
const FINISHED = {
  chargerId: 'c1', carName: 'Audi - Q4', startedAt: T0 - 7200_000, endedAt: T0 - 3600_000,
  energyKwh: 6.76, gridKwh: 0.82, pvKwh: 5.94, pvShare: 88, cost: 0.28, avgPrice: 0.342, currency: 'CHF',
};

test('falls back to the EMS sessions when no OCPP charger is paired', async () => {
  const homey = makeHomey({ ems: { getEmsChargeSessions: () => [FINISHED] } });
  const out = await widgetApi.getSessions({ homey });
  assert.strictEqual(out.error, undefined);
  assert.strictEqual(out.history.length, 1);
  assert.strictEqual(out.history[0].energyWh, 6760, 'kWh → Wh, which is what the widget renders');
  assert.strictEqual(out.history[0].startTime, FINISHED.startedAt);
  assert.strictEqual(out.history[0].stopTime, FINISHED.endedAt);
  assert.strictEqual(out.history[0].durationMs, 3600_000);
  assert.strictEqual(out.lang, 'de');
});

test('the car and the solar share fill the widget\'s reason slot', () => {
  // The OCPP row puts its stop reason there. The EMS has no stop reason but knows two
  // things the charger does not, and the slot would otherwise sit empty.
  const homey = makeHomey({ ems: { getEmsChargeSessions: () => [FINISHED] } });
  return widgetApi.getSessions({ homey }).then((out) => {
    assert.strictEqual(out.history[0].reason, 'Audi - Q4 · 88% PV');
  });
});

test('a running session becomes `current`, not a history row', async () => {
  const running = { ...FINISHED, endedAt: null, running: true, charging: true };
  const homey = makeHomey({ ems: { getEmsChargeSessions: () => [running, FINISHED] } });
  const out = await widgetApi.getSessions({ homey });
  assert.strictEqual(out.history.length, 1, 'only the finished one');
  assert.ok(out.current, 'the running one is the live row');
  assert.strictEqual(out.current.startTime, running.startedAt);
  assert.strictEqual(out.current.paused, false);
  assert.ok(out.current.durationMs > 0, 'measured against now, not against a null end');
});

test('plugged in but not drawing reads as paused', async () => {
  // Normal for an EMS-steered charger between two solar windows. "In progress" next to a
  // duration that grows while nothing charges would be the wrong word.
  const running = { ...FINISHED, endedAt: null, running: true, charging: false };
  const homey = makeHomey({ ems: { getEmsChargeSessions: () => [running] } });
  const out = await widgetApi.getSessions({ homey });
  assert.strictEqual(out.current.paused, true);
});

test('an OCPP charger still wins — its history is the richer one', async () => {
  const ocpp = {
    getSessionHistory: async () => [{ startTime: 1, stopTime: 2, energyWh: 5, amps: 16, phases: 3 }],
    getCurrentSessionInfo: () => null,
  };
  const homey = makeHomey({ ocpp, ems: { getEmsChargeSessions: () => [FINISHED] } });
  const out = await widgetApi.getSessions({ homey });
  assert.strictEqual(out.history[0].amps, 16, 'the OCPP row, which carries amps and phases');
});

test('neither paired — the widget is told so rather than shown an empty list', async () => {
  const out = await widgetApi.getSessions({ homey: makeHomey({}) });
  assert.match(out.error, /no_charger/);
  assert.strictEqual(out.lang, 'de');
});

test('an EMS device from before this shape is not called blindly', async () => {
  // getDevice returns whatever is paired; a device without the method would throw inside
  // the widget request and leave the card stuck on its loading state.
  const out = await widgetApi.getSessions({ homey: makeHomey({ ems: {} }) });
  assert.match(out.error, /no_charger/);
});

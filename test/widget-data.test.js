'use strict';

// The power snapshot every live widget draws from. Run: node --test
//
// The whole point of this file is the difference between "nothing there" and "zero".
// fmt() in the widgets prints null as an em dash, so a null travels all the way to the
// screen as "we don't know" — while a 0 is a measurement, and a wrong one. Two of these
// chains used to end in 0, and a house with no inverter paired was shown a confident
// "0 W" of solar production.

const test   = require('node:test');
const assert = require('node:assert');

const { getDevice, cap, getPowerData } = require('../lib/widget-data');

// A Homey stand-in: `caps` maps driverId -> { capabilityId: value }. A driver that is not
// listed does not exist; a driver listed with null has no paired devices.
function fakeHomey(caps) {
  return {
    drivers: {
      getDriver(id) {
        if (!(id in caps)) throw new Error('no such driver: ' + id);
        const values = caps[id];
        return { getDevices: () => (values === null ? [] : [{ getCapabilityValue: (c) => values[c] ?? null }]) };
      },
    },
  };
}

test('getDevice — an unknown driver or an unpaired one is null, never a throw', () => {
  const homey = fakeHomey({ luna2000_modbus: null });
  assert.strictEqual(getDevice(homey, 'luna2000_modbus'), null, 'driver exists, nothing paired');
  assert.strictEqual(getDevice(homey, 'not_a_driver'), null, 'a throwing lookup is still null');
});

test('cap — a missing device or capability falls back rather than throwing', () => {
  assert.strictEqual(cap(null, 'measure_power'), null);
  assert.strictEqual(cap({ getCapabilityValue: () => { throw new Error('boom'); } }, 'x', 7), 7);
  assert.strictEqual(cap({ getCapabilityValue: () => 0 }, 'measure_power', 99), 0,
    'a real zero reading must survive the fallback — it is a measurement');
});

// The regression this file exists for.
test('getPowerData — with nothing paired every figure is unknown, not zero', () => {
  const homey = fakeHomey({
    sun2000_modbus: null, sun2000_emma_modbus: null, luna2000_modbus: null,
    luna2000_emma_modbus: null, powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  });
  const d = getPowerData(homey);
  assert.strictEqual(d.pvPower, null, 'no inverter is not "producing 0 W"');
  assert.strictEqual(d.gridPower, null, 'no meter is not "importing 0 W"');
  assert.strictEqual(d.batteryPower, null);
  assert.strictEqual(d.batterySoc, null);
  assert.strictEqual(d.housePower, null, 'two unknowns must not add up to a confident zero');
});

test('getPowerData — a genuine zero reading is reported as zero', () => {
  const homey = fakeHomey({
    sun2000_modbus: { measure_power: 0, 'measure_power.grid_active_power': 0 },
    sun2000_emma_modbus: null, luna2000_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  });
  const d = getPowerData(homey);
  assert.strictEqual(d.pvPower, 0, 'the inverter really says zero — that is data');
  assert.strictEqual(d.gridPower, 0);
  assert.strictEqual(d.housePower, 0, 'and the balance derived from it is a real zero too');
});

test('getPowerData — the house balance is derived only when PV and grid are both known', () => {
  const base = {
    sun2000_emma_modbus: null, luna2000_emma_modbus: null, powermeter_emma_modbus: null,
    sdongle_a_modbus: null, isitepower_solar_openapi_fusionsolar: null,
    isitepower_battery_openapi_fusionsolar: null, isitepower_grid_openapi_fusionsolar: null,
    isitepower_home_openapi_fusionsolar: null,
  };
  // PV 3000, importing 500, battery charging 1000 → house = 3000 + 500 - 1000
  const full = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus:  { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: { measure_power: 1000, measure_battery: 80 },
  })));
  assert.strictEqual(full.housePower, 2500);
  assert.strictEqual(full.batterySoc, 80);

  // No battery at all is not a gap — a house without one simply draws the difference.
  const noBattery = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus: { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: null,
  })));
  assert.strictEqual(noBattery.housePower, 3500);

  // A grid reading without any PV reading cannot produce a balance.
  const noPv = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus: null, luna2000_modbus: null,
    powermeter_emma_modbus: { measure_power: 500 },
  })));
  assert.strictEqual(noPv.gridPower, 500);
  assert.strictEqual(noPv.pvPower, null);
  assert.strictEqual(noPv.housePower, null, 'a sum missing one of its terms is not a smaller sum');
});

test('getPowerData — the balance never goes negative', () => {
  const d = getPowerData(fakeHomey({
    sun2000_modbus:  { measure_power: 1000, 'measure_power.grid_active_power': -4000 },
    luna2000_modbus: null, sun2000_emma_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  }));
  assert.strictEqual(d.housePower, 0, 'exporting more than produced would imply a negative load');
});

test('getPowerData — a paired home meter wins over the derived balance', () => {
  const d = getPowerData(fakeHomey({
    sun2000_modbus:  { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: null, sun2000_emma_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null,
    isitepower_home_openapi_fusionsolar: { measure_power: 2222 },
  }));
  assert.strictEqual(d.housePower, 2222, 'a measured figure beats a computed one');
});

// ─── Reachability ───────────────────────────────────────────────────────────
//
// Homey marks a device it cannot reach as unavailable, and shows that everywhere — except
// in these widgets, which read the capability values straight out and drew them as though
// they had just arrived. A dashboard went on reporting "47%, discharging at 2.3 kW" for a
// battery that had dropped off the network an hour earlier. Same failure as the 0-versus-
// null one above, one layer further out: a reading that is not current, presented as one.

const { isReachable } = require('../lib/widget-data');

// `available` defaults to true so the existing stand-ins above keep meaning what they meant.
function fakeDevice(values, { available = true, noAvailableMethod = false } = {}) {
  const d = { getCapabilityValue: (c) => (c in values ? values[c] : null) };
  if (!noAvailableMethod) d.getAvailable = () => available;
  return d;
}

test('isReachable — absent, broken and old devices are judged on the safe side', () => {
  assert.strictEqual(isReachable(null), false, 'no device is not a reachable one');
  assert.strictEqual(isReachable(fakeDevice({}, { available: false })), false);
  assert.strictEqual(isReachable(fakeDevice({}, { available: true })), true);
  // A stand-in without the method, or one that throws, must not be read as unreachable —
  // that would blank widgets that work perfectly today.
  assert.strictEqual(isReachable(fakeDevice({}, { noAvailableMethod: true })), true,
    'a device object without getAvailable is treated as unreachable, blanking live widgets');
  assert.strictEqual(isReachable({ getAvailable: () => { throw new Error('boom'); } }), true,
    'a throwing getAvailable blanks the widget instead of being ignored');
  // Only an explicit false counts against a device. A device that has not yet said either
  // way — mid-init, or a Homey version that answers with undefined — keeps reporting;
  // treating "not yet known" as "unreachable" would blank a dashboard at every app restart.
  assert.strictEqual(isReachable({ getAvailable: () => undefined }), true,
    'a device that has not yet reported its availability is treated as unreachable');
});

test('an unreachable device contributes no live reading', () => {
  const dead = fakeDevice({ measure_power: 2300, measure_battery: 47 }, { available: false });
  assert.strictEqual(cap(dead, 'measure_power'), null,
    'a power reading from an unreachable device is drawn as though it were current');
  assert.strictEqual(cap(dead, 'measure_battery'), null);
  const live = fakeDevice({ measure_power: 2300 });
  assert.strictEqual(cap(live, 'measure_power'), 2300, 'a reachable device still reports');
});

// Lifetime totals are the deliberate exception: 1107.62 kWh lifetime stays the best known
// answer while the device is quiet, whereas "discharging at 2.3 kW" stops being true the
// moment the readings stop.
test('lifetime totals survive an unreachable device', () => {
  const dead = fakeDevice({
    'meter_power': 1107.62,
    'meter_power.exported': 913.4,
    'meter_power.charged': 2698.81,
    'measure_power': 2300,
  }, { available: false });
  assert.strictEqual(cap(dead, 'meter_power'), 1107.62,
    'the lifetime total was withheld, which throws away a figure that is not stale');
  assert.strictEqual(cap(dead, 'meter_power.exported'), 913.4);
  assert.strictEqual(cap(dead, 'meter_power.charged'), 2698.81);
  assert.strictEqual(cap(dead, 'measure_power'), null,
    'the live reading came through alongside the totals');
});

// A counter that resets at midnight is not a running total in that sense. Once a device has
// been offline across one, its last value describes a different day — and the widget draws
// it in the place today's figure belongs. Reported in #28: a battery that answers the
// FusionSolar API only intermittently kept contributing a charged-today figure while
// unavailable.
test("a day-scoped total does not survive, because it stops meaning today", () => {
  // Held in its own object, not read back off the stand-in: fakeDevice does not expose the
  // values it was given, so a loop over the device would iterate nothing and pass empty.
  const DAY_VALUES = {
    'meter_power.today_batt_input': 8.4,
    'meter_power.today_batt_output': 4.3,
    'meter_power.daily': 23.4,
    'meter_power.pv_daily': 23.4,
    'meter_power.inv_daily': 19.5,
    'meter_power.consumption_today': 26.6,
    'meter_power.exported_today': 0.1,
    'meter_power.imported_today': 7.3,
  };
  const ids = Object.keys(DAY_VALUES);
  assert.strictEqual(ids.length, 8, 'the fixture lost entries, so this test checks less than it reads');

  const dead = fakeDevice(DAY_VALUES, { available: false });
  const live = fakeDevice(DAY_VALUES, { available: true });
  for (const id of ids) {
    assert.strictEqual(cap(dead, id), null, `${id} was drawn as today's figure`);
    assert.strictEqual(cap(live, id), DAY_VALUES[id],
      `${id} is withheld from a device Homey can reach, which blanks a healthy widget`);
  }
});

// The same capability from a device Homey can reach is a current reading, and withholding
// it would blank half the energy-balance widget on every healthy installation.
test('a day-scoped total from a reachable device comes through', () => {
  const live = fakeDevice({
    'meter_power.today_batt_input': 8.4,
    'meter_power.daily': 23.4,
  }, { available: true });
  assert.strictEqual(cap(live, 'meter_power.today_batt_input'), 8.4);
  assert.strictEqual(cap(live, 'meter_power.daily'), 23.4);
});

// The fallback chains get better as a side effect: an unreachable first choice no longer
// beats a reachable one further down.
test('a chain falls through an unreachable device to a reachable one', () => {
  const homey = {
    drivers: {
      getDriver(id) {
        const table = {
          sun2000_modbus:      { available: false, values: { measure_power: 4200 } },
          sun2000_emma_modbus: { available: true,  values: { measure_power: 3100 } },
        };
        if (!(id in table)) throw new Error('no such driver: ' + id);
        const { available, values } = table[id];
        return { getDevices: () => [fakeDevice(values, { available })] };
      },
    },
  };
  assert.strictEqual(getPowerData(homey).pvPower, 3100,
    'the unreachable inverter still won the chain, hiding the one that is answering');
});

// ─── FusionSolar OpenAPI plants ─────────────────────────────────────────────
//
// A plant reached only through the FusionSolar cloud — no Modbus, no EMMA gateway. The
// three OpenAPI drivers were named in none of the chains above, so getPowerData returned
// nothing but nulls and the solar-flow and traffic-light widgets drew em dashes throughout.
// Asserted on the returned numbers rather than on the lookups: keeping the getDevice call
// and dropping the device from the chain leaves the widget just as blind.

// A plant that owns exactly the drivers listed. Anything else throws, as a real Homey does
// for a driver with nothing paired.
function plantWith(table) {
  return {
    drivers: {
      getDriver(id) {
        if (!(id in table)) throw new Error('no such driver: ' + id);
        const values = table[id];
        return { getDevices: () => [{ getCapabilityValue: (c) => (c in values ? values[c] : null) }] };
      },
    },
  };
}

test('a FusionSolar OpenAPI plant gets real figures, not dashes', () => {
  const d = getPowerData(plantWith({
    sun2000_openapi_fusionsolar:    { measure_power: 3753 },   // PV, since 1.2.200 the MPPT figure
    powermeter_openapi_fusionsolar: { measure_power: 74 },     // grid, positive = import
    luna2000_openapi_fusionsolar:   { measure_power: -510, measure_battery: 47 },
  }));
  assert.strictEqual(d.pvPower, 3753, 'the OpenAPI inverter is not in the PV chain');
  assert.strictEqual(d.gridPower, 74, 'the OpenAPI meter is not in the grid chain');
  assert.strictEqual(d.batteryPower, -510, 'the OpenAPI battery is not in the power chain');
  assert.strictEqual(d.batterySoc, 47, 'the OpenAPI battery is not in the state-of-charge chain');
  // 3753 PV + 74 imported − (−510 discharging) = 4337 W of house load.
  assert.strictEqual(d.housePower, 4337, 'the house balance cannot be derived for this plant');
});

// The grid meter on the Modbus side had the same gap, for a narrower reason: the SUN2000
// mirrors the meter's reading, so only a plant with the meter and no Modbus inverter went
// without.
test('a plant with only a DTSU666 still reports grid power', () => {
  const d = getPowerData(plantWith({ dtsu666_modbus: { measure_power: 1520 } }));
  assert.strictEqual(d.gridPower, 1520, 'the DTSU666 is not in the grid chain');
});

// Local sources stay ahead of the cloud: Modbus is seconds old, the API minutes at best.
test('a local reading still wins over the cloud', () => {
  const d = getPowerData(plantWith({
    sun2000_modbus:              { measure_power: 4000 },
    sun2000_openapi_fusionsolar: { measure_power: 3753 },
  }));
  assert.strictEqual(d.pvPower, 4000,
    'the cloud figure overtook the local one, which is minutes fresher');
});

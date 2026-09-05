'use strict';

/**
 * Shared helpers for all widget api.js files.
 *
 * Provides:
 *   getDevice(homey, driverId)  — safe driver/device lookup
 *   cap(device, id, fallback)   — safe capability value read
 *   getPowerData(homey)         — live power snapshot used by solar-power-flow & netzampel
 */

function getDevice(homey, driverId) {
  try {
    const driver = homey.drivers.getDriver(driverId);
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

// A device Homey cannot reach still holds the values it last managed to read, and
// getCapabilityValue hands them back without a word. Every one of the twelve widgets read
// them that way, so a dashboard went on showing "47%, discharging at 2.3 kW" for a battery
// that had been unreachable for an hour. Homey marks the device itself as unavailable
// everywhere else; the widgets were the one place that hid it.
//
// So an unavailable device contributes nothing here, and the widgets draw what they
// already draw for a device that is not paired at all: an em dash. Nothing to change in
// twelve separate pages, and the fallback chains improve as a side effect — a value from
// an unreachable inverter no longer wins over a reachable one further down the chain.
//
// The exception is deliberate. meter_* capabilities are running totals, and the last one
// read is still the best known total: "charged 8.4 kWh today" stays true about today when
// the battery drops off the network, while "discharging at 2.3 kW" stops being true the
// moment the reading stops arriving. Withholding the totals as well would throw away
// information that is not stale in any meaningful sense.
function isReachable(device) {
  if (!device) return false;
  try {
    // getAvailable is a device method; a plain object from a test or an older Homey without
    // it should not be treated as unreachable.
    return typeof device.getAvailable === 'function' ? device.getAvailable() !== false : true;
  } catch { return true; }
}

function cap(device, id, fallback = null) {
  if (!device) return fallback;
  if (!isReachable(device) && !String(id).startsWith('meter_')) return fallback;
  try { return device.getCapabilityValue(id) ?? fallback; } catch { return fallback; }
}

/**
 * Returns live power data for the solar-power-flow and netzampel widgets.
 * Device priority: sun2000_modbus → sun2000_emma_modbus → sdongle_a_modbus
 *                  luna2000_modbus → luna2000_emma_modbus → sdongle_a_modbus
 *
 * @returns {{ pvPower, gridPower, batteryPower, batterySoc, housePower }}
 */
function getPowerData(homey) {
  const sun2000    = getDevice(homey, 'sun2000_modbus');
  const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
  const luna2000   = getDevice(homey, 'luna2000_modbus');
  const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
  const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');
  const dtsu666    = getDevice(homey, 'dtsu666_modbus');
  const sdongle    = getDevice(homey, 'sdongle_a_modbus');
  // The three FusionSolar OpenAPI drivers were missing from every chain below. The
  // iSitePower ones were added at some point and these were passed over, so a plant reached
  // only through the FusionSolar cloud — no Modbus, no EMMA — drew four widgets full of em
  // dashes and looked, reasonably enough, broken.
  const sunOa      = getDevice(homey, 'sun2000_openapi_fusionsolar');
  const lunaOa     = getDevice(homey, 'luna2000_openapi_fusionsolar');
  const pmOa       = getDevice(homey, 'powermeter_openapi_fusionsolar');
  const ispSolar   = getDevice(homey, 'isitepower_solar_openapi_fusionsolar');
  const ispBatt    = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
  const ispGrid    = getDevice(homey, 'isitepower_grid_openapi_fusionsolar');
  const ispHome    = getDevice(homey, 'isitepower_home_openapi_fusionsolar');

  // Every chain ends in null, never 0 — "no device of this kind is paired" is not the
  // same statement as "it is producing nothing", and the widgets can say so: fmt() prints
  // null as an em dash. These two used to end in 0, which threw that away and drew a
  // confident "0 W" for a house that simply has no inverter or grid meter attached.
  const pvPower      = cap(sun2000,    'measure_power',                  null)
                    ?? cap(sun2000em,  'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.solar',            null)
                    ?? cap(sunOa,      'measure_power',                   null)
                    ?? cap(ispSolar,   'measure_power',                   null);
  // The DTSU666 was missing here too, and for a narrower reason: the SUN2000 mirrors the
  // meter's reading in its own register, so a plant with both was served either way. A
  // plant with the meter paired and no Modbus inverter had no grid figure at all. Its
  // measure_power is already negated to the same convention as the rest of this chain —
  // positive is import.
  const gridPower    = cap(sun2000,    'measure_power.grid_active_power', null)
                    ?? cap(dtsu666,    'measure_power',                   null)
                    ?? cap(pmEmma,     'measure_power',                   null)
                    ?? cap(sdongle,    'measure_power.grid_active_power', null)
                    ?? cap(pmOa,       'measure_power',                   null)
                    ?? cap(ispGrid,    'measure_power',                   null);
  const batteryPower = cap(luna2000,   'measure_power',                  null)
                    ?? cap(luna2000em, 'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.battery',           null)
                    ?? cap(lunaOa,     'measure_power',                   null)
                    ?? cap(ispBatt,    'measure_power',                   null);
  const batterySoc   = cap(luna2000,   'measure_battery',                null)
                    ?? cap(luna2000em, 'measure_battery',                null)
                    ?? cap(lunaOa,     'measure_battery',                null)
                    ?? cap(ispBatt,    'measure_battery',                null);
  // Derived only where there is something to derive from. The `?? 0` inside the sum would
  // otherwise turn two unknowns into a confident 0 W of house load — the same mistake as
  // above, one line further on. A missing battery is fine (a house without one draws the
  // difference), but without PV or grid the balance is not incomplete, it is unknown.
  const derivedHouse = (pvPower === null || gridPower === null)
    ? null
    : Math.max(0, pvPower + gridPower - (batteryPower ?? 0));
  const housePower   = cap(ispHome,    'measure_power',                  null) ?? derivedHouse;

  return { pvPower, gridPower, batteryPower, batterySoc, housePower };
}

module.exports = { getDevice, cap, getPowerData, isReachable };

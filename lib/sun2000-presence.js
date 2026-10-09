'use strict';

// Which SUN2000 inverters are paired in this app — by Modbus, through an EMMA, or from the
// FusionSolar cloud. Each of them already reports the plant's solar production to Homey
// Energy, so a kiosk device beside one of them counts that production a second time unless
// it is excluded from Energy (1.2.295).

const SUN2000_DRIVERS = ['sun2000_modbus', 'sun2000_emma_modbus', 'sun2000_openapi_fusionsolar'];

function sun2000Names(homey) {
  const names = [];
  for (const id of SUN2000_DRIVERS) {
    try {
      for (const d of homey.drivers.getDriver(id).getDevices()) names.push(d.getName());
    } catch (_) {
      // A driver that is not ready yet has no devices to report; the next check finds them.
    }
  }
  return names;
}

module.exports = { SUN2000_DRIVERS, sun2000Names };

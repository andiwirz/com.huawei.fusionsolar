'use strict';

// A device warning while a device counts wrongly in Homey Energy — the kiosk device beside a
// SUN2000 (1.2.295), the SDongle always (1.2.297).
//
// Homey's "Exclude from Energy" is the owner's setting; the app can only point at it. Homey
// keeps it as energy_exclude among the device's settings, but whether an app is handed it is
// not documented ('energy_' is reserved for Homey), so the first check logs what it sees, and
// the app setting excluded_from_energy stands in when it is not: the owner ticks it once the
// exclusion is done, and the warning goes. setWarning is persistent, so the first check after
// a start also clears one that no longer applies.

function energyExcluded(settings) {
  const v = settings.energy_exclude;
  return typeof v === 'boolean' ? v : null;
}

async function applyEnergyWarning(device, { conflict, message, settings = device.getSettings(), detail = '' }) {
  const excluded = energyExcluded(settings);
  if (!device._energyExcludeLogged) {
    device._energyExcludeLogged = true;
    device.log(`Homey Energy: "Exclude from Energy" ${excluded === null ? 'is not visible to the app' : `reads ${excluded}`}`);
  }
  const show = !!conflict && excluded !== true && settings.excluded_from_energy !== true;
  if (show === device._energyWarningShown) return show;
  device._energyWarningShown = show;
  if (show) {
    device.log(`Energy warning set${detail ? `: ${detail}` : ''}`);
    await device.setWarning(message).catch((err) => device.error('setWarning failed:', err.message));
  } else {
    await device.unsetWarning().catch((err) => device.error('unsetWarning failed:', err.message));
  }
  return show;
}

module.exports = { energyExcluded, applyEnergyWarning };

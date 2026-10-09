'use strict';

// Keeps a few capabilities at the end of a device's tile (1.2.301).
//
// Homey shows a device's capabilities in the order the device holds them. That order is set
// at pairing from the driver manifest, and every addCapability afterwards appends — there is
// no call that reorders. So the software version, last in the manifest, ended up in the middle
// of every tile that had been given a capability since: grid frequency, the meter's grid
// figures, the optimizer counts, a battery's rated capacity all came after it.
//
// A capability moves to the end by being removed and added again, its value carried over.
// That is only done with string capabilities that keep no Insights — a version string has no
// history to lose and no flow card of its own — and only when it is not already in place, so
// the check costs a look at an array on every poll and the move happens once per new
// capability, not once per poll.

/**
 * @param {import('homey').Device} device
 * @param {string[]} capIds  in the order they should end the tile
 * @returns {Promise<boolean>} whether anything moved
 */
async function keepLast(device, capIds) {
  const present = capIds.filter((c) => device.hasCapability(c));
  if (!present.length) return false;
  const caps = device.getCapabilities();
  const tail = caps.slice(caps.length - present.length);
  if (tail.length === present.length && tail.every((c, i) => c === present[i])) return false;

  for (const capId of present) {
    const value = device.getCapabilityValue(capId);
    await device.removeCapability(capId);
    try {
      await device.addCapability(capId);
    } catch (err) {
      // Once more: a capability lost here would stay away until the next app start.
      await device.addCapability(capId);
    }
    if (value !== null && value !== undefined) {
      await device.setCapabilityValue(capId, value).catch(() => {});
    }
  }
  return true;
}

module.exports = { keepLast };

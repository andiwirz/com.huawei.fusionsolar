'use strict';

// lang(): the dashboard language comes from Homey itself, NOT from navigator.language inside
// the widget — see lib/widget-data.js. getEmsDevice and lang are shared by all EMS widgets.
const { getEmsDevice, lang } = require('../../lib/widget-data');

module.exports = {

  async getStatus({ homey, query }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    const id = query && query.device;
    if (!id) return { error: 'no_device_selected', lang: lang(homey) };
    try {
      return { ...(await device.getEmsControllableStatus(id)), lang: lang(homey) };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
    }
  },

  async setEnabled({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { device: id, enabled } = body || {};
    if (!id) return { error: 'missing_params' };
    if (typeof enabled !== 'boolean') return { error: 'invalid_value' };
    try {
      return await device.setEmsDeviceEnabled(id, enabled);
    } catch (e) {
      return { error: e.message };
    }
  },

  async setMode({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { device: id, mode } = body || {};
    if (!id || !mode) return { error: 'missing_params' };
    try {
      return await device.setEmsChargerMode(id, mode);
    } catch (e) {
      return { error: e.message };
    }
  },

  // POST /car-target — charge-limit buttons under the car bar.
  //
  // Must live here, not in the app's api.js: a widget's Homey.api() calls are routed to
  // its own api.js, so an app-level route is simply unreachable from the tile.
  async setCarTarget({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { carId, soc } = body || {};
    if (!carId) return { error: 'missing_car_id' };
    if (typeof device.setCarTargetSoc !== 'function') return { error: 'car_targets_unsupported' };
    try {
      return { ok: true, soc: await device.setCarTargetSoc(carId, soc) };
    } catch (e) {
      return { error: e.message };
    }
  },

  async setChargeNow({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { chargeNow } = body || {};
    if (typeof chargeNow !== 'boolean') return { error: 'invalid_value' };
    try {
      return await device.setEmsChargeNow(chargeNow);
    } catch (e) {
      return { error: e.message };
    }
  },

};

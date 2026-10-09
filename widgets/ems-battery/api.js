'use strict';

const { getEmsDevice, lang } = require('../../lib/widget-data');

module.exports = {

  async getStatus({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    try {
      return { ...(await device.getEmsBatteryStatus()), lang: lang(homey) };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
    }
  },

  async setZones({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    try {
      return await device.setEmsBatteryZones(body || {});
    } catch (e) {
      return { error: e.message };
    }
  },

};

'use strict';

// Dashboard language from Homey itself, not navigator.language — see ems-device/api.js.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  // ?since=<ts> returns only what came after it. The widget used to fetch the whole history
  // — up to 400 events, ~45 KB — every 30 s and rebuild the list from it (1.2.299). newestTs
  // lets it notice a history that shrank (cleared, or restored from an older save) and
  // start over with a full load.
  async getHistory({ homey, query }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      // A code the widget translates, not an English sentence on a German dashboard.
      if (!devices.length) return { events: [], error: 'no_ems_device', lang: lang(homey) };
      const all     = devices[0].getEmsHistory();
      const since   = Number(query && query.since) || 0;
      const newestTs = all.length ? all[all.length - 1].ts : 0;
      const events  = since ? all.filter((e) => e.ts > since) : all;
      return { events, full: !since, newestTs, lang: lang(homey) };
    } catch (e) {
      return { events: [], error: e.message, lang: lang(homey) };
    }
  },
};

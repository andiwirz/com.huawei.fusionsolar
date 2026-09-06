'use strict';

const { getDevice, cap } = require('../../lib/widget-data');

// Dashboard language from Homey itself, not navigator.language in the widget — that is
// the browser/OS language and can differ from the Homey app language. See
// widgets/ems-device/api.js for the full rationale.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  async getData({ homey }) {

    // Try sun2000_modbus → sun2000_emma_modbus → fusionsolar_kiosk
    // The OpenAPI inverter names its yield differently, and the difference matters: its
    // plain meter_power holds the GRID IMPORT total, not production. Read here the way the
    // others are read, it would have drawn a house's grid consumption as its solar yield.
    // The inverter's own figures are meter_power.inv_daily and meter_power.inv_total.
    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');
    const sunOa       = getDevice(homey, 'sun2000_openapi_fusionsolar');
    const kiosk       = getDevice(homey, 'fusionsolar_kiosk');

    // meter_power.pv_daily is the station's PV production; inv_daily is the inverter's AC
    // output, which on a hybrid excludes everything that went into the battery. See #28 and
    // the arithmetic in the OpenAPI inverter driver. inv_daily remains the fallback.
    const dailyKwh        = cap(sun2000,     'meter_power.daily', null)
                         ?? cap(sun2000emma, 'meter_power.pv_daily', null)
                         ?? cap(sun2000emma, 'meter_power.daily', null)
                         ?? cap(sunOa,       'meter_power.pv_daily', null)
                         ?? cap(sunOa,       'meter_power.inv_daily', null)
                         ?? cap(kiosk,       'meter_power.daily', null);
    // Total from the same source as today's figure above, wherever there is one. The
    // OpenAPI pair used to mix periods — a station daily figure beside the inverter's own
    // lifetime counter — and the EMMA pair mixed quantities the same way, since its
    // meter_power is the inverter yield and meter_power.pv_total the PV production. Both
    // inverters' own counters stay as fallbacks and stay on their devices.
    const totalKwh        = cap(sun2000,     'meter_power', null)
                         ?? cap(sun2000emma, 'meter_power.pv_total', null)
                         ?? cap(sun2000emma, 'meter_power', null)
                         ?? cap(sunOa,       'meter_power.pv_total', null)
                         ?? cap(sunOa,       'meter_power.inv_total', null)
                         ?? cap(kiosk,       'meter_power', null);
    const optimizerTotal  = cap(sun2000, 'optimizer_total_count', null);
    const optimizerOnline = cap(sun2000, 'optimizer_online_count', null);

    // CO₂ saved: passed as raw kWh — factor applied client-side in the widget
    // (user can configure the factor per country in widget settings)
    const co2SavedKg = dailyKwh !== null
      ? Math.round(dailyKwh * 0.401 * 10) / 10
      : null;

    return { dailyKwh, totalKwh, optimizerTotal, optimizerOnline, co2SavedKg, lang: lang(homey) };
  },
};

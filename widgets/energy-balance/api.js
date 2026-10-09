'use strict';

// Today's figures are deltas against the baselines app.js stores at midnight; the helper
// (dailyDelta) lives in lib/widget-data.js with the other shared pieces.
const { getDevice, cap, dailyDelta, lang } = require('../../lib/widget-data');

// The two kinds of "PV today" a source can report; see pvToday below.
const PV = 'pv';   // production at the panels
const AC = 'ac';   // what the inverter delivered — the battery already netted out

function reading(device, capId, kind) {
  const kwh = cap(device, capId, null);
  return kwh === null ? null : { kwh, kind };
}

function deltaReading(homey, raw, key, kind) {
  const kwh = dailyDelta(homey, raw, key);
  return kwh === null ? null : { kwh, kind };
}

module.exports = {
  async getData({ homey }) {

    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');
    const pmEmma      = getDevice(homey, 'powermeter_emma_modbus');
    const luna        = getDevice(homey, 'luna2000_modbus');
    const lunaEmma    = getDevice(homey, 'luna2000_emma_modbus');
    // FusionSolar OpenAPI: local sources first, cloud after. The grid counters live under
    // their own names on the meter — meter_power is the import total and
    // meter_power.exported the export total, as on the DTSU666 — while the OpenAPI
    // inverter carries the grid_import / grid_export pair its Modbus twin uses. Each
    // device is read by its own name rather than assuming one shape.
    const sunOa       = getDevice(homey, 'sun2000_openapi_fusionsolar');
    const pmOa        = getDevice(homey, 'powermeter_openapi_fusionsolar');
    const lunaOa      = getDevice(homey, 'luna2000_openapi_fusionsolar');
    // iSitePower and the kiosk were missing here (1.2.300). iSitePower has lifetime totals
    // only, so its days come from midnight baselines like the grid counters.
    const ispSolar    = getDevice(homey, 'isitepower_solar_openapi_fusionsolar');
    const ispGrid     = getDevice(homey, 'isitepower_grid_openapi_fusionsolar');
    const ispHome     = getDevice(homey, 'isitepower_home_openapi_fusionsolar');
    const ispBatt     = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
    const kiosk       = getDevice(homey, 'fusionsolar_kiosk');

    // PV today. On the OpenAPI inverter the station figure comes first: meter_power.daily
    // holds the PV production, meter_power.inv_daily only the inverter's AC output, and on
    // a hybrid the difference is whatever went into the battery — the gap reported in #28.
    // inv_daily stays behind it for a plant whose station summary carries no daily figure.
    // The EMMA inverter names the same quantity meter_power.pv_daily, which is why the
    // OpenAPI one now uses that name too.
    //
    // Which of the two quantities was found matters for the house total below (1.2.299):
    // PV production still contains what went into the battery, the AC output (Modbus
    // 32114, the EMMA inverter yield, inv_daily) already has the battery netted out.
    const pvToday = reading(sun2000, 'meter_power.daily', AC)
                 ?? reading(sun2000emma, 'meter_power.pv_daily', PV)
                 ?? reading(sun2000emma, 'meter_power.daily', AC)
                 ?? reading(sunOa, 'meter_power.pv_daily', PV)
                 ?? reading(sunOa, 'meter_power.inv_daily', AC)
                 ?? reading(kiosk, 'meter_power.daily', PV)
                 ?? deltaReading(homey, cap(ispSolar, 'meter_power', null), 'eb_pv_baseline', PV);
    const pvTodayKwh = pvToday ? pvToday.kwh : null;

    // Grid export today: prefer sun2000 cumulative delta, fall back to EMMA inverter or EMMA meter
    //
    // The order here is load-bearing beyond this file: app.js takes its midnight snapshot
    // from the SAME chain, and a baseline read from one meter against a live value from
    // another gives a nonsense delta. Change one, change both.
    const rawExport = cap(sun2000, 'meter_power.grid_export', null)
                   ?? cap(sun2000emma, 'meter_power.grid_export', null)
                   ?? cap(pmOa, 'meter_power.exported', null)
                   ?? cap(sunOa, 'meter_power.grid_export', null)
                   ?? cap(ispGrid, 'meter_power.exported', null);
    let gridExportKwh = dailyDelta(homey, rawExport, 'eb_grid_export_baseline')
                     ?? cap(pmEmma, 'meter_power.exported_today', null);

    // Grid import today: prefer sun2000 cumulative delta, fall back to EMMA inverter or EMMA meter
    const rawImport = cap(sun2000, 'meter_power.grid_import', null)
                   ?? cap(sun2000emma, 'meter_power.grid_import', null)
                   ?? cap(pmOa, 'meter_power', null)
                   ?? cap(sunOa, 'meter_power.grid_import', null)
                   ?? cap(ispGrid, 'meter_power', null);
    let gridImportKwh = dailyDelta(homey, rawImport, 'eb_grid_import_baseline')
                     ?? cap(pmEmma, 'meter_power.imported_today', null);

    // Battery today
    const battChargedKwh    = cap(luna, 'meter_power.today_batt_input',  null)
                           ?? cap(lunaEmma, 'meter_power.today_batt_input',  null)
                           ?? cap(lunaOa, 'meter_power.today_batt_input',  null);
    const battDischargedKwh = cap(luna, 'meter_power.today_batt_output', null)
                           ?? cap(lunaEmma, 'meter_power.today_batt_output', null)
                           ?? cap(lunaOa, 'meter_power.today_batt_output', null);

    // Self-consumption: PV energy used on-site (not exported)
    let selfConsumptionPct = null;
    let selfConsumedKwh    = null;
    if (pvTodayKwh !== null && pvTodayKwh > 0 && gridExportKwh !== null) {
      selfConsumedKwh    = Math.max(0, pvTodayKwh - gridExportKwh);
      selfConsumptionPct = Math.round(selfConsumedKwh / pvTodayKwh * 100);
      selfConsumptionPct = Math.max(0, Math.min(100, selfConsumptionPct));
    }

    // House consumption today: prefer a directly reported total, fall back to calculation.
    // The FusionSolar station KPI carries one (day_use_energy) and the OpenAPI meter now
    // publishes it, which matters most on a cloud-only plant: there the calculation below
    // rests on a grid delta against a midnight baseline, and Huawei has already done the
    // same sum against its own records.
    //
    // The calculation is the balance at the house connection: what the inverter delivered,
    // minus what went to the grid, plus what came from it. From a PV production figure the
    // battery's net charge comes off first — the panels' energy that went into the battery
    // was not consumed today. Where a battery is paired but its day counters are missing
    // that net is unknown, and so is the total; without a battery it is zero.
    let houseConsumptionKwh = cap(pmEmma, 'meter_power.consumption_today', null)
                           ?? cap(pmOa,   'meter_power.consumption_today', null)
                           ?? dailyDelta(homey, cap(ispHome, 'meter_power', null), 'eb_house_baseline');
    // Not selfConsumedKwh: that one waits for the first PV of the day, the house does not.
    const keptKwh = (pvTodayKwh !== null && gridExportKwh !== null)
      ? Math.max(0, pvTodayKwh - gridExportKwh) : null;
    if (houseConsumptionKwh === null && keptKwh !== null && gridImportKwh !== null) {
      const hasBattery = !!(luna || lunaEmma || lunaOa || ispBatt);
      let batteryNetKwh = 0;
      if (pvToday.kind === PV && hasBattery) {
        batteryNetKwh = (battChargedKwh !== null && battDischargedKwh !== null)
          ? battChargedKwh - battDischargedKwh
          : null;
      }
      if (batteryNetKwh !== null) {
        houseConsumptionKwh = Math.max(0, keptKwh - batteryNetKwh + gridImportKwh);
      }
    }

    // Self-sufficiency: the share of the house's consumption that did not come from the
    // grid. Taken against the house total shown beside it — the old sum of self-consumed
    // PV and import counted the energy that went into the battery as consumed, which put
    // the figure above what the two numbers next to it say (88 % beside 10 kWh used and
    // 2 kWh bought).
    let selfSufficiencyPct = null;
    if (houseConsumptionKwh !== null && houseConsumptionKwh > 0 && gridImportKwh !== null) {
      selfSufficiencyPct = Math.round((1 - gridImportKwh / houseConsumptionKwh) * 100);
      selfSufficiencyPct = Math.max(0, Math.min(100, selfSufficiencyPct));
    }

    // The "values from midnight" hint belongs to a plant whose grid counters exist but
    // whose baseline does not yet. A plant with no such counters at all (kiosk only,
    // EMMA meter with its own day figures) used to see it for good (1.2.300).
    const awaitingBaseline = (rawExport !== null && gridExportKwh === null)
                          || (rawImport !== null && gridImportKwh === null);

    return {
      lang: lang(homey),
      awaitingBaseline,
      pvTodayKwh,
      gridExportKwh,
      gridImportKwh,
      houseConsumptionKwh,
      battChargedKwh,
      battDischargedKwh,
      selfConsumptionPct,
      selfSufficiencyPct,
    };
  },
};

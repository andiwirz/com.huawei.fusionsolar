'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const {
  POWERMETER_EMMA_DATA_REGISTERS,
  isPowerMeterEmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const modbusPolling = require('../../lib/modbus-polling');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

// EMMA provides only aggregate grid data — no per-phase voltage, current, or power.
const REQUIRED_CAPABILITIES = [
  'measure_power',                   // Grid Active Power (W): + = import, − = export
  'meter_power',                     // Total Supply from Grid (kWh)
  'meter_power.exported',            // Total Feed-in to Grid (kWh)
  'meter_power.imported_today',      // Supply from Grid Today (kWh)
  'meter_power.exported_today',      // Feed-in to Grid Today (kWh)
  'measure_power.load',              // House Consumption Live (W)
  'meter_power.consumption_today',   // House Consumption Today (kWh)
  'measure_voltage.phase1',          // Phase A Voltage (V)
  'measure_voltage.phase2',          // Phase B Voltage (V)
  'measure_voltage.phase3',          // Phase C Voltage (V)
  'measure_current.phase1',          // Phase A Current (A)
  'measure_current.phase2',          // Phase B Current (A)
  'measure_current.phase3',          // Phase C Current (A)
  'measure_power.phase1',            // Phase A Active Power (W)
  'measure_power.phase2',            // Phase B Active Power (W)
  'measure_power.phase3',            // Phase C Active Power (W)
  'powermeter_state_string',         // Human-readable grid state: "Export 1234 W" / "Import 1234 W"
];

class PowerMeterEmmaModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevExporting   = null;
    this._failureCount    = 0;
    this._fetchInProgress = false;
    this._lastPollStart   = 0;
    await this._ensureCapabilities();
    this._registerConditions();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('grid_is_exporting')
      .registerRunListener((args) => args.device._prevExporting === true);
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;
    this._lastPollStart = Date.now();

    const address = this.getSetting('address');
    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 0);

    try {
      const d = await readModbusRegisters(address, port, modbusId, POWERMETER_EMMA_DATA_REGISTERS);

      if (!isPowerMeterEmmaDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.meterNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // feedInPower (register 30358): + = import from grid, − = export to grid
      // Matches Homey convention directly — no negation needed.
      const gridPower = d.feedInPower ?? null;

      await this._set('measure_power',                 gridPower);
      if (gridPower !== null) {
        const gridWatts = Math.round(Math.abs(gridPower));
        const label = gridPower < 0 ? 'Export' : 'Import';
        const gridStr = gridWatts === 0 ? '0 W' : `${gridWatts} W ${label}`;
        await this._set('powermeter_state_string', gridStr);
      }
      await this._set('meter_power',                   d.totalSupplyFromGrid  ?? null);
      await this._set('meter_power.exported',          d.totalFeedInToGrid    ?? null);
      await this._set('meter_power.imported_today',    d.supplyFromGridToday  ?? null);
      await this._set('meter_power.exported_today',    d.feedInToGridToday    ?? null);
      await this._set('measure_power.load',            d.loadPower            ?? null);
      await this._set('meter_power.consumption_today', d.consumptionToday     ?? null);

      // Phase data — same sign convention as feedInPower: + = import, − = export
      await this._set('measure_voltage.phase1', d.phaseAVoltage ?? null);
      await this._set('measure_voltage.phase2', d.phaseBVoltage ?? null);
      await this._set('measure_voltage.phase3', d.phaseCVoltage ?? null);
      await this._set('measure_current.phase1', d.phaseACurrent ?? null);
      await this._set('measure_current.phase2', d.phaseBCurrent ?? null);
      await this._set('measure_current.phase3', d.phaseCCurrent ?? null);
      await this._set('measure_power.phase1',   d.phaseAPower ?? null);
      await this._set('measure_power.phase2',   d.phaseBPower ?? null);
      await this._set('measure_power.phase3',   d.phaseCPower ?? null);

      // Fire export/import transition triggers (null = first run, skip)
      if (gridPower !== null && this._prevExporting !== null) {
        const isExporting = gridPower < 0;
        if (isExporting && !this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_export_started')
            .trigger(this, { power: Math.abs(gridPower) }).catch((err) => this.log('Flow trigger dtsu666_grid_export_started failed:', err.message));
        } else if (!isExporting && this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_import_started')
            .trigger(this, { power: gridPower }).catch((err) => this.log('Flow trigger dtsu666_grid_import_started failed:', err.message));
        }
      }
      if (gridPower !== null) this._prevExporting = gridPower < 0;

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: Grid=' + Math.round(gridPower ?? 0) + 'W');

    } catch (err) {
      this._failureCount += 1;
      logPollError(this, `Fetch error (${this._failureCount}): ${err.message}`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          unavailableMessage(this.homey, err, this.getSetting('address')),
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

}

Object.assign(PowerMeterEmmaModbusDevice.prototype, modbusPolling);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(PowerMeterEmmaModbusDevice);

module.exports = PowerMeterEmmaModbusDevice;

'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const {
  POWER_METER_REGISTERS,
  isPowerMeterDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const modbusPolling = require('../../lib/modbus-polling');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

const METER_STATUS_MAP = {
  0: 'Offline',
  1: 'Normal',
};

const REQUIRED_CAPABILITIES = [
  'measure_power',           // grid active power (W): positive = import, negative = export
  'meter_power',             // grid accumulated / imported energy (kWh)
  'meter_power.exported',    // grid exported energy (kWh)
  'measure_voltage.phase1',
  'measure_voltage.phase2',
  'measure_voltage.phase3',
  'measure_current.phase1',
  'measure_current.phase2',
  'measure_current.phase3',
  'measure_power.phase1',
  'measure_power.phase2',
  'measure_power.phase3',
  'dtsu666_meter_status',
  'powermeter_state_string',
];

class DTSU666ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevExporting   = null;
    this._prevMeterStatus = null;
    this._failureCount    = 0;
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

  async onUninit() {
    await this._stopPolling();
  }

  async onDeleted() {
    await this._stopPolling();
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('grid_is_exporting')
      .registerRunListener((args) => args.device._prevExporting === true);

    this.homey.flow
      .getDeviceTriggerCard('dtsu666_meter_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('dtsu666_meter_status_is')
      .registerRunListener((args) => args.device.getCapabilityValue('dtsu666_meter_status') === args.status);
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
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 1);

    try {
      const meter = await readModbusRegisters(address, port, modbusId, POWER_METER_REGISTERS);

      // Always update meter status — even when meter is offline
      if (meter.meterStatus !== null && meter.meterStatus !== undefined) {
        const meterLabel = METER_STATUS_MAP[meter.meterStatus] ?? `Status ${meter.meterStatus}`;
        await this._set('dtsu666_meter_status', meterLabel);
        if (this._prevMeterStatus !== null && meterLabel !== this._prevMeterStatus) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_meter_status_changed')
            .trigger(this, { status: meterLabel }, { status: meterLabel }).catch((err) => this.log('Flow trigger dtsu666_meter_status_changed failed:', err.message));
          if (this.getSetting('enable_timeline_notifications') !== false) {
            this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${meterLabel}` })
              .catch((err) => this.log('Timeline notification failed:', err.message));
          }
        }
        this._prevMeterStatus = meterLabel;
      }

      if (!isPowerMeterDataValid(meter)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.meterNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // PDF sign convention: >0 = feed-in to grid, <0 = supply from grid.
      const negate = (v) => (v !== null && v !== undefined) ? -v : null;

      const gridPower = negate(meter.powerMeterActivePower);
      await this._set('measure_power', gridPower);
      if (gridPower !== null) {
        const gridWatts = Math.round(Math.abs(gridPower));
        const label = gridPower < 0 ? 'Export' : 'Import';
        const gridStr = gridWatts === 0 ? '0 W' : `${gridWatts} W ${label}`;
        await this._set('powermeter_state_string', gridStr);
      }

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

      await this._set('meter_power',            meter.gridAccumulatedEnergy  ?? null);
      await this._set('meter_power.exported',   meter.gridExportedEnergy     ?? null);
      await this._set('measure_voltage.phase1', meter.gridPhaseAVoltage      ?? null);
      await this._set('measure_voltage.phase2', meter.gridPhaseBVoltage      ?? null);
      await this._set('measure_voltage.phase3', meter.gridPhaseCVoltage      ?? null);
      await this._set('measure_current.phase1', meter.gridPhaseACurrent      ?? null);
      await this._set('measure_current.phase2', meter.gridPhaseBCurrent      ?? null);
      await this._set('measure_current.phase3', meter.gridPhaseCCurrent      ?? null);
      await this._set('measure_power.phase1',   negate(meter.gridPhaseAPower));
      await this._set('measure_power.phase2',   negate(meter.gridPhaseBPower));
      await this._set('measure_power.phase3',   negate(meter.gridPhaseCPower));

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: Grid=' + Math.round(gridPower) + 'W');

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

Object.assign(DTSU666ModbusDevice.prototype, modbusPolling);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(DTSU666ModbusDevice);

module.exports = DTSU666ModbusDevice;

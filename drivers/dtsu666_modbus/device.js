'use strict';

const { Device } = require('homey');
const {
  POWER_METER_REGISTERS,
  isPowerMeterDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

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
];

class DTSU666ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevExporting   = null;
    this._failureCount    = 0;
    await this._ensureCapabilities();
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

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let s = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(s) || s < MIN_INTERVAL_S) s = DEFAULT_INTERVAL_S;
    return s * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

    try {
      const meter = await readModbusRegisters(address, port, modbusId, POWER_METER_REGISTERS);

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

      // Fire export/import transition triggers (null = first run, skip)
      if (gridPower !== null && this._prevExporting !== null) {
        const isExporting = gridPower < 0;
        if (isExporting && !this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_export_started')
            .trigger(this, { power: Math.abs(gridPower) }).catch(() => {});
        } else if (!isExporting && this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_import_started')
            .trigger(this, { power: gridPower }).catch(() => {});
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

    } catch (err) {
      this._failureCount += 1;
      this.error(`Fetch error (${this._failureCount}):`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          `${this.homey.__('modbus.errors.fetchFailed')}: ${err.message}`,
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = DTSU666ModbusDevice;

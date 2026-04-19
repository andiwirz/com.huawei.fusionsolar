'use strict';

const { Device } = require('homey');
const {
  SUN2000_EMMA_DATA_REGISTERS,
  isSun2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

// EMMA provides grid data directly — no DTSU666 needed.
// PV string voltages/currents, temperature, device status, and active power
// control mode are not available via EMMA registers.
const REQUIRED_CAPABILITIES = [
  'measure_power',                   // PV Output Power (W)
  'measure_power.active_power',      // Inverter Active Power (W)
  'measure_temperature.invertor',    // Inverter Temperature (°C) — register 30508
  'meter_power',                     // Inverter Total Yield (kWh)
  'meter_power.daily',               // Inverter Yield Today (kWh)
  'measure_power.grid_active_power', // Grid Active Power (W): + = import, − = export
  'meter_power.grid_export',         // Total Feed-in to Grid (kWh)
  'meter_power.grid_import',         // Total Supply from Grid (kWh)
  'meter_power.pv_total',            // Total PV Energy Yield (kWh)
  'meter_power.pv_daily',            // PV Yield Today (kWh)
];

class SUN2000EmmaModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount    = 0;
    this._fetchInProgress = false;
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

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
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
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 0;

    try {
      const d = await readModbusRegisters(address, port, modbusId, SUN2000_EMMA_DATA_REGISTERS);

      if (!isSun2000EmmaDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.fetchFailed'));
        }
        this._fetchInProgress = false;
        return;
      }

      const prevPower = this.getCapabilityValue('measure_power');
      const newPower  = d.pvOutputPower ?? 0;

      await this._set('measure_power',                   newPower);
      await this._set('measure_power.active_power',      d.inverterActivePower  ?? null);
      await this._set('meter_power',                     d.inverterTotalYield   ?? null);
      await this._set('meter_power.daily',               d.inverterYieldToday   ?? null);

      // feedInPower (register 30358): + = import from grid, − = export to grid
      // Matches Homey convention directly — no negation needed.
      await this._set('measure_power.grid_active_power', d.feedInPower ?? null);
      await this._set('meter_power.grid_export',         d.totalFeedInToGrid    ?? null);
      await this._set('meter_power.grid_import',         d.totalSupplyFromGrid  ?? null);
      await this._set('meter_power.pv_total',            d.totalPvEnergyYield   ?? null);
      await this._set('meter_power.pv_daily',            d.pvYieldToday         ?? null);
      await this._set('measure_temperature.invertor',    d.inverterTemperature  ?? null);

      if (prevPower !== newPower) {
        await this.homey.flow
          .getDeviceTriggerCard('modbus_power_changed')
          .trigger(this, { power: newPower })
          .catch((err) => this.log('Flow trigger modbus_power_changed failed:', err.message));
      }

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

module.exports = SUN2000EmmaModbusDevice;

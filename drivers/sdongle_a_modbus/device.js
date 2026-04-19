'use strict';

const { Device } = require('homey');
const {
  SDONGLE_A_REGISTERS,
  isSdonglaADataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

const CONNECTION_TYPE_MAP = {
  0: 'N/A',
  2: 'WLAN',
  3: '4G',
  4: 'WLAN-FE',
};

const REQUIRED_CAPABILITIES = [
  'measure_power',                   // house consumption / load power (W)
  'measure_power.solar',             // total PV input power (W)
  'measure_power.grid_active_power', // grid power (W): positive = import, negative = export
  'measure_power.battery',           // battery power (W): positive = charging, negative = discharging
  'measure_power.active_power',      // total system active power (W)
  'sdongle_type',                    // connection type: N/A, WLAN, 4G, WLAN-FE
];

class SdonglaAModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount = 0;
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
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 100;

    try {
      const data = await readModbusRegisters(address, port, modbusId, SDONGLE_A_REGISTERS);

      if (!isSdonglaADataValid(data)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.sdonglaNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // gridPower: spec sign convention already matches Homey (+import, -export)
      await this._set('measure_power',                   data.loadPower        ?? null);
      await this._set('measure_power.solar',             data.totalInputPower  ?? null);
      await this._set('measure_power.grid_active_power', data.gridPower        ?? null);
      await this._set('measure_power.battery',           data.batteryPower     ?? null);
      await this._set('measure_power.active_power',      data.totalActivePower ?? null);

      if (data.connectionType !== null && data.connectionType !== undefined) {
        const typeLabel = CONNECTION_TYPE_MAP[data.connectionType] ?? `Type ${data.connectionType}`;
        await this._set('sdongle_type', typeLabel);
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

module.exports = SdonglaAModbusDevice;

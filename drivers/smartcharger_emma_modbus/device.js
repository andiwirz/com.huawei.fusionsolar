'use strict';

const { Device } = require('homey');
const {
  SMARTCHARGER_REGISTERS,
  isSmartChargerDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S     = 10;

const REQUIRED_CAPABILITIES = [
  'measure_power',              // real-time charging power (W) — required by Homey evCharger
  'evcharger_charging_state',   // current charging state      — required by Homey evCharger
  'meter_power',                // total energy charged (kWh)
  'measure_voltage.phase1',     // Phase A voltage (V)
  'measure_voltage.phase2',     // Phase B voltage (V)
  'measure_voltage.phase3',     // Phase C voltage (V)
  'measure_temperature',        // charger temperature (°C)
  'smartcharger_rated_power',   // rated power (kW) — static spec value
  'smartcharger_offering_name', // product name — read from register 30000
];

class SmartChargerModbusDevice extends Device {

  async onInit() {
    this.log(`[SmartCharger] Device initialised: ${this.getName()}`);
    this._failureCount      = 0;
    this._prevChargingState = null;
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
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

    try {
      const d = await readModbusRegisters(address, port, modbusId, SMARTCHARGER_REGISTERS);

      if (!isSmartChargerDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.chargerNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // Offering name — only update if it changed and is non-empty
      if (d.offeringName) {
        await this._set('smartcharger_offering_name', d.offeringName);
      }

      // Rated power (kW) — static spec value
      if (d.ratedPower !== null && d.ratedPower !== undefined) {
        await this._set('smartcharger_rated_power', d.ratedPower);
      }

      // Phase voltages (V)
      await this._set('measure_voltage.phase1', d.phaseAVoltage ?? null);
      await this._set('measure_voltage.phase2', d.phaseBVoltage ?? null);
      await this._set('measure_voltage.phase3', d.phaseCVoltage ?? null);

      // Total energy charged (kWh)
      await this._set('meter_power', d.totalEnergyCharged ?? null);

      // Charger temperature (°C)
      await this._set('measure_temperature', d.chargerTemperature ?? null);

      // Derive charging state from voltage presence:
      // If any phase voltage > 10 V, a car session is likely active
      const hasVoltage = (d.phaseAVoltage ?? 0) > 10
        || (d.phaseBVoltage ?? 0) > 10
        || (d.phaseCVoltage ?? 0) > 10;
      const chargingState = hasVoltage ? 'charging' : 'idle';
      await this._set('evcharger_charging_state', chargingState);

      if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
        if (chargingState === 'charging') {
          this.homey.flow.getDeviceTriggerCard('smartcharger_charging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger smartcharger_charging_started failed:', err.message));
        } else {
          this.homey.flow.getDeviceTriggerCard('smartcharger_charging_stopped')
            .trigger(this, {}).catch((err) => this.log('Flow trigger smartcharger_charging_stopped failed:', err.message));
        }
      }
      this._prevChargingState = chargingState;

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

module.exports = SmartChargerModbusDevice;

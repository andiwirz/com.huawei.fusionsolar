'use strict';

const { Device } = require('homey');
const {
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  isLuna2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32 } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

const REQUIRED_CAPABILITIES = [
  'measure_power',              // Battery Power (W): + = charging, − = discharging
  'measure_battery',            // State of Charge (%)
  'meter_power.charged',        // Total Energy Charged (kWh) – Homey energy dashboard
  'meter_power.discharged',     // Total Energy Discharged (kWh) – Homey energy dashboard
  'measure_power.batt_charge',  // Charge power (derived: max(0, power))
  'measure_power.batt_discharge', // Discharge power (derived: max(0, −power))
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
  // EMMA reg 40000: valid values 2=Max Self-Consumption, 4=Fully Fed to Grid,
  // 5=TOU, 6=Third-party — identical semantics to SUN2000 reg 47086.
  // Values 0 (Adaptive), 1 (Fixed), 3 (TOU LG) are reserved on EMMA and should not be used.
  'storage_working_mode_settings',
  'storage_excess_pv_energy_use_in_tou', // reg 40001: 0=Feed to Grid, 1=Charge Battery ✓
  'measure_battery.backup',              // Backup power SOC (%)
  'meter_power.chargeable_capacity',     // ESS chargeable capacity (kWh)
  'meter_power.dischargeable_capacity',  // ESS dischargeable capacity (kWh)
];

// Maps writable enum capability → EMMA Modbus register address (40xxx)
const CONTROL_WRITE_MAP = {
  storage_working_mode_settings:       40000, // valid EMMA values: 2, 4, 5, 6 (1/3 reserved)
  storage_excess_pv_energy_use_in_tou: 40001,
};

class LUNA2000EmmaModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevChargingState          = null;
    this._failureCount               = 0;
    this._updatingFromModbus         = false;
    this._updatingSettingFromModbus  = false;
    this._writeInProgress            = false;
    this._controlPollCounter         = 0;
    await this._ensureCapabilities();
    this._registerControlListeners();
    this._registerFlowActions();
    this._registerConditions();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }

    if (changedKeys.includes('max_grid_charge_power') && !this._updatingSettingFromModbus) {
      const address  = this.getSetting('address');
      const port     = parseInt(this.getSetting('port'), 10) || 502;
      const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 0;
      const kw       = parseFloat(newSettings.max_grid_charge_power) || 0;
      const raw      = Math.round(kw * 1000);
      this.log(`Write max grid charge power: ${kw} kW → reg 40002 raw=${raw}`);
      writeModbusU32(address, port, modbusId, 40002, raw)
        .catch((err) => this.error('Max grid charge power write failed:', err.message));
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

  _registerControlListeners() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseInt(this.getSetting('modbus_id'), 10) || 0;

    for (const [cap, regAddress] of Object.entries(CONTROL_WRITE_MAP)) {
      this.registerCapabilityListener(cap, (value) => {
        if (this._updatingFromModbus) return;

        const previousValue = this.getCapabilityValue(cap);
        this.log(`Write start  [${cap} → reg ${regAddress}] value=${value}`);
        this._writeInProgress = true;

        writeModbusRegister(host(), port(), unitId(), regAddress, parseInt(value, 10))
          .then(() => {
            this.log(`Write OK     [${cap} → reg ${regAddress}]`);
          })
          .catch(async (err) => {
            this.error(`Write failed [${cap} → reg ${regAddress}]:`, err.message);
            this._updatingFromModbus = true;
            await this._set(cap, previousValue).catch(() => {});
            this._updatingFromModbus = false;
          })
          .finally(() => {
            this._writeInProgress = false;
          });
      });
    }
  }

  // ─── Flow actions ──────────────────────────────────────────────────────────

  _registerFlowActions() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseInt(this.getSetting('modbus_id'), 10) || 0;

    const writeEnum = async (cardId, regAddress, capabilityId, mode) => {
      const value = parseInt(mode, 10);
      this.log(`Write start  [${cardId} → reg ${regAddress}] value=${value}`);
      this._writeInProgress = true;
      try {
        await writeModbusRegister(host(), port(), unitId(), regAddress, value);
        this.log(`Write OK     [${cardId} → reg ${regAddress}]`);
        this._updatingFromModbus = true;
        await this._set(capabilityId, mode).catch(() => {});
      } catch (err) {
        this.error(`Write failed [${cardId} → reg ${regAddress}]:`, err.message);
        throw err;
      } finally {
        this._updatingFromModbus = false;
        this._writeInProgress   = false;
      }
    };

    this.homey.flow
      .getActionCard('luna2000_emma_set_working_mode')
      .registerRunListener(async ({ mode }) => {
        await writeEnum('luna2000_emma_set_working_mode', CONTROL_WRITE_MAP.storage_working_mode_settings, 'storage_working_mode_settings', mode);
      });

    this.homey.flow
      .getActionCard('luna2000_emma_set_excess_pv')
      .registerRunListener(async ({ mode }) => {
        await writeEnum('luna2000_emma_set_excess_pv', CONTROL_WRITE_MAP.storage_excess_pv_energy_use_in_tou, 'storage_excess_pv_energy_use_in_tou', mode);
      });

    this.homey.flow
      .getActionCard('luna2000_emma_set_max_grid_charge_power')
      .registerRunListener(async ({ device, power }) => {
        const kw  = Math.max(0, parseFloat(power) || 0);
        const raw = Math.round(kw * 1000);
        this.log(`Set max grid charge power: ${kw} kW → reg 40002 raw=${raw}`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(host(), port(), unitId(), 40002, raw);
          this.log('Max grid charge power written');
          // Keep device setting in sync
          this._updatingSettingFromModbus = true;
          await this.setSettings({ max_grid_charge_power: kw })
            .catch((err) => this.log('setSettings sync failed:', err.message));
        } catch (err) {
          this.error('Set max grid charge power failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress           = false;
          this._updatingSettingFromModbus = false;
        }
      });
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => args.device._prevChargingState === 'charging');

    this.homey.flow
      .getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => args.device._prevChargingState === 'discharging');
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
    if (this._writeInProgress) return;
    this._fetchInProgress = true;

    const address = this.getSetting('address');
    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 0;
    const abort    = () => this._writeInProgress;

    try {
      const d = await readModbusRegisters(address, port, modbusId, LUNA2000_EMMA_DATA_REGISTERS, abort);

      if (!isLuna2000EmmaDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.batteryNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      const power = d.batteryPower ?? 0;
      const soc   = d.soc ?? 0;

      const IDLE_THRESHOLD_W = 50;
      const chargingState = power > IDLE_THRESHOLD_W ? 'charging'
        : power < -IDLE_THRESHOLD_W ? 'discharging'
        : 'idle';

      const prevSoc = this.getCapabilityValue('measure_battery');

      await this._set('measure_power',                    power);
      await this._set('measure_battery',                  soc);
      await this._set('meter_power.charged',              d.totalChargedEnergy      ?? null);
      await this._set('meter_power.discharged',           d.totalDischargedEnergy   ?? null);
      await this._set('measure_power.batt_charge',        Math.max(0,  power));
      await this._set('measure_power.batt_discharge',     Math.max(0, -power));
      await this._set('meter_power.today_batt_input',     d.chargedToday            ?? null);
      await this._set('meter_power.today_batt_output',    d.dischargedToday         ?? null);
      await this._set('measure_battery.backup',           d.backupSoc               ?? null);
      await this._set('meter_power.chargeable_capacity',  d.essChargeableCapacity   ?? null);
      await this._set('meter_power.dischargeable_capacity', d.essDischargableCapacity ?? null);

      // Read control registers every 5th poll — they change rarely
      this._controlPollCounter = (this._controlPollCounter + 1) % 5;
      if (this._controlPollCounter === 0) {
        await this._fetchControl(address, port, modbusId);
      }

      if (prevSoc !== soc) {
        await this.homey.flow
          .getDeviceTriggerCard('luna2000_soc_changed')
          .trigger(this, { soc })
          .catch((err) => this.log('Flow trigger luna2000_soc_changed failed:', err.message));
      }

      if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
        this.homey.flow
          .getDeviceTriggerCard('luna2000_charging_state_changed')
          .trigger(this, { state: chargingState })
          .catch((err) => this.log('Flow trigger luna2000_charging_state_changed failed:', err.message));
        if (chargingState === 'charging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_charging_started failed:', err.message));
        } else if (chargingState === 'discharging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_discharging_started failed:', err.message));
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

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(
        address, port, modbusId,
        LUNA2000_EMMA_CONTROL_REGISTERS,
        () => this._writeInProgress,
      );

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      await this._set('storage_working_mode_settings',       toEnum(ctrl.essControlMode));
      await this._set('storage_excess_pv_energy_use_in_tou', toEnum(ctrl.preferredUseSurplusPv));
      this._updatingFromModbus = false;

      // Sync max grid charging power setting if it differs from what the EMMA reports
      if (ctrl.maxGridChargingPower !== null && ctrl.maxGridChargingPower !== undefined) {
        const currentKw = parseFloat(this.getSetting('max_grid_charge_power')) || 0;
        if (Math.abs(ctrl.maxGridChargingPower - currentKw) > 0.05) {
          this._updatingSettingFromModbus = true;
          await this.setSettings({ max_grid_charge_power: ctrl.maxGridChargingPower })
            .catch((err) => this.log('setSettings max_grid_charge_power failed:', err.message));
          this._updatingSettingFromModbus = false;
        }
      }

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus         = false;
      this._updatingSettingFromModbus  = false;
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

module.exports = LUNA2000EmmaModbusDevice;

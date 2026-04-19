'use strict';

const { Device } = require('homey');
const {
  REGISTERS,
  POWER_METER_REGISTERS,
  CONTROL_REGISTERS,
  isPowerMeterDataValid,
  statusLabel,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32 } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

// Always-present capabilities (core inverter + inverter control register)
const REQUIRED_CAPABILITIES = [
  'measure_power',
  'measure_power.active_power',
  'measure_temperature.invertor',
  'meter_power',
  'meter_power.daily',
  'measure_voltage.pv1',
  'measure_voltage.pv2',
  'measure_current.pv1',
  'measure_current.pv2',
  'huawei_status',
  'activepower_controlmode',
];

// Dynamic capabilities – added when optimizers are registered (register 37200 > 0)
const OPTIMIZER_CAPABILITIES = [
  'optimizer_total_count',
  'optimizer_online_count',
];

// Dynamic capabilities – added when external power meter (DTSU666) is detected
const POWER_METER_CAPABILITIES = [
  'measure_power.grid_active_power',
  'meter_power.grid_export',
  'meter_power.grid_import',
];

// Old capability names from previous app versions – removed during migration
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.grid_phase1',
  'measure_voltage.grid_phase2',
  'measure_voltage.grid_phase3',
  'measure_current.grid_phase1',
  'measure_current.grid_phase2',
  'measure_current.grid_phase3',
  'measure_power.grid_phase1',
  'measure_power.grid_phase2',
  'measure_power.grid_phase3',
  'meter_power_daily',
  'meter_power_cumulative',
  'meter_power_monthly',
  'meter_power_yearly',
  'huawei_device_status',
  'measure_battery_power',
  'meter_battery_charge_today',
  'meter_battery_discharge_today',
  'measure_power_meter',
  'meter_power_exported',
  'meter_power_grid_accumulated',
  // Battery capabilities moved to luna2000_modbus driver
  'storage_working_mode_settings',
  'storage_force_charge_discharge',
  'storage_excess_pv_energy_use_in_tou',
  'remote_charge_discharge_control_mode',
  'measure_battery',
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'measure_power.chargesetting',
  'measure_power.dischargesetting',
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
];

// Only the inverter control register addresses (47xxx)
const INVERTER_CONTROL_REGISTERS = {
  activePowerControlMode:  CONTROL_REGISTERS.activePowerControlMode,
  activePowerMaxFeedIn:    CONTROL_REGISTERS.activePowerMaxFeedIn,
  activePowerMaxFeedInPct: CONTROL_REGISTERS.activePowerMaxFeedInPct,
};

// Maps writable enum capability → Modbus register address (47xxx)
const CONTROL_WRITE_MAP = {
  activepower_controlmode: 47415,
};

class SUN2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount              = 0;
    this._prevDeviceStatus          = null;
    this._updatingFromModbus        = false;
    this._updatingSettingFromModbus = false;
    this._writeInProgress           = false;
    this._settingsInitialized       = false; // true after first successful _fetchControl
    this._controlPollCounter        = 4; // start at 4 so first poll immediately reads control registers
    await this._ensureCapabilities();
    this._registerControlListeners();
    this._registerFlowActions();
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

    if (!this._updatingSettingFromModbus && this._settingsInitialized) {
      const address  = this.getSetting('address');
      const port     = parseInt(this.getSetting('port'), 10) || 502;
      const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

      if (changedKeys.includes('max_feed_in_power')) {
        const raw = Math.round(parseFloat(newSettings.max_feed_in_power) || 0);
        this.log(`Write max_feed_in_power: ${raw} W → reg 47416`);
        writeModbusU32(address, port, modbusId, 47416, raw)
          .catch((err) => this.error('max_feed_in_power write failed:', err.message));
      }

      if (changedKeys.includes('max_feed_in_power_pct')) {
        const raw = Math.round((parseFloat(newSettings.max_feed_in_power_pct) || 0) * 10);
        this.log(`Write max_feed_in_power_pct: ${newSettings.max_feed_in_power_pct} % → reg 47418 raw=${raw}`);
        writeModbusRegister(address, port, modbusId, 47418, raw)
          .catch((err) => this.error('max_feed_in_power_pct write failed:', err.message));
      }
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
    // Remove stale capabilities from previous app versions.
    // Wrapped in try-catch: removeCapability also validates against app.json,
    // so deprecated names that are no longer defined would otherwise throw.
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }
  }

  _registerControlListeners() {
    const host    = () => this.getSetting('address');
    const port    = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId  = () => parseInt(this.getSetting('modbus_id'), 10) || 1;

    for (const [cap, regAddress] of Object.entries(CONTROL_WRITE_MAP)) {
      this.registerCapabilityListener(cap, (value) => {
        if (this._updatingFromModbus) return; // ignore updates triggered by poll reads

        const previousValue = this.getCapabilityValue(cap);
        this.log(`Write start  [${cap} → reg ${regAddress}] value=${value}`);
        this._writeInProgress = true;

        // Fire-and-forget: return immediately so Homey never shows a UI timeout.
        // On failure the capability is reverted to its previous value.
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
    this.homey.flow
      .getDeviceTriggerCard('sun2000_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('sun2000_status_is')
      .registerRunListener((args) => this.getCapabilityValue('huawei_status') === args.status);

    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseInt(this.getSetting('modbus_id'), 10) || 1;

    this.homey.flow
      .getActionCard('sun2000_set_active_power_mode')
      .registerRunListener(async ({ mode }) => {
        const reg   = CONTROL_WRITE_MAP.activepower_controlmode;
        const value = parseInt(mode, 10);
        this.log(`Write start  [sun2000_set_active_power_mode → reg ${reg}] value=${value}`);
        this._writeInProgress = true;
        try {
          await writeModbusRegister(host(), port(), unitId(), reg, value);
          this.log(`Write OK     [sun2000_set_active_power_mode → reg ${reg}]`);
          this._updatingFromModbus = true;
          await this._set('activepower_controlmode', mode).catch(() => {});
        } catch (err) {
          this.error(`Write failed [sun2000_set_active_power_mode → reg ${reg}]:`, err.message);
          throw err;
        } finally {
          this._updatingFromModbus = false;
          this._writeInProgress   = false;
        }
      });
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
    if (this._writeInProgress) return; // pause poll while a write is queued/running
    this._fetchInProgress = true;

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

    const abort = () => this._writeInProgress;

    try {
      const data = await readModbusRegisters(address, port, modbusId, REGISTERS, abort);

      const prevPower = this.getCapabilityValue('measure_power');
      const newPower  = data.inputPower ?? 0;

      await this._set('measure_power',              newPower);
      await this._set('measure_power.active_power', data.activePower ?? null);
      await this._set('measure_temperature.invertor', data.internalTemperature ?? null);
      await this._set('meter_power',                data.accumulatedYieldEnergy ?? null);
      await this._set('meter_power.daily',          data.dailyYieldEnergy ?? null);
      await this._set('measure_voltage.pv1',        data.pv1Voltage ?? null);
      await this._set('measure_voltage.pv2',        data.pv2Voltage ?? null);
      await this._set('measure_current.pv1',        data.pv1Current ?? null);
      await this._set('measure_current.pv2',        data.pv2Current ?? null);
      await this._updateOptimizerCapabilities(data.totalOptimizers, data.onlineOptimizers);

      if (data.deviceStatus !== null && data.deviceStatus !== undefined) {
        const label = statusLabel(data.deviceStatus);
        await this._set('huawei_status', label);
        if (this._prevDeviceStatus !== null && label !== this._prevDeviceStatus) {
          this.homey.flow.getDeviceTriggerCard('sun2000_status_changed')
            .trigger(this, { status: label }, { status: label }).catch((err) => this.log('Flow trigger sun2000_status_changed failed:', err.message));
        }
        this._prevDeviceStatus = label;
      }

      await this._fetchPowerMeter(address, port, modbusId, abort);

      // Read control registers every 5th poll — they change rarely and the read
      // adds ~1 s of connection time that delays pending writes.
      this._controlPollCounter = (this._controlPollCounter + 1) % 5;
      if (this._controlPollCounter === 0) {
        await this._fetchControl(address, port, modbusId);
      }

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

  async _updateOptimizerCapabilities(total, online) {
    const hasOptimizers = typeof total === 'number' && Number.isFinite(total) && total > 0;

    if (hasOptimizers) {
      for (const cap of OPTIMIZER_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap);
      }
      await this._set('optimizer_total_count',  total);
      await this._set('optimizer_online_count', online ?? null);
    } else {
      for (const cap of OPTIMIZER_CAPABILITIES) {
        if (this.hasCapability(cap)) await this.removeCapability(cap);
      }
    }
  }

  async _fetchPowerMeter(address, port, modbusId, shouldAbort) {
    try {
      const meter = await readModbusRegisters(address, port, modbusId, POWER_METER_REGISTERS, shouldAbort);

      if (!isPowerMeterDataValid(meter)) {
        for (const cap of POWER_METER_CAPABILITIES) {
          if (this.hasCapability(cap)) await this.removeCapability(cap);
        }
        return;
      }

      for (const cap of POWER_METER_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap);
      }

      const negate = (v) => (v !== null && v !== undefined) ? -v : null;
      await this._set('measure_power.grid_active_power', negate(meter.powerMeterActivePower));
      await this._set('meter_power.grid_export',      meter.gridExportedEnergy ?? null);
      await this._set('meter_power.grid_import',      meter.gridAccumulatedEnergy ?? null);

    } catch (err) {
      this.log('Power meter read skipped:', err.message);
    }
  }

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, INVERTER_CONTROL_REGISTERS, () => this._writeInProgress);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      await this._set('activepower_controlmode', toEnum(ctrl.activePowerControlMode));
      this._updatingFromModbus = false;

      // Sync feed-in power settings if they differ
      const settingUpdates = {};
      const numericSync = [
        ['activePowerMaxFeedIn',    'max_feed_in_power',     1  ],
        ['activePowerMaxFeedInPct', 'max_feed_in_power_pct', 0.5],
      ];
      for (const [key, settingId, tolerance] of numericSync) {
        const v = ctrl[key];
        if (v !== null && v !== undefined) {
          const current = parseFloat(this.getSetting(settingId));
          if (!Number.isFinite(current) || Math.abs(v - current) > tolerance) settingUpdates[settingId] = v;
        }
      }
      if (Object.keys(settingUpdates).length > 0) {
        this._updatingSettingFromModbus = true;
        await this.setSettings(settingUpdates)
          .catch((err) => this.log('setSettings sync failed:', err.message));
        this._updatingSettingFromModbus = false;
      }

      // Mark settings as initialised — onSettings writes are now safe
      this._settingsInitialized = true;

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus        = false;
      this._updatingSettingFromModbus = false;
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

module.exports = SUN2000ModbusDevice;

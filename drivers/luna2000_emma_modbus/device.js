'use strict';

const { Device } = require('homey');
const { withSettingsLog, applySettingSync, record } = require('../../lib/change-log');
const {
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  isLuna2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { pendingModeWrites, syncModeSettings, applyModeWrites, revertModeSetting } = require('../../lib/mode-settings');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const modbusPolling = require('../../lib/modbus-polling');

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
  'battery_state_string',                // human-readable state: "1234 W Laden (73%)" — hidden in UI
];

// Maps storage working mode register value → human-readable label (used as flow trigger token)
const STORAGE_WORKING_MODE_LABELS = {
  '0': 'Adaptive',
  '1': 'Fixed Charge/Discharge',
  '2': 'Maximise Self-Consumption',
  '3': 'Time of Use (LG)',
  '4': 'Fully Fed to Grid',
  '5': 'Time of Use (LUNA2000)',
  '6': 'Third-party Scheduling',
};

const EXCESS_PV_LABELS = {
  '0': 'Feed to Grid',
  '1': 'Charge Battery',
};

// Maps writable enum capability → EMMA Modbus register address (40xxx)
const CONTROL_WRITE_MAP = {
  storage_working_mode_settings:       40000, // valid EMMA values: 2, 4, 5, 6 (1/3 reserved)
  storage_excess_pv_energy_use_in_tou: 40001,
};

// If the same control register gets written two *different* values within this
// window, a second source (a Homey flow, a Huawei TOU schedule, or another app)
// is fighting this app for control. We only log it — behaviour is unchanged.
const WRITE_CONFLICT_WINDOW_MS = 45000;

// Changed from the "Change battery mode" dropdowns in the device settings, not from the tile —
// see lib/mode-settings.js and issue #35. ids are the values each register takes, as strings.
// The EMMA takes only 2, 4, 5 and 6 as working modes; 1 and 3 are reserved.
const MODE_SETTINGS = {
  mode_storage_working: { cap: 'storage_working_mode_settings',       reg: 40000, ids: ['2', '4', '5', '6'] },
  mode_excess_pv_tou:   { cap: 'storage_excess_pv_energy_use_in_tou', reg: 40001, ids: ['0', '1'] },
};

class LUNA2000EmmaModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevChargingState          = null;
    this._prevWorkingMode            = null;
    this._prevExcessPv               = null;
    this._prevBackupSoc              = null;
    this._failureCount               = 0;
    this._updatingFromModbus         = false;
    this._updatingSettingFromModbus  = false;
    this._writeInProgress            = false;
    this._controlPollCounter         = 4;    // start at 4 so the first poll reads control registers
    this._lastPollStart              = 0;
    await this._ensureCapabilities();
    // No capability listeners for the battery modes — see "Why the battery modes cannot be
    // changed from the device tile" further down.
    this._registerFlowActions();
    this._registerConditions();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ oldSettings = {}, newSettings, changedKeys }) {
    // Before anything else is written — see lib/mode-settings.js.
    const modeWrites = pendingModeWrites(this, MODE_SETTINGS, newSettings, changedKeys);

    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._restartPolling(newSettings);
    }

    if (changedKeys.includes('max_grid_charge_power') && !this._updatingSettingFromModbus) {
      // From the page being saved — see the luna2000_modbus driver.
      const address  = newSettings.address ?? this.getSetting('address');
      const port     = parseInt(newSettings.port ?? this.getSetting('port'), 10) || 502;
      const modbusId = parseIntSafe(newSettings.modbus_id ?? this.getSetting('modbus_id'), 0);
      const kw       = parseFloat(newSettings.max_grid_charge_power) || 0;
      const raw      = Math.round(kw * 1000);
      this.log(`Write max grid charge power: ${kw} kW → reg 40002 raw=${raw}`);
      writeModbusU32(address, port, modbusId, 40002, raw)
        .then(() => this.log('Write OK     [max_grid_charge_power → reg 40002]'))
        .catch((err) => {
          this.error('Max grid charge power write failed:', err.message);
          record(this, 'failed', 'max_grid_charge_power', `Write failed [max_grid_charge_power → reg 40002]: ${err.message}`);
        });
    }

    // Not awaited, like every other write here: Homey stores the settings when this returns.
    applyModeWrites(this, modeWrites, (w) => {
      this._noteWrite(w.cap, w.reg, parseInt(w.value, 10), 'settings'); // a number, as from the flow cards
      return writeModbusRegister(newSettings.address, parseInt(newSettings.port, 10) || 502,
        parseIntSafe(newSettings.modbus_id, 0), w.reg, parseInt(w.value, 10));
    }, (w, err) => revertModeSetting(this, w.key, oldSettings[w.key], err))
      .catch((err) => this.error('Mode write failed:', err.message));
  }

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

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

  // ─── Why the battery modes cannot be changed from the device tile ────────────
  //
  // Same reason and same change as in the luna2000_modbus driver (issue #35): the scroll
  // wheels wrote whatever they landed on, with Fixed Charge/Discharge or Feed to Grid near
  // the top. The tile shows both modes as text; they are changed from dropdowns in the
  // device settings, written only on Save — see onSettings and lib/mode-settings.js.
  // CONTROL_WRITE_MAP stays for the flow cards.

  // ─── Flow actions ──────────────────────────────────────────────────────────

  _registerFlowActions() {
    // Homey keeps one run listener per action card for the whole app, and the last device to
    // register it wins. Until 1.2.291 these listeners closed over `this` — that device — for
    // the address they wrote to, the limits they checked and the state they updated, so with
    // two devices of this driver a card set for the second acted on the first. They are now
    // built for the device each run names: `self` is args.device. With one device per driver
    // self and this are the same device, and test/flow-action-routing.test.js holds every card
    // to what it did before. A run that names no device — none of these cards can, each has a
    // device argument — falls back to the registering device, which is what it always did.
    const build = (self) => {
      const cards = {};
      const host   = () => self.getSetting('address');
      const port   = () => parseInt(self.getSetting('port'), 10) || 502;
      const unitId = () => parseIntSafe(self.getSetting('modbus_id'), 0);

      const writeEnum = async (cardId, regAddress, capabilityId, mode) => {
        const value = parseInt(mode, 10);
        self._noteWrite(capabilityId, regAddress, value, `flow:${cardId}`);
        self.log(`Write start  [${cardId} → reg ${regAddress}] value=${value}`);
        self._writeInProgress = true;
        try {
          await writeModbusRegister(host(), port(), unitId(), regAddress, value);
          self.log(`Write OK     [${cardId} → reg ${regAddress}]`);
          self._updatingFromModbus = true;
          await self._set(capabilityId, mode).catch(() => {});
        } catch (err) {
          self.error(`Write failed [${cardId} → reg ${regAddress}]:`, err.message);
          throw err;
        } finally {
          self._updatingFromModbus = false;
          self._writeInProgress   = false;
        }
      };

      cards['luna2000_emma_set_working_mode'] = ({ mode }) => {
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        writeEnum('luna2000_emma_set_working_mode', CONTROL_WRITE_MAP.storage_working_mode_settings, 'storage_working_mode_settings', mode)
          .catch((err) => self.error('Set working mode failed:', err.message));
      };

      cards['luna2000_emma_set_excess_pv'] = ({ mode }) => {
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        writeEnum('luna2000_emma_set_excess_pv', CONTROL_WRITE_MAP.storage_excess_pv_energy_use_in_tou, 'storage_excess_pv_energy_use_in_tou', mode)
          .catch((err) => self.error('Set excess PV mode failed:', err.message));
      };

      cards['luna2000_emma_set_max_grid_charge_power'] = ({ device, power }) => {
        // Register 40002 takes 0–50 kW (Huawei's EMMA table) — the card allowed 100 until 1.2.287.
        const kw  = Math.min(50, Math.max(0, parseFloat(power) || 0));
        const raw = Math.round(kw * 1000);
        self.log(`Set max grid charge power: ${kw} kW → reg 40002 raw=${raw}`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 40002, raw);
            self.log('Max grid charge power written');
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_grid_charge_power: kw })
              .catch((err) => self.log('setSettings sync failed:', err.message));
          } catch (err) {
            self.error('Set max grid charge power failed:', err.message);
          } finally {
            self._writeInProgress           = false;
            self._updatingSettingFromModbus = false;
          }
        })();
      };
      return cards;
    };
    for (const id of Object.keys(build(this))) {
      this.homey.flow.getActionCard(id).registerRunListener((args, state) => build((args && args.device) || this)[id](args, state));
    }
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => args.device._prevChargingState === 'charging');

    this.homey.flow
      .getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => args.device._prevChargingState === 'discharging');

    this.homey.flow
      .getConditionCard('luna2000_soc_above')
      .registerRunListener((args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc !== undefined && soc > args.soc;
      });

    // Registered here as well as on the other battery driver, the way luna2000_soc_above is:
    // Homey keeps one listener per card, and these read everything off args.device, so
    // whichever driver initialises last answers correctly for either device.
    this.homey.flow
      .getConditionCard('luna2000_backup_soc_above')
      .registerRunListener((args) => {
        const value = args.device.getCapabilityValue('measure_battery.backup');
        return typeof value === 'number' && Number.isFinite(value) && value > args.soc;
      });

    this.homey.flow
      .getConditionCard('luna2000_backup_soc_below')
      .registerRunListener((args) => {
        const value = args.device.getCapabilityValue('measure_battery.backup');
        return typeof value === 'number' && Number.isFinite(value) && value < args.soc;
      });

    this.homey.flow
      .getConditionCard('luna2000_soc_below')
      .registerRunListener((args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc !== undefined && soc < args.soc;
      });

    this.homey.flow
      .getConditionCard('luna2000_working_mode_is')
      .registerRunListener((args) => args.device.getCapabilityValue('storage_working_mode_settings') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_excess_pv_is')
      .registerRunListener((args) => args.device.getCapabilityValue('storage_excess_pv_energy_use_in_tou') === args.mode);
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    if (this._writeInProgress) return;
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
      let battLabel;
      let battLabelAlways = false; // show label even at 0 W
      if (soc >= 100) {
        battLabel = this.homey.__('modbus.battery.state.full');
        battLabelAlways = true;
      } else if (soc < 5 && Math.abs(power) <= IDLE_THRESHOLD_W) {
        battLabel = this.homey.__('modbus.battery.state.empty');
        battLabelAlways = true;
      } else {
        battLabel = power < 0 ? '🔻' : '🔺';
      }
      const battWatts = Math.round(Math.abs(power));
      const battStr = battWatts === 0
        ? battLabelAlways ? `${battLabel} (${Math.round(soc)}%)` : `(${Math.round(soc)}%)`
        : `${battWatts} W ${battLabel} ${Math.round(soc)}%`;
      await this._set('battery_state_string', battStr);
      await this._set('meter_power.charged',              d.totalChargedEnergy      ?? null);
      await this._set('meter_power.discharged',           d.totalDischargedEnergy   ?? null);
      await this._set('measure_power.batt_charge',        Math.max(0,  power));
      await this._set('measure_power.batt_discharge',     Math.max(0, -power));
      await this._set('meter_power.today_batt_input',     d.chargedToday            ?? null);
      await this._set('meter_power.today_batt_output',    d.dischargedToday         ?? null);
      await this._set('measure_battery.backup',           d.backupSoc               ?? null);
      await this._set('meter_power.chargeable_capacity',  d.essChargeableCapacity   ?? null);
      await this._set('meter_power.dischargeable_capacity', d.essDischargableCapacity ?? null);

      // Issue #32: this device has shown the reserve on its tile all along, but nothing
      // could act on a change to it. Same guard as the SoC trigger below — only a real
      // change, and never the first poll after a restart.
      if (d.backupSoc !== null && d.backupSoc !== undefined) {
        if (this._prevBackupSoc !== null && d.backupSoc !== this._prevBackupSoc) {
          await this.homey.flow
            .getDeviceTriggerCard('luna2000_backup_soc_changed')
            .trigger(this, { soc: d.backupSoc })
            .catch((err) => this.log('Flow trigger luna2000_backup_soc_changed failed:', err.message));
        }
        this._prevBackupSoc = d.backupSoc;
      }

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
        if (this.getSetting('enable_timeline_notifications') !== false) {
          this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${this.homey.__(`modbus.battery.state.${chargingState}`)}` })
            .catch((err) => this.log('Timeline notification failed:', err.message));
        }
      }
      this._prevChargingState = chargingState;

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: SoC=' + Math.round(soc) + '% P=' + Math.round(power) + 'W');

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

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(
        address, port, modbusId,
        LUNA2000_EMMA_CONTROL_REGISTERS,
        () => this._writeInProgress,
      );

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      const newMode = toEnum(ctrl.essControlMode);
      await this._set('storage_working_mode_settings',       newMode);
      await this._set('storage_excess_pv_energy_use_in_tou', toEnum(ctrl.preferredUseSurplusPv));
      this._updatingFromModbus = false;

      // Fire working mode changed trigger when mode changes (skip on first read)
      if (newMode !== null) {
        if (this._prevWorkingMode !== null && newMode !== this._prevWorkingMode) {
          const modeLabel = STORAGE_WORKING_MODE_LABELS[newMode] ?? `Mode ${newMode}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_working_mode_changed')
            .trigger(this, { mode: modeLabel })
            .catch((err) => this.log('Flow trigger luna2000_working_mode_changed failed:', err.message));
        }
        this._prevWorkingMode = newMode;
      }

      // Fire excess PV changed trigger
      const newExcessPv = toEnum(ctrl.preferredUseSurplusPv);
      if (newExcessPv !== null) {
        if (this._prevExcessPv !== null && newExcessPv !== this._prevExcessPv) {
          const label = EXCESS_PV_LABELS[newExcessPv] ?? `Mode ${newExcessPv}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_excess_pv_changed')
            .trigger(this, { mode: label })
            .catch((err) => this.log('Flow trigger luna2000_excess_pv_changed failed:', err.message));
        }
        this._prevExcessPv = newExcessPv;
      }


      // The Energy Management row at the end of "Change battery mode" — see the same block in
      // the luna2000_modbus driver.
      const infoUpdates = {};
      const infoRow = (settingId, text) => {
        if (text && this.getSetting(settingId) !== text) infoUpdates[settingId] = text;
      };

      try {
        const ems = this.homey.drivers.getDriver('energy_management').getDevices().length > 0;
        infoRow('info_ems_battery', this.homey.__(ems ? 'modbus.battery.ems.present'
                                                      : 'modbus.battery.ems.absent'));
      } catch (_) {
        infoRow('info_ems_battery', this.homey.__('modbus.battery.ems.absent'));
      }

      if (Object.keys(infoUpdates).length > 0) {
        this._updatingSettingFromModbus = true;
        await this.setSettings(infoUpdates)
          .catch((err) => this.log('setSettings info rows failed:', err.message));
        this._updatingSettingFromModbus = false;
      }

      // The "Change battery mode" dropdowns — see lib/mode-settings.js.
      await syncModeSettings(this, MODE_SETTINGS, {
        mode_storage_working: ctrl.essControlMode,
        mode_excess_pv_tou:   ctrl.preferredUseSurplusPv,
      });

      // Sync max grid charging power setting if it differs from what the EMMA reports
      if (ctrl.maxGridChargingPower !== null && ctrl.maxGridChargingPower !== undefined) {
        const currentKw = parseFloat(this.getSetting('max_grid_charge_power')) || 0;
        if (Math.abs(ctrl.maxGridChargingPower - currentKw) > 0.05) {
          await applySettingSync(this, { max_grid_charge_power: ctrl.maxGridChargingPower });
        }
      }

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus         = false;
      this._updatingSettingFromModbus  = false;
    }
  }

  // Detects when a control register is being written two different values in
  // quick succession — a sign that a second source (a Homey flow, a Huawei TOU
  // schedule, or another app) is fighting this app for control. Purely diagnostic:
  // it logs a warning and never changes what gets written.
  _noteWrite(capability, regAddress, value, source) {
    const now = Date.now();
    if (!this._recentWrites) this._recentWrites = {};
    const prev = this._recentWrites[capability];
    if (prev && prev.value !== value && (now - prev.ts) <= WRITE_CONFLICT_WINDOW_MS) {
      const secs = Math.round((now - prev.ts) / 1000);
      const label = STORAGE_WORKING_MODE_LABELS[String(value)] || `value ${value}`;
      const prevLabel = STORAGE_WORKING_MODE_LABELS[String(prev.value)] || `value ${prev.value}`;
      this.log(
        `[warn] Control conflict on reg ${regAddress} (${capability}): now set to ${value} (${label}) by ${source}, `
        + `but was set to ${prev.value} (${prevLabel}) by ${prev.source} ${secs}s ago. `
        + 'A second source (a Homey flow, a Huawei TOU/scheduling entry, or another app) is fighting for control — '
        + 'the mode will keep flipping until that source is disabled.',
      );
    }
    this._recentWrites[capability] = { value, ts: now, source };
  }

}

Object.assign(LUNA2000EmmaModbusDevice.prototype, modbusPolling);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(LUNA2000EmmaModbusDevice);

module.exports = LUNA2000EmmaModbusDevice;

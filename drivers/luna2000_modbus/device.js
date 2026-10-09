'use strict';

const { Device } = require('homey');
const { withSettingsLog, applySettingSync, record } = require('../../lib/change-log');
const {
  BATTERY_REGISTERS,
  BATTERY_MODULE_REGISTERS,
  CONTROL_REGISTERS,
  isBatteryDataValid,
  isBatteryAbsent,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { pendingModeWrites, syncModeSettings, applyModeWrites } = require('../../lib/mode-settings');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const { keepLast } = require('../../lib/capability-order');

// Shown last on the tile, below everything added later (lib/capability-order.js).
const VERSION_CAPABILITIES = ['luna2000_unit1_software_version', 'luna2000_unit2_software_version'];
const modbusPolling = require('../../lib/modbus-polling');
const enumLabel     = require('../../lib/enum-label');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

// Capabilities removed in previous versions — cleaned up on init
const DEPRECATED_CAPABILITIES = [
  'luna2000_unit1_status', // renamed to luna2000_battery_status
];

const UNIT1_STATUS_MAP = {
  0: 'Offline',
  1: 'Standby',
  2: 'Running',
  3: 'Fault',
  4: 'Sleep mode',
};

// Battery module slot keys — used to count installed packs from BATTERY_MODULE_REGISTERS
const BATTERY_MODULE_KEYS = ['unit1Pack1', 'unit1Pack2', 'unit1Pack3', 'unit2Pack1', 'unit2Pack2', 'unit2Pack3'];

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

const REMOTE_MODE_LABELS = {
  '0': 'Local Control',
  '1': 'Remote: Max Self-Consumption',
  '2': 'Remote: Fully Fed to Grid',
  '3': 'Remote: Time of Use',
  '4': 'Remote: AI Control',
  '5': 'Remote: Three-party Scheduling',
};

// All battery capabilities are always present (device IS a LUNA2000)
const REQUIRED_CAPABILITIES = [
  'measure_power',           // combined W: positive = charging, negative = discharging
  'measure_battery',         // SoC 0-100 %
  'measure_battery.backup',  // backup power reserve, register 47102 — readable in flows (#32)
  'meter_power.charged',     // lifetime total charged (kWh) – used by Homey energy dashboard
  'meter_power.discharged',  // lifetime total discharged (kWh) – used by Homey energy dashboard
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'measure_power.chargesetting',
  'measure_power.dischargesetting',
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
  'luna2000_battery_status',
  'storage_working_mode_settings',
  'storage_force_charge_discharge',
  'storage_excess_pv_energy_use_in_tou',
  'remote_charge_discharge_control_mode',
  'measure_battery_modules',
  'luna2000_unit1_installed',
  'luna2000_unit2_installed',
  'battery_state_string',        // human-readable state: "1234 W Laden (73%)" — hidden in UI
  // software version capabilities are added/removed dynamically based on register response
];

// The control block, split by what it costs to read — not by what it means.
//
// A Modbus read here is one TCP connection, and a Huawei device needs a full second to
// settle after connect (POST_CONNECT_MS) before the first register may be asked for. Four
// requests on top of that are ~61 ms each. So a control read of its own costs ~1.25 s, of
// which roughly 80 % is the connection and 20 % the registers — and the comment that used
// to sit on the throttle below blamed the registers.
//
// 47075..47108 is one contiguous span: eleven registers, including both power limits, the
// working mode and both cutoff SoCs. Carried along with the battery read it is ONE extra
// request on a connection that is already open — ~61 ms against ~1.25 s. So it rides
// along, and the values a flow can see are never more than one poll old.
const LIVE_CONTROL_REGISTERS = {
  storageMaxChargePower:            CONTROL_REGISTERS.storageMaxChargePower,          // 47075
  storageMaxDischargePower:         CONTROL_REGISTERS.storageMaxDischargePower,       // 47077
  storageChargingCutoffCapacity:    CONTROL_REGISTERS.storageChargingCutoffCapacity,  // 47081
  storageDischargeCutoffCapacity:   CONTROL_REGISTERS.storageDischargeCutoffCapacity, // 47082
  storageWorkingMode:               CONTROL_REGISTERS.storageWorkingMode,             // 47086
  storageChargeFromGrid:            CONTROL_REGISTERS.storageChargeFromGrid,          // 47087
  storageGridChargeCutoffSoc:       CONTROL_REGISTERS.storageGridChargeCutoffSoc,     // 47088
  storageForceChargeDischarge:      CONTROL_REGISTERS.storageForceChargeDischarge,    // 47100
  storageBackupPowerSoc:            CONTROL_REGISTERS.storageBackupPowerSoc,          // 47102
  storageUnit1No:                   CONTROL_REGISTERS.storageUnit1No,                 // 47107
  storageUnit2No:                   CONTROL_REGISTERS.storageUnit2No,                 // 47108
};

// The ones that sit far enough away to need a request of their own, and that nothing reads
// often: 47242 with its ceiling 47244 right behind it, 47299, 47589, and since 1.2.274 peak
// shaving at 47954/47955 — four requests. 47589 is the reason the throttle still earns its
// keep: it is a single-register span, and the field log of 2026-08 shows it going silent for
// minutes at a time — a silent register holds the host lock for the full RESPONSE_TIMEOUT_MS.
// Once every five polls, not every one. A battery without peak shaving answers 47954 with
// "illegal data address", which the client logs sparingly and does not count as a fault.
const RARE_CONTROL_REGISTERS = {
  storageGridChargePower:           CONTROL_REGISTERS.storageGridChargePower,           // 47242
  storageMaxGridChargePower:        CONTROL_REGISTERS.storageMaxGridChargePower,        // 47244
  storageExcessPvEnergyUseInTou:    CONTROL_REGISTERS.storageExcessPvEnergyUseInTou,    // 47299
  remoteChargeDischargeControlMode: CONTROL_REGISTERS.remoteChargeDischargeControlMode, // 47589
  storageCapacityControlMode:       CONTROL_REGISTERS.storageCapacityControlMode,       // 47954
  storageCapacityControlSoc:        CONTROL_REGISTERS.storageCapacityControlSoc,        // 47955
};

// The configured charge/discharge limits, setting id → the capability that mirrors it. A
// setting is what the user edits; the capability is what a flow can read as a token. Both
// must say the same thing, and both come from 47075/47077 — never from the battery's own
// reported maximum (37046/37048), which is a different number (issue #31).
const MAX_POWER_CAP = {
  max_charge_power:    'measure_power.chargesetting',
  max_discharge_power: 'measure_power.dischargesetting',
};

// Setting id → the name a person would recognise, for the timeline note when a write is
// refused. Only used there; the log keeps the raw id.
const SETTING_LABEL = {
  charge_from_grid:          'Charge battery from grid',
  grid_charge_cutoff_soc:    'Grid charge cutoff SoC',
  charging_cutoff_capacity:  'Charging cutoff capacity',
  discharge_cutoff_capacity: 'Discharge cutoff capacity',
  backup_power_soc:          'Backup power SoC',
  max_charge_power:          'Max charge power',
  max_discharge_power:       'Max discharge power',
  max_grid_charge_power:     'Grid charge power',
  mode_storage_working:      'Storage working mode',
  mode_excess_pv_tou:        'Excess PV energy (Time of Use)',
  mode_remote_dispatch:      'Remote charge/discharge mode',
  max_grid_charge_ceiling:   'Grid charge power limit',
  mode_capacity_control:     'Peak shaving',
  capacity_control_soc:      'Backup SoC for peak shaving',
};

// Maps writable enum capability → Modbus register address (47xxx)
const CONTROL_WRITE_MAP = {
  storage_working_mode_settings:        47086,
  storage_force_charge_discharge:       47100,
  storage_excess_pv_energy_use_in_tou:  47299,
  remote_charge_discharge_control_mode: 47589,
};

// Changed from the "Change battery mode" dropdowns in the device settings, not from the tile —
// see lib/mode-settings.js and issue #35. ids are the values each register takes, as strings.
const MODE_SETTINGS = {
  mode_storage_working: { cap: 'storage_working_mode_settings',        reg: 47086, ids: ['0', '1', '2', '3', '4', '5', '6'] },
  mode_excess_pv_tou:   { cap: 'storage_excess_pv_energy_use_in_tou',  reg: 47299, ids: ['0', '1'] },
  mode_remote_dispatch: { cap: 'remote_charge_discharge_control_mode', reg: 47589, ids: ['0', '1', '2', '3', '4', '5'] },
  // Peak shaving has no tile, so it names its values itself (SPC177: 2 is not supported in
  // single-device systems, but a device reporting it must still fill the dropdown).
  mode_capacity_control: { reg: 47954, ids: ['0', '1', '2'], labels: { 0: 'Disabled', 1: 'Active power limit', 2: 'Apparent power limit' } },
};

class LUNA2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevChargingState         = null;
    this._prevBatteryStatus         = null;
    this._prevWorkingMode           = null;
    this._prevExcessPv              = null;
    this._prevBackupSoc             = null;
    this._prevRemoteMode            = null;
    this._batteryModuleCount        = null;  // tracks last known module count for setEnergy
    this._batteryModulesInitialized = false; // true once a non-zero module count has been read and locked
    this._failureCount              = 0;
    this._updatingFromModbus        = false;
    this._updatingSettingFromModbus = false;
    this._writeInProgress           = false;
    this._settingsInitialized       = false; // true once _applyControl has seen the working mode
    this._controlPollCounter        = 4;     // start at 4 so first poll immediately reads control registers
    this._forceTimer                = null;  // pending auto-stop timer for timed force charge/discharge
    this._pendingForceMode          = null;  // set after a force charge/discharge write; cleared once poll confirms
    this._lastPollStart             = 0;
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

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Before anything else is written: a mode dropdown that cannot be written rejects the
    // whole save, so nothing is half-applied. See lib/mode-settings.js.
    const modeWrites = pendingModeWrites(this, MODE_SETTINGS, newSettings, changedKeys);

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
      const modbusId = parseIntSafe(this.getSetting('modbus_id'), 1);

      if (changedKeys.includes('charge_from_grid')) {
        const raw = newSettings.charge_from_grid ? 1 : 0;
        this.log(`Write charge_from_grid: ${raw} → reg 47087`);
        writeModbusRegister(address, port, modbusId, 47087, raw)
          .then(() => this.log('Write OK     [charge_from_grid → reg 47087]'))
          .catch((err) => this._revertSetting('charge_from_grid', oldSettings, err));
      }

      const socSettings = {
        grid_charge_cutoff_soc:   { reg: 47088, scale: 10, u32: false },
        charging_cutoff_capacity: { reg: 47081, scale: 10, u32: false },
        discharge_cutoff_capacity:{ reg: 47082, scale: 10, u32: false },
        backup_power_soc:         { reg: 47102, scale: 10, u32: false },
        capacity_control_soc:     { reg: 47955, scale: 10, u32: false },
      };
      for (const [key, { reg, scale, u32 }] of Object.entries(socSettings)) {
        if (changedKeys.includes(key)) {
          // Homey renders 0 as a blank number field — treat blank (null/NaN) as 0
          const val = parseFloat(newSettings[key]);
          const raw = Math.round((Number.isFinite(val) ? val : 0) * scale);
          this.log(`Write ${key}: ${newSettings[key]} → reg ${reg} raw=${raw}`);
          (u32 ? writeModbusU32 : writeModbusRegister)(address, port, modbusId, reg, raw)
            .then(() => this.log(`Write OK     [${key} → reg ${reg}]`))
            .catch((err) => this._revertSetting(key, oldSettings, err));
        }
      }

      const wattSettings = {
        max_charge_power:     { reg: 47075 },
        max_discharge_power:  { reg: 47077 },
      };
      for (const [key, { reg }] of Object.entries(wattSettings)) {
        if (changedKeys.includes(key)) {
          const raw = Math.round(parseFloat(newSettings[key]) || 0);
          this.log(`Write ${key}: ${raw} W → reg ${reg}`);
          writeModbusU32(address, port, modbusId, reg, raw)
            .then(() => { this.log(`Write OK     [${key} → reg ${reg}]`); return this._reflectMaxPower(key, raw); })
            .catch((err) => this._revertSetting(key, oldSettings, err));
        }
      }

      // The ceiling the set point 47242 cannot exceed.
      if (changedKeys.includes('max_grid_charge_ceiling')) {
        const raw = Math.round(Math.max(0, parseFloat(newSettings.max_grid_charge_ceiling) || 0));
        this.log(`Write max_grid_charge_ceiling: ${raw} W → reg 47244`);
        writeModbusU32(address, port, modbusId, 47244, raw)
          .then(() => this.log('Write OK     [max_grid_charge_ceiling → reg 47244]'))
          .catch((err) => this._revertSetting('max_grid_charge_ceiling', oldSettings, err));
      }

      // Register 47242 (active grid charge power set point) requires Charge from Grid
      // (47087) to be enabled — otherwise the inverter ignores the write.
      if (changedKeys.includes('max_grid_charge_power')) {
        const raw = Math.round(parseFloat(newSettings.max_grid_charge_power) || 0);
        this.log(`Write max_grid_charge_power: ${raw} W → reg 47242 (ensuring charge_from_grid enabled first)`);
        const ensureEnabled = !this.getSetting('charge_from_grid')
          ? writeModbusRegister(address, port, modbusId, 47087, 1)
              .then(() => {
                this._updatingSettingFromModbus = true;
                return this.setSettings({ charge_from_grid: true })
                  .catch(() => {})
                  .finally(() => { this._updatingSettingFromModbus = false; });
              })
          : Promise.resolve();
        ensureEnabled
          .then(() => writeModbusU32(address, port, modbusId, 47242, raw))
          .then(() => this.log('Write OK     [max_grid_charge_power → reg 47242]'))
          .catch((err) => this._revertSetting('max_grid_charge_power', oldSettings, err));
      }
    }

    // Not awaited, like every other write here: Homey stores the settings when this returns.
    applyModeWrites(this, modeWrites, (w) => {
      return writeModbusRegister(newSettings.address, parseInt(newSettings.port, 10) || 502,
        parseIntSafe(newSettings.modbus_id, 1), w.reg, parseInt(w.value, 10));
    }, (w, err) => this._revertSetting(w.key, oldSettings, err))
      .catch((err) => this.error('Mode write failed:', err.message));
  }

  async onUninit() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
    await this._stopPolling();
  }

  async onDeleted() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
    await this._stopPolling();
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
    await keepLast(this, VERSION_CAPABILITIES).catch((err) => this.error('Capability order:', err.message));
  }

  // ─── Why the battery modes cannot be changed from the device tile ────────────
  //
  // Until 1.2.266 the four modes — storage working mode, force charge/discharge, excess PV
  // and remote charge/discharge mode — were scroll-wheel pickers, and a listener here wrote
  // whatever a wheel landed on straight into the battery. Issue #35 showed the same wheel on
  // the inverter writing its top entry merely because the device was opened; these wheels
  // carry Adaptive, Stop, Feed to Grid and Local Control on top, and the reporter had found
  // his remote mode on Local Control after reopening this tile.
  //
  // So the tile shows the modes as text (setable: false, uiComponent: sensor) and nothing is
  // registered here. Three of them are changed in the device settings instead, from
  // dropdowns that list every value and write only on Save — see onSettings and
  // lib/mode-settings.js. Force charge/discharge has no dropdown on purpose: it is a command,
  // not a setting, and stays with the flow cards. CONTROL_WRITE_MAP stays for those cards.

  // ─── Flow actions ──────────────────────────────────────────────────────────

  /**
   * Put a setting back after the inverter refused the write.
   *
   * Homey stores the new number in the settings field BEFORE onSettings runs, and every
   * write here is fire-and-forget. Until 1.2.239 a refusal was only logged, so the field
   * kept showing a limit the inverter never took — and the four max-power condition cards
   * read that field, not the capability. "Max discharge power is below 1" could therefore
   * answer "blocked" while the battery went on discharging at the old limit, until the next
   * control poll happened to read the real value back.
   *
   * The guard is what stops the revert from being written straight back out: onSettings
   * skips its whole write block while _updatingSettingFromModbus is set.
   *
   * A silent revert would only replace one puzzle with another, so it is also said out
   * loud — under the same toggle as every other timeline note from this device.
   */
  async _revertSetting(settingId, oldSettings, err) {
    this.error(`${settingId} write failed:`, err.message);
    record(this, 'failed', settingId, `Write failed [${settingId}]: ${err.message} — setting taken back`);
    const previous = oldSettings ? oldSettings[settingId] : undefined;
    if (previous === undefined || previous === null) return;
    if (this.getSetting(settingId) === previous) return;  // nothing drifted

    this._updatingSettingFromModbus = true;
    try {
      await this.setSettings({ [settingId]: previous });
    } catch (e) {
      this.log(`setSettings(${settingId}) revert failed:`, e.message);
      return;
    } finally {
      this._updatingSettingFromModbus = false;
    }

    if (this.getSetting('enable_timeline_notifications') === false) return;
    const label = SETTING_LABEL[settingId] || settingId;
    // A mode reads as its name, not as the register value behind the dropdown.
    const spec = MODE_SETTINGS[settingId];
    const shown = !spec ? previous : spec.labels ? (spec.labels[previous] ?? previous) : this._enumLabel(spec.cap, previous);
    this.homey.notifications.createNotification({
      excerpt: `${this.getName()}: ${label} could not be written (${err.message}) — put back to ${shown}.`,
    }).catch((e) => this.log('Timeline notification failed:', e.message));
  }

  /**
   * Bring both views of a charge/discharge limit in line with a value the inverter has just
   * accepted: the device setting the user edits, and the capability a flow reads.
   *
   * Called after a SUCCESSFUL write only. After a failed one both keep what they had, and
   * that is the truth — the inverter still runs on the old limit. The capability half is
   * also written by _applyControl on every poll (47075/47077 ride with the battery data),
   * so a change made in Huawei's own app arrives on the next poll; this path is for a change
   * made from Homey, which shows at once rather than waiting for one.
   */
  async _reflectMaxPower(settingId, watts) {
    const cap = MAX_POWER_CAP[settingId];
    if (!cap || typeof watts !== 'number' || !Number.isFinite(watts)) return;
    await this._set(cap, watts);
    const current = parseFloat(this.getSetting(settingId));
    if (Number.isFinite(current) && Math.abs(current - watts) <= 0.5) return;
    this._updatingSettingFromModbus = true;
    try {
      await this.setSettings({ [settingId]: watts });
    } catch (err) {
      this.log(`setSettings(${settingId}) failed:`, err.message);
    } finally {
      this._updatingSettingFromModbus = false;
    }
  }

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
      const unitId = () => parseIntSafe(self.getSetting('modbus_id'), 1);

      const writeEnum = (cardId, capabilityId, mode) => {
        const reg   = CONTROL_WRITE_MAP[capabilityId];
        const value = parseInt(mode, 10);
        self.log(`Write start  [${cardId} → reg ${reg}] value=${value}`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), reg, value);
            self.log(`Write OK     [${cardId} → reg ${reg}]`);
            self._updatingFromModbus = true;
            await self._set(capabilityId, mode).catch(() => {});
          } catch (err) {
            self.error(`Write failed [${cardId} → reg ${reg}]:`, err.message);
          } finally {
            self._updatingFromModbus = false;
            self._writeInProgress   = false;
          }
        })();
      };

      cards['luna2000_set_working_mode'] = ({ mode }) =>
        writeEnum('luna2000_set_working_mode', 'storage_working_mode_settings', mode);

      cards['luna2000_set_excess_pv'] = ({ mode }) =>
        writeEnum('luna2000_set_excess_pv', 'storage_excess_pv_energy_use_in_tou', mode);

      cards['luna2000_set_remote_mode'] = ({ mode }) =>
        writeEnum('luna2000_set_remote_mode', 'remote_charge_discharge_control_mode', mode);

      // ── Forced charging and discharging, the way the Home Assistant integration does it ──
      //
      // wlcrs/huawei_solar (services.py) writes a run's values first, then the mode in 47246 —
      // 0 runs for the minutes in 47083, 1 runs to the target SoC in 47101 — and the start
      // command in 47100 last, every step only after the one before it succeeded. Its stop
      // writes 47100 = 0 and then clears the discharge power (47249), the minutes (47083) and
      // sets the mode back to "duration" (1.2.302, on Andi's request after comparing the two).
      //
      // Until 1.2.301 this app never wrote 47246, so each card ran in whatever mode the battery
      // last had. Measured on Andi's LUNA2000: mode 1 — there the minute cards ignored their
      // minutes and ran to an old target SoC. And a failed power or minutes write used to start
      // the run anyway, on the value left from an earlier one.
      const MODE_DURATION = 0;
      const MODE_SOC = 1;

      // Runs the steps in order and starts nothing when one fails: the start command is the
      // last step, so an aborted sequence leaves the battery as it was.
      const forceSequence = (label, kind, steps, done) => {
        const h = host(), p = port(), u = unitId();
        self._writeInProgress = true;
        (async () => {
          try {
            for (const [fn, reg, value, what] of steps) {
              try {
                await fn(h, p, u, reg, value);
              } catch (err) {
                self.error(`${label}: ${what} (reg ${reg}) write failed — aborting, the run was not started:`, err.message);
                self._pendingForceMode = null;
                self._notifyForceAbort(kind, what, err);
                return;
              }
            }
            self.log(`${label} command sent`);
            if (done) await done();
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      // "Zwangsladen/Entladen steuern" — the one card HA has no counterpart for. Charging and
      // discharging run to the target SoC in 47101 (set by "Zwangslade-Ziel-SoC setzen" or the
      // last start card), at the power already in 47247/47249: the card sets mode 1 first, so it
      // does the same on every battery whatever mode the last card left behind. Stop is HA's.
      cards['luna2000_set_force_charge_discharge'] = ({ mode }) => {
        const value = parseInt(mode, 10);
        const reflect = async () => {
          self._updatingFromModbus = true;
          try { await self._set('storage_force_charge_discharge', String(value)); } catch (_) {}
          finally { self._updatingFromModbus = false; }
        };
        if (value === 0) {
          self.log('Force stop: 47100 = 0, then clear discharge power, minutes and mode (as HA)');
          self._pendingForceMode = null;
          const h = host(), p = port(), u = unitId();
          self._writeInProgress = true;
          (async () => {
            try {
              try {
                await writeModbusRegister(h, p, u, 47100, 0);
              } catch (err) {
                self.error('Force stop: stop write (reg 47100) failed:', err.message);
                return;
              }
              await reflect();
              // The battery is stopped; the clean-up afterwards is best effort.
              for (const [fn, reg, v, what] of [
                [writeModbusU32, 47249, 0, 'discharge power'],
                [writeModbusRegister, 47083, 0, 'duration'],
                [writeModbusRegister, 47246, MODE_DURATION, 'mode'],
              ]) {
                try { await fn(h, p, u, reg, v); } catch (err) {
                  self.error(`Force stop: clearing ${what} (reg ${reg}) failed:`, err.message);
                }
              }
              self.log('Force stop sent');
            } finally {
              self._writeInProgress = false;
            }
          })();
          return;
        }
        const label = value === 1 ? 'Force charge (to target SoC)' : 'Force discharge (to target SoC)';
        self.log(`${label}: mode 47246 = ${MODE_SOC}, then 47100 = ${value}`);
        forceSequence(label, value === 1 ? 'charge' : 'discharge', [
          [writeModbusRegister, 47246, MODE_SOC, 'mode'],
          [writeModbusRegister, 47100, value, 'start command'],
        ], reflect);
      };

      cards['luna2000_start_force_charge'] = ({ device, power, target_soc }) => {
        const powerW = self._forcePowerW('charge', power);
        const socRaw  = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        self.log(`Force charge: power=${powerW} W, target SoC=${target_soc}% (raw ${socRaw})`);
        self._pendingForceMode = { direction: 'charging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // The target SoC goes first: a run must never start on a stale target.
        forceSequence('Force charge', 'charge', [
          [writeModbusRegister, 47101, socRaw, `target SoC (${target_soc}%)`],
          [writeModbusU32, 47247, powerW, 'charge power'],
          [writeModbusRegister, 47246, MODE_SOC, 'mode'],
          [writeModbusRegister, 47100, 1, 'start command'],
        ]);
      };

      const startForceDischargeSoc = ({ device, power, target_soc }) => {
        const powerW = self._forcePowerW('discharge', power);
        const socRaw  = Math.round(Math.max(0, Math.min(99, target_soc)) * 10);
        self.log(`Force discharge: power=${powerW} W, target SoC=${target_soc}% (raw ${socRaw})`);
        self._pendingForceMode = { direction: 'discharging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // The target SoC goes first: a run must never discharge to a stale target (e.g. a
        // morning 2% run).
        forceSequence('Force discharge', 'discharge', [
          [writeModbusRegister, 47101, socRaw, `target SoC (${target_soc}%)`],
          [writeModbusU32, 47249, powerW, 'discharge power'],
          [writeModbusRegister, 47246, MODE_SOC, 'mode'],
          [writeModbusRegister, 47100, 2, 'start command'],
        ]);
      };
      cards['luna2000_start_force_discharge'] = startForceDischargeSoc;
      // Deprecated twin of the card above, kept for flows that still use it.
      cards['luna2000_start_force_discharge_soc'] = startForceDischargeSoc;

      cards['luna2000_start_force_charge_duration'] = ({ device, power, duration }) => {
        const powerW = self._forcePowerW('charge', power);
        const durationMin = Math.round(Math.max(1, Math.min(1440, duration)));
        self.log(`Force charge for ${durationMin} min: power=${powerW} W`);
        self._pendingForceMode = { direction: 'charging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // Reg 47083 (hardware timer) stops the run after the minutes — with mode 47246 = 0,
        // which is what makes the battery count them at all.
        forceSequence('Force charge (timed)', 'charge', [
          [writeModbusU32, 47247, powerW, 'charge power'],
          [writeModbusRegister, 47083, durationMin, `duration (${durationMin} min)`],
          [writeModbusRegister, 47246, MODE_DURATION, 'mode'],
          [writeModbusRegister, 47100, 1, 'start command'],
        ]);
      };

      cards['luna2000_start_force_discharge_duration'] = ({ device, power, duration }) => {
        const powerW = self._forcePowerW('discharge', power);
        const durationMin   = Math.round(Math.max(1, Math.min(1440, duration)));
        self.log(`Force discharge for ${durationMin} min: power=${powerW} W`);
        self._pendingForceMode = { direction: 'discharging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        forceSequence('Force discharge (timed)', 'discharge', [
          [writeModbusU32, 47249, powerW, 'discharge power'],
          [writeModbusRegister, 47083, durationMin, `duration (${durationMin} min)`],
          [writeModbusRegister, 47246, MODE_DURATION, 'mode'],
          [writeModbusRegister, 47100, 2, 'start command'],
        ]);
      };

      cards['luna2000_set_force_charge_power'] = ({ device, power }) => {
        const powerW = self._forcePowerW('charge', power);
        self.log(`Set force charge power: ${powerW} W`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47247, powerW);
            self.log('Force charge power written');
          } catch (err) {
            self.error('Set force charge power failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_charge_from_grid'] = ({ device, mode }) => {
        const value = parseInt(mode, 10);
        self.log(`Set charge from grid: ${value === 1 ? 'Enable' : 'Disable'} (reg 47087)`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47087, value);
            self.log('Charge from grid written');
          } catch (err) {
            self.error('Set charge from grid failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_grid_charge_cutoff_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(20, Math.min(100, target_soc)) * 10);
        self.log(`Set grid charge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47088)`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47088, socRaw);
            self.log('Grid charge cutoff SoC written');
          } catch (err) {
            self.error('Set grid charge cutoff SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_max_charge_power'] = ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        self.log(`Set max charge power: ${powerW} W → reg 47075`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47075, powerW);
            self.log('Max charge power written');
            await self._reflectMaxPower('max_charge_power', powerW);
          } catch (err) {
            self.error('Set max charge power failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_max_discharge_power'] = ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        self.log(`Set max discharge power: ${powerW} W → reg 47077`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47077, powerW);
            self.log('Max discharge power written');
            await self._reflectMaxPower('max_discharge_power', powerW);
          } catch (err) {
            self.error('Set max discharge power failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_force_charge_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        self.log(`Set force charge target SoC: ${target_soc}% (raw ${socRaw})`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47101, socRaw);
            self.log('Force charge target SoC written');
          } catch (err) {
            self.error('Set force charge SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_grid_charge_power'] = ({ device, power }) => {
        const raw = Math.round(Math.max(0, parseFloat(power) || 0));
        self.log(`Set grid charge power: ${raw} W → reg 47242`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47242, raw);
            self.log('Grid charge power written');
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_grid_charge_power: raw }).catch(() => {});
          } catch (err) {
            self.error('Set grid charge power failed:', err.message);
          } finally {
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      cards['luna2000_set_charge_cutoff_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(90, Math.min(100, target_soc)) * 10);
        self.log(`Set charge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47081)`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47081, socRaw);
            self.log('Charge cutoff SoC written');
          } catch (err) {
            self.error('Set charge cutoff SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_discharge_cutoff_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(12, Math.min(20, target_soc)) * 10);
        self.log(`Set discharge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47082)`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47082, socRaw);
            self.log('Discharge cutoff SoC written');
          } catch (err) {
            self.error('Set discharge cutoff SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_backup_reserve_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        self.log(`Set backup reserve SoC: ${target_soc}% (raw ${socRaw}, reg 47102)`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47102, socRaw);
            self.log('Backup reserve SoC written');
          } catch (err) {
            self.error('Set backup reserve SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_max_grid_charge_power'] = ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        self.log(`Set max grid charge power: ${powerW} W → reg 47244`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47244, powerW);
            self.log('Max grid charge power written');
          } catch (err) {
            self.error('Set max grid charge power failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_force_discharge_power'] = ({ device, power }) => {
        const powerW = self._forcePowerW('discharge', power);
        self.log(`Set force discharge power: ${powerW} W → reg 47249`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47249, powerW);
            self.log('Force discharge power written');
          } catch (err) {
            self.error('Set force discharge power failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      // 47079, "[Energy storage unit] Power limit of the grid-tied point": I32, W, gain 1,
      // [0, Pmax], default Pmax, "supported only by certain models" — row 91 of Huawei's Solar
      // Inverter Modbus Interface Definitions V3.0, absent from SPC177. Written as U32, which for
      // a value from 0 up is the same two words. Two flows use the card (Flow Card Usage,
      // 2026-10-09), so it stays — and since 1.2.290 it writes to the battery the flow names.
      cards['luna2000_set_power_limit_grid'] = ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        device.log(`Set grid-tied power limit: ${powerW} W → reg 47079`);
        device._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(device.getSetting('address'), parseInt(device.getSetting('port'), 10) || 502,
              parseIntSafe(device.getSetting('modbus_id'), 1), 47079, powerW);
            device.log('Grid-tied power limit written');
          } catch (err) {
            device.error('Set grid-tied power limit failed:', err.message);
          } finally {
            device._writeInProgress = false;
          }
        })();
      };

      // Retired in 1.2.289. Register 47604 documents one value — 0, "switch from grid-tied to
      // off-grid" (SPC177, p. 77) — and this card sent exactly that for "Disabled", so a flow
      // meant to keep the house on the grid would have taken it off. It stays registered so an
      // existing flow fails with a message instead of doing either thing; the manifest marks it
      // deprecated, which hides it from new flows.
      cards['luna2000_set_backup_offgrid'] = async () => {
        throw new Error(self.homey.__('modbus.battery.offgridCardReplaced'));
      };

      // The one command Huawei documents for 47604, under its own name: only with the
      // confirmation ticked, on the battery the flow names, and awaited, so a refused write
      // fails the flow rather than vanishing into the log.
      cards['luna2000_switch_to_offgrid'] = async ({ device, confirm }) => {
        if (confirm !== true) throw new Error(self.homey.__('modbus.battery.offgridNotConfirmed'));
        await device._switchToOffgrid();
      };

      cards['luna2000_set_capacity_control_mode'] = ({ device, mode }) => {
        const value = parseInt(mode, 10);
        self.log(`Set capacity control mode: ${value} (reg 47954)`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47954, value);
            self.log('Capacity control mode written');
          } catch (err) {
            self.error('Set capacity control mode failed:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['luna2000_set_capacity_control_soc'] = ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        self.log(`Set capacity control peak-shaving SoC: ${target_soc}% (raw ${socRaw}, reg 47955)`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47955, socRaw);
            self.log('Capacity control SoC written');
          } catch (err) {
            self.error('Set capacity control SoC failed:', err.message);
          } finally {
            self._writeInProgress = false;
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

    this.homey.flow
      .getConditionCard('luna2000_soc_below')
      .registerRunListener((args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc !== undefined && soc < args.soc;
      });

    this.homey.flow
      .getDeviceTriggerCard('luna2000_battery_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('luna2000_battery_status_is')
      // The device the flow picked, not the one that registered the card: since 1.2.281 the
      // cloud battery shares this card, and only one listener survives per card.
      .registerRunListener((args) => args.device.getCapabilityValue('luna2000_battery_status') === args.status);

    this.homey.flow
      .getConditionCard('luna2000_working_mode_is')
      .registerRunListener((args) => args.device.getCapabilityValue('storage_working_mode_settings') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_excess_pv_is')
      .registerRunListener((args) => args.device.getCapabilityValue('storage_excess_pv_energy_use_in_tou') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_remote_mode_is')
      .registerRunListener((args) => args.device.getCapabilityValue('remote_charge_discharge_control_mode') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_max_charge_power_above')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_charge_power'));
        return Number.isFinite(current) && current > args.power;
      });

    this.homey.flow
      .getConditionCard('luna2000_max_charge_power_below')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_charge_power'));
        return Number.isFinite(current) && current < args.power;
      });

    // The discharge pair was missing (issue #31). Without it the only thing a flow could
    // compare was the capability — which at the time showed the wrong number.
    this.homey.flow
      .getConditionCard('luna2000_max_discharge_power_above')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_discharge_power'));
        return Number.isFinite(current) && current > args.power;
      });

    this.homey.flow
      .getConditionCard('luna2000_max_discharge_power_below')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_discharge_power'));
        return Number.isFinite(current) && current < args.power;
      });

    // Issue #32: the reserve could be written from a flow — "Set backup power reserve SoC"
    // has been there all along — but never read back, so a flow that set it had no way to
    // notice a change made in FusionSolar, on the inverter, or by hand in the app.
    //
    // Read off the capability rather than the setting, unlike the four pairs above: the
    // EMMA battery driver has this capability but no backup_power_soc setting, and one pair
    // of cards covering both devices is better than two pairs that look identical.
    const backupSocOf = (device) => {
      const value = device.getCapabilityValue('measure_battery.backup');
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };

    this.homey.flow
      .getConditionCard('luna2000_backup_soc_above')
      .registerRunListener((args) => {
        const current = backupSocOf(args.device);
        return current !== null && current > args.soc;
      });

    this.homey.flow
      .getConditionCard('luna2000_backup_soc_below')
      .registerRunListener((args) => {
        const current = backupSocOf(args.device);
        return current !== null && current < args.soc;
      });
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    if (this._writeInProgress) return; // pause poll while a write is queued/running
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

    const abort = () => this._writeInProgress;

    try {
      const batt = await readModbusRegisters(
        address, port, modbusId, { ...BATTERY_REGISTERS, ...LIVE_CONTROL_REGISTERS }, abort);

      if (!isBatteryDataValid(batt)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          const msg = isBatteryAbsent(batt)
            ? this.homey.__('modbus.errors.batteryNotOnRS485')
            : this.homey.__('modbus.errors.batteryNotDetected');
          await this.setUnavailable(msg);
        }
        this._fetchInProgress = false;
        return;
      }

      const prevSoc = this.getCapabilityValue('measure_battery');
      const soc     = batt.storageSOC ?? 0;
      const power   = batt.storageChargeDischarge ?? 0; // positive = charging, negative = discharging

      const IDLE_THRESHOLD_W = 50;
      const chargingState = power > IDLE_THRESHOLD_W ? 'charging'
        : power < -IDLE_THRESHOLD_W ? 'discharging'
        : 'idle';

      await this._set('measure_power',                power);  // Homey home battery convention
      await this._set('measure_battery',              soc);
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
      await this._set('meter_power.charged',          batt.storageTotalCharge ?? null);
      await this._set('meter_power.discharged',       batt.storageTotalDischarge ?? null);
      await this._set('measure_power.batt_charge',    Math.max(0,  power));
      await this._set('measure_power.batt_discharge',  Math.max(0, -power));
      // measure_power.chargesetting / .dischargesetting are the configured limits (47075 /
      // 47077). They are set by _applyControl a few lines below, from the same read this
      // poll just made, and by _reflectMaxPower right after a write from Homey. Until
      // 1.2.238 they were written HERE from the battery's own reported maximum (37046/37048,
      // essMax*), which does not move when the user changes the limit — issue #31.
      if (batt.storageUnit1Status !== null && batt.storageUnit1Status !== undefined) {
        const statusLabel = UNIT1_STATUS_MAP[batt.storageUnit1Status] ?? `Status ${batt.storageUnit1Status}`;
        await this._set('luna2000_battery_status', statusLabel);
        if (this._prevBatteryStatus !== null && statusLabel !== this._prevBatteryStatus) {
          this.homey.flow.getDeviceTriggerCard('luna2000_battery_status_changed')
            .trigger(this, { status: statusLabel }, { status: statusLabel }).catch((err) => this.log('Flow trigger luna2000_battery_status_changed failed:', err.message));
          if (this.getSetting('enable_timeline_notifications') !== false) {
            this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${statusLabel}` })
              .catch((err) => this.log('Timeline notification failed:', err.message));
          }
        }
        this._prevBatteryStatus = statusLabel;
      }
      await this._set('meter_power.today_batt_input',  batt.storageDayCharge ?? null);
      await this._set('meter_power.today_batt_output', batt.storageDayDischarge ?? null);

      await this._syncStringCap('luna2000_unit1_software_version', batt.storageUnit1SoftwareVer);
      await this._syncStringCap('luna2000_unit2_software_version', batt.storageUnit2SoftwareVer);
      // The stack's nameplate capacity, register 37758. Dynamic for the same reason as the
      // two above: a battery that does not answer it should show nothing rather than a zero.
      await this._syncNumberCap('battery_rated_capacity', batt.ratedCapacity);

      // The eleven settings registers came with the battery data on the same connection.
      await this._applyControl(batt);

      // The remaining three need a connection of their own — see RARE_CONTROL_REGISTERS.
      // Skipped outright while a write is waiting: opening a connection only to abort at the
      // first register would lay a full second of settle time on exactly the write it is
      // trying to stay out of the way of, and read nothing. The counter is left alone so the
      // attempt comes back on the next poll rather than in five.
      if (!this._writeInProgress) {
        this._controlPollCounter = (this._controlPollCounter + 1) % 5;
        if (this._controlPollCounter === 0) {
          await this._fetchControl(address, port, modbusId);
        }
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
      // The version strings end the tile, after whatever this poll may have added (1.2.301).
      await keepLast(this, VERSION_CAPABILITIES).catch((err) => this.error('Capability order:', err.message));
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: SoC=' + Math.round(soc) + '% P=' + Math.round(power) + 'W');

      // Confirm pending force charge/discharge command once the poll shows the expected direction
      if (this._pendingForceMode) {
        const { direction, powerW, sentAt } = this._pendingForceMode;
        const confirmed = direction === 'discharging' ? power < -50 : power > 50;
        const elapsedS  = Math.round((Date.now() - sentAt) / 1000);
        if (confirmed) {
          this.log(`Force ${direction} confirmed by poll: P=${Math.round(power)} W (target ${powerW} W, ${elapsedS}s after command)`);
          this._pendingForceMode = null;
        } else if (elapsedS > 300) {
          this.log(`Force ${direction} NOT confirmed after ${elapsedS}s — battery may have ignored the command`);
          this._pendingForceMode = null;
        }
      }

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

  // Adds the capability and sets its value when present; removes it when absent.
  // Used for optional string capabilities that only exist on some hardware configurations.
  /**
   * The numeric counterpart to _syncStringCap, for a reading a battery may or may not give.
   *
   * Register 37758 is the stack's nameplate capacity. The same physical fact the module
   * count registers describe, and those are known to answer with a transient 0 — see
   * _fetchControl below, which only trusts a module count once it is greater than zero. So
   * a zero here is treated as "not answered", never as "this battery holds nothing": a
   * capacity of 0 reaching the EMS would silently switch off the adaptive solar-forecast
   * gate and price-optimised charging, with no error anywhere.
   *
   * Removal follows _syncStringCap's rule exactly: only when the current value is empty
   * too, so a capacity read once survives any number of failed polls.
   */
  async _syncNumberCap(capId, value) {
    const usable = typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (usable) {
      if (!this.hasCapability(capId)) await this.addCapability(capId);
      await this._set(capId, value);
      return;
    }
    if (!this.hasCapability(capId)) return;
    const current = this.getCapabilityValue(capId);
    if (current !== null && current !== undefined && current !== 0) return;
    await this.removeCapability(capId);
  }

  async _syncStringCap(capId, value) {
    const hasValue = value && typeof value === 'string' && value.trim().length > 0;
    if (hasValue) {
      if (!this.hasCapability(capId)) await this.addCapability(capId);
      await this._set(capId, value.trim());
      return;
    }
    if (!this.hasCapability(capId)) return;
    // An empty read is not proof the unit is absent. These two live in registers 37799 and
    // 37814, which the field log of 2026-08-20 shows failing individually while the rest of
    // the poll came through — the bisection path exists for exactly that. Removing on the
    // first empty answer therefore deleted a capability that was merely unread, and the
    // next good poll added it straight back: the tile flickers and the store is rewritten
    // for nothing.
    //
    // A total failure never got this far — isBatteryDataValid returns earlier — so the case
    // this guards is the partial one.
    //
    // Requiring the CURRENT value to be empty too keeps a version string that was once read
    // through any number of failed reads, while "this battery has no second unit" still
    // removes the capability: there the value was never there to begin with.
    const current = this.getCapabilityValue(capId);
    if (current !== null && current !== undefined && String(current).trim().length > 0) return;
    await this.removeCapability(capId);
  }

  /**
   * The three control registers that do not ride along with the battery data, plus the
   * one-off battery module count. Everything it reads is handed to _applyControl, which is
   * the same code the data poll runs — it takes whatever registers it was given and leaves
   * the rest alone.
   */
  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, RARE_CONTROL_REGISTERS, () => this._writeInProgress);
      await this._applyControl(ctrl);
    } catch (err) {
      this.log('Control register read skipped:', err.message);
    }

    // Battery module count — read once at startup, then locked permanently.
    // Registers 47750–47755 are unreliable during operation (return transient 0 or
    // wrong counts) and battery modules are never added/removed during normal use.
    // Retries automatically on each control-poll cycle until a non-zero count is seen.
    if (this._batteryModulesInitialized) return;
    try {
      const mods  = await readModbusRegisters(address, port, modbusId, BATTERY_MODULE_REGISTERS, () => this._writeInProgress);
      const count = BATTERY_MODULE_KEYS.filter((k) => mods[k] !== null && mods[k] !== undefined && mods[k] !== 0).length;
      await this._set('measure_battery_modules', count);

      if (count > 0) {
        this._batteryModulesInitialized = true;
        this._batteryModuleCount        = count;
        const batteries = Array(count).fill('INTERNAL');
        await this.setEnergy({
          batteries,
          homeBattery:                    true,
          meterPowerImportedCapability:   'meter_power.charged',
          meterPowerExportedCapability:   'meter_power.discharged',
        }).catch((err) => this.log('setEnergy failed:', err.message));
        this.log(`Battery modules: ${count} → energy.batteries locked to ${JSON.stringify(batteries)}`);
      } else {
        this.log('Battery modules: read returned 0 — will retry on next control poll');
      }
    } catch (err) {
      this.log('Battery module register read skipped:', err.message);
    }
  }

  /**
   * Turn whatever control registers were read into capabilities, triggers and settings.
   *
   * Called six times per five polls, with different halves: every poll with the eleven that
   * came with the battery data, and once more every fifth with the three that needed their
   * own connection.
   * Every branch below already tolerates a missing register — toEnum gives null, _set skips
   * null, and the settings sync only collects values that are present — so the two halves
   * need no bookkeeping between them.
   *
   * It carries its own try/catch on purpose. Running inside the data poll would otherwise
   * let a control-side fault count toward _failureCount and take the device offline; a
   * setting that could not be read is not a battery that cannot be reached.
   */
  async _applyControl(ctrl) {
    try {
      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      const newMode = toEnum(ctrl.storageWorkingMode);
      await this._set('storage_working_mode_settings',        newMode);
      await this._set('storage_force_charge_discharge',       toEnum(ctrl.storageForceChargeDischarge));
      await this._set('storage_excess_pv_energy_use_in_tou',  toEnum(ctrl.storageExcessPvEnergyUseInTou));
      await this._set('remote_charge_discharge_control_mode', toEnum(ctrl.remoteChargeDischargeControlMode));
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
      const newExcessPv = toEnum(ctrl.storageExcessPvEnergyUseInTou);
      if (newExcessPv !== null) {
        if (this._prevExcessPv !== null && newExcessPv !== this._prevExcessPv) {
          const label = EXCESS_PV_LABELS[newExcessPv] ?? `Mode ${newExcessPv}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_excess_pv_changed')
            .trigger(this, { mode: label })
            .catch((err) => this.log('Flow trigger luna2000_excess_pv_changed failed:', err.message));
        }
        this._prevExcessPv = newExcessPv;
      }

      // Fire remote mode changed trigger
      const newRemoteMode = toEnum(ctrl.remoteChargeDischargeControlMode);
      if (newRemoteMode !== null) {
        if (this._prevRemoteMode !== null && newRemoteMode !== this._prevRemoteMode) {
          const label = REMOTE_MODE_LABELS[newRemoteMode] ?? `Mode ${newRemoteMode}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_remote_mode_changed')
            .trigger(this, { mode: label })
            .catch((err) => this.log('Flow trigger luna2000_remote_mode_changed failed:', err.message));
        }
        this._prevRemoteMode = newRemoteMode;
      }

      await this._set('luna2000_unit1_installed', ctrl.storageUnit1No !== null && ctrl.storageUnit1No !== undefined ? ctrl.storageUnit1No > 0 : null);
      await this._set('luna2000_unit2_installed', ctrl.storageUnit2No !== null && ctrl.storageUnit2No !== undefined ? ctrl.storageUnit2No > 0 : null);

      // Sync settings from modbus if they differ
      const settingUpdates = {};

      if (ctrl.storageChargeFromGrid !== null && ctrl.storageChargeFromGrid !== undefined) {
        const enabled    = ctrl.storageChargeFromGrid === 1;
        const currentVal = this.getSetting('charge_from_grid');
        if (currentVal === null || currentVal === undefined || enabled !== currentVal)
          settingUpdates.charge_from_grid = enabled;
      }
      const numericSync = [
        ['storageGridChargeCutoffSoc',     'grid_charge_cutoff_soc'],
        ['storageChargingCutoffCapacity',  'charging_cutoff_capacity'],
        ['storageDischargeCutoffCapacity', 'discharge_cutoff_capacity'],
        ['storageMaxChargePower',          'max_charge_power'],
        ['storageMaxDischargePower',       'max_discharge_power'],
        ['storageBackupPowerSoc',          'backup_power_soc'],
        ['storageMaxGridChargePower',      'max_grid_charge_ceiling'],   // rare half
        ['storageCapacityControlSoc',      'capacity_control_soc'],      // rare half
      ];
      // Stored only when the device reports something else than the setting holds — or the
      // setting holds nothing yet. Until 1.2.279 the discharge cutoff and the backup SoC were
      // written on every poll, some 1440 times a day, "so a stored 0 triggers a settings
      // refresh": writing the same 0 again changes nothing about how Homey draws it.
      for (const [key, settingId] of numericSync) {
        const v = ctrl[key];
        if (v !== null && v !== undefined) {
          const current = parseFloat(this.getSetting(settingId));
          if (!Number.isFinite(current) || Math.abs(v - current) > 0.5) {
            settingUpdates[settingId] = v;
          }
        }
      }

      // The same two limits as capabilities, so flows can read them as tokens. Same source
      // as the settings above; the battery's reported maximum (essMax*) is a different
      // number and stays out of here.
      await this._set('measure_power.chargesetting',    ctrl.storageMaxChargePower    ?? null);
      await this._set('measure_power.dischargesetting', ctrl.storageMaxDischargePower ?? null);

      // The backup reserve, likewise (issue #32). It has been read on every poll for a long
      // time but only ever reached a device setting, where no flow can see it — so a flow
      // could set the reserve and never learn that somebody else had changed it.
      //
      // The trigger fires only on a real change, and never on the first poll after a
      // restart: _prevBackupSoc is still null then, and every value would look new.
      const backupSoc = ctrl.storageBackupPowerSoc;
      if (backupSoc !== null && backupSoc !== undefined) {
        await this._set('measure_battery.backup', backupSoc);
        if (this._prevBackupSoc !== null && backupSoc !== this._prevBackupSoc) {
          this.homey.flow.getDeviceTriggerCard('luna2000_backup_soc_changed')
            .trigger(this, { soc: backupSoc })
            .catch((err) => this.log('Flow trigger luna2000_backup_soc_changed failed:', err.message));
        }
        this._prevBackupSoc = backupSoc;
      }

      // Register 47242 (active grid charge power set point) only reflects a meaningful
      // value when charge_from_grid is enabled — skip sync when it is disabled.
      //
      // The two sit in different halves of the split read: the gate at 47087 rides with the
      // battery data every poll, the set point at 47242 comes round every fifth. So neither
      // call has both, and taking the gate from the register alone stopped max_grid_charge_power
      // syncing at all in 1.2.240. It is read from the register when this half carried it,
      // and from the setting otherwise — which the live half wrote at most one poll ago.
      const gridChargeOn = (ctrl.storageChargeFromGrid !== null && ctrl.storageChargeFromGrid !== undefined)
        ? ctrl.storageChargeFromGrid === 1
        : this.getSetting('charge_from_grid') === true;
      if (gridChargeOn && ctrl.storageGridChargePower !== null && ctrl.storageGridChargePower !== undefined) {
        const v       = ctrl.storageGridChargePower;
        const current = parseFloat(this.getSetting('max_grid_charge_power'));
        if (!Number.isFinite(current) || Math.abs(v - current) > 0.5) settingUpdates.max_grid_charge_power = v;
      }
      // Stored under the guard, and every value that moved on the device is logged.
      await applySettingSync(this, settingUpdates);


      // The one setting of type "label" left, at the end of "Change battery mode": whether
      // the device that does price- and forecast-driven charging is installed. Homey renders
      // a label as a disabled box showing its value, so the value is the answer and the
      // advice sits behind the (i). Until 1.2.272 two more rows here showed the working and
      // the remote mode — since 1.2.266 word for word what the dropdowns above them show.
      //
      // Written in a call of its own, with its own catch: a string the store refuses must not
      // take the real settings sync above down with it.
      const infoUpdates = {};
      const infoRow = (settingId, text) => {
        if (text && this.getSetting(settingId) !== text) infoUpdates[settingId] = text;
      };

      // Not a register: whether the device that does price- and forecast-driven charging is
      // even installed. getDriver throws on an app that has never had one, which is an
      // answer ("no"), not an error.
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

      // The "Change battery mode" dropdowns, each only from the half of the split read that
      // carried its register — see lib/mode-settings.js.
      await syncModeSettings(this, MODE_SETTINGS, {
        mode_storage_working: ctrl.storageWorkingMode,
        mode_excess_pv_tou:   ctrl.storageExcessPvEnergyUseInTou,
        mode_remote_dispatch: ctrl.remoteChargeDischargeControlMode,
        mode_capacity_control: ctrl.storageCapacityControlMode,
      });

      // onSettings refuses to write to the inverter until it has seen the registers it
      // would be overwriting. Gated on the working mode rather than on "the call did not
      // throw": a read whose settings span came back empty tells us nothing, and claiming
      // otherwise would let the first settings edit write over values never read.
      if (ctrl.storageWorkingMode !== null && ctrl.storageWorkingMode !== undefined) {
        this._settingsInitialized = true;
      }

    } catch (err) {
      this.log('Control register handling skipped:', err.message);
    } finally {
      this._updatingFromModbus         = false;
      this._updatingSettingFromModbus  = false;
    }
  }

  // "Switch to off-grid operation": 0 into 47604, the only value Huawei documents for it.
  // There is no write for the way back — Huawei names no value for it in this register.
  async _switchToOffgrid() {
    const host = this.getSetting('address');
    const port = parseInt(this.getSetting('port'), 10) || 502;
    const unit = parseIntSafe(this.getSetting('modbus_id'), 1);
    this.log('Write start  [luna2000_switch_to_offgrid] 47604 = 0 (switch from grid-tied to off-grid)');
    this._writeInProgress = true;
    try {
      await writeModbusRegister(host, port, unit, 47604, 0);
    } catch (err) {
      this.error('Write FAILED [luna2000_switch_to_offgrid]:', err.message);
      throw err;
    } finally {
      this._writeInProgress = false;
    }
    this.log('Write OK     [luna2000_switch_to_offgrid]');
    if (this.getSetting('enable_timeline_notifications') !== false) {
      this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${this.homey.__('modbus.battery.offgridSent')}` })
        .catch((err) => this.log('Off-grid notification failed:', err.message));
    }
  }

  // The power a force card may use, clamped to the configured limit — 47075 for charging,
  // 47077 for discharging. Until 1.2.276 the limit was read as `setting || 5000`, and 0 is
  // falsy: a battery whose discharging was blocked at 0 W (issue #31) still got a forced
  // discharge of up to 5 kW. A limit of 0 now refuses the card with the reason; a limit not
  // read yet, right after a start, leaves the ceiling to the battery, which enforces its own.
  _forcePowerW(kind, power) {
    const limit = parseFloat(this.getSetting(kind === 'charge' ? 'max_charge_power' : 'max_discharge_power'));
    if (Number.isFinite(limit) && limit <= 0) {
      throw new Error(this.homey.__(kind === 'charge' ? 'modbus.battery.chargeBlocked' : 'modbus.battery.dischargeBlocked'));
    }
    const asked = Math.max(0, Number(power) || 0);
    return Math.round(Number.isFinite(limit) ? Math.min(asked, limit) : asked);
  }

  // Surfaces an aborted force charge/discharge on the timeline. The flow action is
  // fire-and-forget (it must return before the ~10 s Homey flow timeout while the
  // modbus writes run with retries), so a failed write can never fail the card itself —
  // this notification is the only way the user learns the run was skipped. Since 1.2.302
  // any failed step aborts the run (as in the HA integration), so it names the step.
  _notifyForceAbort(kind, what, err) {
    if (this.getSetting('enable_timeline_notifications') === false) return;
    this.homey.notifications.createNotification({
      excerpt: `${this.getName()}: Force ${kind} NOT started — could not set the ${what}: ${err.message}. Battery left unchanged rather than running on an old value.`,
    }).catch((e) => this.log('Timeline notification failed:', e.message));
  }

}

Object.assign(LUNA2000ModbusDevice.prototype, modbusPolling, enumLabel);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(LUNA2000ModbusDevice);

module.exports = LUNA2000ModbusDevice;

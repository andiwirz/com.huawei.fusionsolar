# Huawei FusionSolar Manager – Homey App

**App ID:** `com.huawei.fusionsolar`
**SDK:** Homey SDK 3
**Minimum firmware:** Homey >= 12.13.0
**Compatible with:** Homey Pro (Early 2019) and newer Homey Pro models running firmware >= 12.13.0 — local platform only, not Homey Cloud

> Firmware >= 12.13.0 is required by the OCPP Smart Charger's standard `target_power` capability. Earlier releases of this app targeted 12.4.5.

---

## Supported Connection Types

This app supports five independent connection methods to a Huawei FusionSolar installation:

| Connection      | Description                                                                        |
|-----------------|------------------------------------------------------------------------------------|
| **Kiosk**       | Reads plant data via the public Kiosk URL (no account required)                   |
| **OpenAPI**     | Connects via the official Northbound API using a FusionSolar account              |
| **Modbus TCP**  | Direct communication with SUN2000, LUNA2000, DTSU666 and SDongle A over the local network |
| **EMMA Modbus** | Direct communication via Huawei's EMMA (Energy Management Assistant, e.g. EMMA-A02) |
| **OCPP 1.6**    | Runs an OCPP 1.6 WebSocket server on Homey so EV chargers can connect directly    |

On top of these, the app includes an **Energy Management System (EMS)** device — a local orchestration layer that steers EV charging, heat pumps and other loads from live solar surplus. See [Energy Management System](#energy-management-system-ems).

---

## Devices

### FusionSolar Plant (Kiosk)

Connection via the public Kiosk URL. No FusionSolar account required.

| Capability       | Description                     |
|------------------|---------------------------------|
| Solar power      | Current generation power (W)    |
| Total yield      | Cumulative total yield (kWh)    |
| Daily yield      | Today's energy yield (kWh)      |
| Monthly yield    | Monthly energy yield (kWh)      |
| Yearly yield     | Annual energy yield (kWh)       |

A reading the kiosk endpoint does not deliver is **never reported as zero**. Its payload is JSON escaped inside more JSON, and a response that fails to unpack used to fall through to a complete set of zeros — nothing failed, the device stayed available, and the tile read `0 W`, indistinguishable from a roof in the dark. A missing figure now keeps its last known value, a response carrying no measurements at all marks the device unavailable with the real reason, and no flow fires on a value that never arrived. This mattered most for the lifetime counter, from which Homey derives the daily yield by difference: writing `0` and then the true reading again booked the whole lifetime output as a single day.

**Beside a SUN2000, exclude the kiosk device from Homey Energy.** A SUN2000 paired by Modbus, through an EMMA or from the cloud already reports the plant's production to Energy; the kiosk device reports the same production again, and Homey counts it twice. Homey's own *Exclude from Energy* setting (device → Settings → Energy) fixes that, but only the owner can set it. So the pairing view warns before the kiosk device is added, and the device carries a warning for as long as a SUN2000 is paired and the device is not excluded. Homey tells the app about the exclusion only when the setting changes, not when the app starts; the device remembers it from then on. A device excluded before the app knew to look needs the setting switched off and on once.

---

### Inverter SUN2000 (OpenAPI)

Connection via the Huawei FusionSolar Northbound API. Provides inverter, grid and PV string data.

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| Power                   | The generation figure Homey Energy reads (W) — see the note below |
| Solar power             | DC input power from PV strings (W) — blank where the inverter does not report it |
| Active power            | AC output power (W)                                               |
| Heat sink temperature   | Internal inverter temperature (°C)                                |
| PV energy today         | Plant PV production today (kWh) — used by the widgets             |
| Total PV energy         | PV generation meter (kWh) — used by Homey Energy; see the note below |
| Total yield             | The inverter's own cumulative AC yield (kWh)                      |
| Daily yield             | The inverter's own AC yield today (kWh)                           |
| PV1 / PV2 voltage       | DC voltage of PV strings (V)                                      |
| PV1 / PV2 current       | DC current of PV strings (A)                                      |
| Grid frequency          | Mains frequency (Hz)                                              |
| Inverter status         | Operating state as text                                           |
| Grid active power       | Current: positive = import, negative = export (W)                 |
| Total grid export       | Cumulative total energy exported to grid (kWh)                    |
| Total grid import       | Cumulative total energy imported from grid (kWh)                  |

> **"Power" and "Solar power" are two capabilities, not one.** `measure_power.mppt` is the DC
> input alone, and it stays empty on an inverter that does not report `mppt_power`.
> `measure_power` is the one Homey Energy and the widgets read, and it falls back to the AC
> output where the DC figure is missing — so a reading never disappears, but on a hybrid
> inverter the fallback can include battery discharge. Most installations show the same number
> twice; the ones that do not are the ones the fallback was written for.

> **What Homey Energy reads as solar.** *Total PV energy* is seeded from the plant's lifetime
> total and from then on advances only with the inverter's own DC counter (`mppt_total_cap`),
> and only while the panels are producing. The plant total itself is not a meter: FusionSolar
> computes it as inverter yield plus battery charge minus battery discharge, so it sinks every
> evening, dips by a whole day at the nightly rollover and is re-settled after midnight —
> sometimes above where it stood. Homey counts every rise as generation and ignores every fall,
> which produced phantom solar before sunrise (issue #34). Expect the daily figure in Homey
> Energy to run a few per cent above FusionSolar's: it is the energy the panels delivered on
> the DC side, before conversion losses. Inverters that do not report the DC counter keep the
> guarded plant total.

> Grid frequency and inverter status are added on the first successful
> poll rather than at pairing, and **PV energy today** appears the first time the plant summary
> carries it. A plant whose API never sends a field does not get a permanently empty row.

> **Production and yield are two different figures on a hybrid system.** The inverter's own
> counters measure its AC output, and the battery sits on the DC bus in front of that — so
> everything charged into the battery never crosses the point they measure. On one reported
> installation, FusionSolar showed 2.03 kWh generated while the inverter's daily yield read
> 1.43 kWh, with most of the PV going into the battery at that moment. The PV figures come
> from the plant summary instead and match what FusionSolar displays; the inverter's own
> counters remain available under their own names.
>
> The two also cover different periods where a FusionSolar plant record was created later
> than the inverter was commissioned. One installation reads 7.67 MWh of plant production
> against 35.1 MWh of inverter lifetime yield — both correct, four years apart.

> Grid values are sourced from the plant's EMMA (type 23070) where one is present, otherwise
> from its Power Sensor (type 47) or Grid Meter (type 17).

---

### Battery LUNA2000 (OpenAPI)

Connection via the Huawei FusionSolar Northbound API.

| Capability               | Description                                          |
|--------------------------|------------------------------------------------------|
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                   |
| Battery charge power     | Current charge power (W)                             |
| Battery discharge power  | Current discharge power (W)                          |
| Max charge power         | Configured maximum (W)                               |
| Max discharge power      | Configured maximum (W)                               |
| Daily charged energy     | Energy charged today (kWh)                           |
| Daily discharged energy  | Energy discharged today (kWh)                        |
| Total charged / discharged | Cumulative lifetime energy (kWh)                   |
| Battery voltage          | DC bus voltage (V)                                   |
| State of health          | SoH in percent (%) — see note                        |
| Battery modules          | Number of modules reported by the plant              |
| Battery capacity         | Nameplate capacity the plant reports (kWh), summed over its batteries — only where reported |
| Battery Unit 1 / 2 installed | Whether each unit is fitted                      |
| Battery status           | Operating state as text (e.g. Running, Standby)      |
| Working mode             | Charge/discharge mode as text (read-only)            |
| Battery state            | Text summary, e.g. "1234 W 🔺 73%" — available in flows |

> **State of health** is read from the per-module list the API returns; the flat
> `battery_soh` field is used only where no module reports and it is above 0 — it reads 0 on plants that publish no health figure, and a
> 0 % row states a scrap battery where none was reported. Where the modules do report, the
> row shows their average; where nothing reports, there is no row at all.

---

### Power Meter (OpenAPI)

Connection via the Huawei FusionSolar Northbound API. Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Phase A/B/C voltage     | Phase voltages (V) — dynamic                              |
| Phase A/B/C current     | Phase currents (A) — dynamic                              |
| Phase A/B/C power       | Phase power (W) — dynamic                                 |
| Grid frequency          | Mains frequency (Hz) — power sensor only                  |
| Meter status            | Normal / Offline, with an optional timeline notification  |
| House consumption today | Plant-wide consumption today (kWh)                        |
| Grid state indicator    | Text summary, e.g. "1319 W Export"                        |

> Reads an EMMA (type 23070) where the plant has one, otherwise a Power Sensor (type 47) or
> Grid Meter (type 17). The three differ in ways that fail silently if merged: EMMA reports
> power in kilowatts and the power sensor in watts, their lifetime counters run the opposite
> way round, and Huawei counts feed-in as positive on the power sensor and grid meter while
> EMMA already matches Homey's direction. Each is read on its own terms. A plant with only a
> Grid Meter (type 17) gets grid power and the state indicator, but no import/export totals and
> no phase values.

---

### iSitePower-M Solar (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Solar subsystem. Registered as a solar panel in the Homey Energy Dashboard.

| Capability    | Description                                      |
|---------------|--------------------------------------------------|
| Solar power   | Current PV output power (W)                      |
| Total yield   | Cumulative PV yield (kWh) — from station KPI     |
| Current       | PV output current (A) — when reported            |

> When the plant delivers nothing for the PV devices, the last power stays on display rather than dropping to 0 W, and the device is marked unavailable.

---

### iSitePower-M Battery (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Battery subsystem. Registered as a home battery in the Homey Energy Dashboard.

| Capability               | Description                                              |
|--------------------------|----------------------------------------------------------|
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                       |
| Charge power             | Current charge power (W)                                 |
| Discharge power          | Current discharge power (W)                              |
| Total charged energy     | Charged energy (kWh), integrated by the app from charge power — the API has no lifetime charge counter |
| Total discharged energy  | Cumulative discharged energy (kWh)                       |
| Battery voltage          | Current battery voltage (V)                              |
| Remaining backup time    | Estimated backup runtime at current load (h)             |
| Total capacity           | Total installed battery capacity (kWh)                   |
| Discharge cycles         | Total number of discharge cycles                         |
| Battery state            | Human-readable state string — available in flows         |
| Battery status           | iSitePower state as text (e.g. Float charging, Standby) — when reported |
| Battery current          | Battery current (A) — when reported                      |

> When the plant delivers nothing for the battery, the last readings stay on display rather than dropping to 0 W, the device is marked unavailable, and the charging-state cards do not fire.

---

### iSitePower-M Grid (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Grid meter. Registered as a cumulative energy meter in the Homey Energy Dashboard. Grid power is read directly from the Mains meter (type 60001) when available, or derived from energy balance as fallback.

| Capability      | Description                                                  |
|-----------------|--------------------------------------------------------------|
| Grid power      | Current import power (W)                                     |
| Grid import     | Cumulative grid import (kWh) — with a Mains meter it follows that meter's increments from where this one stands, so it never jumps to the Mains meter's lifetime total; without one it is integrated by the app |
| AC voltage      | AC voltage (V) — AC output (60010), else power converter (60092), else Mains meter (60001) |
| AC current      | AC current (A) — same order of sources                       |
| Grid frequency  | Frequency (Hz) — same order of sources                       |

---

### iSitePower-M Home (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Home consumption measurement. Registered as a cumulative energy consumer in the Homey Energy Dashboard.

| Capability         | Description                                              |
|--------------------|----------------------------------------------------------|
| Home consumption   | Current home load power (W)                              |
| Total consumption  | Home energy (kWh), integrated by the app from home load power since pairing |

> If load data is temporarily unavailable from the API, the last known power stays on display (no drop to 0 W), but no energy is counted for that time: Homey Energy books the total as real consumption. The same goes for a gap between two readings of more than two and a half poll intervals (at least 15 minutes) — also for the grid import and battery charge totals the app integrates itself.

---

### SDongle A (Modbus)

Direct Modbus TCP connection to the Huawei SDongle A (unit ID 100).

**Exclude it from Homey Energy** (device → Settings → Energy → *Exclude from Energy*). Its power reading is the whole house's consumption, which Homey would otherwise count as one more consumer on top of everything else. The pairing view says so before the device is added, and the device carries a warning until it is excluded. Homey tells the app only when that setting changes, so a SDongle excluded before needs the setting switched off and on once; the device remembers it from then on.

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| House Consumption       | Current house load / consumption power (W)                         |
| Solar Input Power       | Total PV input power (W)                                           |
| Grid Power              | Current: positive = import, negative = export (W)                  |
| Battery Power           | Current: positive = charging, negative = discharging (W)           |
| Total Active Power      | Net system active power (W)                                        |
| Connection Type         | SDongle connection type (N/A, WLAN, 4G, WLAN-FE)                  |
| Software Version        | The dongle's own OS version (register 30050)                       |

---

### Inverter SUN2000 (Modbus)

Direct Modbus TCP connection to the SUN2000 inverter or SDongle.

| Capability                  | Description                                               |
|-----------------------------|-----------------------------------------------------------|
| Solar power                 | DC input power from PV strings (W)                        |
| Active power                | AC output power (W)                                       |
| Heat sink temperature       | Internal inverter temperature (°C)                        |
| Total yield                 | Cumulative total yield (kWh)                              |
| Daily yield                 | Today's energy yield (kWh)                                |
| PVn voltage                 | DC voltage per PV string (V) — one per string, up to 24    |
| PVn current                 | DC current per PV string (A) — one per string, up to 24    |
| Grid frequency              | Mains frequency (Hz)                                      |
| Inverter status             | Operating state as text. "Standby: battery empty" at night once the battery has reached its discharge cutoff. A code Huawei does not document shows its range and number, e.g. "Shutdown (0x030D)" |
| Software version            | Inverter firmware version                                 |
| Active power control mode   | Feed-in limit mode — shown here; changed in the device settings (*Feed-in Power Control*) or by flow cards |
| Optimizers total / online   | Counts from register 37200 — only where optimizers are registered |
| Grid active power           | Current (W) — only when DTSU666 is connected              |
| Total grid import           | Cumulative (kWh) — only when DTSU666 is connected         |
| Total grid export           | Cumulative (kWh) — only when DTSU666 is connected         |

> The last four rows come and go with the hardware: the optimizer counts while register 37200
> reads above zero, the three meter rows while a DTSU666 answers with plausible data. Only an
> inverter that reports no meter or no optimizers removes them; a poll cut short — by a flow
> card writing to the inverter, a settings check or a timeout — keeps the rows and their last
> values (since 1.2.316). PV power that was not read is not reported as 0 W either: the last
> value stays.

---

### Inverter SUN2000 (EMMA Modbus)

Reads inverter data via the EMMA Energy Management Module (unit ID 0). No SDongle or separate meter required.

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Solar power             | PV output power (W)                                       |
| Active power            | Inverter active power (W)                                 |
| Total PV yield          | Cumulative total PV yield (kWh)                           |
| PV yield today          | PV energy yield today (kWh)                               |
| Total yield             | Inverter total yield (kWh)                                |
| Daily yield             | Inverter daily yield (kWh)                                |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |

> This driver reports **no inverter temperature**. It used to, from register 30508 — but in the
> EMMA address space that register is the external meter's A-B line voltage, so a ~400 V reading
> was displayed as "4000 °C". EMMA exposes no inverter temperature at all, so the capability is
> removed from devices that still carry it rather than repointed.

---

### The three SUN2000 drivers side by side

The same inverter can be read three ways, and the three do not expose the same capabilities
under the same names. This matters when moving a device from one driver to another: **flows
reference capability IDs, not titles**, so a flow survives the move only where its ID exists on
both sides.

| Capability ID | Title | Modbus | EMMA Modbus | OpenAPI |
|---|---|:-:|:-:|:-:|
| `measure_power` | Solar Power / Power | yes | yes | yes |
| `measure_power.mppt` | Solar Power | — | — | yes |
| `measure_power.active_power` | Active Power | yes | yes | yes |
| `measure_power.grid_active_power` | Grid Active Power | with DTSU666 | yes | yes |
| `meter_power` | Total Energy | yes | yes | — |
| `meter_power.daily` | Daily Energy | yes | yes | — |
| `meter_power.inv_total` | Total Yield | — | — | yes |
| `meter_power.inv_daily` | Daily Yield | — | — | yes |
| `meter_power.pv_total` | Total PV Energy | — | yes | yes |
| `meter_power.pv_daily` | PV Energy Today | — | yes | on first arrival |
| `meter_power.grid_export` | Grid Export Energy / Grid Export | with DTSU666 | yes | yes |
| `meter_power.grid_import` | Grid Import Energy / Grid Import | with DTSU666 | yes | yes |
| `measure_voltage.pvN` / `measure_current.pvN` | PVn Voltage / Current | up to 24 | — | PV1 and PV2 |
| `measure_temperature.invertor` | Inverter Temperature | yes | removed | yes |
| `measure_frequency` | Grid Frequency | yes | — | on first poll |
| `huawei_status` | Inverter Status | yes | — | on first poll |
| `sun2000_software_version` | Software Version | yes | — | — |
| `activepower_controlmode` | Active Power Control Mode | yes | — | — |
| `optimizer_total_count` / `optimizer_online_count` | Optimizers | with optimizers | — | — |

Three differences are worth knowing before switching:

- **The lifetime counter has a different ID on the cloud driver.** Modbus and EMMA Modbus both
  call it `meter_power`; the OpenAPI driver has no `meter_power` at all and splits the same
  idea into `meter_power.inv_total` (the inverter's own AC yield) and `meter_power.pv_total`
  (the plant's PV production). They are not interchangeable — see the note under the OpenAPI
  driver on why production and yield differ on a hybrid system.
- **Homey Energy reads a different capability on each driver**: `meter_power` on Modbus,
  `meter_power.pv_total` on EMMA Modbus and on OpenAPI. Pairing the same physical inverter on
  two of these drivers at once therefore counts its production twice.
- **No driver changes the inverter from its tile.** `activepower_controlmode` on the Modbus
  driver is shown, not set, because a scroll gesture on the old picker could switch a feed-in
  limit off (issue #35). The mode is changed from a dropdown under *Feed-in Power Control* in
  the device settings, written only on Save (since 1.2.266), or through flow cards. The EMMA
  and cloud drivers have no inverter controls at all.

---

### Battery LUNA2000 (Modbus)

Direct Modbus TCP connection to the LUNA2000 battery via SUN2000 / SDongle. If no LUNA2000 is detected on the RS485 bus, the device shows a targeted error distinguishing between "SUN2000 reachable but no LUNA2000 on RS485" (check the RS485 cable) and a general connection failure.

#### Readable Values

| Capability                  | Description                                              |
|-----------------------------|----------------------------------------------------------|
| Battery State Indicator     | Human-readable battery state: `850 W 🔺 67%` charging / `1200 W 🔻 45%` discharging / `(67%)` at idle / `Full (100%)` / `Empty (<5%)` — hidden in UI, available in flows |
| Battery power               | Current: positive = charging, negative = discharging (W) |
| State of charge             | SoC in percent (%)                                       |
| Total charged energy        | Cumulative since commissioning (kWh)                     |
| Total discharged energy     | Cumulative since commissioning (kWh)                     |
| Battery charge power        | Current charge power (W)                                 |
| Battery discharge power     | Current discharge power (W)                              |
| Max charge power            | Configured maximum (W)                                   |
| Max discharge power         | Configured maximum (W)                                   |
| Daily charged energy        | Energy charged today (kWh)                               |
| Daily discharged energy     | Energy discharged today (kWh)                            |
| Battery status              | Operating state as text (e.g. Running, Standby)          |
| Installed battery modules   | Number of detected battery packs (read from registers 47750–47755) — hidden in UI, available in flows |
| Battery capacity            | Nameplate capacity of the whole stack (kWh, register 37758) — shown once the battery reports it |
| Backup power SoC            | Reserve for grid outages (%, register 47102) — hidden in UI, available in flows; set under *State of charge limits* |
| Software version (unit 1/2) | Firmware of each battery unit; unit 2 only when installed                |
| Battery unit 1/2 installed  | Whether each unit is present — hidden in UI, available in flows          |

#### Battery Modes

The device tile shows the working mode, excess PV and remote mode but does not change them: until
1.2.266 they were scroll wheels that wrote whatever they landed on (issue #35). Force
charge/discharge is not on the tile; its value is available in flows. The three are changed in the device settings
under **Change battery mode**, from dropdowns that list every value and write only on Save. Force
charge/discharge has no dropdown — it is a command, not a setting, and stays with the flow cards.

| Mode                          | Options                                                                                   | Changed from                         |
|-------------------------------|-------------------------------------------------------------------------------------------|--------------------------------------|
| Storage working mode          | Adaptive · Fixed charge/discharge · Maximise self-consumption · TOU (LG) · Full feed-in · TOU (LUNA2000) · Third party | Settings dropdown · flow card |
| Force charge/discharge        | Stop · Charge · Discharge                                                                 | Flow cards                           |
| Excess PV energy (TOU)        | Feed into grid · Charge battery                                                           | Settings dropdown · flow card        |
| Remote charge/discharge mode  | Local control · Max self-consumption · Full feed-in · TOU · AI · Third party             | Settings dropdown · flow card        |

A dropdown can be saved once the app has read the battery's current value from it — until then
it shows its default, and a save is refused with a message rather than writing that default into
the battery.

The log notes each mode once after every app start (`Mode dropdown filled`), and again whenever
the battery reports a different one (`Mode dropdown follows the device`) — changed in the
FusionSolar app, by a flow card, or by anything else talking to it.

**Time of Use windows (since 1.2.307).** The charge and discharge windows *Time of Use (LUNA2000)*
follows are in the same group, as text in the format of the Home Assistant integration
([wiki](https://github.com/wlcrs/huawei_solar/wiki/Time-of-Use-control)) — one line per window,
`start-end/days/+ or -`, days 1 = Monday to 7 = Sunday, `+` charge (from the grid only with
*Charge battery from grid* on), `-` discharge. The windows apply only in the working mode
*Time of Use (LUNA2000)*:

```
00:00-06:00/12345/+
17:00-23:59/1234567/-
```

Register 47255, 43 words, written as one block on Save; a save replaces all windows. At most 14,
no two overlapping on a day they share, each within one day (a window over midnight is two lines,
ending 23:59 — HA's users report an error for an end of 00:00). A line that does not fit refuses
the save and names the line. The field shows what the inverter holds, read every fifth poll, so a
change made in the FusionSolar app appears there too; like the dropdowns, it cannot be saved
before it was read once. With no windows at all the battery charges from surplus solar only and
does not discharge. The EMMA battery keeps its windows in the EMMA (40004) and has no such field
yet.

Since 1.3.15 the card *Set Time of Use windows* sets the same windows from a flow, for a script
that plans them (Homey does not let a script change a device setting — it answers "Missing scopes").
The card's text is one line, so `;` (or `,`) separates the windows: `00:00-06:00/12345/+; 17:00-23:59/12345/-`.
It is checked as the field is, and an error names the window by its place on the card. Unlike a save
of the field the card waits for the write, so a mistake or a refused write fails the flow and the
battery keeps its windows. Windows the battery already holds are not written again; an empty text
clears them, as an empty field does.

---

### Battery LUNA2000 (EMMA Modbus)

Reads battery data via the EMMA Energy Management Module (unit ID 0).

#### Readable Values

| Capability               | Description                                          |
|--------------------------|------------------------------------------------------|
| Battery State Indicator  | Human-readable battery state: `850 W 🔺 67%` charging / `1200 W 🔻 45%` discharging / `(67%)` at idle / `Full (100%)` / `Empty (<5%)` — hidden in UI, available in flows |
| Battery power            | Current: positive = charging, negative = discharging (W) |
| Battery charge power     | Current charge power (W)                             |
| Battery discharge power  | Current discharge power (W)                          |
| State of charge          | SoC in percent (%)                                   |
| Backup SoC               | Reserved emergency SoC (%)                           |
| Chargeable capacity      | Currently available charge capacity (kWh)            |
| Dischargeable capacity   | Currently available discharge capacity (kWh)         |
| Total charged energy     | Cumulative since commissioning (kWh)                 |
| Total discharged energy  | Cumulative since commissioning (kWh)                 |
| Daily charged energy     | Energy charged today (kWh)                           |
| Daily discharged energy  | Energy discharged today (kWh)                        |

#### Battery Modes

Shown on the device tile, changed in the device settings under **Change battery mode** (written
only on Save, since 1.2.266) or through flow cards — same reason as on the LUNA2000 Modbus driver.

| Mode                        | Options                                                                     |
|-----------------------------|-----------------------------------------------------------------------------|
| Storage working mode        | Self-consumption · Full feed-in · TOU · Third party                         |
| Excess PV energy (TOU)      | Feed into grid · Charge battery                                             |

A dropdown can be saved once the app has read the battery's current value from it — until then
it shows its default, and a save is refused with a message rather than writing that default into
the battery.

The log notes each mode once after every app start (`Mode dropdown filled`), and again whenever
the battery reports a different one (`Mode dropdown follows the device`) — changed in the
FusionSolar app, by a flow card, or by anything else talking to it.

#### Settings

| Setting                        | Description                                      |
|--------------------------------|--------------------------------------------------|
| Max grid charging power (kW)   | Writes register 40002 (0–50 kW, EMMA R/W)        |

---

### Power Meter (Modbus)

Direct Modbus TCP connection to the DTSU666 smart meter via SUN2000 / SDongle. Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid State Indicator    | Human-readable grid state: `1234 W Import` / `1234 W Export` / `0 W` — hidden in UI, available in flows |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Phase A/B/C voltage     | Phase voltages (V)                                        |
| Phase A/B/C current     | Phase currents (A)                                        |
| Phase A/B/C power       | Phase power (W)                                           |
| Meter status            | `Normal` / `Offline`; a change fires *Meter status changed* and posts to the timeline (setting *Timeline notifications*) |

---

### Power Meter (EMMA Modbus)

Reads grid data via the EMMA Energy Management Module (unit ID 0). Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid State Indicator    | Human-readable grid state: `1234 W Import` / `1234 W Export` / `0 W` — hidden in UI, available in flows |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Grid import today       | Energy imported from grid today (kWh)                     |
| Grid export today       | Energy exported to grid today (kWh)                       |
| House consumption       | Current house load / consumption power (W)                |
| House consumption today | Total consumption today (kWh)                             |
| Phase A/B/C voltage     | Phase voltages (V)                                        |
| Phase A/B/C current     | Phase currents (A)                                        |
| Phase A/B/C power       | Phase power (W)                                           |

---

### Smart Charger (EMMA Modbus)

Reads EV charger data via the EMMA (the EMMA's IP address, and the charger's own unit ID behind
it — 3 and 24 have been seen; the EMMA's own unit answers with the EMMA's name and is turned away).
Read-only — charging is controlled with the Smart Charger (OCPP) device.

| Capability           | Description                              |
|----------------------|------------------------------------------|
| Charging             | Read-only: on while charging             |
| Charging state       | `plugged_in_charging` from the energy counter's first rise until it has stood still for six minutes, or twice its last step-to-step span if that is longer; otherwise `plugged_out`, and at once when every phase reads 0 V. The voltages alone do not count: some chargers report their supply voltage with no car (until 1.3.8 any phase above 10 V did). A car that is plugged in but not drawing current reads as unplugged. If the counter cannot be read, the last state stands for up to three polls |
| Charging power       | Estimated from the energy counter, from one step of it to a later one at least two minutes apart (no power register); 0 W when not charging (W) |
| Rated power          | Maximum charging power of the station (kW)|
| Model name           | Charger product name                     |
| Phase A/B/C voltage  | Current phase voltages (V)               |
| Temperature          | Internal charger temperature (°C)        |
| Total energy charged | Cumulative since commissioning (kWh)     |

---

### Smart Charger (OCPP)

Runs an OCPP 1.6 JSON WebSocket server (port 8887 unless changed) so compatible EV chargers (Huawei SCharger and others) can connect directly to Homey without a cloud intermediary. An Easee has a device of its own, [Easee Charger (OCPP)](#easee-charger-ocpp), on the same server. Since 1.3.2 a charger gets one command at a time and its answer is awaited before the next, as OCPP-J requires; a charger connecting with a Station ID that no device has is named in the app log, a device waiting for another Station ID shows on its *Last OCPP message* tile which one connected, and correcting the Station ID takes effect without the charger reconnecting. One Homey device is created per charger (Station ID). Chargers set to different ports each get a server of their own, so changing or saving one never cuts the other off (since 1.2.323).

#### Readable Capabilities

| Capability              | Description                                                                      |
|-------------------------|----------------------------------------------------------------------------------|
| Charging (on/off)       | Native EV `evcharger_charging` control — on = actively charging (generates the standard "Start charging" / "Is charging" flow cards) |
| Target Charging Power   | Native EV `target_power` (W) — Homey/Energy set-point, converted to a current for the configured number of phases; acted on only while Homey is in control (`target_power_mode`). The slider steps by 230 W × phases and skips everything below 6 A per phase (1380 W single-phase, 4140 W three-phase); 0 W stops charging |
| Charging power          | Live AC charging power (W)                                                       |
| Target current (A)      | Active charging current limit (fine-grained amp control, kept in sync with Target Charging Power) |
| Charging energy         | Cumulative total energy (kWh)                                                    |
| Charging state          | Homey EV state: `plugged_out` / `plugged_in` (also while the charger reports Finishing — the cable is still in) / `plugged_in_paused` (charger reports SuspendedEV/SuspendedEVSE) / `plugged_in_charging`; left unchanged while the charger is offline |
| Session status          | Not connected · Connected · Smart charging (car in, auto-start off) · Charging · Finishing (under 100 W for 3 min) · Paused · Fully charged (the charger ended the session after the car had stopped drawing: SuspendedEV, or 3 min under 100 W) · Offline · Error — used by the *Session status is* condition |
| Session energy          | Energy of the current session (kWh), across pauses; refreshed every minute, 0 after unplug |
| Session duration        | Duration of the current session (e.g. "1h 12m"); "—" after unplug              |
| Charging profile        | Active limit, e.g. "11.0 kW / 16A / 3P"                                          |
| Status summary          | One line for the device card, e.g. "Charging · 7.4 kW", "Paused · 3.20 kWh", "Ready to start", "Fully Charged" |
| Current total           | Sum of the phase currents (A) from MeterValues                                   |
| Voltage (avg)           | Average of the phase voltages (V) from MeterValues                               |
| Phase currents L1/L2/L3 | Per-phase current (A) from MeterValues                                           |
| Phase voltages L1/L2/L3 | Per-phase voltage (V) from MeterValues                                           |
| Temperature             | Charger internal temperature (°C)                                                |
| Vehicle SoC             | Vehicle battery state of charge (%) — if charger supports it                    |
| OCPP server status      | Starting · Waiting for charger · Charger connected · Error                        |
| Last OCPP message       | The last event received from the charger, e.g. "Status: Charging", "MeterValues received", "Boot: <model>" |

#### Button Actions (device card)

| Button           | Description                                                           |
|------------------|-----------------------------------------------------------------------|
| Pause charging   | Sends RemoteStop and stores session state for resume                  |
| Resume charging  | Sends RemoteStart and restores the previous charging limit            |
| Instant Charging | Charges at 16 A: resumes a paused session, raises a running one or starts one; refused when the charger is offline or no car is connected. A one-shot command: the switch goes back off by itself, and switching it off does nothing (since 1.2.325). Also a quick action and the flow card *Charge now at 16A* |

*Release charger* (ChangeAvailability → Operative, unlocks a charger stuck in Unavailable) is under
the device's **Maintenance** actions, not on the card, and is also a flow card.

#### Setup (Huawei SCharger)

OCPP needs charger firmware **V100R023C10SPC220** or newer. Configure the SCharger as installer in
the FusionSolar app: *Services* → *Commission Device*, connect to the charger's WLAN, then
*Settings* → *Third-party management system* → *OCPP Settings*:

| SCharger field      | Value                                                                                      |
|---------------------|--------------------------------------------------------------------------------------------|
| Domain Name         | Homey's local IP address                                                                   |
| Path                | Your chosen Station ID (e.g. `scharger-home` or the serial number from the charger label) |
| Port                | `8887`                                                                                     |
| Mode                | Insecure transmission with basic authentication                                            |
| Username / Password | Optional — enter the same values in Homey settings if used                                 |

> The **Path** field in the SCharger is empty by default. You choose any unique identifier and enter the exact same value as **Station ID** in Homey. The value is case-sensitive.

> **OCPP and the EMMA.** One owner reports that once OCPP is configured on the charger, the EMMA's
> surplus charging stops working, and only a factory reset of the charger brings it back (the
> firmware cannot be downgraded either). With OCPP, charging is controlled from Homey — the
> Energy Management System can take over the surplus charging. To only *read* the charger in
> Homey without changing it, use the Smart Charger (EMMA Modbus) device instead.

#### Device Settings

| Group | Setting | Default | Description |
|-------|---------|---------|-------------|
| Connection | Station ID | – | Unique identifier matching the Path field on the charger. Empty accepts the first charger that connects and keeps it for as long as it stays connected; a second unknown charger is answered but reaches no device. Each Station ID — the empty one included — belongs to one device per port: a second device asking for it is shown as unavailable with the name of the device that holds it, and takes over when that one is deleted or changed |
| Connection | OCPP port | 8887 | WebSocket server port. Each port has its own server; changing it moves only this device |
| Connection | Username / Password | – | Optional Basic Auth credentials (must match charger settings) |
| Charger | Charger vendor | Huawei | Not read from the charger; edit freely |
| Charger | Charger model | Other / not sure | Hardware variant; the 7KS rejects three phases |
| Charger | Number of phases | 3 (Tri-Phase) | How the charger is wired; used for SetChargingProfile. Never auto-detected |
| Charging | Auto-start charging | on | Automatically starts charging when a car connects |
| Charging | Default charging current | 10A | Current used by auto-start and by "Start charging" without an ampere value; a change during a session applies from the next start |
| Display | Show vehicle battery level | on | Off removes the tile for cars that do not report their state of charge |
| Notifications | Timeline notifications | on | Posts car connected (auto-start off), charging started/paused/resumed/stopped, limit changes, a car that draws no power, car disconnected, and charger offline/back online. Off also silences the offline warning |

---

### Easee Charger (OCPP)

> **Not offered for pairing**: the driver is marked deprecated in the manifest, so *Add device* does not list it, until it has been tested on a charger. A device already paired keeps working.

A copy of the Smart Charger (OCPP) device for an Easee charger on Easee's own OCPP 1.6J, which Easee calls *Direct OCPP* and still marks as beta (firmware 344 or later). The charger talks to Homey directly, without the Easee cloud in between (since 1.3.2). It shares the OCPP server and the flow cards with the Smart Charger (OCPP) device, and shows the same readings, buttons and session history — without *Charging profile* and the maintenance action *Release charger* (the app makes the charger operative on every connection, and the profile line repeated the target power and current). What differs:

- **Limits in amperes.** An Easee accepts no watt-based charging schedules, so every limit goes out in A, and 0 A as 0 A.
- **Readings.** When the charger connects, it is told to sample energy, power, current, voltage and temperature every 30 s, the Easee's minimum (its own default is not to sample at all, and it refuses 10 s). A list or a value it refuses is followed by the next — energy, power and current alone, 60 s — and one it refuses throughout is read back into the app log. It is also told to send a heartbeat every 60 s instead of once a day, so an idle charger is not taken for offline.
- **The default profile on stack level 10**, the Easee's highest, so no profile already on the charger outranks it.
- **Firmware.** Connecting needs firmware 344; setting the charging current over OCPP may need a newer one (evcc reports testing with beta firmware 9012). The app log names the charger's firmware at every boot (`[OcppServer] <serial>: Easee …, firmware …`), and the *Offered current* tile shows whether it follows: see below.
- **Pause at 0 A.** A pause — by hand, by a flow, or an EMS stop sending 0 A — holds the transaction at 0 A, and a resume raises the limit again; the car stays in one session. The Smart Charger (OCPP) ends the transaction with RemoteStop instead, which on an Easee also switches free charging off. As evcc pauses an OCPP charger. A new current while paused waits for the resume.
- **Only the wired phase count.** An Easee is not known to switch phases over OCPP: evcc offers no switching for it, and Easee documents none. If it ignored the count, "16 A on one phase" would charge 16 A on three — 11 kW instead of 3.7 kW. A limit or start with another phase count than *Number of phases* is refused with that reason. In the Energy Management, leave phase switching off for this charger.
- **Offered current**: what the charger offers the car (`Current.Offered`), on a tile of its own. If it offers more than was set for two readings in a row, the app log says the charger does not follow the limit and the *Last OCPP message* tile reads *Offers 16 A, set 8 A*; if less, a limit of its own (circuit, Easee app) is lower.
- **Power per phase**: the total power is shown, or the phases summed when only those arrive; the same for the energy register.
- **After configuring**, the charger is made operative and asked for its status and readings at once, so the device is current after an app restart without waiting for the next change.
- **Every limit as the default profile**, also during a session, as evcc does — never a profile that names a transaction. A session the charger no longer has, because it reports *Preparing*, *Finishing* or *Available* while the app still holds one (say, after an app update), is closed after 30 s. A limit the charger refuses fails the flow card or the slider instead of being reported as set. Each MeterValues message is logged in one line, value by value.
- **A charger that offers less than it was given** — *Offers 0 A, set 16 A* on the *Last OCPP message* tile — is asked for its own schedule (GetCompositeSchedule), and the app log says where the limit comes from: the schedule at 16 A means from outside OCPP (the Easee app or cloud — a pause or a dynamic current set there —, a charging schedule, the circuit), at 0 A from OCPP. With the Easee also in the Easee app or another integration, a pause made there holds the charger at 0 A whatever OCPP sets.
- **Flash wear** (since 1.3.3). An Easee keeps charging profiles in flash: 100,000 writes in its life, and Easee advises at most 25 a day — beyond that the warranty is at stake (Easee, *Smart Charging & Profiles*). A profile the charger already holds is therefore not written again (remembered per connection), every write is counted in the app log against the 25 (`charging profile 3 of 25 today`), and with auto-start off the 0 A is not refreshed every five minutes. Don't let the Energy Management steer an Easee over OCPP yet: every step of the surplus control would be a write.
- **Easee's own keys** (since 1.3.3) are read out at every connection and logged one by one: `LockConnectorPhaseMode` (one phase or three), `DynamicChargerCurrent` and `DynamicCircuitCurrent` (Easee's real-time limits — the lowest of all limits applies, so 0 there holds the charger at 0 A), `FreeCharging` and `FreeChargingIdTag`. Easee documents them for its cloud OCPP only; the log says which the charger knows (`… keeps DynamicChargerCurrent = 0` or `… does not know …`).
- **No vehicle SoC tile**, since an Easee does not report the car's state of charge, and **no charger model setting**.
- **Target power as Homey's EV charger page processes it:** rounded down to whole amps (5000 W single-phase charges at 4830 W, so a surplus is never overshot), and idle below 6 A on every phase. The power range is written to Homey only when the phase setting changes it.

#### Setup (Easee)

Easee's own OCPP needs firmware 344 or later and the charger on WiFi. It is switched on in the **Easee Installer app**:

1. Open the Easee Installer app and sign in.
2. *Update existing site* → choose the site.
3. *Circuits* → choose the charger, then choose it once more.
4. *Settings* → *OCPP* → *Server*.
5. Enter `ws://<Homey-IP>:8887` as the OCPP URL — the URL only, nothing after the port. The app adds the Station ID itself: the charger's serial number.

In Homey, add an **Easee Charger (OCPP)** device with the charger's serial number as Station ID, or leave the Station ID empty: the device then takes the first charger that connects, and the app log names it (`Client connected: …`). A device whose Station ID does not match says on its tile which ID connected instead, and correcting it takes effect without the charger reconnecting. With a password for OCPP at Easee (`basicAuthPassword`), enter it as the password: the user name is the Station ID, and the pairing fills it in when left empty.

**Without the Installer app**, Easee's commissioning API does the same (Easee's guide: developer.easee.com → *Direct OCPP (Home)* → *Commissioning for users*). Both calls need the bearer token of your Easee account:

1. Store the connection for the charger's serial number:
   `POST https://api.easee.com/local-ocpp/v1/connection-details/{serial}`
   ```json
   {
     "connectivityMode": "DualProtocol",
     "websocketConnectionArgs": { "url": "ws://<Homey-IP>:8887" }
   }
   ```
   Optional: `chargePointId` (without it the charger connects as its serial number) and `basicAuthPassword`.
2. Apply it with the `version` from the answer:
   `POST https://api.easee.com/local-ocpp/v1/connections/chargers/{serial}` with `{ "version": "…" }`

Without a `chargePointId` the charger connects as its serial number. To switch OCPP off again through the API, store the connection details with `"connectivityMode": "OcppOff"` and apply them, or pair the charger with another operator in the Easee app.

#### Device Settings

As for the Smart Charger (OCPP), without *Charger model* and *Show vehicle battery level*; *Charger vendor* defaults to Easee.

---

### Energy Management System (EMS)

A local orchestration device (Homey class `other`) that decides, on a configurable tick (15 s by default), how to use solar surplus. It reads your PV, house, grid and battery figures from the Homey devices you pick — typically the paired FusionSolar devices, but any Homey device with the matching reading can be chosen — and drives loads — EV chargers, heat pump, boiler, pool pump, dehumidifier, air conditioner — plus battery and inverter export limits, prioritising free solar energy. No cloud, no external service; all logic runs on Homey.

**Control model:** the EMS does not write to other devices directly. Instead it **fires flow trigger cards** (e.g. *Set charger current*, *Start heat pump*) that you link to the corresponding device action cards in your own flows. This keeps it compatible with any charger/heat-pump brand, not just Huawei.

**A charger of another app** needs a *charging state* that says whether a car is plugged in. The settings take `evcharger_charging_state` where the app has it, otherwise a value named after the plug, cable or connection — the Keba app's `plug_status`, for example — and `onoff` only when there is nothing else, since on a wallbox it usually says whether the charger is enabled. Read as the state, `onoff` breaks the stop: a flow that switches the charger off at 0 A makes the EMS see an unplugged car, and it never starts the charger again. Until 1.3.10 only `onoff` and values with *charging* in their name could be chosen. A charging state saved earlier stays as it is.

#### Capabilities

| Capability            | Description                                                                 |
|-----------------------|-----------------------------------------------------------------------------|
| Enabled (on/off)      | Master switch for the whole EMS                                              |
| Off-peak charging     | Switches the off-peak window on for chargers left in *Solar only* mode; chargers set to *Solar & off-peak window* use the window regardless |
| Charge now            | Instant charging at full power. A deliberate toggle: nothing clears it but unplugging the car — the charge target does not apply, since the point of the mode is "full power until *I* say otherwise". Once the car reaches its target it stops drawing on its own, and the status says so (`Tesla voll (82% ≥ 80%) — wartet auf Abstecken · 16A/3ph`) rather than implying the granted amps are flowing |
| EMS mode              | Current decision (see modes below)                                          |
| Status text           | Human-readable summary of the active decision (e.g. `16A × 1 Lader · Bat 82%`) |
| Solar surplus (W)     | The meter reading — what is actually flowing to the grid                    |
| Released surplus (W)  | What the EMS grants the devices: the meter reading **plus** the share the SoC ramp lends out of the battery's charging. The gap between the two lines is exactly that share, and it widens as the battery fills — so Insights shows over the day why a device was allowed to run, which the meter alone can never explain (the lent power never passes it). Identical to Solar surplus when no ramp is configured; `0` while the EMS is switched off or has no grid reading (disabled, no API key, grid meter unreadable) |
| PV / House / Grid / Battery power (W) | Live snapshot of the inputs driving the decision            |
| Electricity price     | Current tariff (fixed, low/high, time zones, variable flow, or day-ahead forecast) |

#### EMS Modes

`idle` · `disabled` · `not_configured` · `error` · `holding` · `battery_priority` · `solar_ev` · `offpeak_ev` · `lowtariff_ev` (dual low/high tariff) · `price_ev` (price-optimised) · `instant_ev` · `solar_hp` (heat pump) · `solar_boiler` · `solar_pool` · `solar_dehumidifier` · `solar_aircon` (air conditioner) · `solar_multi` (several device types at once)

#### Controlled loads

| Load               | Behaviour                                                                                     |
|--------------------|-----------------------------------------------------------------------------------------------|
| EV chargers        | Solar-first current stepping (1/3-phase, per-charger min/max), off-peak fallback, per-car target SoC + car↔charger assignment |
| Heat pump / boiler / pool / dehumidifier / air conditioner | On/off from surplus, with per-device start threshold (default 2000 W), start sustain (60 s), reaction grace (120 s), stop grace (60 s), optional max-run, restart cooldown (5 min) and min. power while running, plus a fixed 5-minute minimum run after every start |
| Battery            | One hard-stop SoC, plus a surplus **share ramp** — see below                                  |
| Inverter export    | Optional export-limit coordinator: fires on/off triggers for every configured inverter when the battery reaches a trigger SoC (default 95 %, released below 90 %), when the price falls below a threshold (default 0, i.e. negative), or permanently (*zero export*). The limit stays on for at least 5 min |

**Device priority** (*Controlled devices → Device Priority*): the order in which individual devices — each charger, heat pump, boiler, … — get first claim on the surplus and on the ramp's share. Drag to reorder; unlisted devices go last.

#### How the battery and the loads share the sun

Older releases had three SoC zones (reserve / normal / an "orange" flat watt budget). That is gone. There is now **one threshold and one ramp**, configured under *Home Batteries*:

- **Below the lower SoC point** nothing runs from the surplus. Every surplus-driven load is off — heat pump, boiler, pool, dehumidifier, air conditioner, and solar / off-peak / price / low-tariff charging — and the battery takes the whole production. Instant charging and chargers in *Always charge* mode are the exception: they charge regardless of the battery, capped only by the whole-house grid import limit. This point *is* the hard stop — "0 % share at the lower point" therefore means what it reads like. A charger that keeps drawing there — a stop that did not land, or a car started in the charger's own app — gets the stop again on every tick, and the history says so once the stops plainly do not reach it (since 1.2.308; before, it was stopped once).
- **Between the two points** the devices' share of production rises linearly with SoC: the fuller the battery, the more of the sun the devices may claim, and the less goes into charging.
- **At the upper point** the battery stops having priority.

The ramp is opt-in: with both SoC points at 0 it is off, and the hard stop is then a single SoC set via *Stop below* in the **EMS Battery Usage** widget (80 % if never set).

**After a dip, a running charger steps up again as soon as the surplus has held for its adjustment interval** (*Adjustment interval ↑*, 30 s by default; since 1.3.1). Until then every step down also locked stepping up for 5 minutes, a second, longer copy of that interval that could not be set, and on a house without a battery or with a full one those were 5 minutes of export after every dip. What keeps a running charger from flapping is the interval, 250 W of headroom before each step up, and no step down while at least 200 W is still exported. A start after a stop still waits 5 minutes, and switching up to three phases 10 minutes.

**Chargers are steered by what they measure** (since 1.2.308). A charger that ignores its start — drawing under 500 W although the EMS started it — is started once more after 90 s and stopped after 5 minutes, then left alone for 5, 10, 20, up to 30 minutes before the next try from surplus; a car that is full or at its own limit looks the same and is handled the same way. Until 1.2.308 the current the EMS had commanded counted as drawn, so such a charger kept its share of the surplus indefinitely. A charger switched out of EMS control (widget or settings) is left alone entirely: its draw is no longer counted as surplus the EMS could hand out, and the current last commanded to it is forgotten.

**A full battery lets the charger take the next step** (since 1.3.1). In solar mode a charger takes the highest current that fits the surplus, and once running it keeps 250 W free before it steps up. While the home battery charges, it absorbs that remainder. Once the battery is full, the remainder goes to the grid: up to 940 W at three phases.

- **The level** is set with the battery, under *Home Batteries → surplus split*: *From charge level [97] % the EV charger may charge one step higher* (one value for all chargers, 0 = off). The line only appears once an EV charger is configured. From that level the charger may take the next step up even when the surplus falls slightly short, and the full battery supplies the rest. That is always less than one step: 230 W on one phase, 690 W on three. The 250 W reserve falls away too. The status line then begins with *Akku voll*.
- **4 points lower** (93 % by default), the charger takes the step that fits the surplus again, and the battery refills.
- **A charger with phase switching** moves both phase edges one three-phase step lower while the battery is full: three phases from 4140 W of surplus instead of 4830 W, and back to one phase only below 3450 W instead of 4140 W. The 690 W between the two edges stays, so it does not flap more than before. On a surplus between 3.7 and 4.8 kW it used to switch six times an hour and export the rest at 16 A on one phase; it now stays at three phases.
- **The step is measured against the real surplus**, which is the budget less what the battery is discharging. So the charger cannot climb step by step on the battery: with the battery covering the gap, the meter reads zero, and a budget taken from the meter alone would always look like room for one more step.
- **When the rule ends**, a running charger is measured the same way, rounded down, until the battery no longer pays for its step, for at most 15 minutes. Otherwise the step would stay: the plain rule cannot see a battery that covers it.
- **Limits:** the rule never applies while power is drawn from the grid, and it needs a battery power reading. Setting the level to 0 switches it off.

Two guards sit under the ramp, both from field measurements:

- **The share can never exceed what the battery is actually absorbing.** The budget's whole justification is "what a device may claim is what the battery would otherwise have taken" — so while the battery *discharges* it lends nothing. Without this, a charger climbed 1.6 → 6.9 kW in eleven minutes financed entirely by the battery, invisible to every meter-based guard because the inverter holds the grid near zero during discharge. Installations without a battery power sensor keep the old behaviour: capping on a guess would be worse than not capping.
- **A hard-stop overflow exception** lets a load run below the stop threshold when the battery is charging *and* there is more export than it can absorb — with a reserve held back, so a start cannot revoke its own permission on the next tick.

The two SoC points also decide when the EMS announces *battery low* / *battery full*: those are the moments the chart already shows. Without a ramp these stay at 80 % / 95 %, and the Home Batteries section names the thresholds in force.

#### Flow cards

Every EMS trigger, condition and action — with its tokens and what it does — is listed under
[Flow Cards](#flow-cards), device *Energy Management System*.

#### Solar forecast (Solcast, optional)

An optional **Solcast** PV forecast feed. Enter a free [Solcast Hobbyist](https://toolkit.solcast.com.au) rooftop **Resource ID** and **API key** under *App Settings → Energy Management → Data sources → Solar Forecast*. The EMS fetches the rooftop-site forecast (30-minute slots, up to 7 days) and caches it. **Multiple sites** are supported (e.g. a north- and south-facing roof) — enter one Resource ID per line and their forecasts are summed per slot. To respect the free tier's ~10 calls/day limit, it refreshes **at most every 3 hours** (the interval scales with the number of sites, since each site is one API call) and persists the last fetch across restarts so app reloads never exhaust the daily quota. A **correction factor** (default 1, range 0.3–1.5, since 1.3.14) multiplies the whole forecast — its P10/P90 band included — for a plant where Solcast is consistently too high or too low: 0.8 if it predicts 25 % more than the plant yields. Every reader sees the corrected figures: the capabilities and flow cards below, the start gate, the solar gate of price charging, the EV deadline planning and the forecast chart and widget. The forecast is stored as Solcast sent it, so a new factor applies as soon as the settings are saved, not at the next fetch. A flow can set it too (**Set solar forecast correction factor**), e.g. a different factor for summer and winter; the value is saved in the settings like a typed one. When configured, the EMS device also exposes three forecast **capabilities** (device card / flows / Insights): *Solar forecast today* and *Solar forecast tomorrow* (kWh) and *Solar forecast (now)* (kW) — the latter is handy for comparing the forecast against actual production. They are added only while Solcast is configured and removed when it is disabled. Expected PV (remaining today / next 6 h / forecast peak) is also shown in the EMS Diagnostics panel and available in flows: a **Solar forecast updated** trigger (tokens: remaining today / next 6 h / peak) and **Expected solar today / in the next N hours / until a cutoff time is more/less than X kWh** conditions (the cutoff-time variant is anchored to a wall-clock deadline). **Solar-forecast start gate** (under *Data sources → Home Batteries*): on a poor-forecast day the EMS can hold off *starting* loads to protect the home battery for the evening — either a manual kWh threshold or an Adaptive mode that blocks starts when the remaining forecast can't refill the battery to full (uses each battery's capacity — read from the battery when its capacity capability is selected, otherwise the typed value — summed across multiple batteries, + current SOC). It covers **solar EV charging as well as** heat pump / boiler / pool / dehumidifier / air conditioner. Running devices and charges finish normally — the gate holds *starts*, never stops something already going — and it falls back to normal when the forecast is missing or stale.

The gate closes at the bare comparison but **reopens only with 1 kWh of forecast on top of the deficit**. The asymmetry is deliberate and was measured: an opening starts loads whose own draw slows the battery's charging, which grows the deficit and closes the gate again. Without the margin it closed at 5.1/5.7, opened at 5.1/5.1 and closed again at 5.1/5.3 inside 28 minutes — every opening revoking itself. While the margin is what holds it, the settings page says so (`5.4 kWh left — reopens from 6.3 kWh`) rather than showing "blocked" beside a remaining figure that already exceeds the requirement. Each transition is written to the EMS History once, so you can see when it engaged and why. Beyond this, the forecast is a **data feed** for flows/Insights (foundation for further solar-aware planning).

#### Price-optimised EV charging (optional)

EV chargers can be set to **"Solar & cheapest hours (forecast)"** mode. This combines the Solcast PV forecast with a pushed electricity-price forecast to charge on solar surplus first, and grid-charge only what solar won't cover, during the cheapest available hours before the car's deadline:

1. Under **Cars**, set the car's usable **battery capacity (kWh)** and a **"Ready by"** time.
2. Feed an hourly price forecast into the EMS via the **"Set price forecast"** flow action — it takes a JSON array of hourly prices and a period (*this day* / *tomorrow* / *next hours*). This works directly with [Power by the Hour](https://homey.app/)'s **"New prices received"** trigger (its `Prices` token is exactly this array — just drag it in) or Tibber, EPEX, or any similar day-ahead price app that can produce an hourly array.
3. Set the charger's **Charging mode** to *Solar & cheapest hours (forecast)*.

Each tick, the EMS computes the car's remaining energy need (target − current SoC × capacity), subtracts what the Solcast forecast will deliver by the deadline, and — only for the remainder — checks whether *now* is one of the cheapest price slots before the deadline (ties prefer the later slot; a short block right before the deadline always charges regardless of price, as a safety margin). If the price feed goes stale or was never fed, it falls back to charging continuously so the car is never stranded just because a flow broke. Shows as the **Price-Optimised EV Charging** EMS mode. Without an assigned car with capacity and *Ready by* time the charger behaves like *Solar only*; without a Solcast forecast the whole remaining need is planned into the cheapest hours.

The price forecast works independently of EV charging too: the **Electricity Price** settings section's **Tariff model** dropdown has a dedicated **"Price forecast (day-ahead)"** option — pick it to have the EMS's displayed current price (tile/Insights/flow token) read directly from this same hourly forecast, no separate "current price" flow needed. This is distinct from **"Variable (via flow)"**, which is for price sources that can only push a single current-price value without a day-ahead array (e.g. some real-time Tibber setups). Selecting "Price forecast" also reveals a live preview chart of the incoming data (with a one-time **Flow setup** helper to auto-create the required flows) so you can confirm your price app is feeding it correctly.

**Time zones (3+ tariffs)** is a fifth tariff model for contracts with more than two periods. It takes any number of zones, each with its own times, price and weekdays. Hours no zone covers cost the standard rate, a window may cross midnight, and a window inside another one wins. It produces the same hourly slots as the day-ahead forecast and never goes stale, so price-optimised EV charging, battery grid-charging / reserve and the negative-price export limit all work from it without a *Set price forecast* flow.

#### Price-optimised home battery control (optional)

The same price forecast can also drive the home battery itself — a Homey equivalent of evcc's "battery grid charge": grid-charge the battery in the cheapest hours, and hold discharge back outside the priciest hours so it has capacity when it matters most. Opt in per battery under **Home Batteries**:

1. Enable **"Price-optimised charging"** for the battery and set a **Target SOC**, a **charge power** (kW, used only for the EMS's own scheduling math — it doesn't set the actual hardware limit), and how many hours to **reserve** for the most expensive part of the day (0 disables the reserve/hold behaviour). Optionally set **No grid charging above forecast** (kWh, `0` = off): when Solcast expects at least that much over the next 24 h, cheap-hour grid charging is skipped; a stale forecast leaves it charging as before. These four values can also be changed by a flow (since 1.3.14): **Set battery price control value** writes one of them into the battery's settings, exactly as if typed into the field — e.g. a lower forecast threshold in winter, or a target SOC that depends on tomorrow's weather. A value outside the field's range fails the flow instead of being clamped.
2. In that battery's **Flow setup** below, wire up the *Force Charge*, *Max Discharge Power*, and *Normal Mode* rows to your battery's own action cards — same as any other EMS battery flow. Set **Max Discharge Power**'s value to `0` (or a low reserve figure): this is the flow the EMS fires to hold discharge back.

Unlike EV charging, there's no "by" deadline — a battery has no real-world moment it must be ready by, so instead of a fixed clock-time cutoff, the EMS looks at a **rolling 24-hour window from now** and picks the cheapest hours within it to reach Target SOC, firing *Force Charge* when now is one of them. This lets it hold out for a genuinely cheaper hour later instead of being forced to commit early. Independently, it picks the `N` most expensive upcoming hours in that same window (the reserve) and fires *Max Discharge Power* outside them, *Normal Mode* inside them. If the price forecast is stale or missing, or a battery isn't SoC-readable, this does nothing — battery behaviour falls back to whatever the inverter/battery already does on its own. A live preview under each battery's price fields ("Refresh plan") shows, from the current forecast, what the battery is doing right now and its planned charge/reserve windows for the next 24h.

**Which flow rows the EMS drives, and which are yours.** The *Flow setup* panels create one Homey flow per row in the folder `_Huawei EMS`, and the rows are of two kinds. *Force Charge*, *Normal Mode* and *Max Discharge Power* on a battery, and *Enable/Disable export limit* on an inverter, arrive with a working trigger — the EMS fires those cards itself, so replacing their trigger is exactly how you switch price control or the export limit back off. Every other row arrives with a **placeholder** trigger that nothing fires, for you to replace in Homey with your own condition (a price app, a schedule). The flow list marks the difference: a working flow gets a green tick, one still sitting on its placeholder gets an amber ⚠ that says so. The ▶ button beside each flow fires that card exactly as the EMS would and now reports whether any flow was actually listening — `trigger()` resolves either way, so "it fired" and "something ran" are not the same statement. Note that pressing *Create / Update Flows* again deletes these flows by name and recreates them, so a trigger you edited by hand does not survive it.

**Grid-charging in cheap hours:** the home battery and any EV chargers in "Solar & cheapest hours (forecast)" / "Solar & low tariff" mode can all decide to grid-charge in the same cheap hour. They share the whole-house ceiling below, and the battery is allocated first each tick. A charger is capped to the highest amp rung that still fits, and only skips grid-charging (falling back to solar-only) when not even its minimum current fits. The separate *Grid import limit for price-charging* was removed in 1.2.93.

**Live plan previews:** both the battery (its price fields) and each EV charger in a price-aware mode have a "↻ Refresh plan" button showing, from the current forecast, whether it's grid-charging right now and its planned cheap-hour window(s) for the next 24h — no need to wait and watch to find out.

**Grid import limit — whole house (load shedding):** an optional **Grid import limit — whole house** field (under *Grid Meter*, `0` = unlimited) sets a hard ceiling on *total* grid import, e.g. matching the site's main fuse rating. It covers every EMS behaviour that draws from the grid: Instant charging, "Always charge" chargers, off-peak-window, price-optimised and low-tariff charging, and Home Battery force-charge; a heat pump, boiler, pool pump, dehumidifier or air conditioner start that would not fit is denied. Every tick the EMS starts from the actually-measured house import (so ordinary baseline load — fridge, lights, whatever isn't EMS-controlled — is already accounted for) and, if any of these unconditional tiers would push total import over the limit, gracefully steps the charging current down to the highest amp rung that still fits rather than stopping outright; if even the minimum amp doesn't fit, the charger is held off entirely for that tick. Home Battery force-charge is included too — since its power is a fixed value set via your own flow rather than an adjustable amp, it's simply skipped for the tick if it wouldn't fit. EMS Diagnostics shows how much of the ceiling is currently committed.

> **How the ceiling is counted.** Because the starting figure is a *measurement*, it already contains whatever EMS-controlled loads are running right now. Anything that re-claims its full draw every tick — EV chargers and Home Battery force-charge — therefore takes its own current draw back out before asking for headroom, and only the difference is charged against the ceiling. Loads that claim once when they start and not again while running (heat pump, boiler, pool pump, dehumidifier) correctly stay part of that measured baseline. Without this a charger sitting comfortably inside the limit would be counted twice, get stopped, then restart on the next tick once its draw left the meter reading — a permanent 15-second on/off cycle (fixed in 1.2.43). A charger whose house load has since risen *above* the ceiling now steps its current down to fit instead of stopping.

**Stale-forecast notification:** if a price forecast that was previously being fed goes more than 48h without an update (the source flow likely broke or was removed), the EMS sends a one-shot Homey notification instead of silently falling back to continuous charging — it re-arms once fresh data arrives, so a later outage notifies again.

**Keeping the forecast fresh is the source app's job:** the EMS can only react to price data that gets pushed to it via the "Set price forecast" flow action — it has no way to make another app's trigger fire more often (Homey itself blocks programmatically re-running a flow whose trigger needs live data from its owning app — "Flow Is Not Triggerable"). If your forecast keeps going stale, check your price app's own settings for how often *it* checks for new prices.

#### Charge sessions

Every configured EV charger (any charging mode — solar, off-peak, price-optimised, low-tariff, always) gets a per-session energy and cost log, shown under **App Settings → Energy Management → 🔌 Charge Sessions**. A session runs from the car being plugged in to being unplugged; energy only accumulates on ticks where the charger actually draws power, so pauses within one plug-in period (waiting for surplus, a cheaper price slot, battery protection, …) don't split it into several entries. Energy is integrated from the charger's **measured** power, not from the current the EMS commanded — a car that self-caps below the commanded amps (tapering near full, or a 1-phase car on a 3-phase charger) is billed for what it actually drew. Before 1.2.43 the commanded estimate was used, which could overstate a session's kWh and cost by up to about 3×; entries logged before that release keep their original figures. Cost is computed from whatever the **Electricity Price** tariff model reports at each tick (Fixed / Low-high / Time zones / Variable / Price forecast) — sessions where no price was known at all show energy only, with cost left blank. Sessions under 0.05 kWh (e.g. a brief plug-in) aren't logged. The last 200 sessions are kept.

**The running session is shown too**, at the top of the list, so a charge in progress is visible instead of appearing only once the cable comes out. It is labelled *charging* or *paused* by whether the EMS is currently granting it current — a session waiting for surplus or a cheaper price slot is still one session, but it is not charging, and saying "running" for both was misleading. The same list feeds the **Charging Sessions** widget, which falls back to these EMS sessions when no OCPP charger is paired.

**Feed-in tariff.** Solar a charging car takes was never bought — but where exporting is paid for, it was not free either: it is revenue given up. Enter what you are paid per exported kWh under **Electricity Price → Feed-in tariff / kWh** (it applies whichever tariff model you use for buying, since feeding in is a separate contract), and the solar half of a session is counted at that rate. Both the cost and the average price per kWh then become the real ones — a sunny charge no longer reads `0.00` as if that were the whole story. Because that total mixes two different kinds of money, the session list names both halves underneath it: what was **paid**, and what was **not fed in**. A 6.28 kWh charge that was 97 % solar reads `0.51 CHF (Ø 0.082/kWh)` with `0.05 paid · 0.46 forgone feed-in` below — which is why the average sits nowhere near the 0.3415 on the bill. The breakdown appears only where it says something, so a charge taken entirely from the grid, or one on a contract with no feed-in rate, looks exactly as it did. The CSV export carries the same split in two extra columns.

Leaving the field **empty keeps everything exactly as it was**: without it nobody has said what an exported kWh earns, that solar stays unpriced, and the average keeps meaning "per kWh whose price was known". Entering **zero** is a different and equally valid answer — some contracts pay nothing, and that solar is then genuinely free, which the average now says rather than leaving it out.

#### Configuration & diagnostics

Data sources, controlled devices, tariff/automation and diagnostics are configured in **App Settings → Energy Management** (grouped by section). The settings page also shows an **EMS History** (recent mode/device/charger events, with a Copy button) and a live **EMS Diagnostics** view (`getEmsDiag`: tick health, last decision snapshot, the Solcast PV forecast when enabled, and the price forecast when configured).

**Copy configuration** puts the whole setup on the clipboard for a bug report: settings, the current readings, and the per-device table with each steered device's *measured* value beside the one the EMS believes. The aim is that a tick can be recomputed from the export alone — every figure the control loop branches on leaves the device as a value rather than only inside a sentence. **Secrets are redacted by key name** (anything matching key / secret / password / token / code / credential / user): the key stays, the value is replaced, and an unset secret stays visibly unset, so the export is safe to paste into a forum thread.

**Scheduler** (*Automation → Scheduler*): runs a flow from the `_Huawei EMS` folder at a set time, daily or on chosen weekdays, in Homey's time zone. Tasks run only while the EMS is enabled. A task missed by a late or slow control cycle runs with the next one, up to five minutes late and once only (since 1.2.319). A task in the hour skipped by the spring clock change runs when the clocks jump; one in the repeated autumn hour runs once.

#### Manual control always wins

A heat pump, boiler, pool pump, dehumidifier or air conditioner switched on **by hand** while the EMS is not running it is adopted as "externally on" and left alone entirely — no start, no stop, no amp commands — until it is switched off again. To avoid mistaking a slow report for a person, that decision waits out the device's own **reaction grace** (the per-device setting that also covers start-up lag; 60 s minimum). Without it, an air conditioner whose app reports more slowly than a minute was classified "switched on externally" one minute after *every* EMS stop, and then ran unmanaged into the evening — four times in one day.

EV chargers are the exception: a charger drawing power the EMS did not command is adopted at its current amps and regulated like any other, and is stopped below the hard stop. To keep the EMS off a charger, switch it out of EMS control (widget, settings or the *Enable or disable EMS control for a device* card).

The opposite direction is reported honestly too. What the EMS actually fires to start a heat pump, boiler, pool pump, dehumidifier or air conditioner is **your** flow — and a flow is free to decline. If the device is never once seen running during an attempt, the history says *"started, but nothing happened — the start flow did not act"* rather than *"switched off outside the EMS"*, which points at the flow instead of the hardware. One owner's air-conditioning flow only acts above a room temperature; on a cool afternoon that produced two "switched off externally" entries for a device nobody had touched. A run that genuinely was switched off reads as before, and so does one the app could not watch from beginning to end — across a restart, for instance, where guessing would only trade one wrong story for another.

---

## Installation

### Requirements

#### Kiosk
- FusionSolar Kiosk URL (available in the FusionSolar app under Share → Kiosk URL)

#### OpenAPI (SUN2000 / LUNA2000 / iSitePower-M)
- FusionSolar account with Northbound API enabled
- Username and System Code (API password)
- The regional server (picked from a list in the device settings, or entered as a URL)

#### OCPP Smart Charger
- EV charger with OCPP 1.6 JSON support
- Charger and Homey on the same local network
- Charger's OCPP backend set to `ws://<Homey-IP>:8887/<station-id>` — 8887 is the default; the port can be set per device (one server per port) — and that port reachable from the charger (not blocked by a firewall)
- Huawei SCharger: firmware V100R023C10SPC220 or newer

#### Easee Charger (OCPP)
- Easee charger with firmware 344 or newer, on WiFi
- Easee's own OCPP switched on in the Easee Installer app (*Settings* → *OCPP* → *Server*) or with Easee's commissioning API, OCPP URL `ws://<Homey-IP>:8887` (see [Setup (Easee)](#setup-easee))
- Charger and Homey on the same local network, the port reachable from the charger

#### SDongle A
- SDongle A reachable over LAN
- Modbus TCP enabled (port **502**; 6607 is the inverter's built-in WLAN access point, not the SDongle)
- Modbus Unit ID: **100** (older firmware may use **0**)
- Static IP address recommended

#### Modbus (SUN2000 / LUNA2000 / DTSU666)
- SUN2000 inverter or SDongle reachable over LAN
- Modbus TCP enabled (default port: **502**, also for the SDongle; **6607** only through the inverter's built-in WLAN access point, then usually IP 192.168.200.1 and unit ID 0)
- Modbus Unit ID: **1** (battery and meter use the inverter's)
- Static IP address recommended (DHCP reservation in router)

#### EMMA Modbus
- EMMA (Energy Management Assistant, e.g. EMMA-A02) reachable over LAN
- Modbus TCP enabled (default port: **502**)
- Modbus Unit ID: **0**
- Static IP address recommended
- The Smart Charger behind an EMMA is read through the **EMMA's** address and unit ID 0, not its own IP

#### Energy Management System
- A Homey API key (Homey → Settings → System → API Keys) with read/write access to Devices and Flows, entered in the EMS device's settings; without it the EMS stays in `error`. Devices of this app (inverter, meter, battery, charger) are read directly inside the app; the key is used for devices of other apps (another wallbox, a car, a heat pump) and for flows
- Configuration is done in App Settings → Energy Management

> **Huawei hardware accepts exactly one Modbus TCP connection at a time.** A second program connecting — Home Assistant, EVCC, another Homey app, or the FusionSolar app left in local commissioning mode — takes the connection over, and the dongle then accepts the handshake and hangs up immediately. That looks nothing like a wiring or address fault, so the device now says what it is: *"192.168.x.x accepted the connection and closed it again — no register could be read. Huawei devices allow only one Modbus connection at a time: is another program reading this device?"* rather than blaming the battery or the meter. Also check that **Modbus TCP** is set to *Enable (unrestricted)* in the FusionSolar app under the dongle's parameter settings; *limited* produces the same symptom.
>
> The app itself opens one connection per poll and closes it afterwards. Since 1.3.14 a connection the device has not closed on its side within a second is **reset** (TCP RST) instead of being left half-open — on a device with a single client slot, such a leftover would hold that slot until the app restarted, and every later connection would be accepted and closed at once (reported on an EMMA). The app log says once per address which way the device behaves: *"… closes its side of the connection after N ms"* or *"… did not close its side of the connection within 1000 ms — reset (TCP RST)"*. A lost connection now ends that poll at once instead of logging one failure per register, and while the app backs off after three failed polls, the device tile keeps naming the failure that started it.

### Setup in Homey

1. Install the app from the Homey App Store
2. Add a device: **Devices → + → Huawei FusionSolar Manager**
3. Select connection type and device, enter connection details
4. Connection test — on success the device is created

---

## Device Settings

### Kiosk

| Setting           | Default  | Description                                   |
|-------------------|----------|-----------------------------------------------|
| Kiosk URL         | –        | Public Kiosk URL of the plant                 |
| Update interval   | 10 min   | How often data is fetched (min. 5 min)        |

### OpenAPI (SUN2000 / LUNA2000 / iSitePower-M)

| Setting           | Default                         | Description                                   |
|-------------------|---------------------------------|-----------------------------------------------|
| Server            | Other (use Server URL below)    | Regional FusionSolar server (eu5, intl, region01–05, sg5, au5, jp5, la5, EnergyOrb). Applies to every OpenAPI device of the plant |
| Server URL        | https://eu5.fusionsolar.huawei.com (iSitePower-M: https://intl.fusionsolar.huawei.com) | Only used when Server is "Other" |
| Username          | –                               | FusionSolar API username                      |
| System Code       | –                               | API password                                  |
| Station Code      | –                               | Set automatically during pairing              |
| Update interval   | 5 min                           | 5–60 min. One fetch per plant; the shortest interval set on any of its devices applies |
| Timeline notifications | On                         | Announce inverter, battery or meter status changes (SUN2000, LUNA2000 and Power Meter) |

> **Rate limiting:** Huawei may return HTTP 407 if polling too frequently. The default of 5 minutes is recommended; it is also the minimum — Huawei refreshes its data about every 5 minutes.

### SUN2000 (Modbus)

#### Connection

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SUN2000 / SDongle                   |
| Modbus port          | 502     | Also 502 for the SDongle. 6607 only via the inverter's built-in WLAN access point (usually 192.168.200.1, unit ID 0) |
| Modbus unit ID       | 1       | Unit ID of the device (default: 1)            |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

#### Feed-in Power Control

These values are read from the inverter on startup and kept in sync.

| Setting                    | Default | Description                                                                          |
|----------------------------|---------|--------------------------------------------------------------------------------------|
| Active power control mode  | –       | The feed-in mode (register 47415), written only on Save. Shows the inverter's current mode; it can be saved once the app has read it. A change the inverter reports is logged as `Mode dropdown follows the device`. |
| Max feed-in power (W)      | –       | Maximum grid feed-in power in watts (register 47416). Set to 0 to block all export. |
| Max feed-in power (%)      | –       | Maximum grid feed-in power as % of rated power (register 47418).                    |

#### Output Limit (works without power meter)

These registers derate the inverter AC output directly and work without a DTSU666.

| Setting                   | Default | Description                                                                         |
|---------------------------|---------|-------------------------------------------------------------------------------------|
| Inverter output limit (W) | –       | Absolute output cap in watts (register 40126). 0 shuts the inverter down; *Remove inverter output limit* sets rated power × 1.1 for no cap. |
| Inverter output limit (%) | –       | Output cap as % of rated power (register 40125). Set to 100 for no limit.          |

#### MPPT

| Setting                      | Default | Description                                                    |
|------------------------------|---------|----------------------------------------------------------------|
| MPPT multimodal scanning     | –       | Multi-peak scan for shaded strings (register 42054), written on Save and kept in sync |
| MPPT scanning interval (min) | –       | 1–60 min (register 42055); only with multimodal scanning on    |

#### Notifications

| Setting                | Default | Description                                                         |
|------------------------|---------|---------------------------------------------------------------------|
| Timeline notifications | On      | Inverter status changes, and a setting the inverter refused (put back) |

### LUNA2000 / DTSU666 (Modbus)

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SUN2000 / SDongle                   |
| Modbus port          | 502     | Also 502 for the SDongle. 6607 only via the inverter's built-in WLAN access point (usually 192.168.200.1, unit ID 0) |
| Modbus unit ID       | 1       | Unit ID of the device (default: 1)            |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

On the battery these four are the **Connection** group. Since 1.2.270 every battery setting
sits in a group, the way the inverter's do:

| Group | Settings |
|-------|----------|
| Connection | IP Address · Modbus Port · Modbus Unit ID · Update Interval |
| Change battery mode | Storage working mode · Excess PV energy (Time of Use) · Charge/discharge windows (Time of Use) · Remote charge/discharge mode — see *Battery Modes* above — and whether an Energy Management device is installed, the tool for charging by price or forecast |
| Charge and discharge power | Max charge power (W) · Max discharge power (W) |
| Charging from the grid | Charge battery from grid · Grid charge power (W) · Grid charge power limit (W) · Grid charge cutoff SoC (%) |
| State of charge limits | Charging cutoff capacity (%) · Discharge cutoff capacity (%) · Backup power SoC (%) |
| Peak shaving | Peak shaving mode · Backup SoC for peak shaving (%) — the limits per time period are set in the FusionSolar app |
| Notifications | Timeline notifications |

The EMMA battery has Connection, Change battery mode, Charging from the grid (max grid charging
power) and Notifications. The DTSU666 has Connection and Notifications (Timeline notifications,
on: meter status changes).

### SDongle A Modbus

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SDongle A                           |
| Modbus port          | 502     | 6607 is the inverter's WLAN access point, not the SDongle |
| Modbus unit ID       | 100     | Older firmware may use 0                      |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

### EMMA Modbus

| Setting                         | Default | Description                                      |
|---------------------------------|---------|--------------------------------------------------|
| IP address                      | –       | IP of the EMMA Energy Management Module          |
| Modbus port                     | 502     | Default port of the EMMA                         |
| Modbus unit ID                  | 0       | EMMA uses unit ID 0                              |
| Update interval (s)             | 60 (Smart Charger: 30) | How often data is polled (min. 10 s) |
| Max grid charging power (kW)    | 5       | Battery only: writes EMMA register 40002         |
| Timeline notifications          | On      | Battery only: charging / discharging / idle      |

### Energy Management System

| Setting                | Default | Description                                                                 |
|------------------------|---------|-----------------------------------------------------------------------------|
| Homey API Key          | –       | Created in Homey → Settings → System → API Keys, with read/write access to Devices and Flows. All other EMS configuration is in the app settings |
| Timeline notifications | On      | When the EMS starts or stops a device, when the battery is full or low, when the price forecast has not been updated for hours, and when an EMS cycle overruns |
| Debug logging          | Off     | Logs every tick's price/battery decision, not only changes — only while troubleshooting |

---

## Flow Cards

<!-- flow-cards:start — generated by scripts/readme-flow-cards.js from app.json; edit the card hints there -->

Every card the app offers, with the text Homey shows behind its (i). Retired cards are left
out — they are no longer offered for new flows, and existing flows keep working.

### Triggers

| Card | Device | Tokens | Description |
|---|---|---|---|
| Power output changed | FusionSolar Plant (Kiosk) | `power` | Fires on every successful kiosk update (every 10 minutes by default) with the plant's current power — also when it has not changed. The Power token holds the value. |
| Daily energy updated | FusionSolar Plant (Kiosk) | `daily_energy` | Fires on every successful kiosk update with the plant's daily yield. Huawei refreshes that figure only about every 30 minutes, so consecutive values are often the same. |
| Power output changed | Inverter SUN 2000 (OpenAPI) | `power` | Fires on every FusionSolar OpenAPI update with the inverter's AC active power — also when the value has not changed. |
| Battery state of charge changed | Battery LUNA 2000 (OpenAPI) | `soc` | Fires every time the battery's state of charge changes. Reads the current value via the FusionSolar OpenAPI. |
| Battery charging state changed | Battery LUNA 2000 (OpenAPI) | `state` | Fires when the battery switches between charging, discharging, and idle. The State token contains the new value. |
| Battery unit status changed | Battery LUNA 2000 (OpenAPI / Modbus) | `status` | Fires when the LUNA2000 battery unit's operating status changes. Select a specific status to trigger only on that transition. |
| Battery started charging | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | – | Fires when the battery transitions from idle or discharging to charging (power above 50 W). |
| Battery started discharging | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | – | Fires when the battery transitions from idle or charging to discharging (power above 50 W). |
| Battery working mode changed | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | `mode` | Fires when the storage working mode changes — e.g. switched by an external grid balancing service. |
| Grid export started | Power Meter (OpenAPI / Modbus / EMMA Modbus) | `power` | Fires when the meter switches from importing to exporting — i.e. when surplus PV power starts flowing back to the grid. |
| Grid import started | Power Meter (OpenAPI / Modbus / EMMA Modbus) | `power` | Fires when the meter switches from exporting to importing — i.e. when grid power is being drawn again. |
| Meter status changed | Power Meter (OpenAPI / Modbus) | `status` | Fires when the grid meter's online/offline status changes. Select a specific status to trigger only on that transition. |
| Battery state of charge changed | iSitePower-M Battery (OpenAPI), Battery LUNA 2000 (Modbus / EMMA Modbus) | `soc` | Fires every time the battery's state of charge changes. The SoC token contains the new percentage value. |
| Battery charging state changed | iSitePower-M Battery (OpenAPI), Battery LUNA 2000 (Modbus / EMMA Modbus) | `state` | Fires when the battery switches between charging, discharging, and idle. The State token contains the new value. |
| Power output changed | Inverter SUN 2000 (Modbus / EMMA Modbus) | `power` | Fires when the solar power the device reports changes: the PV input power (register 32064) on a SUN2000 via Modbus, the PV power read from the EMMA (register 30354) on an inverter connected through EMMA. |
| Inverter status changed | Inverter SUN 2000 (Modbus) | `status` | Fires when the SUN2000 inverter's operating status changes. Select a specific status to trigger only on that transition. |
| Backup power SoC changed | Battery LUNA 2000 (Modbus / EMMA Modbus) | `soc` | Fires whenever the backup power reserve (register 47102 on a LUNA2000 via the inverter, 30373 via EMMA) changes — whether you changed it here, in FusionSolar, or on the inverter itself. The token holds the new percentage, which is what you need to keep another setting a fixed margin above it. |
| Excess PV energy use in TOU mode changed | Battery LUNA 2000 (Modbus / EMMA Modbus) | `mode` | Fires when the excess PV energy setting changes between 'Feed to Grid' and 'Charge Battery'. |
| Remote dispatch mode changed | Battery LUNA 2000 (Modbus) | `mode` | Fires when the remote charge/discharge control mode changes (e.g. switched by a third-party scheduling service). |
| EV charging started | Smart Charger (EMMA Modbus) | – | Fires at the first rise of the charger's energy counter. The charger has no register for its charging state, so a session is recognised by the energy it counts. |
| EV charging stopped | Smart Charger (EMMA Modbus) | – | Fires once the charger's energy counter has stood still for six minutes (longer during a slow charge), or at once when every phase reads 0 V. The charger has no register for its charging state, so this is how the end of a session is recognised. |
| Charger reported a fault (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `error_code`, `vendor_error_code`, `info`, `status` | Fires when the charger reports a fault of its own. The error code is the charger’s, not the app’s — for example GroundFailure, OverCurrentFailure or HighTemperature. |
| EV charging started (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `amps`, `phases`, `phase_label`, `message`, `transaction_id`, `meter_start` | Fires once power actually flows (above 100 W) after the charger has started a transaction, or right away when a start card releases a car that was waiting. Not fired when the car draws nothing, nor when charging continues after a pause — that is "Charging resumed (OCPP)". |
| EV charging stopped (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `energy_delivered_kwh`, `energy_delivered_wh`, `energy_delivered_formatted`, `duration_minutes`, `duration_formatted`, `reason`, `amps`, `phases`, `message` | Fires when the charger reports the end of a transaction (OCPP StopTransaction). Not fired for a pause, nor for a start in which the car never drew power — there was no "EV charging started" for it either; a paused session that is then stopped or unplugged fires it once, with the totals of the whole session. |
| EV plugged in — waiting for start (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | – | Fires when a car plugs in and auto-start charging is disabled. Use this to start charging manually from a flow. |
| EV charger state changed (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `state` | Fires on every status report from the charger (OCPP StatusNotification), mapped to idle / connected / charging / error — the state can be the same as before. |
| EV disconnected (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `connected_minutes`, `message` | Fires when the cable is physically unplugged from the charger (rawStatus=Available). |
| Charger went offline (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `message` | Fires when no OCPP message has been received from the charger for 3 minutes. Not fired for 5 minutes after a reboot command. |
| Charger came back online (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `message` | Fires when the charger reconnects after "Charger went offline (OCPP)" has fired. |
| Charging paused (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `resume_amps`, `message` | Fires when charging is paused via the masked-stop mechanism. |
| Charging resumed (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `amps`, `phases`, `phase_label`, `message` | Fires when power is flowing again after a pause (power-verified). |
| Charging limit changed (OCPP) | Smart Charger (OCPP), Easee Charger (OCPP) | `amps`, `previous_amps`, `phases`, `phase_label`, `message` | Fires when the charging current limit is changed during an active session. |
| Solar forecast updated | Energy Management System | `remaining_today_kwh`, `next_6h_kwh`, `peak_kw` | Fires when a fresh Solcast PV forecast has been fetched. |
| EMS mode changed | Energy Management System | `mode` | Fires when the Energy Management System switches to a different operating mode. |
| EMS wants to set charger current | Energy Management System | `amps`, `phase1`, `phase2`, `phase3`, `charger_device_id` | Fires when the EMS wants to change an EV charger's current. Paste the Charger Device ID from the EMS settings. Use the [amps], [phase1], [phase2], [phase3] tokens in the charger action: [amps] is the current per phase, [phase2] and [phase3] are 0 when charging on one phase, and 0 A means stop charging. |
| EMS wants to start charging | Energy Management System | `charger_device_id` | Fires when the EMS starts giving current to a charger that is not charging (drawing under 500 W) and a charging session should begin. Fired once more if the car still draws nothing after 90 s. |
| EMS wants to start heat pump | Energy Management System | `heat_pump_device_id` | Fires when the EMS wants to turn the heat pump on (enough solar surplus). |
| EMS wants to stop heat pump | Energy Management System | `heat_pump_device_id` | Fires when the EMS wants to turn the heat pump off (battery priority or no surplus). |
| EMS wants to start boiler/heater | Energy Management System | `boiler_device_id` | Fires when the EMS wants to turn the boiler/heater on (sufficient solar surplus available). |
| EMS wants to stop boiler/heater | Energy Management System | `boiler_device_id` | Fires when the EMS wants to turn the boiler/heater off (battery priority or no surplus). |
| EMS wants to start pool pump | Energy Management System | `pool_device_id` | Fires when the EMS wants to turn the pool pump on (sufficient solar surplus available). |
| EMS wants to stop pool pump | Energy Management System | `pool_device_id` | Fires when the EMS wants to turn the pool pump off (battery priority or no surplus). |
| EMS wants to start dehumidifier | Energy Management System | `dehumidifier_device_id` | Fires when the EMS wants to turn the dehumidifier on (sufficient solar surplus available). |
| EMS wants to start air conditioner | Energy Management System | `aircon_device_id` | Fires when the EMS wants to turn the air conditioner on (sufficient solar surplus available). |
| EMS wants to stop dehumidifier | Energy Management System | `dehumidifier_device_id` | Fires when the EMS wants to turn the dehumidifier off (battery priority or no surplus). |
| EMS wants to stop air conditioner | Energy Management System | `aircon_device_id` | Fires when the EMS wants to turn the air conditioner off (surplus gone or battery too low). |
| EMS: battery is full | Energy Management System | `battery_device_id`, `soc` | Fires when the battery SOC first reaches the upper point of "Battery: surplus split" (EMS settings → Home Batteries) — 95 % when no split is set up. It only notifies. Use it, for example, to start force-discharging the battery into the EV charger. |
| EMS: battery is low | Energy Management System | `battery_device_id`, `soc` | Fires when the battery SOC drops below the lower point of "Battery: surplus split" (EMS settings → Home Batteries) — 80 % when no split is set up. It only notifies; switching the devices off is what the lower point itself does. Use it, for example, to stop force-discharging. |
| EMS: battery — force charge | Energy Management System | `battery_device_id` | Fires when the EMS decides this battery should grid-charge because electricity is cheap now. Requires price-based charging to be enabled for the battery in the EMS settings. |
| EMS: battery — force discharge | Energy Management System | `battery_device_id` | Placeholder trigger created by EMS Setup Flows for 'Force Discharge'. Replace with your own trigger in Homey. |
| EMS: battery — normal mode | Energy Management System | `battery_device_id` | Fires when the EMS hands this battery back to its normal behaviour — neither grid-charging nor holding its charge back. |
| EMS: battery — set max charge power | Energy Management System | `battery_device_id` | Placeholder trigger created by EMS Setup Flows for 'Max Charge Power'. Replace with your own trigger in Homey. |
| EMS: battery — set max discharge power | Energy Management System | `battery_device_id` | Fires when the EMS wants this battery to stop discharging and save its capacity for the most expensive upcoming hours. Wire it to a card that sets the discharge power to 0 W. |
| EMS: inverter — enable export limit | Energy Management System | `inverter_device_id` | Fires for every inverter set up in the EMS when the Export Limit Coordinator (EMS settings) starts limiting feed-in: at once and for good with "Never feed in (zero export)", otherwise only while more than 100 W is exported and the battery has reached "Activate at SOC" (default 95 %) or the price is below the set threshold. Link it to "Enable/disable grid export limit" or "Enable zero export (Nulleinspeisung)" of the inverter. |
| EMS: inverter — disable export limit | Energy Management System | `inverter_device_id` | Fires for every inverter set up in the EMS when the coordinator lifts the limit: at the earliest 5 minutes after it was set, once the price is no longer below the threshold and either nothing is exported any more or the battery has fallen below "Deactivate at SOC" (default 90 %). Also fires when the coordinator is switched off while a limit is active; never while "Never feed in (zero export)" is on. |
| EMS: inverter — set feed-in limit (W) | Energy Management System | `inverter_device_id` | Placeholder trigger created by EMS Setup Flows for 'Set max feed-in power (W)'. The EMS never fires it — replace it with your own trigger (e.g. energy price, time schedule) in Homey. |
| EMS: inverter — set feed-in limit (%) | Energy Management System | `inverter_device_id` | Placeholder trigger created by EMS Setup Flows for 'Set max feed-in power (%)'. The EMS never fires it — replace it with your own trigger (e.g. energy price, time schedule) in Homey. |
| EMS: inverter — remove output limit | Energy Management System | `inverter_device_id` | Placeholder trigger created by EMS Setup Flows for 'Remove output limit'. The EMS never fires it — replace it with your own trigger (e.g. energy price, time schedule) in Homey. |
| EMS: set car target charge | Energy Management System | `target_soc`, `car_name`, `message` | Fires each time a car target is set through "Set car target charge (%)" or the EMS Device widget — also when the value is unchanged. Use the Target SOC token to set the charge limit on your vehicle. |

### Conditions

| Card | Device | Description |
|---|---|---|
| Is producing / not producing | FusionSolar Plant (Kiosk) | Checks whether the plant is currently generating power. |
| Solar power is above / not above value for duration | Inverter SUN 2000 (OpenAPI / Modbus / EMMA Modbus) | True when solar power has been continuously above the specified wattage for at least the given number of minutes. What "solar power" is depends on the device: PV input power on a SUN2000 via Modbus, the EMMA's PV power via EMMA, AC active power on a cloud inverter (which on a hybrid inverter includes battery discharge). The app keeps about 2 hours of readings: a longer duration is never true, and after an app restart the card needs that much history first. |
| Solar power is below / not below value for duration | Inverter SUN 2000 (OpenAPI / Modbus / EMMA Modbus) | True when solar power has been continuously below the specified wattage for at least the given number of minutes. What "solar power" is depends on the device: PV input power on a SUN2000 via Modbus, the EMMA's PV power via EMMA, AC active power on a cloud inverter (which on a hybrid inverter includes battery discharge). The app keeps about 2 hours of readings: a longer duration is never true, and after an app restart the card needs that much history first. |
| Battery is charging / not charging | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | True when the battery is actively charging (power above 50 W). |
| Battery is discharging / not discharging | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | True when the battery is actively discharging (power above 50 W). |
| Battery SoC is above / not above threshold | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | True when the battery state of charge is above the given threshold. |
| Battery SoC is below / not below threshold | Battery LUNA 2000 (OpenAPI / Modbus / EMMA Modbus), iSitePower-M Battery (OpenAPI) | True when the battery state of charge is below the given threshold. |
| Battery unit status is / is not | Battery LUNA 2000 (OpenAPI / Modbus) | Checks the current operating status of the LUNA2000 battery unit (e.g. Running, Fault, Sleep mode). |
| Grid is exporting / importing | Power Meter (OpenAPI / Modbus / EMMA Modbus) | True when the meter reports a negative active power — i.e. surplus energy is being fed into the grid. |
| Meter status is / is not | Power Meter (OpenAPI / Modbus) | Checks the current online status of the DTSU666 grid meter (Offline or Normal). |
| Inverter status is / is not | Inverter SUN 2000 (Modbus) | Checks the current operating status of the SUN2000 inverter (e.g. On-grid, Shutdown: fault). |
| Is producing / not producing | Inverter SUN 2000 (Modbus / EMMA Modbus) | Checks whether the SUN2000 inverter is currently generating power. |
| Backup power SoC is above / not above threshold | Battery LUNA 2000 (Modbus / EMMA Modbus) | True when the backup power reserve (register 47102 on a LUNA2000 via the inverter, 30373 via EMMA) is above the given threshold. Read on every poll, so it follows a change made anywhere. |
| Backup power SoC is below / not below threshold | Battery LUNA 2000 (Modbus / EMMA Modbus) | True when the backup power reserve (register 47102 on a LUNA2000 via the inverter, 30373 via EMMA) is below the given threshold. Read on every poll, so it follows a change made anywhere. |
| Max charge power is above / not above threshold | Battery LUNA 2000 (Modbus) | True when the battery max charge power setting (register 47075) is above the given threshold. Synced from the inverter on every poll, and at once after a change made from Homey. |
| Max charge power is below / not below threshold | Battery LUNA 2000 (Modbus) | True when the battery max charge power setting (register 47075) is below the given threshold. Use threshold 1 to check whether the limit has already been set to 0 (blocked). Synced from the inverter on every poll, and at once after a change made from Homey. |
| Max discharge power is above / not above threshold | Battery LUNA 2000 (Modbus) | True when the battery max discharge power setting (register 47077) is above the given threshold. Synced from the inverter on every poll, and at once after a change made from Homey. |
| Max discharge power is below / not below threshold | Battery LUNA 2000 (Modbus) | True when the battery max discharge power setting (register 47077) is below the given threshold. Use threshold 1 to check whether the limit has already been set to 0 (blocked). Synced from the inverter on every poll, and at once after a change made from Homey. |
| Battery working mode is / is not | Battery LUNA 2000 (Modbus / EMMA Modbus) | Checks the current storage working mode of the LUNA2000 battery. |
| Excess PV energy use in TOU mode is / is not | Battery LUNA 2000 (Modbus / EMMA Modbus) | Checks how excess PV energy is used in TOU mode (feed to grid or charge battery). In any other working mode the setting does nothing. |
| Remote dispatch mode is / is not | Battery LUNA 2000 (Modbus) | Checks the current remote charge/discharge control mode of the LUNA2000 battery. |
| Charger is / is not online | Smart Charger (OCPP), Easee Charger (OCPP) | True while OCPP messages are arriving from the charger. Worth checking before any charging action — they all fail on an offline charger. |
| Charger is charging / not charging | Smart Charger (OCPP), Easee Charger (OCPP) | True while the charger reports the status Charging — what the charger says, not measured power — as opposed to the cable merely being connected. |
| Car is / is not plugged in | Smart Charger (OCPP), Easee Charger (OCPP) | True whenever the cable is connected — while waiting for a start, charging, paused, and after charging has finished (Finishing). False while the charger reports Unavailable or Faulted: it cannot tell then. |
| Session status is / is not | Smart Charger (OCPP), Easee Charger (OCPP) | The status shown on the device, for the cases the plainer conditions do not separate — finishing, fully charged, waiting for a start. |
| Expected solar today is more / less than | Energy Management System | True when the Solcast forecast for the rest of today (until midnight) is above the given number of kWh. |
| Expected solar until a time is below / not below | Energy Management System | True when the Solcast forecast for the PV production remaining from now until the given time today is below the threshold (kWh). Returns 0 once that time has passed. Useful for deadline planning, e.g. "the sun won't cover the car by 18:00, start grid charging". |
| Expected solar in the next hours is more / less than | Energy Management System | True when the Solcast forecast for the next N hours is above the given number of kWh. |
| EMS mode is / is not | Energy Management System | Compares the EMS's current mode (shown on the Energy Management device) with the one selected. To react the moment it changes, use the trigger for a changed EMS mode. |
| EMS control for a device is / is not active | Energy Management System | True while the EMS may start and stop the chosen charger or device — the per-device switch in the EMS settings and the EMS Device widget. Fails if the device is no longer set up in the EMS. |

### Actions

#### Inverter SUN 2000 (Modbus)

| Card | Description |
|---|---|
| Set active power control mode | Sets the active power control mode of the SUN2000 inverter via Modbus (register 47415) — how it limits what it feeds into the grid. If your house connection depends on a feed-in limit, check it after every change. "Unlimited" — Huawei's default: no limit, the inverter feeds in whatever is left over. "DI Active Scheduling": follows the signals on the inverter's digital inputs (DI), for example from the grid operator's ripple control receiver. "Zero Power Grid Connection": regulates so that nothing is fed into the grid at the connection point. "Limited by Power (kW)" and "Limited by Power (%)": cap the feed-in at the connection point at what "Set max feed-in power" or "Set max feed-in power (%)" set. These three need a power meter at the grid connection (Smart Power Sensor); without one, only "Set inverter output limit (W)" and "Set inverter output limit (%)" help. |
| Enable/disable grid export limit | Enables (mode: Limited by Power, register 47415=6) or disables (mode: Unlimited, register 47415=0) the grid export limit. Set the watt limit separately using 'Set max feed-in power'. Needs a power meter at the grid connection (e.g. DTSU666); without one the inverter ignores it — use "Set inverter output limit (W)" instead. |
| Set max feed-in power | Sets the maximum grid feed-in power of the SUN2000 inverter via Modbus (register 47416). Set to 0 to block all export. Takes effect only in the mode "Limited by Power (kW)" — switch it on with "Enable/disable grid export limit". Needs a power meter at the grid connection (e.g. DTSU666); without one the inverter ignores it — use "Set inverter output limit (W)" instead. |
| Set inverter output limit (W) | Sets the maximum AC output of the inverter in watts (register 40126). This is a ceiling, not a setpoint — actual production follows the natural PV level when sun is weaker, and is only throttled when sun would otherwise produce more. Set to 0 to fully shut down. To lift the limit, use "Remove inverter output limit" (it writes rated power × 1.1). Works WITHOUT a Smart Power Sensor. |
| Remove inverter output limit | Resets both output limits to 'no cap': writes rated power × 1.1 to register 40126 and 100 % to register 40125. Use this to fully remove a previously set output limit and let the inverter run at its natural maximum. |
| Set inverter output limit (%) | Sets the maximum AC output as a percentage of rated power (register 40125). This is a ceiling, not a setpoint — actual production follows the natural PV level when sun is weaker, and is only throttled when sun would otherwise produce more. Example on a 4 kW inverter: 50 % = 2 kW cap. Set to 0 to fully shut down, 100 to remove the limit. Works WITHOUT a Smart Power Sensor. |
| Set max feed-in power (%) | Sets the maximum grid feed-in power as a percentage of rated power via Modbus (register 47418). Set to 0 to block all export. Also switches the active power control mode to "Limited by Power (%)" (register 47415 = 7), replacing a watt limit. Needs a power meter at the grid connection (e.g. DTSU666); without one the inverter ignores it — use "Set inverter output limit (%)" instead. |
| Enable zero export (Nulleinspeisung) | Activates zero export: sets active power control mode to "Limited by Power (kW)" (register 47415 = 6) and sets the feed-in limit to 0 W (register 47416 = 0). The inverter will continue producing power for self-consumption but will not export any surplus to the grid. The feed-in mode and limit in force before are remembered, so 'Disable zero export' can put them back. Needs a power meter at the grid connection (e.g. DTSU666); without one the inverter ignores it — use "Set inverter output limit (W)" instead. |
| Disable zero export (Nulleinspeisung) | Deactivates zero export: puts back the feed-in mode and limit that were in force before 'Enable zero export' ran (registers 47416 and 47415) — a standing feed-in limit stays a limit. Without a remembered state nothing is written: if zero export is not on, there is nothing to disable; if it was switched on outside this app, the feed-in mode before it is unknown — the card fails, the timeline says so, and the inverter stays at zero export until the feed-in mode is set in its device settings. |
| Start inverter | Sends a startup command to the inverter via Modbus (register 40200). Verify that grid conditions are suitable before using. |
| Shut down inverter | Sends a shutdown command to the inverter via Modbus (register 40201). The inverter stops feeding power to the grid. |
| Set MPPT multimodal scanning | Enables or disables MPPT multimodal scanning (register 42054). Useful for installations with partial shading where multiple power peaks may exist. |
| Set MPPT scanning interval | Sets the MPPT scanning interval in minutes (register 42055). Shorter intervals improve response to changing conditions but increase inverter activity. |

#### Battery LUNA 2000 (Modbus)

| Card | Description |
|---|---|
| Set storage working mode | What the battery does on its own (register 47086). For charging by price or forecast, use the Energy Management device instead. "Maximise Self-Consumption" — the normal choice: surplus solar charges the battery; when the sun is not enough, it supplies the house. "Time of Use (LUNA2000)" — follows the charge and discharge windows stored in the inverter. Set them in the device settings or in the FusionSolar app, or the battery may discharge on a sunny morning. "Fully Fed to Grid" — as much solar as possible into the grid; the battery charges only with what exceeds the inverter's maximum output and discharges below it. "Third-party Scheduling" — only if an outside platform is connected; otherwise nothing controls the battery. "Fixed Charge/Discharge", "Time of Use (LG)" and "Adaptive" — meant for LG batteries or not described by Huawei; do not choose them with a LUNA2000. |
| Set excess PV energy use in TOU mode | Only takes effect in the working mode "Time of Use (LUNA2000)": whether surplus solar goes into the grid or charges the battery (register 47299). In any other mode the setting does nothing. |
| Set Time of Use windows | Replaces all charge and discharge windows the working mode "Time of Use (LUNA2000)" follows (register 47255), like the field "Charge/discharge windows (Time of Use)" in the battery's settings. Write start-end/days/+ or -, several windows separated by ; — for example 00:00-06:00/12345/+; 17:00-23:59/12345/-. Days 1 = Monday to 7 = Sunday; + charges (from the grid only with "Charge battery from grid"), - discharges. At most 14 windows, not overlapping on the same day; end with 23:59 rather than 00:00. Empty removes all windows. A mistake fails the flow, and nothing is written. |
| Set remote charge/discharge mode | Who may command the battery from outside. "Local Control" means nobody, and that is what you want unless a third-party scheduler really is talking to the inverter. Any other value hands control over and overrides the storage working mode — without such a scheduler the battery then behaves unpredictably. (Modbus register 47589.) |
| Stop force charge/discharge | Stops a forced charge or discharge of the LUNA2000: the stop command (register 47100 = 0), then the discharge power (47249), the duration (47083) and the mode (47246 = 0) are cleared, so the next run starts from known values. The same as "Set force charge/discharge" with "Stop". The card is done once the stop is written; if it cannot be sent, the card fails and the timeline warns that the run may still be going. |
| Start charging until SoC % | Starts force charging the LUNA2000 at the given power until the target SoC is reached (registers 47101, 47247, mode 47246 = 1, start 47100). The card is done only once every value is written; if one step fails nothing starts, the card fails with the reason, and the timeline says it too. The power is capped at the battery's max charge or discharge power (registers 47075/47077); the card is refused while that limit is 0. Charging from the grid — at night, say — is also held to the battery's grid charge power (register 47242, which cannot exceed its limit 47244): if the battery charges slower than asked, raise it with "Set grid charge power". The log says so when the power asked for is above it. |
| Start discharging until SoC % | Starts force discharging the LUNA2000 at the given power until the target SoC is reached (registers 47101, 47249, mode 47246 = 1, start 47100). The card is done only once every value is written; if one step fails nothing starts, the card fails with the reason, and the timeline says it too. The power is capped at the battery's max charge or discharge power (registers 47075/47077); the card is refused while that limit is 0. |
| Start charging for minutes | Starts force charging the LUNA2000 at the given power for the specified duration (registers 47247, 47083, mode 47246 = 0, start 47100). The battery firmware stops automatically when the timer expires — on every battery, since the card sets the mode to "duration" itself. The card is done only once every value is written; if one step fails nothing starts, the card fails with the reason, and the timeline says it too. The power is capped at the battery's max charge or discharge power (registers 47075/47077); the card is refused while that limit is 0. Charging from the grid — at night, say — is also held to the battery's grid charge power (register 47242, which cannot exceed its limit 47244): if the battery charges slower than asked, raise it with "Set grid charge power". The log says so when the power asked for is above it. |
| Start discharging for minutes | Starts force discharging the LUNA2000 at the given power for the specified duration (registers 47249, 47083, mode 47246 = 0, start 47100). The battery firmware stops automatically when the timer expires — on every battery, since the card sets the mode to "duration" itself. The card is done only once every value is written; if one step fails nothing starts, the card fails with the reason, and the timeline says it too. The power is capped at the battery's max charge or discharge power (registers 47075/47077); the card is refused while that limit is 0. |
| Set max charge power | Sets the maximum battery charge power (register 47075, UINT32). The device setting and tile follow at once, and the value is read back on every poll. |
| Set max discharge power | Sets the maximum battery discharge power (register 47077, UINT32). The device setting and tile follow at once, and the value is read back on every poll. |
| Set charge from grid | Enables or disables charging the battery from the grid (register 47087). |
| Set grid charge cutoff SoC | Sets the state of charge at which grid charging stops (register 47088). Range: 20–100 %, default 50 %. |
| Set grid charge power | Sets the power at which the battery charges from the grid (register 47242). Requires 'Charge from grid' to be enabled. |
| Set charge cutoff SoC | Sets the maximum SoC the battery charges to during normal operation (register 47081). Valid range: 90–100 %, default 100 %. |
| Set discharge cutoff SoC | Sets the minimum SoC the battery discharges to (register 47082). Valid range: 12–20 %, default 15 %. |
| Set backup power reserve SoC | Sets the SoC reserved for backup / off-grid operation (register 47102). The battery will not discharge below this level during normal grid-tied operation. |
| Set max power charge from grid | Sets the ceiling for charging from the grid (register 47244, UINT32) — the upper limit that "Set grid charge power" (register 47242) cannot exceed. |
| Set grid-tied power limit | Sets register 47079, which Huawei calls "[Energy storage unit] Power limit of the grid-tied point": 0 W up to the inverter's maximum active power (Pmax), default Pmax, supported only by certain models (Solar Inverter Modbus Interface Definitions V3.0; the SPC177 register list does not have it). The table says no more about what it limits. A model without it refuses the write, which shows only in the app log. |
| Switch to off-grid operation | ⚠️ Sends Huawei's command to switch the system from grid-tied to off-grid operation (register 47604 = 0). With backup hardware the house is cut off from the grid and runs on battery and solar alone. Huawei documents no value for the way back in this register, so this app offers none. Needs a Backup Box or SmartGuard. Runs only with the confirmation ticked. Replaces "Set backup off-grid switch", whose "Disabled" sent this same command. |
| Set capacity control mode | Sets peak shaving (register 47954): off, active power limit, or apparent power limit (several inverters only). The limits per time period come from the FusionSolar app; the charge kept in reserve for it is set with "Set capacity control peak-shaving SoC" (register 47955). |
| Set capacity control peak-shaving SoC | Sets the charge the battery keeps in reserve for peak shaving (register 47955). Takes effect while peak shaving is on (register 47954). |

#### Battery LUNA 2000 (EMMA Modbus)

| Card | Description |
|---|---|
| Set storage working mode | What the battery does on its own (EMMA register 40000). For charging by price or forecast, use the Energy Management device instead. "Maximise Self-Consumption" — the normal choice: surplus solar charges the battery; when the sun is not enough, it supplies the house. "Time of Use (TOU)" — follows the charge and discharge windows stored in the system. This app does not write them: set them in the FusionSolar app first, or the battery may discharge on a sunny morning. "Fully Fed to Grid" — as much solar as possible into the grid; the battery charges only with what exceeds the inverter's maximum output and discharges below it. "Third-party Scheduling" — only if an outside platform is connected; otherwise nothing controls the battery. |
| Set excess PV energy use in TOU mode | Only takes effect in the working mode "Time of Use (TOU)": whether surplus solar goes into the grid or charges the battery (EMMA register 40001). In any other mode the setting does nothing. |
| Set max grid charging power | Sets the maximum power the LUNA2000 battery may draw from the grid for charging via EMMA Modbus (register 40002), 0–50 kW. Huawei defines it for the working mode "Time of Use (TOU)". |

#### Smart Charger (OCPP), Easee Charger (OCPP)

| Card | Description |
|---|---|
| Set max charging current (OCPP) | Sets the maximum charging current via OCPP SetChargingProfile (6–32 A). 0 A pauses a running session, as "Pause charging (OCPP)" does — which is what an EMS stop sends; a session paused that way resumes at the next current above 0. 1–5 A is refused. Without a running session, the value is used for the next start. |
| Start charging (OCPP) | Sends a RemoteStartTransaction command to the OCPP charger. |
| Start charging at (OCPP) | Starts charging at the given current. If the car is already plugged in and blocked, unblocks it at the specified ampere value. |
| Stop charging (OCPP) | Sends a RemoteStopTransaction command to the OCPP charger. |
| Pause charging (OCPP) | Pauses charging using a masked RemoteStop. The session snapshot is preserved so Resume stitches it back together. |
| Resume charging (OCPP) | Resumes a previously paused charging session. |
| Release charger (OCPP) | Sends ChangeAvailability → Operative to unlock the connector. Use if the charger is stuck Unavailable after a pause. |
| Start charging at current + phase (OCPP) | Starts charging at the specified current and phase count. Useful for solar surplus charging on mono-phase. |
| Set charging limit at current + phase (OCPP) | Changes the charging current and phase count during an active session. |
| Reboot charger (OCPP) | Sends a Reset command to the charger. Soft reboot gracefully stops the session; Hard restarts at once, without ending the session properly first. |
| Charge now at 16A | Charges at 16 A right away, whatever the default current: resumes a paused session at 16 A, raises a running session to 16 A, or starts a new one (also releasing a car that waits for a start). Fails if the charger is offline or no car is plugged in. |

#### Energy Management System

| Card | Description |
|---|---|
| Enable or disable EMS | Switches the Energy Management on or off — the same as the device's on/off switch. While off it keeps showing readings but starts, stops and adjusts nothing; devices it started stay as they are, and its mode reads Disabled. |
| Enable or disable EMS control for a device | Takes one charger or device out of EMS control, or hands it back — the same switch as in the EMS settings and the EMS Device widget, and saved there. While it is out, the EMS neither starts nor stops it. Fails if the device is no longer set up in the EMS. |
| Set electricity price (per kWh) | Sets the current variable electricity price. Only used when the EMS price model is set to Variable. Call this from your dynamic-tariff app (e.g. Tibber, EPEX). |
| Set price forecast | Feeds an hourly price array (e.g. the "Prices" token from "Power by the Hour"'s New prices received trigger, or any similar day-ahead price app) into the EMS for price-optimised EV charging (chargers set to "Solar & price-optimised"). Link this once from your price app's forecast trigger — no separate schedule needed. |
| Set car target charge (%) | Sets the car target charge. If the vehicle has no target-charge capability the value is kept virtually in the EMS. Also fires the matching "Set charge X%" flow so the vehicle is updated. |
| Set solar forecast correction factor | Sets the correction factor under App Settings → EMS → Data sources → Solar Forecast and saves it there, as if typed into the field. It applies at once to the forecast values, the chart and every EMS decision that uses the forecast, e.g. 0.8 when Solcast forecasts 25 % more than your plant yields. Allowed: 0.3–1.5; a value outside fails the flow. |
| Set battery price control value | Changes one value of a home battery's price-optimised charging under App Settings → EMS → Data sources → Home Batteries and saves it there, as if typed into the field; the EMS decides with it from its next cycle. Ranges as on the page: target SOC 0–100 %, charge power 0–50 kW, reserve peak hours 0–24 h, no grid charging above forecast 0–500 kWh (0 = off). A value outside fails the flow. Does not switch price control on or off. |

<!-- flow-cards:end -->

### More on some actions

#### Zero export and a standing feed-in limit (Inverter SUN2000 Modbus)

Many installations need a permanent limit — a
main fuse, or a grid operator's 60/70 % rule. Until 1.2.264, *Disable zero export* returned to
*Unlimited* regardless, and *Enable zero export* had already overwritten the watt limit with
0 W, so a negative-price flow quietly removed that protection. Both cards now hand the
earlier state back. Until 1.2.312 *Disable zero export* still fell back to *Unlimited* when
nothing was remembered — and the memory is cleared after each restore, so a second run took
the limit off after all. It now writes nothing in that case. *Enable/disable grid export
limit* keeps its literal meaning: off is *Unlimited*.

#### Forced charging and discharging (Battery LUNA2000 Modbus)

**Forced charging and discharging work like the Home Assistant integration** ([wlcrs/huawei_solar](https://github.com/wlcrs/huawei_solar/wiki/Force-charge-discharge-battery), since 1.2.302). A forced run ends either after a duration or at a target SoC, and register 47246 decides which: 0 = duration (47083), 1 = target SoC (47101). Until 1.2.301 no card wrote it, so each ran in the mode the battery happened to have — on a battery set to target SoC the minute cards ignored their minutes. Now:

| Card | Writes, in this order |
|---|---|
| Start charging / discharging for minutes | power (47247 / 47249) → minutes (47083) → mode 47246 = 0 → start (47100) |
| Start charging / discharging until SoC % | target SoC (47101) → power (47247 / 47249) → mode 47246 = 1 → start (47100) |
| Set force charge/discharge → charge / discharge | mode 47246 = 1 → start (47100): runs to the target SoC already set, at the power already set |
| Stop force charge/discharge — or *Set force charge/discharge* → stop | stop (47100 = 0) → discharge power 0 (47249) → minutes 0 (47083) → mode 47246 = 0 |

Each step waits for the one before it, and a step that fails starts nothing — the timeline says which value could not be written, instead of the run starting on a value left from an earlier one. Since 1.2.309 each card is also done only once its last register is written, as an HA service is, and a step that fails makes the card fail with the reason — a stop that cannot be sent included. A stop followed by a start in the same flow therefore reaches the battery in that order; before, the cards returned at once and both sequences wrote at the same time, which could end in a run of zero minutes or in charging after the stop. Runs on the same battery are also queued one after the other, so two flows firing at once cannot mix them either. After a stop, a discharge started with *Set force charge/discharge* needs a power again (a start card, or *Set force discharge power*), as in the HA integration.

**Retired in 1.2.304:** *Set force charge/discharge* and the three cards that fed it (*Set force charge target percentage*, *Set force charge power*, *Set force discharge power*). The start cards above bring their own power and target, and *Stop force charge/discharge* stops — the same set the HA integration has. Retired cards are no longer offered for new flows; existing flows keep working as described above.

*Set backup off-grid switch* was retired in 1.2.289: it sends nothing, because its "Disabled" sent Huawei's command to switch to off-grid operation — use *Switch to off-grid operation* instead. An older duplicate of *Start discharging until SoC %* is retired as well.

---

## Energy Dashboard

The app is fully configured for the Homey Energy Dashboard:

| Device                          | Homey category        | Function                                                  |
|---------------------------------|-----------------------|-----------------------------------------------------------|
| Kiosk                           | Solar panel           | Total yield → Generated energy                            |
| Inverter SUN2000 OpenAPI        | Solar panel           | Total PV energy → Generated energy (follows the inverter's DC counter, since 1.2.262) |
| Inverter SUN2000 Modbus         | Solar panel           | Total yield → Generated energy                            |
| Inverter SUN2000 EMMA Modbus    | Solar panel           | Total PV energy → Generated energy                        |
| iSitePower-M Solar              | Solar panel           | Total yield → Generated energy                            |
| Battery LUNA2000 OpenAPI        | Home battery          | Charged / discharged energy + charge/discharge power      |
| Battery LUNA2000 Modbus         | Home battery          | Charged / discharged energy + charge/discharge power      |
| Battery LUNA2000 EMMA Modbus    | Home battery          | Charged / discharged energy + charge/discharge power      |
| iSitePower-M Battery            | Home battery          | Charged / discharged energy + charge/discharge power      |
| Power Meter OpenAPI             | P1 meter (cumulative) | Grid import + grid export                                 |
| Power Meter Modbus              | P1 meter (cumulative) | Grid import + grid export                                 |
| Power Meter EMMA Modbus         | P1 meter (cumulative) | Grid import + grid export                                 |
| iSitePower-M Grid               | P1 meter (cumulative) | Grid import (Mains meter or energy balance); export always 0 |
| iSitePower-M Home               | Cumulative meter      | Total home consumption as cumulative import; export always 0 |
| Smart Charger (OCPP)            | EV charger            | Total energy charged → consumption                        |
| Smart Charger (EMMA Modbus)     | EV charger            | Total energy charged → consumption                        |

All LUNA2000 and iSitePower-M Battery variants are declared with `"batteries": ["INTERNAL"]` so Homey correctly identifies them as built-in home batteries in the Energy Dashboard.

> **Do not count the Kiosk and a SUN2000 inverter (Modbus, EMMA or OpenAPI) in Energy at the
> same time.** Both are solar-panel devices reporting the same plant production, so Homey would
> count it twice. Since 1.2.295 the kiosk device warns while a SUN2000 is paired and the kiosk is
> not excluded; exclude it under *Settings → Energy → Exclude from Energy*. The same applies to
> running the Modbus and OpenAPI devices for one installation side by side: two inverters,
> two batteries and two cumulative meters all describing one house.

---

## Dashboard Widgets

The app includes 12 Homey dashboard widgets that provide live and daily energy data at a glance. Widgets are added via **Homey → Dashboard → + → Huawei FusionSolar Manager**.

The energy widgets prefer the local devices — `sun2000_modbus` / `luna2000_modbus`, then the EMMA and SDongle A variants (and a DTSU666 for the grid) — and fall back to the FusionSolar cloud (OpenAPI, then iSitePower) and, for PV, a kiosk device. A device Homey shows as unavailable contributes nothing: the next one in the chain answers, or the figure shows as an em dash instead of its last value. Only lifetime `meter_*` totals keep their last reading. The charger widgets read the OCPP or EMMA charger, the EMS widgets the Energy Management device.

**Several inverters and batteries over Modbus** (since 1.3.9) — two SUN2000 with a LUNA2000 each on unit IDs 1 and 2, say — are taken together: solar power, battery power, today's yield and charge/discharge, lifetime yield and optimizer counts add up, and the battery's state of charge, charge ceiling, discharge floor and backup reserve are weighted by each battery's rated capacity (a plain mean where one does not report it). The grid comes from the inverter the meter is wired to, whichever was paired first. An inverter or battery that cannot be reached is left out of the sums, and one unit paired twice counts once. The EMMA and OpenAPI devices are not summed: their figures already cover the plant.

Behaviour shared by every widget:

- **Language** follows the language set in the Homey app itself (`homey.i18n.getLanguage()`, delivered with each API response), *not* the browser or phone language — an English phone paired with a German Homey still renders German widgets. Available in English, German and Dutch.
- **Theme** follows the dashboard's light/dark setting via Homey's own `--homey-*` CSS variables, not the OS-level `prefers-color-scheme`.
- **Polling stops entirely while the dashboard isn't on screen** and resumes with an immediate refresh when you return, so an open widget doesn't keep updating in the background. The per-widget intervals below therefore apply only while the widget is actually visible. One request at a time: a slow answer is never overtaken by the next.
- **When the app does not answer**, a widget says so on its first load instead of pulsing forever, and after two missed answers it dims its figures and marks them "not current" instead of showing them as live.
- **Numbers and dates** are written the way the dashboard language writes them — 8,8 kW and 9. Okt. in German, 8.8 kW and Oct 9 in English.
- **Homey's widget styling guide** throughout (since 1.2.300): Homey's padding classes, text sizes (nothing smaller than 14 px, the axes of the charts included), colours, lines and radii; no second card inside Homey's frame and no inner shadows; buttons and switches big enough for a finger, with haptic feedback where the device offers it. Each widget announces one height — the manifest's, or the one it measured on its first drawing — so nothing jumps on load.

---

### Solar Power Flow

A hub-layout widget showing real-time power flows between PV, house, grid and battery.

```
          ☀️  Solar PV
               |
  ⚡ Netz ────●──── 🔋 Batterie
               |
           🏠  Haus
```

- **Animated flow lines** — dashed lines move in the direction of actual energy flow, coloured by source (amber = PV, blue = house, green = charge/export, orange = discharge, red = import)
- **Hub circle** — ⚡ icon with colour-coded border:
  - 🟢 Green: PV producing, no grid import
  - 🟠 Orange: no PV, battery discharging (covering load)
  - 🔴 Red: grid import active
  - No border: night / standby
- **Battery node** shows SoC % below the power value; faded when no LUNA2000 is paired
- Sources beyond Modbus: the grid reading of an EMMA or cloud inverter when no meter device is paired, and a kiosk device's PV figure as the last resort
- Updates every **15 seconds** — the readings behind it change once a minute at most on a default Modbus poll

| Widget setting           | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| Activity threshold (W)   | 50 W    | Minimum power to show a flow as active (reduce flickering) |

---

### Grid Status (Netzampel)

A compact status widget with a pulsing colour circle indicating the current grid state.

- 🟢 **Green pulse** — exporting to grid (Einspeisung)
- 🔴 **Red pulse** — importing from grid (Netzbezug)
- 🟡 **Yellow pulse** — self-sufficient: the grid is quiet. Shows the house load and what covers it — PV, the battery, or both (at night with the battery carrying the house it used to say "0 W, PV covers load")
- ⚪ **Grey, no pulse** — no grid reading at all (no meter paired). Its own state on purpose: with nothing measured, both comparisons above are false, and the widget used to fall through to "self-sufficient" — announcing that the house covers its own load on the strength of no measurement whatsoever
- Stats row shows current PV power, battery power + SoC, and house consumption
- Battery stat is hidden when no LUNA2000 is paired
- Updates every **15 seconds**

| Widget setting           | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| Activity threshold (W)   | 50 W    | Minimum power for state changes (reduce flickering)      |

---

### Energy Balance (Energiebilanz)

Daily energy totals shown as relative bars, plus self-consumption and self-sufficiency metrics.

| Bar               | Source                                                                        |
|-------------------|-------------------------------------------------------------------------------|
| PV today          | `sun2000_modbus` → `meter_power.daily` (register 32114, resets at midnight); on a cloud-only plant the FusionSolar plant summary |
| Grid export today | `sun2000_modbus` → cumulative delta from midnight baseline; an EMMA power meter's own day counter where there is no cumulative counter |
| Grid import today | `sun2000_modbus` → cumulative delta from midnight baseline; an EMMA power meter's own day counter where there is no cumulative counter |
| House consumption | An EMMA meter's or the plant summary's own daily total where there is one, otherwise the balance at the house connection: what the inverter delivered − export + import. From a PV production figure (EMMA, cloud) the battery's net charge comes off first; with a battery paired but its day counters missing, the total is left unknown rather than guessed |

Local sources come first everywhere: a Modbus or EMMA reading is seconds old and the cloud
minutes at best, so the cloud is consulted only where nothing closer answers.

> **Midnight baseline:** the app records the cumulative grid export/import counter at 00:00:05 each night. Daily values are derived as `current − baseline`. If the app was not running at midnight the baseline is written on the next start — retried after 1, 5 and 15 minutes, because ten seconds after start is a guess at how long an inverter needs for its first reading, and losing that race used to cost the whole day its baseline in silence. If the counters are still unread after that, the log says so instead. A start writes only the baselines today still lacks, so a restart never re-takes the grid baselines from a later reading. Installations with none of the devices that carry cumulative counters — SUN2000 Modbus, EMMA inverter, FusionSolar cloud inverter or meter, iSitePower grid, solar or home — have nothing to snapshot at all, and the log says that too rather than repeating that it is writing one. An iSitePower plant without a grid device still gets its PV and house baselines. An EMMA power meter needs no baseline: its own day counters are used directly. A hint is shown in the widget until the baseline is available.

- **Eigenverbrauch %** — share of PV energy used on-site (not exported)
- **Autarkie %** — share of the house consumption that did not come from the grid: 1 − import ÷ consumption, against the very figures shown beside it
- Battery charged / discharged row is shown only when a LUNA2000 is paired
- iSitePower plants have their day too, from midnight baselines of their lifetime totals (PV, house, grid)
- The "values from midnight" hint shows only where a baseline is really still missing; a figure that does not exist is an em dash, not "…"
- Updates **once a minute** — these are day totals

---

### Battery Status (Batteriestatus)

Detailed battery state at a glance.

- **SoC bar** — colour coded: green ≥ 40 %, orange 20–40 %, red < 20 %
- **Charge / discharge power** with direction label and a pulsing icon
- **Time remaining** — estimated time until the battery stops, shown prominently below the SoC bar: up to its maximum charge when charging, down to the higher of its discharge cutoff and backup reserve when discharging (each as far as the battery reports it, otherwise 100 % / 0 %). An EMMA battery's own kWh to full and to empty come first; otherwise the battery's reported capacity, then the widget setting. With no capacity known, no time is shown
- **Today's stats** — energy charged and discharged today (kWh)
- **State** in the dashboard language — Huawei's "Running" becomes charging, discharging or standby by the power
- Shows the first battery that answers; **"Battery unreachable"** when none does, **"No battery"** only when none is paired
- Updates every **15 seconds**

| Widget setting             | Default | Description                                                   |
|----------------------------|---------|---------------------------------------------------------------|
| Battery capacity (kWh)     | 0 (empty) | Only for batteries that do not report their own capacity — a LUNA2000 over Modbus does (register 37758), and that figure is used automatically. Left at 0, no time is shown rather than a guessed one. LUNA2000 examples: 1 module = 5 kWh, 2 modules = 10 kWh, 3 modules = 15 kWh |

---

### Daily Yield (Tagesertrag)

At-a-glance summary of today's solar production.

- **Today's yield** — large display in kWh (auto-scales to MWh above 1 000 kWh)
- **Lifetime total** — cumulative production. Both figures come from the same source and
  cover the same period; on a cloud plant that is the FusionSolar plant record, which may
  start later than the inverter itself. The inverter's own lifetime counter stays on the
  device under its own name.
- **Optimizer count** — online / total (shown only when optimizers are detected)
- **CO₂ saved** — calculated from today's yield × emission factor
- iSitePower plants: today from a midnight baseline of the lifetime total
- Updates **once a minute** — these are day totals

| Widget setting              | Default     | Description                                                        |
|-----------------------------|-------------|--------------------------------------------------------------------|
| CO₂ factor (g/kWh)          | 401 g/kWh   | Grid emission factor. DE = 401, CH = 29, AT = 108, EU avg = 255   |

---

### Charger Status (Ladestatus)

Live state of an EV charger (OCPP or EMMA): charging power, session energy, active current/phase limit and connection state at a glance. Phases and limits are written in the dashboard language. Updates every **10 seconds**; the session clock ticks every second.

---

### Charging Sessions (Ladesitzungen)

The most recent charging sessions — energy delivered and duration per session; an OCPP session also shows its current and phases and the charger's stop reason, translated (*Car disconnected*, *Stopped remotely* …). Prefers a paired OCPP charger, whose history is the richer one, and otherwise falls back to the EMS's own charge sessions, so the widget is useful with any charger brand — those rows name the car and the solar share instead of a stop reason. Every session in progress appears at the top, labelled *In progress* or *Paused* — two chargers running at once show as two. The widget grows with its rows instead of scrolling inside a fixed box. Updates every **30 seconds**; running clocks tick every second. A session's cost and its split into paid and forgone feed-in are shown in the session list in App Settings, not on the widget.

| Widget setting   | Default | Description                                                   |
|------------------|---------|---------------------------------------------------------------|
| Sessions to show | Last 5  | Last 5 or last 10; sessions in progress count towards it      |

---

### EMS History (EMS Verlauf)

Recent Energy Management System events — mode changes, device start/stop and charger current steps — the same feed shown in App Settings, on your dashboard. Pages through calendar days (also across a clock change); after the first load only new events are fetched. No settings — the former "Time window" was never read and is gone. Updates every **30 seconds**; ↻ reloads the whole history.

---

### Sensor Chart (Sensor-Verlauf)

A configurable time-series chart of up to four power readings, for a quick trend view directly on the dashboard. Any one series is enough to start it.

- **6 h to 7 days.** The app keeps one point a minute for the last 25 hours and a quarter-hour average (with its low and high) for a week; the views beyond 24 hours draw from the latter. Until 1.2.299 only the 25 hours existed, and 48 H, 72 H and 7 D all showed them.
- **Gaps stay gaps.** A device that is unreachable contributes nothing for that stretch, and the line breaks there; the legend shows "—" instead of a last value that is no longer true.
- **Light on the network.** The app thins each series to at most 240 points before sending (largest-triangle sampling, which keeps peaks), a few kilobytes instead of every stored point.
- Dates follow the dashboard's language (9.10. in German, 10/9 in English).
- Updates **once a minute**.

| Widget setting      | Default | Description                                                         |
|---------------------|---------|---------------------------------------------------------------------|
| Series 1–4          | —       | Any power reading (`measure_power`, `measure_power.load`) of this app's devices |
| Series 1–4 label    | empty   | Optional name for the legend                                        |
| Time range (hours)  | 24      | Starting view; snaps to the nearest step (6 h, 12 h, 24 h, 48 h, 72 h, 7 d) |

---

### EMS Device (EMS-Gerät)

Live status card for a single EMS-controlled device — pick any configured **EV charger**, **heat pump**, **boiler**, **pool pump**, **dehumidifier** or **air conditioner** via a search field in the widget settings (add the same widget multiple times for several devices).

- **EV charger:** connection state, current power (green dashed underline + bolt icon while actively charging), current session's energy and an estimated remaining-time-to-target, a **charging-mode selector** (Solar / Solar + Off-peak / Solar + Low tariff / Solar + Price / Always charge), and an **"Instant charge" switch** — the same `charge_now` capability as the device tile's own button, for a one-off full-power charge without switching the mode to "Always charge" (device-wide: applies to every charger on this EMS device, not just the one shown on the card). If a car is assigned to the charger, a sub-card shows its name, a charge-level progress bar (with a marker at the charge limit), and charge level / plan (the car's configured "ready by" deadline, shown only in "Solar + Price" mode) / charge limit as three labelled stats. Three buttons below it — **80 %**, **90 %**, **100 %** — set that car's charge target, the same as the *Set car target charge (%)* flow action: the EMS stores it and fires *EMS: set car target charge*, so your vehicle flow can pass it on to the car. A failed write marks the button red; the next refresh shows the real target. The remaining-time estimate needs the car's battery capacity (set under Cars in App Settings), current power, current SoC and target SoC — it's a simple estimate (constant-power assumption), not a real navigation-grade prediction.

- **Heat pump / boiler / pool / dehumidifier / air conditioner:** on/off state, current power, today's energy and runtime (reset at local midnight, saved to the device store roughly every 60s so it survives an app restart), and the configured **minimum surplus (W)** threshold (read-only — change it in App Settings)
- **All devices:** an **"EMS control" switch** — turns EMS's control of *this specific device* on or off, independent of any other device or the app-wide settings. Off means EMS leaves it alone entirely (no start/stop/current commands).
- Updates every **15 seconds**, matching the EMS's own tick — polling faster only re-fetches that tick's cached snapshot. Responsiveness doesn't suffer, because every control you change (switch, charging-mode dropdown) applies optimistically and then confirms itself with an immediate refresh rather than waiting for the next poll. If the write fails, the control springs back to its previous state and shows the reason instead of silently reverting later. A change runs one EMS tick at once — it no longer restarts the loop, whose first tick only observes, so a change used to wait a full interval. The power shown for a charger is what it measures, not the floor the EMS uses for control (amps × phases × 230 V)

---

### EMS Battery Usage (EMS Batterienutzung)

Aggregate view of the EMS's Home Battery SoC and its priority zones — mirrors the **Battery** section of App Settings.

- Colour-coded SoC bar (green = solar free, red = protected/hard-stop) with a marker at the stop, and the stored energy beside it (e.g. "8.7 of 13.4 kWh") where the battery capacity is known
- **Stop below** is editable directly on the widget and writes the setting the EMS actually stops at: with the surplus ramp configured its lower point (a value at or above the ramp's upper point is refused, with the limit), otherwise the single battery floor. An edited value confirms itself immediately, and on failure restores the previous value with the reason shown
- Status line shows whether price-optimised grid-charging is currently active or holding discharge, when configured
- Updates every **15 seconds**, matching the EMS's own tick

---

### EMS Forecast (EMS Prognose)

Two stacked charts showing what the EMS is planning against: the Solcast **solar forecast** (kW per slot, next up to 24h, bar chart) and the **electricity price** — whichever tariff model is actually configured under App Settings → Electricity Price, not just "Price forecast":

| Tariff model (App Settings) | Widget shows |
|------------------------------|--------------|
| Fixed price                  | The fixed value, as a single number (no chart — it doesn't change) |
| Variable (via flow)          | The last value pushed by the `Set electricity price` flow action, as a single number (no future is known) |
| Low / high tariff            | A 24h hourly step-chart built from the configured weekday high/low windows |
| Tariff zones                 | The next 24 hours from the configured zones, with the name of the zone in force now |
| Price forecast (day-ahead)   | The real ingested forecast — colour-graded cheap→green to expensive→red, same as the settings-page preview |

The current slot/value is highlighted in both charts where a timeline is shown; a ↻ button forces an immediate re-read (the underlying forecasts themselves still only refresh server-side at Solcast's/your price source's own interval — this doesn't trigger a new fetch from either service). Each section shows its own "not configured" hint when that data source isn't set up — and only then: a Solcast fetch error (a rate-limit pause, one of two sites failing) shows as a warning beside the last good forecast, and a forecast too old to trust shows no figure for "now". No settings — reads directly from the EMS device. Updates every **60 seconds**.

---

## Languages

English, German and Dutch are complete — the app's own texts, the widgets, and everything Homey
renders from `app.json`. Counted on 1.2.324:

| Surface | What it covers | en | de | nl |
|---|---|---|---|---|
| `locales/*.json` | App code, pairing, the entire settings page | 869 | 869 | **869** |
| Widgets (12) | All dashboard widget text | 225 | 225 | **225** |
| `app.json` | Driver names, device settings, capability titles, flow cards | 1738 | 1724 | **1724** |

### What a Dutch user sees today

Dutch throughout: the settings page, all twelve widgets, pairing, every message the app shows or
logs itself, driver names in the device list, device setting labels, capability titles on the tile
and flow card text. Only units have no `nl` (see Scope); Homey shows them from `en`, and they are
the same in every language.

### Scope

Dutch is complete. The fourteen `app.json` entries still without `nl` are `units` — `W`, `kW`,
`kWh`, `%`, `/kWh` — which are identical in every language and which `de` does not carry either.

Driver names follow the German wording as the guide to what counts as a product designation:
whatever `de` leaves in English stays English in `nl` too (`Inverter`, `Smart Charger`,
`SDongle A`, `Solar`). Only what `de` translates is translated — `Battery` → `Batterij`,
`Power Meter` → `Energiemeter`, `Plant` → `Installatie`, `Grid` → `Net`, `Home` → `Huis`.

Flow card titles keep Homey's `!{{a|b}}` toggle syntax and `[[token]]` placeholders. Both were
checked mechanically across all 540 translated strings before they were written to `app.json`:
tokens must appear in the translation exactly as in the English, and every toggle must still
carry two non-empty branches.

### French

Ten strings in widget metadata used to carry an `fr` translation, out of 1361 translatable
objects — the remainder of an abandoned start, with no `locales/fr.json` behind it. A French
user therefore saw ten French labels in an otherwise English app, which reads worse than
consistent English. They were removed in 1.2.60. Adding French means starting from `en`, not
from those ten.

---

## Logs and the Change Log

**App Settings → Logs** has two panels.

**Changes** (since 1.2.275) lists what changed, per device, and survives restarts and updates —
the last 50 entries per device, kept in the device's own store:

| Source | What is recorded |
|--------|------------------|
| Settings | A saved device settings page: every changed setting from old to new (passwords, keys, codes and user names masked) |
| Flow | Every action flow card that ran, with its arguments. Data feeds (electricity price, price forecast) appear in the live log only |
| Device | A value changed on the device itself — in the FusionSolar app, say — once the app reads it (`Setting follows the device`, `Mode dropdown follows the device`). A poll that read the device before a save ended stores nothing, so the value just saved is not briefly put back (`Setting sync skipped … read before the last save` in the live log, since 1.2.323) |
| Failed | A settings page that was not saved (`Settings not saved: …`), a write the device refused (the setting is put back where the app can), and a flow card the app refused, with the reason |

A repeat of the same entry within 15 minutes — a flow that adjusts a charger every minute —
counts up instead of pushing everything else out. The panel shows the newest 300 entries across
all devices.

**Live log** is everything the app writes, the last 1500 lines in memory. A device that keeps
polling fine writes its `Poll OK` line once every 15 minutes, with the number of polls it stands
for; a failure that repeats unchanged is written in full three times, then every 15 minutes with a
count — so a few devices cannot push the morning's problem out of the 1500 lines. It holds every write to a device
with `Write start`, `Write OK` or the failure, each saved settings page (`Settings saved: …`)
and each flow card (`[flow] …`). It is cleared by a restart or an update, and is what
*More → Apps → FusionSolar → Submit App Logs* sends.

## Technical Background

- **Kiosk:** HTTP polling of the public FusionSolar Kiosk API
- **OpenAPI:** HTTPS connection to the Huawei FusionSolar Northbound API (xsrf-token authentication, automatic re-login on session expiry). Devices from the same plant share a common session and coordinator — one set of calls per poll for all of them: the plant KPI, then one device-KPI call per device type, 1.5 s apart; the device list is fetched once a day, and again after 15 minutes while a device is missing from it. The poll interval is the shortest set on any device of the plant (5–60 min, default 5). A 407 refusal (calling too often) pauses all calls for 15 minutes. A cached reading bridges up to three poll cycles and is then dropped rather than shown; a timed-out call skips the rest of that cycle instead of taking the plant's devices offline
- **Modbus (SUN2000/SDongle):** TCP connection via [`jsmodbus`](https://www.npmjs.com/package/jsmodbus) following the Huawei SUN2000 Modbus Interface Definition A. All Modbus devices on the same host share a serialised queue (`withHostLock`) — no concurrent connections. Each poll opens its own connection, waits a second for the device to settle, reads in batches of up to 64 registers and closes it before the next device's turn. A failed poll is retried once after 1.5 s; after three failed polls a host is left alone for 60 s, so it does not stall the devices behind the same dongle. Reads time out after 5 s, writes after 25 s; a write or a settings-page probe interrupts a running poll rather than queueing behind it. A register that was not read is told apart from one the device does not have (since 1.2.316)
- **EMMA Modbus:** TCP connection to the EMMA (Energy Management Assistant, unit ID 0). All four EMMA device types (inverter, battery, meter, Smart Charger) are read through the EMMA — no SDongle or DTSU666 required. The Smart Charger is read-only this way (model, rated power, phase voltages, energy, temperature); charge control is the OCPP charger device. R/W access to ESS control registers (40000–40002) via FC06/FC16
- **Energy Management System:** A decision loop running on Homey, every 15 seconds by default (adjustable from 10 to 60 s). Reads PV/house/grid/battery from the paired devices, allocates solar surplus across a fixed load priority (instant → battery-protect → EV solar/off-peak → simple loads), and acts by firing flow trigger cards rather than writing to devices directly (brand-agnostic). Internally modular (`lib/ems/*` mixins: charger control, simple devices, battery zones, price, export limit, history) with debounced history persistence, config validation and a diagnostics snapshot (`getEmsDiag`). Core decision logic is covered by unit tests (`node --test`).
- **OCPP 1.6:** One WebSocket server per configured port (8887 by default) running inside Homey; a device moves between them when its port changes, and a server stops when its last device leaves. Station IDs are unique per server (a second device is refused and queued), and the device without a Station ID keeps the charger it took while that charger stays connected. Implements BootNotification, Heartbeat, StatusNotification, MeterValues, StartTransaction, StopTransaction, Authorize, DataTransfer. Outgoing calls are fully async with response tracking (`_pendingCalls` map, 10 s timeout): RemoteStartTransaction, RemoteStopTransaction, SetChargingProfile (TxDefaultProfile stackLevel 0 / TxProfile stackLevel 1, `chargingRateUnit: 'W'`, Absolute kind), ChangeAvailability, Reset. SetChargingProfile uses Watts (0 A → 1 W to work around a Huawei firmware bug where a 0 W TxDefaultProfile is unreliable). Supports optional HTTP Basic Authentication per station. Station ID is extracted from the WebSocket URL path (`ws://homey-ip:8887/[station-id]`). Masked Pause/Resume stitches two physical transactions into a single logical session preserving cumulative energy and start time. Power-verified start: the `charging_started` trigger fires only after > 100 W is confirmed (90 s watchdog). Offline watchdog triggers a flow card after 3 minutes of silence and suppresses alerts for 5 minutes after a reboot command.

---

## License

MIT License – see [LICENSE](LICENSE)

---

## Support

If this app saves you time or money, a small donation is always appreciated:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/AndiWirz)

---

## AI Development

This app was developed entirely with the assistance of **Claude (Anthropic AI)**.

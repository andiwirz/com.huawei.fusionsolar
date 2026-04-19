# Huawei FusionSolar Manager – Homey App

**App ID:** `com.huawei.fusionsolar`
**SDK:** Homey SDK 3
**Minimum firmware:** Homey >= 12.4.5
**Compatible with:** Homey Pro (Early 2019) and all newer Homey devices running firmware >= 12.4.5

---

## Supported Connection Types

This app supports four independent connection methods to a Huawei FusionSolar installation:

| Connection      | Description                                                                        |
|-----------------|------------------------------------------------------------------------------------|
| **Kiosk**       | Reads plant data via the public Kiosk URL (no account required)                   |
| **OpenAPI**     | Connects via the official Northbound API using a FusionSolar account              |
| **Modbus TCP**  | Direct communication with SUN2000, LUNA2000 and DTSU666 over the local network   |
| **EMMA Modbus** | Direct communication via the EMMA Energy Management Module (SUN2000MA)            |

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

---

### Inverter SUN2000 (OpenAPI)

Connection via the Huawei FusionSolar Northbound API. Provides inverter, grid and PV string data.

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| Solar power             | DC input power from PV strings (W)                                |
| Active power            | AC output power (W)                                               |
| Heat sink temperature   | Internal inverter temperature (°C)                                |
| Total yield             | Cumulative total yield (kWh)                                      |
| Daily yield             | Today's energy yield (kWh)                                        |
| PV1 / PV2 voltage       | DC voltage of PV strings (V)                                      |
| PV1 / PV2 current       | DC current of PV strings (A)                                      |
| Grid active power       | Current: positive = import, negative = export (W)                 |
| Total grid export       | Cumulative total energy exported to grid (kWh)                    |
| Total grid import       | Cumulative total energy imported from grid (kWh)                  |

> Grid values are sourced from the plant's Power Sensor (type 47) or Grid Meter (type 17).

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
| State of health          | SoH in percent (%)                                   |
| Battery status           | Operating state as text (e.g. Running, Standby)      |

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

---

### SDongle A (Modbus)

Direct Modbus TCP connection to the Huawei SDongle A (unit ID 100).

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| House Consumption       | Current house load / consumption power (W)                         |
| Solar Input Power       | Total PV input power (W)                                           |
| Grid Power              | Current: positive = import, negative = export (W)                  |
| Battery Power           | Current: positive = charging, negative = discharging (W)           |
| Total Active Power      | Net system active power (W)                                        |
| Connection Type         | SDongle connection type (N/A, WLAN, 4G, WLAN-FE)                  |

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
| PV1 / PV2 voltage           | DC voltage of PV strings (V)                              |
| PV1 / PV2 current           | DC current of PV strings (A)                              |
| Inverter status             | Operating state as text                                   |
| Active power control mode   | Configurable feed-in limit                                |
| Grid active power           | Current (W) — only when DTSU666 is connected              |
| Total grid import           | Cumulative (kWh) — only when DTSU666 is connected         |
| Total grid export           | Cumulative (kWh) — only when DTSU666 is connected         |

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

---

### Battery LUNA2000 (Modbus)

Direct Modbus TCP connection to the LUNA2000 battery via SUN2000 / SDongle.

#### Readable Values

| Capability                  | Description                                          |
|-----------------------------|------------------------------------------------------|
| Battery power               | Current: positive = charging, negative = discharging (W) |
| State of charge             | SoC in percent (%)                                   |
| Total charged energy        | Cumulative since commissioning (kWh)                 |
| Total discharged energy     | Cumulative since commissioning (kWh)                 |
| Battery charge power        | Current charge power (W)                             |
| Battery discharge power     | Current discharge power (W)                          |
| Max charge power            | Configured maximum (W)                               |
| Max discharge power         | Configured maximum (W)                               |
| Daily charged energy        | Energy charged today (kWh)                           |
| Daily discharged energy     | Energy discharged today (kWh)                        |
| Battery status              | Operating state as text (e.g. Running, Standby)      |

#### Controllable Values

| Capability                    | Options                                                                                              |
|-------------------------------|------------------------------------------------------------------------------------------------------|
| Storage working mode          | Adaptive · Fixed charge/discharge · Maximise self-consumption · TOU · Full feed-in · Third party    |
| Force charge/discharge        | Stop · Charge · Discharge                                                                            |
| Excess PV energy (TOU)        | Feed into grid · Charge battery                                                                      |
| Remote charge/discharge mode  | Local control · Max self-consumption · Full feed-in · TOU · AI · Third party                        |

---

### Battery LUNA2000 (EMMA Modbus)

Reads battery data via the EMMA Energy Management Module (unit ID 0).

#### Readable Values

| Capability               | Description                                          |
|--------------------------|------------------------------------------------------|
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                   |
| Backup SoC               | Reserved emergency SoC (%)                           |
| Chargeable capacity      | Currently available charge capacity (kWh)            |
| Dischargeable capacity   | Currently available discharge capacity (kWh)         |
| Total charged energy     | Cumulative since commissioning (kWh)                 |
| Total discharged energy  | Cumulative since commissioning (kWh)                 |
| Daily charged energy     | Energy charged today (kWh)                           |
| Daily discharged energy  | Energy discharged today (kWh)                        |

#### Controllable Values

| Capability                  | Options / Range                                                             |
|-----------------------------|-----------------------------------------------------------------------------|
| Storage working mode        | Self-consumption · Full feed-in · TOU · Third party                         |
| Excess PV energy (TOU)      | Feed into grid · Charge battery                                             |

#### Settings

| Setting                        | Description                                      |
|--------------------------------|--------------------------------------------------|
| Max grid charging power (kW)   | Writes register 40002 (0–50 kW, EMMA R/W)        |

---

### Power Meter (Modbus)

Direct Modbus TCP connection to the DTSU666 smart meter via SUN2000 / SDongle. Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Phase A/B/C voltage     | Phase voltages (V)                                        |
| Phase A/B/C current     | Phase currents (A)                                        |
| Phase A/B/C power       | Phase power (W)                                           |

---

### Power Meter (EMMA Modbus)

Reads grid data via the EMMA Energy Management Module (unit ID 0). Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Grid import today       | Energy imported from grid today (kWh)                     |
| Grid export today       | Energy exported to grid today (kWh)                       |
| House consumption       | Current house load / consumption power (W)                |
| House consumption today | Total consumption today (kWh)                             |

---

### Smart Charger (EMMA Modbus)

Reads EV charger data via the EMMA Energy Management Module.

| Capability           | Description                              |
|----------------------|------------------------------------------|
| Rated power          | Maximum charging power of the station (W)|
| Model name           | Charger product name                     |
| Phase A/B/C voltage  | Current phase voltages (V)               |
| Temperature          | Internal charger temperature (°C)        |
| Total energy charged | Cumulative since commissioning (kWh)     |

---

## Installation

### Requirements

#### Kiosk
- FusionSolar Kiosk URL (available in the FusionSolar app under Share → Kiosk URL)

#### OpenAPI
- FusionSolar account with Northbound API enabled
- Username and System Code (API password)
- Regional server, e.g. `https://eu5.fusionsolar.huawei.com`

#### SDongle A
- SDongle A reachable over LAN
- Modbus TCP enabled (default port: **502**, alternative: **6607**)
- Modbus Unit ID: **100** (older firmware may use **0**)
- Static IP address recommended

#### Modbus (SUN2000 / LUNA2000 / DTSU666)
- SUN2000 inverter or SDongle reachable over LAN
- Modbus TCP enabled (default port: **502**, SDongle: **6607**)
- Static IP address recommended (DHCP reservation in router)

#### EMMA Modbus
- SUN2000MA Energy Management Module reachable over LAN
- Modbus TCP enabled (default port: **502**)
- Modbus Unit ID: **0**
- Static IP address recommended

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
| Update interval   | 10 min   | How often data is fetched (min. 10 min)       |

### OpenAPI

| Setting           | Default                    | Description                                   |
|-------------------|----------------------------|-----------------------------------------------|
| Server URL        | eu5.fusionsolar.huawei.com | Regional FusionSolar API server               |
| Username          | –                          | FusionSolar API username                      |
| System Code       | –                          | API password                                  |
| Plant code        | –                          | Set automatically during pairing              |
| Update interval   | 10 min                     | How often data is fetched (min. 10 min)       |

> Huawei rate-limits API requests. An interval below 10 minutes is not recommended.

### Modbus (SUN2000 / LUNA2000 / DTSU666)

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SUN2000 / SDongle                   |
| Modbus port          | 502     | SDongle typically uses 6607                   |
| Modbus unit ID       | 1       | Unit ID of the device (default: 1)            |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

### SDongle A Modbus

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SDongle A                           |
| Modbus port          | 502     | Alternative: 6607                             |
| Modbus unit ID       | 100     | Older firmware may use 0                      |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

### EMMA Modbus

| Setting                         | Default | Description                                      |
|---------------------------------|---------|--------------------------------------------------|
| IP address                      | –       | IP of the EMMA Energy Management Module          |
| Modbus port                     | 502     | Default port of the EMMA                         |
| Modbus unit ID                  | 0       | EMMA uses unit ID 0                              |
| Update interval (s)             | 60      | How often data is polled (min. 10 s)             |
| Max grid charging power (kW)    | 5       | Battery only: writes EMMA register 40002         |

---

## Flow Cards

### Triggers

| Card                              | Device                          | Token          | Description                               |
|-----------------------------------|---------------------------------|----------------|-------------------------------------------|
| Power output changed              | Kiosk                           | `power` (W)    | Fires on every power change               |
| Daily yield updated               | Kiosk                           | `daily_energy` | Fires when daily yield is updated         |
| Power output changed (Modbus)     | Inverter SUN2000 Modbus/EMMA    | `power` (W)    | Fires on every power change               |
| Power output changed (OpenAPI)    | Inverter SUN2000 OpenAPI        | `power` (W)    | Fires on every power change               |
| Battery SoC changed               | LUNA2000 Modbus/EMMA            | `soc` (%)      | Fires on every SoC change                 |
| Battery charging state changed    | LUNA2000 Modbus/EMMA            | `state`        | `charging` / `discharging` / `idle`      |
| Battery SoC changed               | Battery OpenAPI                 | `soc` (%)      | Fires on every SoC change                 |
| Battery charging state changed    | Battery OpenAPI                 | `state`        | `charging` / `discharging` / `idle`      |
| Grid export started               | Power Meter Modbus/EMMA         | `power` (W)    | Fires when switching from import to export|
| Grid import started               | Power Meter Modbus/EMMA         | `power` (W)    | Fires when switching from export to import|

### Conditions

| Card                           | Device                         | Description                                    |
|--------------------------------|--------------------------------|------------------------------------------------|
| Is currently producing         | Kiosk                          | Checks if the plant is currently generating    |
| Is currently producing (Modbus)| Inverter SUN2000 Modbus/EMMA   | Checks if the inverter is currently generating |

---

## Energy Dashboard

The app is fully configured for the Homey Energy Dashboard:

| Device                          | Homey category  | Function                                                  |
|---------------------------------|-----------------|-----------------------------------------------------------|
| Kiosk                           | Solar panel     | Total yield → Generated energy                            |
| Inverter SUN2000 OpenAPI        | Solar panel     | Inverter total yield → Generated energy                   |
| Inverter SUN2000 Modbus         | Solar panel     | Total yield → Generated energy                            |
| Inverter SUN2000 EMMA Modbus    | Solar panel     | Total yield → Generated energy                            |
| Battery LUNA2000 OpenAPI        | Home battery    | Charge and discharge power                                |
| Battery LUNA2000 Modbus         | Home battery    | Charged / discharged energy + charge/discharge power      |
| Battery LUNA2000 EMMA Modbus    | Home battery    | Charged / discharged energy + charge/discharge power      |
| Power Meter OpenAPI             | P1 meter        | Grid import (cumulative) + grid export (cumulative)       |
| Power Meter Modbus              | P1 meter        | Grid import (cumulative) + grid export (cumulative)       |
| Power Meter EMMA Modbus         | P1 meter        | Grid import (cumulative) + grid export (cumulative)       |

---

## Technical Background

- **Kiosk:** HTTP polling of the public FusionSolar Kiosk API
- **OpenAPI:** HTTPS connection to the Huawei FusionSolar Northbound API (xsrf-token authentication, automatic re-login on session expiry). Devices from the same plant share a common session (one API call per interval for all devices)
- **Modbus (SUN2000/SDongle):** TCP connection via [`jsmodbus`](https://www.npmjs.com/package/jsmodbus) following the Huawei SUN2000 Modbus Interface Definition A. All Modbus devices on the same host share a serialised queue (`withHostLock`) — no concurrent connections
- **EMMA Modbus:** TCP connection to the SUN2000MA Energy Management Module (unit ID 0). All three EMMA device types (inverter, battery, meter) read from the same EMMA register range — no SDongle or DTSU666 required. R/W access to ESS control registers (40000–40002) via FC06/FC16

---

## License

MIT License – see [LICENSE](LICENSE)

---

## AI Development

This app was developed entirely with the assistance of **Claude (Anthropic AI)**.

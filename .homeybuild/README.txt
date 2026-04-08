The app supports three independent connection methods: the public Kiosk URL (no account required), the official FusionSolar Northbound API, and direct Modbus TCP communication with the SUN2000 inverter, LUNA2000 battery and DTSU666 smart meter.

Each device type appears separately in Homey. The SUN2000 inverter reports solar power, PV string voltages and currents, daily and total energy yield. The LUNA2000 battery shows state of charge, charge and discharge power, and supports direct control of the storage working mode. The DTSU666 smart meter tracks grid import and export energy across all three phases and integrates with the Homey Energy Dashboard as a P1 meter. The Kiosk and OpenAPI devices provide plant-level energy data including daily, monthly and yearly totals.

All values are available in Homey Insights and Flows — for example to switch on a heat pump when grid export starts, or to limit loads when battery state of charge drops below a threshold.

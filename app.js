'use strict';

const { App }             = require('homey');
const OpenAPICoordinator  = require('./lib/openapi-coordinator');

class FusionSolarKioskApp extends App {

  async onInit() {
    this.log('FusionSolar app is running...');

    this._coordinator = new OpenAPICoordinator(this.homey);

    this.homey.flow
      .getConditionCard('is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    this.homey.flow
      .getConditionCard('modbus_is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });
  }

  async onUninit() {
    this.log('FusionSolar app is stopping...');
  }

  getCoordinator() {
    return this._coordinator;
  }

}

module.exports = FusionSolarKioskApp;

'use strict';

const { powerPayload } = require('../../lib/widget-data');

// The same payload as the other live power widget (solar-power-flow / netzampel); the two
// files used to be identical copies of it.
module.exports = {
  async getData({ homey }) {
    return powerPayload(homey);
  },
};

'use strict';

const { lang } = require('../../lib/widget-data');

module.exports = {
  async getData({ homey, query }) {
    return { ...homey.app.getSensorChartData(query), lang: lang(homey) };
  },
};

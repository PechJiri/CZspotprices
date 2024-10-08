'use strict';

module.exports = {
  async getHourlyPrices({ homey }) {
    const prices = [];
    for (let i = 0; i < 24; i++) {
      const price = await homey.devices.getCapabilityValue(`hour_price_CZK_${i}`);
      prices.push(price);
    }
    return prices;
  }
};

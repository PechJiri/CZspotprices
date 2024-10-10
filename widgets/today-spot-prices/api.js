'use strict';

module.exports = {
  async getHourlyPrices({ homey }) {
    try {
      const device = await homey.drivers.getDriver('cz-spot-prices').getDevice();
      const hourlyPrices = [];
      
      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        const isHighTariff = !(await device.getSetting(`hour_${i}`));
        hourlyPrices.push({ hour: i, price, isHighTariff });
      }

      const averagePrice = await device.getCapabilityValue('daily_average_price');

      return {
        hourlyPrices,
        averagePrice
      };
    } catch (error) {
      console.error('Error fetching hourly prices:', error);
      throw error;
    }
  }
};
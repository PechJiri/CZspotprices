'use strict';

let updateCallback = null;

module.exports = {
  async getSpotPrice({ homey }) {
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();

      if (devices.length === 0) {
        throw new Error('Nenalezeno žádné zařízení');
      }

      const device = devices[0]; 

      const currentSpotPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentSpotIndex = await device.getCapabilityValue('measure_current_spot_index');

      // Přidání časové zóny (např. "Europe/Prague")
      const currentHour = new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Prague' });
      const nextHour = (parseInt(currentHour, 10) + 1) % 24;

      const nextHourPrice = await device.getCapabilityValue(`hour_price_CZK_${nextHour}`);
      const nextHourIndex = await device.getCapabilityValue(`hour_price_index_${nextHour}`);

      const averagePrice = await device.getCapabilityValue('daily_average_price');

      return {
        currentSpotPrice,
        currentSpotIndex,
        nextHourPrice,
        nextHourIndex,
        averagePrice
      };
    } catch (error) {
      console.error('API Chyba v getSpotPrice:', error);
      throw error;
    }
  },

  registerUpdateCallback({ homey }, callback) {
    updateCallback = callback;
    
    homey.on('spot_prices_updated', () => {
      if (updateCallback) {
        updateCallback();
      }
    });
  }
};

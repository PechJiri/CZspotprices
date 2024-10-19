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

      const device = devices[0];  // Použijeme první zařízení

      const currentSpotPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentSpotIndex = await device.getCapabilityValue('measure_current_spot_index');

      // Získání ceny pro příští hodinu
      const nextHour = (new Date().getHours() + 1) % 24;
      const nextHourPrice = await device.getCapabilityValue(`hour_price_CZK_${nextHour}`);
      const nextHourIndex = await device.getCapabilityValue(`hour_price_index_${nextHour}`);

      // Získání průměrné denní ceny
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

  // Metoda pro registraci callback funkce
  registerUpdateCallback({ homey }, callback) {
    updateCallback = callback;
    
    // Registrujeme posluchač události
    homey.on('spot_prices_updated', () => {
      if (updateCallback) {
        updateCallback();
      }
    });
  }
};
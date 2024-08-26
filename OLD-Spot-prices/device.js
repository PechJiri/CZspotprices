'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api'); // Předpoklad, že api.js je ve stejném adresáři

class CZSpotPricesDevice extends Homey.Device {

  async onInit() {
    this.log('CZ Spot Prices device has been initialized');

    // Připojení k API
    this.spotPriceApi = new SpotPriceAPI(this.homey);

    // Získání hodnot ze settings
    const lowTariffPrice = this.homey.settings.get('low_tariff_price') || 0;
    const highTariffPrice = this.homey.settings.get('high_tariff_price') || 0;
    const updateInterval = this.homey.settings.get('update_interval') || 1; // Výchozí 1 hodina

    await this.setSettings({
      low_tariff_price: lowTariffPrice,
      high_tariff_price: highTariffPrice,
      update_interval: updateInterval,
    });

    // Definice schopností (capabilities)
    const capabilities = [
      'current_spot_price_CZK',
      'current_spot_index'
    ];

    for (let i = 0; i < 24; i++) {
      capabilities.push(`hour_price_CZK_${i}`);
      capabilities.push(`hour_price_index_${i}`);
    }

    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    // Registrace Flow karet
    this.setupFlowCards();

    // Nastavení intervalu pro získávání dat
    this.startDataFetchInterval(updateInterval);

    // Nastavení zařízení jako dostupného
    this.setAvailable();
  }

  setupFlowCards() {
    // Registrace trigger karet
    this.homey.flow.getDeviceTriggerCard('current_price_lower_than');
    this.homey.flow.getDeviceTriggerCard('current_price_higher_than');
    this.homey.flow.getDeviceTriggerCard('current_price_index');

    // Registrace condition karet
    this.homey.flow.getDeviceConditionCard('price_lower_than');
    this.homey.flow.getDeviceConditionCard('price_higher_than');
    this.homey.flow.getDeviceConditionCard('price_index_is');
  }

  startDataFetchInterval(interval) {
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }

    this.dataFetchInterval = this.homey.setInterval(async () => {
      await this.fetchAndUpdateSpotPrices();
    }, 1000 * 60 * 60 * interval); // Interval v hodinách
  }

  async fetchAndUpdateSpotPrices() {
    try {
      const currentPrice = await this.spotPriceApi.getCurrentPriceCZK();
      const currentIndex = await this.spotPriceApi.getCurrentPriceIndex();
      const dailyPrices = await this.spotPriceApi.getDailyPrices();

      await this.setCapabilityValue('current_spot_price_CZK', currentPrice);
      await this.setCapabilityValue('current_spot_index', currentIndex);

      dailyPrices.forEach(async (priceData, hour) => {
        await this.setCapabilityValue(`hour_price_CZK_${hour}`, priceData.priceCZK);
        await this.setCapabilityValue(`hour_price_index_${hour}`, priceData.level);
      });

      this.log('Spot prices updated successfully.');
    } catch (error) {
      this.error(`Error fetching spot prices: ${error}`);
      this.setUnavailable(`Error fetching data (${error})`);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('CZ Spot Prices device settings were changed');

    if (changedKeys.includes('update_interval')) {
      this.startDataFetchInterval(newSettings.update_interval);
    }

    // Znovu načte data
    await this.fetchAndUpdateSpotPrices();
  }

  async onDeleted() {
    this.log('CZ Spot Prices device deleted');
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }
  }
}

module.exports = CZSpotPricesDevice;

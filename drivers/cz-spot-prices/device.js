'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');

class CZSpotPricesDevice extends Homey.Device {

  async onInit() {
    this.log('CZ Spot Prices device has been initialized');

    // Získání ID zařízení z úložiště nebo nastavení výchozího
    const deviceId = this.getData().id || this.getStoreValue('device_id');
    if (!deviceId) {
      const newDeviceId = this.generateDeviceId();
      this.setStoreValue('device_id', newDeviceId);
      this.log('Generated new device ID:', newDeviceId);
    } else {
      this.log('Using existing device ID:', deviceId);
    }

    // Připojení k API
    this.spotPriceApi = new SpotPriceAPI(this.homey);

    // Získání hodnot ze settings nebo nastavení výchozích hodnot
    const lowTariffPrice = this.getSetting('low_tariff_price') || 0;
    const highTariffPrice = this.getSetting('high_tariff_price') || 0;
    const updateInterval = this.getSetting('update_interval') || 1; // Výchozí 1 hodina

    this.log('Nastavení bylo načteno z uložených hodnot.');
    this.log('Low Tariff Price:', lowTariffPrice);
    this.log('High Tariff Price:', highTariffPrice);

    for (let i = 0; i < 24; i++) {
      const hourTariff = this.getSetting(`hour_${i}`) || false;
      this.log(`Hour ${i} Low Tariff:`, hourTariff);
    }

    // Definice schopností (capabilities)
    const capabilities = [
      'measure_current_spot_price_CZK',
      'measure_current_spot_index'
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

    // Registrace Flow Action pro aktualizaci dat přes API
    this.registerUpdateDataViaApiFlowAction();

    // Nastavení intervalu pro získávání dat
    this.startDataFetchInterval(updateInterval);

    // Volání API pro aktualizaci hodnot
    await this.fetchAndUpdateSpotPrices();

    // Nastavení zařízení jako dostupného
    this.setAvailable();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('CZ Spot Prices device settings were changed');
    this.log('Old Settings:', oldSettings);
    this.log('New Settings:', newSettings);
    this.log('Changed Keys:', changedKeys);

    // Uložení změněných nastavení
    changedKeys.forEach((key) => {
      this.homey.settings.set(key, newSettings[key]);
      this.log(`Setting ${key} updated to:`, newSettings[key]);
    });

    // Změna intervalu pro získávání dat, pokud byl update_interval změněn
    if (changedKeys.includes('update_interval')) {
      this.startDataFetchInterval(newSettings.update_interval);
      this.log('Data fetch interval updated to:', newSettings.update_interval);
    }

    // Znovu načte data z API
    await this.fetchAndUpdateSpotPrices();
  }

  async fetchAndUpdateSpotPrices() {
    try {
      this.log('Fetching and updating spot prices...');
      const currentPrice = await this.spotPriceApi.getCurrentPriceCZK(this);
      const currentIndex = await this.spotPriceApi.getCurrentPriceIndex();
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);

      await this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice);
      await this.setCapabilityValue('measure_current_spot_index', currentIndex);

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

  async onDeleted() {
    this.log('CZ Spot Prices device deleted');
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }
  }

  setupFlowCards() {
    if (this.homey.flow.getDeviceConditionCard) {
      this.homey.flow.getDeviceConditionCard('price-lower-than-condition')
        .registerRunListener(async (args, state) => {
          const currentPrice = await this.getCapabilityValue('measure_current_spot_price_CZK');
          return currentPrice < args.price;
        });

      this.homey.flow.getDeviceConditionCard('price-higher-than-condition')
        .registerRunListener(async (args, state) => {
          const currentPrice = await this.getCapabilityValue('measure_current_spot_price_CZK');
          return currentPrice > args.price;
        });

      this.homey.flow.getDeviceConditionCard('price-index-is-condition')
        .registerRunListener(async (args, state) => {
          const currentIndex = await this.getCapabilityValue('measure_current_spot_index');
          return currentIndex === args.index;
        });
    } else {
      this.log('getDeviceConditionCard is not available');
    }

    this.homey.flow.getDeviceTriggerCard('current-price-lower-than-trigger')
      .registerRunListener(async (args, state) => {
        const currentPrice = await this.getCapabilityValue('measure_current_spot_price_CZK');
        return currentPrice < args.price;
      });

    this.homey.flow.getDeviceTriggerCard('current-price-higher-than-trigger')
      .registerRunListener(async (args, state) => {
        const currentPrice = await this.getCapabilityValue('measure_current_spot_price_CZK');
        return currentPrice > args.price;
      });

    this.homey.flow.getDeviceTriggerCard('current-price-index-trigger')
      .registerRunListener(async (args, state) => {
        const currentIndex = await this.getCapabilityValue('measure_current_spot_index');
        return currentIndex === args.index;
      });
  }

  registerUpdateDataViaApiFlowAction() {
    this.homey.flow.getActionCard('update_data_via_api')
      .registerRunListener(async (args, state) => {
        this.log('Running action: Update data via API');
        await this.fetchAndUpdateSpotPrices();
        this.log('Data successfully updated via API.');
        return true; // Vše proběhlo úspěšně
      });
  }

  startDataFetchInterval(interval) {
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }

    this.dataFetchInterval = this.homey.setInterval(async () => {
      await this.fetchAndUpdateSpotPrices();
    }, 1000 * 60 * 60 * interval); // Interval v hodinách
  }

  generateDeviceId() {
    const deviceId = this.homey.util.generateUniqueId();
    this.log('Generated new device ID:', deviceId);
    return deviceId;
  }
}

module.exports = CZSpotPricesDevice;

'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');

class CZSpotPricesDevice extends Homey.Device {

  async onInit() {
    const deviceId = this.getData().id || this.getStoreValue('device_id');
    if (!deviceId) {
      const newDeviceId = this.generateDeviceId();
      await this.setStoreValue('device_id', newDeviceId);
    }
  
    this.spotPriceApi = new SpotPriceAPI(this.homey);
  
    const updateInterval = this.getSetting('update_interval') || 1;
    this.lowIndexHours = this.getSetting('low_index_hours') || 8;
    this.highIndexHours = this.getSetting('high_index_hours') || 8;
  
    const capabilities = [
      'measure_current_spot_price_CZK',
      'measure_current_spot_index',
      'daily_average_price',
      ...Array.from({ length: 24 }, (_, i) => [`hour_price_CZK_${i}`, `hour_price_index_${i}`]).flat()
    ];
  
    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        try {
          await this.addCapability(capability);
        } catch (error) {
          this.error(`Failed to add capability ${capability}:`, error);
        }
      }
    }
  
    this.setupFlowCards();
    this.registerUpdateDataViaApiFlowAction();
    this.startDataFetchInterval(updateInterval);
  
    this.registerCapabilityListener('measure_current_spot_price_CZK', this.onCurrentPriceChanged.bind(this));
  
    const currentHour = new Date().getHours();
    const initialTariff = this.driver.isLowTariff(currentHour, this) ? 'low' : 'high';
    await this.setStoreValue('previousTariff', initialTariff);
  
    try {
      this.log('Fetching initial spot prices...');
      await this.fetchAndUpdateSpotPrices();
      this.log('Initial spot prices fetched successfully');
      await this.setAvailable();
    } catch (error) {
      this.error('Failed to fetch initial spot prices:', error);
      await this.setUnavailable('Failed to fetch initial data');
    }
  }
  
  async onCurrentPriceChanged(value, opts) {
    await this.driver.triggerCurrentPriceChangedFlow(this, { price: value });
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Nastavení byla změněna');
    this.log('Změněné klíče:', changedKeys);
  
    // Aktualizace interních proměnných
    if (changedKeys.includes('low_index_hours')) {
      this.lowIndexHours = newSettings.low_index_hours;
    }
    if (changedKeys.includes('high_index_hours')) {
      this.highIndexHours = newSettings.high_index_hours;
    }
    if (changedKeys.includes('update_interval')) {
      this.startDataFetchInterval(newSettings.update_interval);
    }
  
    // Odložení aktualizace dat o 100ms
    this.homey.setTimeout(async () => {
      try {
        this.log('Načítám a aktualizuji spotové ceny po změně nastavení...');
        if (changedKeys.includes('low_index_hours') || changedKeys.includes('high_index_hours')) {
          await this.recalculateAndUpdatePriceIndexes();
        }
        await this.fetchAndUpdateSpotPrices();
        this.log('Spotové ceny byly úspěšně aktualizovány po změně nastavení');
      } catch (error) {
        this.error('Nepodařilo se načíst a aktualizovat spotové ceny po změně nastavení:', error);
      }
    }, 100);
  }
  
  async fetchAndUpdateSpotPrices() {
    try {
      const homeyTimezone = this.homey.clock.getTimezone();
      const currentDate = new Date();
      const options = { timeZone: homeyTimezone };
      const currentHour = parseInt(currentDate.toLocaleString('en-US', { ...options, hour: 'numeric', hour12: false }));
  
      const currentPrice = await this.spotPriceApi.getCurrentPriceCZK(this);
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
  
      if (!dailyPrices || !Array.isArray(dailyPrices) || dailyPrices.length !== 24) {
        throw new Error('Invalid daily prices data received from API');
      }
  
      await this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice)
        .then(() => this.log(`Updated measure_current_spot_price_CZK: ${currentPrice}`))
        .catch(err => this.error(`Failed to update measure_current_spot_price_CZK: ${err}`));
  
      this.setPriceIndexes(dailyPrices);
  
      for (const priceData of dailyPrices) {
        await this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, priceData.priceCZK)
          .then(() => this.log(`Updated hour_price_CZK_${priceData.hour}: ${priceData.priceCZK}`))
          .catch(err => this.error(`Failed to update hour_price_CZK_${priceData.hour}: ${err}`));
  
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level)
          .then(() => this.log(`Updated hour_price_index_${priceData.hour}: ${priceData.level}`))
          .catch(err => this.error(`Failed to update hour_price_index_${priceData.hour}: ${err}`));
      }
  
      const currentHourData = dailyPrices.find(price => price.hour === currentHour);
      const currentIndex = currentHourData ? currentHourData.level : 'unknown';
      await this.setCapabilityValue('measure_current_spot_index', currentIndex)
        .then(() => this.log(`Updated measure_current_spot_index: ${currentIndex}`))
        .catch(err => this.error(`Failed to update measure_current_spot_index: ${err}`));
  
      await this.spotPriceApi.updateDailyAverageCapability(this);
  
      await this.setAvailable();
  
      await this.homey.emit('spot_prices_updated', {
        deviceId: this.getData().id,
        currentPrice,
        currentIndex,
        dailyPrices,
        averagePrice: await this.getCapabilityValue('daily_average_price')
      });
  
      return true;
    } catch (error) {
      const errorMessage = this.spotPriceApi.getErrorMessage(error);
      this.error(`Error fetching spot prices: ${errorMessage}`);
  
      await this.homey.notifications.createNotification({
        excerpt: `Error fetching spot prices: ${errorMessage}`,
      });
  
      this.spotPriceApi.triggerApiCallFail(errorMessage, this);
      return false;
    }
  }  

  async recalculateAndUpdatePriceIndexes() {
    try {
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      this.setPriceIndexes(dailyPrices);
      
      for (const priceData of dailyPrices) {
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level)
          .then(() => this.log(`Updated hour_price_index_${priceData.hour}: ${priceData.level}`))
          .catch(err => this.error(`Failed to update hour_price_index_${priceData.hour}: ${err}`));
      }
  
      const currentHour = new Date().getHours();
      const currentIndex = dailyPrices.find(price => price.hour === currentHour)?.level || 'unknown';
      await this.setCapabilityValue('measure_current_spot_index', currentIndex)
        .then(() => this.log(`Updated measure_current_spot_index: ${currentIndex}`))
        .catch(err => this.error(`Failed to update measure_current_spot_index: ${err}`));
    } catch (error) {
      this.error('Failed to recalculate and update price indexes:', error);
    }
  }

  setPriceIndexes(hoursToday) {
    const sortedPrices = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
    sortedPrices.forEach((hourData, index) => {
      if (index < this.lowIndexHours) hourData.level = 'low';
      else if (index >= sortedPrices.length - this.highIndexHours) hourData.level = 'high';
      else hourData.level = 'medium';
    });
  }

  async onDeleted() {
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }
  }

  setupFlowCards() {
    this.registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', (current, target) => current < target);
    this.registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', (current, target) => current > target);
    this.registerConditionCard('price-index-is-condition', 'measure_current_spot_index', (current, target) => current === target);
    this.registerAveragePriceCondition();

    this.registerTriggerCard('current-price-lower-than-trigger', 'measure_current_spot_price_CZK', (current, target) => current < target);
    this.registerTriggerCard('current-price-higher-than-trigger', 'measure_current_spot_price_CZK', (current, target) => current > target);
    this.registerTriggerCard('current-price-index-trigger', 'measure_current_spot_index', (current, target) => current === target);

    const apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
    apiCallFailTrigger.registerRunListener(async () => true);

    const whenCurrentPriceChangesTrigger = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
    whenCurrentPriceChangesTrigger.registerRunListener(async (args, state) => true);
  }

  registerConditionCard(cardId, capability, comparison) {
    this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
        const currentValue = await this.getCapabilityValue(capability);
        return comparison(currentValue, args.value);
      });
  }

  registerTriggerCard(cardId, capability, comparison) {
    this.homey.flow.getDeviceTriggerCard(cardId)
      .registerRunListener(async (args, state) => {
        const currentValue = await this.getCapabilityValue(capability);
        return comparison(currentValue, args.value);
      });
  }

  registerAveragePriceCondition() {
    this.homey.flow.getConditionCard('average-price-condition')
        .registerRunListener(async (args, state) => {
            const { hours, condition } = args;
            const allCombinations = await this.calculateAveragePrices(hours);
            const targetCombination = this.findTargetCombination(allCombinations, condition);
            const currentHour = new Date().getHours();
            return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
        });
  }

  async calculateAveragePrices(hours) {
    const allCombinations = [];
    for (let startHour = 0; startHour <= 24 - hours; startHour++) {
        let total = 0;
        for (let i = startHour; i < startHour + hours; i++) {
            const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
            if (price === null || price === undefined) {
                throw new Error(`Chybí cenová data pro hodinu ${i}`);
            }
            total += price;
        }
        const avg = total / hours;
        allCombinations.push({ startHour, avg });
    }
    return allCombinations;
  }

  findTargetCombination(combinations, condition) {
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    return condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
  }

  registerUpdateDataViaApiFlowAction() {
    this.homey.flow.getActionCard('update_data_via_api')
      .registerRunListener(async () => {
        try {
          await this.fetchAndUpdateSpotPrices();
          return true;
        } catch (error) {
          const errorMessage = this.spotPriceApi.getErrorMessage(error);
          this.error('Failed to update data via API:', errorMessage);
          this.spotPriceApi.triggerApiCallFail(errorMessage, this);
          return false;
        }
      });
  }

  startDataFetchInterval(interval) {
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }

    const now = new Date();
    const currentHour = now.getHours();
    const nextIntervalHour = Math.ceil(currentHour / interval) * interval;
    let msUntilNextInterval = ((nextIntervalHour - currentHour) * 60 * 60 - now.getMinutes() * 60 - now.getSeconds()) * 1000 + 1000;

    if (msUntilNextInterval <= 0) {
      msUntilNextInterval += interval * 60 * 60 * 1000;
    }

    this.homey.setTimeout(async () => {
      await this.fetchAndUpdateSpotPrices();
      this.dataFetchInterval = this.homey.setInterval(async () => {
        await this.fetchAndUpdateSpotPrices();
      }, interval * 60 * 60 * 1000);
    }, msUntilNextInterval);
  }

  generateDeviceId() {
    return this.homey.util.generateUniqueId();
  }
}

module.exports = CZSpotPricesDevice;
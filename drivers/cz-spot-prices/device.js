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
    this.lowIndexHours = this.getSetting('low_index_hours') || 8;
    this.highIndexHours = this.getSetting('high_index_hours') || 8;
    this.priceInKWh = this.getSetting('price_in_kwh') || false;

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
    this.scheduleMidnightUpdate();
    this.scheduleHourlyUpdate();
    
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    try {
      await this.checkAveragePrice().catch(err => {
        this.error('Error in initial average price check:', err);
      });

      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      const delay = nextHour.getTime() - now.getTime();

      this.averagePriceTimeout = this.homey.setTimeout(() => {
        this.checkAveragePrice();
        this.averagePriceInterval = this.homey.setInterval(() => {
          this.checkAveragePrice();
        }, 60 * 60 * 1000);
      }, delay);
    } catch (error) {
      this.error('Error setting up average price checks:', error);
    }
    
    const initialTariff = this.driver.isLowTariff(currentHour, this) ? 'low' : 'high';
    await this.setStoreValue('previousTariff', initialTariff);

    try {
      await this.fetchAndUpdateSpotPrices();
      await this.setAvailable();
    } catch (error) {
      this.error('Failed to fetch initial spot prices:', error);
      await this.setUnavailable('Failed to fetch initial data');
    }
  }

  setupHourlyAveragePriceCheck() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const delay = nextHour.getTime() - now.getTime();

    this.homey.setTimeout(() => {
      this.checkAveragePrice();
      this.averagePriceInterval = this.homey.setInterval(() => {
        this.checkAveragePrice();
      }, 60 * 60 * 1000);
    }, delay);
  }

  scheduleMidnightUpdate() {
    const calculateNextMidnight = () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return tomorrow;
    };

    const scheduleNext = () => {
      const nextMidnight = calculateNextMidnight();
      const delay = nextMidnight.getTime() - Date.now();
      
      this.homey.setTimeout(async () => {
        try {
          await this.fetchAndUpdateSpotPrices();
        } catch (error) {
          this.error('Midnight update failed:', error);
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  scheduleHourlyUpdate() {
    const calculateNextHour = () => {
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      return nextHour;
    };

    const updateCurrentFromStored = async () => {
      try {
        const currentHour = new Date().getHours();
        const price = await this.getCapabilityValue(`hour_price_CZK_${currentHour}`);
        const index = await this.getCapabilityValue(`hour_price_index_${currentHour}`);
        
        if (price !== null && index !== null) {
          await this.setCapabilityValue('measure_current_spot_price_CZK', price);
          await this.setCapabilityValue('measure_current_spot_index', index);
          await this.driver.triggerCurrentPriceChangedFlow(this, { price });
        }
      } catch (error) {
        this.error('Error updating current values from stored:', error);
      }
    };

    const scheduleNext = () => {
      const nextHour = calculateNextHour();
      const delay = nextHour.getTime() - Date.now();
      
      this.homey.setTimeout(async () => {
        await updateCurrentFromStored();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  setPriceIndexes(hoursToday) {
    const sortedPrices = [...hoursToday]
      .sort((a, b) => a.priceCZK - b.priceCZK)
      .map((price, index) => ({
        ...price,
        sortedIndex: index
      }));

    const totalHours = sortedPrices.length;
    sortedPrices.forEach(hourData => {
      if (hourData.sortedIndex < this.lowIndexHours) {
        hourData.level = 'low';
      } else if (hourData.sortedIndex >= totalHours - this.highIndexHours) {
        hourData.level = 'high';
      } else {
        hourData.level = 'medium';
      }
    });

    return sortedPrices
      .sort((a, b) => a.hour - b.hour)
      .map(({ level, ...rest }) => ({ ...rest, level }));
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('low_index_hours')) {
      this.lowIndexHours = newSettings.low_index_hours;
    }
    if (changedKeys.includes('high_index_hours')) {
      this.highIndexHours = newSettings.high_index_hours;
    }
    if (changedKeys.includes('price_in_kwh')) {
      this.priceInKWh = newSettings.price_in_kwh;
    }
  
    this.homey.setTimeout(async () => {
      try {
        if (changedKeys.includes('low_index_hours') || 
            changedKeys.includes('high_index_hours') || 
            changedKeys.some(key => key.startsWith('hour_'))) {
          await this.recalculateAndUpdatePriceIndexes();
        }
        await this.fetchAndUpdateSpotPrices();
        this.homey.emit('settings_changed');
      } catch (error) {
        this.error('Failed to update spot prices after settings change:', error);
      }
    }, 100);
  }
  
  convertPrice(price) {
    return this.priceInKWh ? price / 1000 : price;
  }

  async fetchAndUpdateSpotPrices() {
    try {
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      if (!dailyPrices || !Array.isArray(dailyPrices) || dailyPrices.length !== 24) {
        throw new Error('Invalid daily prices data received from API');
      }
  
      const pricesWithIndexes = this.setPriceIndexes(dailyPrices.map(priceData => ({
        ...priceData,
        priceCZK: this.spotPriceApi.addDistributionPrice(this, priceData.priceCZK)
      })));
  
      for (const priceData of pricesWithIndexes) {
        const price = this.convertPrice(priceData.priceCZK);
        await this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, price);
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level);
      }
  
      const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
      const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
  
      if (currentHourData) {
        await this.setCapabilityValue('measure_current_spot_price_CZK', this.convertPrice(currentHourData.priceCZK));
        await this.setCapabilityValue('measure_current_spot_index', currentHourData.level);
      }
  
      await this.updateDailyAverageCapability();
      await this.setAvailable();
  
      await this.homey.emit('spot_prices_updated', {
        deviceId: this.getData().id,
        currentPrice: currentHourData ? this.convertPrice(currentHourData.priceCZK) : null,
        currentIndex: currentHourData ? currentHourData.level : 'unknown',
        dailyPrices: pricesWithIndexes.map(price => ({
          ...price,
          priceCZK: this.convertPrice(price.priceCZK)
        })),
        averagePrice: await this.getCapabilityValue('daily_average_price')
      });
  
      return true;
    } catch (error) {
      this.error(`Error fetching spot prices: ${error.message}`);
      await this.homey.notifications.createNotification({
        excerpt: `Error fetching spot prices: ${error.message}`,
      });
      return false;
    }
  }

  async recalculateAndUpdatePriceIndexes() {
    try {
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      const pricesWithIndexes = this.setPriceIndexes(dailyPrices);

      for (const priceData of pricesWithIndexes) {
        await this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, this.convertPrice(priceData.priceCZK));
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level);
      }
  
      const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
      const currentIndex = pricesWithIndexes.find(price => price.hour === currentHour)?.level || 'unknown';
      await this.setCapabilityValue('measure_current_spot_index', currentIndex);
    } catch (error) {
      this.error('Failed to recalculate and update price indexes:', error);
    }
  }

  async updateDailyAverageCapability() {
    try {
      let totalPrice = 0;
      let count = 0;
    
      for (let i = 0; i < 24; i++) {
        const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
        if (price !== null && price !== undefined) {
          totalPrice += price;
          count++;
        }
      }
  
      if (count === 0) {
        throw new Error('Nebyly nalezeny žádné platné ceny pro výpočet průměru.');
      }
  
      const averagePrice = totalPrice / count;
      await this.setCapabilityValue('daily_average_price', averagePrice);
    } catch (error) {
      this.error('Chyba při aktualizaci denní průměrné ceny:', error);
    }
  }
  
  async onDeleted() {
    if (this.dataFetchInterval) {
        this.homey.clearInterval(this.dataFetchInterval);
    }
    if (this.averagePriceInterval) {
        this.homey.clearInterval(this.averagePriceInterval);
    }
    if (this.averagePriceTimeout) {
        this.homey.clearTimeout(this.averagePriceTimeout);
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
    apiCallFailTrigger.registerRunListener(async (args, state) => {
      return args.type === state.type;
    });

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
        try {
          const { hours, condition } = args;
          const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
          const currentHour = timeInfo.hour;
          
          const allCombinations = await this.calculateAveragePrices(hours, 0);
          const targetCombination = this.findTargetCombination(allCombinations, condition);
          
          const result = currentHour >= targetCombination.startHour && 
                        currentHour < (targetCombination.startHour + hours);
          
          return result;
        } catch (error) {
          this.error('Error in average price condition:', error);
          return false;
        }
      });
  }
  
  async checkAveragePrice() {
    try {
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
      
      const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
      const flows = await triggerCard.getArgumentValues();
  
      for (const flow of flows) {
        const { hours, condition } = flow;
        const allCombinations = await this.calculateAveragePrices(hours, 0);
        const targetCombination = this.findTargetCombination(allCombinations, condition);
        
        if (targetCombination.startHour === currentHour) {
          const tokens = {
            average_price: parseFloat(targetCombination.avg.toFixed(2))
          };
          
          await triggerCard.trigger(this, tokens, { 
            hours: hours, 
            condition: condition 
          });
        }
      }
    } catch (error) {
      this.error('Error checking average price:', error);
    }
  }
  
  async calculateAveragePrices(hours, startFromHour = 0) {
    if (startFromHour < 0 || startFromHour >= 24) {
      startFromHour = 0;
    }
    
    const allCombinations = [];
    
    for (let startHour = startFromHour; startHour <= 24 - hours; startHour++) {
      let total = 0;
      
      for (let i = startHour; i < startHour + hours; i++) {
        const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
        
        if (price === null || price === undefined) {
          throw new Error(`Missing price data for hour ${i}`);
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
      .registerRunListener(async (args) => {
        try {
          if (args.type === 'current') {
            await this.spotPriceApi.updateCurrentValues(this);
          } else {
            await this.fetchAndUpdateSpotPrices();
          }
          return true;
        } catch (error) {
          const errorMessage = this.spotPriceApi.getErrorMessage(error);
          this.error('Failed to update data via API:', errorMessage);
          return false;
        }
      });
  }
  
  generateDeviceId() {
    return this.homey.util.generateUniqueId();
  }
  }
  
  module.exports = CZSpotPricesDevice;
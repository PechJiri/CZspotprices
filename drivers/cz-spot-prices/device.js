'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');

class CZSpotPricesDevice extends Homey.Device {

  async onInit() {
    this.homey.log('Initializing device...');
    const deviceId = this.getData().id || this.getStoreValue('device_id');
    if (!deviceId) {
      const newDeviceId = this.generateDeviceId();
      await this.setStoreValue('device_id', newDeviceId);
      this.homey.log('Generated new device ID:', newDeviceId);
    } else {
      this.homey.log('Device initialized with ID:', deviceId);
    }

    this.spotPriceApi = new SpotPriceAPI(this.homey);
    this.lowIndexHours = this.getSetting('low_index_hours') || 8;
    this.highIndexHours = this.getSetting('high_index_hours') || 8;
    this.priceInKWh = this.getSetting('price_in_kwh') || false;
    this.homey.log('Device settings:', { lowIndexHours: this.lowIndexHours, highIndexHours: this.highIndexHours, priceInKWh: this.priceInKWh });

    // Registrace capabilities
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
          this.homey.log(`Capability ${capability} added successfully.`);
        } catch (error) {
          this.error(`Failed to add capability ${capability}:`, error);
        }
      }
    }
  
    // Nastavení Flow karet
    this.setupFlowCards();
    this.registerUpdateDataViaApiFlowAction();

    // Nastavení pravidelných aktualizací
    this.scheduleMidnightUpdate();
    this.scheduleHourlyUpdate();
    
    // Nastavení kontroly průměrných cen (okamžitá kontrola + plánování dalších)
    this.homey.log('Setting up average price checks...');
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    try {
      // Okamžitá kontrola průměrných cen
      this.homey.log('Performing initial average price check');
      await this.checkAveragePrice().catch(err => {
        this.error('Error in initial average price check:', err);
      });

      // Plánování další kontroly na začátek příští hodiny
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      const delay = nextHour.getTime() - now.getTime();

      this.homey.log(`Scheduling next average price check in ${Math.round(delay / 1000)} seconds`);
      this.averagePriceTimeout = this.homey.setTimeout(() => {
        this.checkAveragePrice();
        
        // Nastavení hodinového intervalu
        this.homey.log('Setting up hourly interval for average price checks');
        this.averagePriceInterval = this.homey.setInterval(() => {
          this.checkAveragePrice();
        }, 60 * 60 * 1000);
      }, delay);
    } catch (error) {
      this.error('Error setting up average price checks:', error);
    }
    
    // Nastavení iniciálního tarifu
    const initialTariff = this.driver.isLowTariff(currentHour, this) ? 'low' : 'high';
    await this.setStoreValue('previousTariff', initialTariff);
    this.homey.log('Initial tariff set to:', initialTariff);

    // Inicializační načtení dat
    try {
      await this.fetchAndUpdateSpotPrices();
      await this.setAvailable();
    } catch (error) {
      this.error('Failed to fetch initial spot prices:', error);
      await this.setUnavailable('Failed to fetch initial data');
    }

    this.homey.log('Device initialization completed');
}

  setupHourlyAveragePriceCheck() {
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
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

  // Metoda pro naplánování půlnoční aktualizace
  scheduleMidnightUpdate() {
    this.homey.log('Scheduling midnight update');
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

  // Metoda pro naplánování hodinové aktualizace current price
  scheduleHourlyUpdate() {
    this.homey.log('Scheduling hourly update for current price');
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
          this.homey.log(`Updated current price and index for hour ${currentHour}:`, { price, index });
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

  // Optimalizovaná metoda pro nastavení cenových indexů
  setPriceIndexes(hoursToday) {
    this.homey.log('Calculating price indexes for the day.');
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
    this.homey.log('Device settings updated:', changedKeys);
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
    this.homey.log('Fetching and updating spot prices');
    try {
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      if (!dailyPrices || !Array.isArray(dailyPrices) || dailyPrices.length !== 24) {
        throw new Error('Invalid daily prices data received from API');
      }
  
      // Přidání distribučního tarifu k cenám
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
        this.homey.log('Updated current hour data:', currentHourData);
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
    this.homey.log('Recalculating and updating price indexes');
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
    this.homey.log('--- Start: Aktualizace denní průměrné ceny ---');
    try {
      let totalPrice = 0;
      let count = 0;
    
      for (let i = 0; i < 24; i++) {
        const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
        this.homey.log(`Hodina ${i}: Načtená cena: ${price}`);
        
        if (price !== null && price !== undefined) {
          totalPrice += price;
          count++;
          this.homey.log(`Hodina ${i}: Cena přičtena do totalPrice (${totalPrice}), aktuální count: ${count}`);
        }
      }
  
      if (count === 0) {
        this.homey.log('Žádné platné ceny nebyly nalezeny. Vyvolávám chybu.');
        throw new Error('Nebyly nalezeny žádné platné ceny pro výpočet průměru.');
      }
  
      const averagePrice = totalPrice / count;
      this.homey.log(`--- Výsledný totalPrice: ${totalPrice}, Počet platných hodnot: ${count}, Vypočítaná průměrná cena: ${averagePrice} ---`);
      
      await this.setCapabilityValue('daily_average_price', averagePrice);
      this.homey.log('Denní průměrná cena úspěšně nastavena:', averagePrice);
    } catch (error) {
      this.error('Chyba při aktualizaci denní průměrné ceny:', error);
    }
    this.homey.log('--- Konec: Aktualizace denní průměrné ceny ---');
  }  
  
  
  async onDeleted() {
    this.homey.log('Cleaning up device...');
    if (this.dataFetchInterval) {
        this.homey.clearInterval(this.dataFetchInterval);
    }
    if (this.averagePriceInterval) {
        this.homey.clearInterval(this.averagePriceInterval);
    }
    if (this.averagePriceTimeout) {
        this.homey.clearTimeout(this.averagePriceTimeout);
    }
    this.homey.log('Device cleanup completed');
}

  setupFlowCards() {
    this.homey.log('Setting up flow cards for device.');
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
          this.homey.log('=== Start: Average Price Condition Check ===');
          this.homey.log(`Checking condition with args:`, args);
          
          const { hours, condition } = args;
          const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
          const currentHour = timeInfo.hour;
          
          this.homey.log(`Current hour: ${currentHour}, Checking for ${hours} hour(s) window`);
          
          // Pro condition vždy začínáme od 0. hodiny
          const allCombinations = await this.calculateAveragePrices(hours, 0);
          const targetCombination = this.findTargetCombination(allCombinations, condition);
          
          const result = currentHour >= targetCombination.startHour && 
                        currentHour < (targetCombination.startHour + hours);
          
          this.homey.log(`Condition result: ${result}`);
          this.homey.log(`(Current hour ${currentHour} is${result ? '' : ' not'} within window ${targetCombination.startHour}-${targetCombination.startHour + hours})`);
          this.homey.log('=== End: Average Price Condition Check ===');
          
          return result;
        } catch (error) {
          this.error('Error in average price condition:', error);
          this.homey.log('=== End: Average Price Condition Check (with error) ===');
          return false;
        }
      });
}

async checkAveragePrice() {
  try {
    this.homey.log('=== Start: checkAveragePrice ===');
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    this.homey.log(`Current hour: ${currentHour}`);
    
    const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
    const flows = await triggerCard.getArgumentValues();
    this.homey.log('Found trigger flows:', flows);

    for (const flow of flows) {
      const { hours, condition } = flow;
      this.homey.log(`Checking trigger for ${hours} hour(s) window with condition: ${condition}`);
      
      const allCombinations = await this.calculateAveragePrices(hours, 0);
      const targetCombination = this.findTargetCombination(allCombinations, condition);
      
      this.homey.log(`Target combination found: startHour=${targetCombination.startHour}, avg=${targetCombination.avg}`);
      
      if (targetCombination.startHour === currentHour) {
        this.homey.log(`Triggering flow for ${condition} price combination of ${hours} hours`);
        
        // Vytvoření tokenu s průměrnou cenou
        const tokens = {
          average_price: parseFloat(targetCombination.avg.toFixed(2))
        };
        
        await triggerCard.trigger(this, tokens, { 
          hours: hours, 
          condition: condition 
        });
        
        this.homey.log(`Trigger executed successfully with average price: ${tokens.average_price}`);
      } else {
        this.homey.log(`Current hour ${currentHour} is not the start of the ${condition} ${hours}-hour window`);
      }
    }
    
    this.homey.log('=== End: checkAveragePrice ===');
  } catch (error) {
    this.error('Error checking average price:', error);
    this.homey.log('=== End: checkAveragePrice (with error) ===');
  }
}

  async calculateAveragePrices(hours, startFromHour = 0) {
    this.homey.log('=== Start: calculateAveragePrices ===');
    this.homey.log(`Parameters: hours=${hours}, startFromHour=${startFromHour}`);
    
    if (startFromHour < 0 || startFromHour >= 24) {
      this.homey.error(`Invalid startFromHour: ${startFromHour}`);
      startFromHour = 0;
    }
    
    const allCombinations = [];
    
    this.homey.log(`Calculating combinations from hour ${startFromHour} to ${24 - hours}`);
    
    for (let startHour = startFromHour; startHour <= 24 - hours; startHour++) {
      this.homey.log(`\nProcessing combination starting at hour ${startHour}:`);
      let total = 0;
      
      for (let i = startHour; i < startHour + hours; i++) {
        this.homey.log(`  Reading price for hour ${i}`);
        const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
        
        if (price === null || price === undefined) {
          this.homey.error(`  Error: Missing price data for hour ${i}`);
          throw new Error(`Missing price data for hour ${i}`);
        }
        
        total += price;
        this.homey.log(`  Hour ${i} price: ${price}, Running total: ${total}`);
      }
      
      const avg = total / hours;
      this.homey.log(`Calculated average for ${hours} hours starting at ${startHour}: ${avg}`);
      
      allCombinations.push({ startHour, avg });
    }
    
    this.homey.log('All calculated combinations:', allCombinations);
    this.homey.log('=== End: calculateAveragePrices ===');
    
    return allCombinations;
}

  findTargetCombination(combinations, condition) {
    this.homey.log('=== Start: findTargetCombination ===');
    this.homey.log(`Finding ${condition} combination from ${combinations.length} combinations`);
    this.homey.log('Input combinations:', combinations);
    
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    this.homey.log('Sorted combinations:', sortedCombinations);
    
    const result = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
    this.homey.log(`Selected ${condition} combination:`, result);
    this.homey.log('=== End: findTargetCombination ===');
    
    return result;
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

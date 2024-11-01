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

    // Plánování půlnoční aktualizace přes driver
    this.driver.scheduleMidnightUpdate();

    // Nastavení hodinové aktualizace
    this.scheduleHourlyUpdate();
    
    // Nastavení kontroly průměrných cen
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    try {
      // Okamžitá kontrola průměrných cen
      await this.checkAveragePrice().catch(err => {
        this.error('Error in initial average price check:', err);
      });

      // Plánování další kontroly na začátek příští hodiny
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      const delay = nextHour.getTime() - now.getTime();

      this.averagePriceTimeout = this.homey.setTimeout(() => {
        this.checkAveragePrice();
        
        // Nastavení hodinového intervalu
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

  scheduleHourlyUpdate() {
    
    const scheduleNextUpdate = () => {
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
      const nextHour = new Date();
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0); // Nastavíme 0ms po celé hodině
        
        // Vypočítáme zpoždění do příští aktualizace
        const delay = nextHour.getTime() - Date.now();
        
        const minutes = Math.floor(delay / 60000); // Převod na minuty
        const seconds = Math.floor((delay % 60000) / 1000); // Zbývající sekundy
        this.homey.log(`Příští aktualizace current price naplánována za ${minutes} minut a ${seconds} sekund (${new Date(nextHour).toISOString()})`);

        // Naplánujeme aktualizaci
        this.hourlyUpdateTimeout = this.homey.setTimeout(async () => {
            try {
                const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;
                
                // Získáme hodnoty pro aktuální hodinu
                const price = await this.getCapabilityValue(`hour_price_CZK_${currentHour}`);
                const index = await this.getCapabilityValue(`hour_price_index_${currentHour}`);
                
                if (price !== null && index !== null) {
                    // Nastavíme nové hodnoty
                    await Promise.all([
                        this.setCapabilityValue('measure_current_spot_price_CZK', price),
                        this.setCapabilityValue('measure_current_spot_index', index)
                    ]);

                    // Spustíme trigger pro změnu ceny
                    await this.driver.triggerCurrentPriceChangedFlow(this, { price });
                    
                    this.homey.log('Current price úspěšně aktualizována');
                } else {
                    this.error(`Chybějící data pro hodinu ${currentHour}:`, { price, index });
                }
            } catch (error) {
                this.error('Chyba při aktualizaci current price:', error);
            }

            // Naplánujeme další aktualizaci
            scheduleNextUpdate();
        }, delay);
    };

    // Spustíme první plánování
    scheduleNextUpdate();

    // Vyčistíme timeout při odstranění zařízení
    this.registerTimeoutHandler('hourlyUpdateTimeout');
}

// Pomocná metoda pro registraci timeout handleru
registerTimeoutHandler(timeoutName) {
  if (!this._timeoutHandlers) {
      this._timeoutHandlers = new Set();
  }
  this._timeoutHandlers.add(timeoutName);
}

  // Optimalizovaná metoda pro nastavení cenových indexů
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
  
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
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
    try {
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      const pricesWithIndexes = this.setPriceIndexes(dailyPrices);

      for (const priceData of pricesWithIndexes) {
        await this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, this.convertPrice(priceData.priceCZK));
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level);
      }
  
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
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
      this.homey.log('Denní průměrná cena úspěšně nastavena:', averagePrice);
    } catch (error) {
      this.error('Chyba při aktualizaci denní průměrné ceny:', error);
    }
  }  
  
  
  async onDeleted() {
    this.homey.log('Čištění device resources...');
    
    // Vyčistíme všechny intervaly
    if (this.dataFetchInterval) {
        this.homey.clearInterval(this.dataFetchInterval);
    }
    if (this.averagePriceInterval) {
        this.homey.clearInterval(this.averagePriceInterval);
    }
    if (this.averagePriceTimeout) {
        this.homey.clearTimeout(this.averagePriceTimeout);
    }

    // Vyčistíme všechny zaregistrované timeouty
    if (this._timeoutHandlers) {
        for (const timeoutName of this._timeoutHandlers) {
            if (this[timeoutName]) {
                this.homey.clearTimeout(this[timeoutName]);
                this[timeoutName] = null;
            }
        }
    }

    this.homey.log('Device cleanup dokončen');
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
          const { hours, condition } = args;
          const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
          const currentHour = timeInfo.hour;
                    
          // Pro condition vždy začínáme od 0. hodiny
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
    const flows = await triggerCard.getArgumentValues(this);

    for (const flow of flows) {
      const { hours, condition } = flow;
      
      const allCombinations = await this.calculateAveragePrices(hours, 0);
      const targetCombination = this.findTargetCombination(allCombinations, condition);
            
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
    
  } catch (error) {
    this.error('Error checking average price:', error);
  }
}

  async calculateAveragePrices(hours, startFromHour = 0) {
    
    if (startFromHour < 0 || startFromHour >= 24) {
      this.homey.error(`Invalid startFromHour: ${startFromHour}`);
      startFromHour = 0;
    }
    
    const allCombinations = [];
        
    for (let startHour = startFromHour; startHour <= 24 - hours; startHour++) {
      let total = 0;
      
      for (let i = startHour; i < startHour + hours; i++) {
        const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
        
        if (price === null || price === undefined) {
          this.homey.error(`  Error: Missing price data for hour ${i}`);
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
    this.homey.log(`Finding ${condition} combination from ${combinations.length} combinations`);
    
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    
    const result = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
    this.homey.log(`Selected ${condition} combination:`, result);
    
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

'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/PriceCalculator');

class CZSpotPricesDevice extends Homey.Device {

    async onInit() {
      try {
        await this.initializeBasicSettings();
        
        // Načtení dat jen pokud nemáme čerstvá data
        const lastUpdate = await this.getStoreValue('lastDataUpdate');
        const now = Date.now();
        if (!lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
            await this.initialDataFetch();
        } else {
            this.homey.log('Skipping initial data fetch - using recent data');
        }
        
        // Nastavení plánovaných úloh bez okamžitého spuštění
        await this.setupScheduledTasks(false);
        
        // Nastavení flow karet a ostatní inicializace...
        await this._registerCapabilities();
        this.setupFlowCards();
        
        this.homey.log('Device initialization completed');
    } catch (error) {
        this.error('Device initialization failed:', error);
        await this.setUnavailable('Initialization failed');
    }
  }
  
  async initializeBasicSettings() {
      this.homey.log('Initializing device...');
  
      // Inicializace helperů
      this.priceCalculator = new PriceCalculator(this.homey);
      this.spotPriceApi = new SpotPriceAPI(this.homey);
      this.intervalManager = new IntervalManager(this.homey);
  
      // Inicializace device ID
      await this.initializeDeviceId();
  
      // Načtení nastavení
      await this.initializeSettings();
  
      // Registrace capabilities
      await this._registerCapabilities();
  
      // Nastavení Flow karet
      this.setupFlowCards();
  
      // Nastavení iniciálního tarifu
      await this.initializeInitialTariff();
  }
  
  async initializeDeviceId() {
      const deviceId = this.getData().id || this.getStoreValue('device_id');
      if (!deviceId) {
          const newDeviceId = this.generateDeviceId();
          await this.setStoreValue('device_id', newDeviceId);
          this.homey.log('Generated new device ID:', newDeviceId);
      } else {
          this.homey.log('Device initialized with ID:', deviceId);
      }
  }
  
  async initializeSettings() {
      this.lowIndexHours = this.getLowIndexHours();
      this.highIndexHours = this.getHighIndexHours();
      this.priceInKWh = this.getSetting('price_in_kwh') || false;
      
      this.homey.log('Device settings:', { 
          lowIndexHours: this.lowIndexHours, 
          highIndexHours: this.highIndexHours, 
          priceInKWh: this.priceInKWh 
      });
  }
  
  async initializeInitialTariff() {
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
      const initialTariff = this.priceCalculator.isLowTariff(currentHour, this.getSettings()) ? 'low' : 'high';
      await this.setStoreValue('previousTariff', initialTariff);
      this.homey.log('Initial tariff set to:', initialTariff);
  }
  
  async initialDataFetch() {
    const lastUpdate = await this.getStoreValue('lastDataUpdate');
    const now = Date.now();
    const firstInit = await this.getStoreValue('firstInit');
    
    if (!firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
        try {
            await this.fetchAndUpdateSpotPrices();
            await this.setStoreValue('lastDataUpdate', now);
            await this.setStoreValue('firstInit', true);
            await this.setAvailable();
            this.homey.log('Initial data fetch completed');
            return true;
        } catch (error) {
            this.error('Initial data fetch failed:', error);
            await this.setUnavailable('Initial data fetch failed');
            return false;
        }
    } else {
        this.homey.log('Using cached data');
        return true;
    }
}
  
  async setupScheduledTasks(runImmediately = false) {
    this.homey.log('Setting up scheduled tasks...');
    
    // Ověření, že máme všechny potřebné instance
    if (!this.intervalManager || !this.spotPriceApi || !this.priceCalculator) {
      this.error('Chybí potřebné instance pro scheduled tasks');
      return;
    }

    const initialDelay = this.intervalManager.calculateDelayToNextHour();
    
    // Nastavení hodinové aktualizace
    const hourlyCallback = async () => {
      try {
        await this.updateHourlyData();
        await this.setStoreValue('lastHourlyUpdate', new Date().getTime());
        this.homey.log('Hourly update completed successfully');
      } catch (error) {
        this.error('Hourly update failed:', error);
      }
    };  

    // Nastavení průměrných cen
    const averagePriceCallback = async () => {
      try {
        await this.checkAveragePrice();
        await this.setStoreValue('lastAverageUpdate', new Date().getTime());
        this.homey.log('Average price check completed');
      } catch (error) {
        this.error('Average price check failed:', error);
      }
    };

    // Registrace intervalů
    this.intervalManager.setScheduledInterval(
        'hourly',
        hourlyCallback,
        60 * 60 * 1000,
        initialDelay
    );

    this.intervalManager.setScheduledInterval(
        'average',
        averagePriceCallback,
        60 * 60 * 1000,
        initialDelay
    );

    // Spustit okamžitě pouze pokud je vyžadováno a ještě nebylo spuštěno v této hodině
    if (runImmediately) {
        const now = new Date();
        const currentHour = now.setMinutes(0, 0, 0);
        const [lastHourlyUpdate, lastAverageUpdate] = await Promise.all([
            this.getStoreValue('lastHourlyUpdate'),
            this.getStoreValue('lastAverageUpdate')
        ]);

        const tasks = [];
        
        if (!lastHourlyUpdate || new Date(lastHourlyUpdate).getTime() < currentHour) {
            tasks.push(hourlyCallback());
        } else {
            this.homey.log('Skipping initial hourly update - already done this hour');
        }
        
        if (!lastAverageUpdate || new Date(lastAverageUpdate).getTime() < currentHour) {
            tasks.push(averagePriceCallback());
        } else {
            this.homey.log('Skipping initial average price check - already done this hour');
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    }

    // Formátování a logování následující aktualizace
    const { hours, minutes, seconds } = this._formatDelay(initialDelay);
    this.homey.log(`Next update scheduled in ${hours ? hours + 'h ' : ''}${minutes}m ${seconds}s`);
}

async updateHourlyData() {
  try {
      // Získání aktuálního času s respektováním časové zóny
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();

      this.homey.log('Začátek hodinové aktualizace:', {
          hour: timeInfo.hour,
          systemHour: new Date().getHours(),
          timezone: this.homey.clock.getTimezone()
      });
      
      // Získání aktuální ceny a indexu pro danou hodinu
      const [currentPrice, currentIndex] = await Promise.all([
          this.getCapabilityValue(`hour_price_CZK_${timeInfo.hour}`),
          this.getCapabilityValue(`hour_price_index_${timeInfo.hour}`)
      ]);
      
      // Validace získaných dat
      if (currentPrice === null || currentIndex === null) {
          this.homey.error('Chybí data pro hodinu:', {
              hour: timeInfo.hour,
              price: currentPrice,
              index: currentIndex
          });
          return false;
      }

      // Aktualizace current capabilities s lepším error handlingem
      try {
          await Promise.all([
              this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice)
                  .catch(err => {
                      this.error('Chyba při aktualizaci current price capability:', err);
                      throw err;
                  }),
              this.setCapabilityValue('measure_current_spot_index', currentIndex)
                  .catch(err => {
                      this.error('Chyba při aktualizaci current index capability:', err);
                      throw err;
                  })
          ]);
      } catch (error) {
          this.error('Chyba při aktualizaci capabilities:', error);
          return false;
      }

      // Trigger pro změnu ceny s rozšířenými informacemi
      try {
          await this.triggerCurrentPriceChanged({
              price: currentPrice,
              index: currentIndex,
              hour: timeInfo.hour,
              timestamp: new Date().toISOString()
          });
      } catch (error) {
          this.error('Chyba při spouštění price change triggeru:', error);
          // Pokračujeme dál i když trigger selže
      }

      // Rozšířené logování pro debugging
      this.homey.log('Hodinová aktualizace dokončena:', {
          hour: timeInfo.hour,
          systemHour: new Date().getHours(),
          price: currentPrice,
          index: currentIndex,
          timezone: this.homey.clock.getTimezone(),
          timeString: new Date().toLocaleString('en-US', { 
              timeZone: this.homey.clock.getTimezone() 
          })
      });

      return true;
  } catch (error) {
      this.error('Kritická chyba při hodinové aktualizaci:', error);
      return false;
  }
}

// Helper pro formátování času
_formatDelay(delay) {
    const hours = Math.floor(delay / (1000 * 60 * 60));
    const minutes = Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((delay % (1000 * 60)) / 1000);
    return { hours, minutes, seconds };
}

async checkAveragePrice() {
  try {
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
      
      // Získat flow kartu pro trigger
      const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
      if (!triggerCard) {
          throw new Error('Nenalezena average-price-trigger karta');
      }

      // Získat všechny flow s jejich argumenty
      const flows = await triggerCard.getArgumentValues(this);
      this.homey.log('Checking average prices for hour:', currentHour, 'Number of flows:', flows.length);

      // Zpracovat každý flow zvlášť
      for (const flow of flows) {
          const { hours, condition } = flow;
          
          try {
              // Použít PriceCalculator místo lokální metody
              const allCombinations = await this.priceCalculator.calculateAveragePrices(this, hours, 0);
              if (!allCombinations || allCombinations.length === 0) {
                  this.homey.error('Nebyly nalezeny žádné kombinace pro výpočet průměru');
                  continue;
              }
              
              // Seřadit kombinace podle průměrné ceny
              const prices = allCombinations.sort((a, b) => a.avg - b.avg);
              const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];

              // Kontrola, zda aktuální hodina je začátkem intervalu
              if (targetCombination.startHour === currentHour) {
                  this.homey.log(`Nalezen interval pro trigger - ${condition} kombinace pro ${hours} hodin`, {
                      startHour: targetCombination.startHour,
                      currentHour,
                      averagePrice: targetCombination.avg
                  });
                  
                  // Vytvoření tokenu s průměrnou cenou
                  const tokens = {
                      average_price: parseFloat(targetCombination.avg.toFixed(2))
                  };
                  
                  // Trigger flow
                  await triggerCard.trigger(this, tokens, { 
                      hours: hours, 
                      condition: condition 
                  });
                  
                  this.homey.log('Average price trigger proveden úspěšně', {
                      hours,
                      condition,
                      averagePrice: tokens.average_price
                  });
              } else {
                  this.homey.log(`Hodina ${currentHour} není začátkem ${condition} ${hours}-hodinového okna (začátek: ${targetCombination.startHour})`);
              }
          } catch (error) {
              this.error(`Chyba při zpracování flow s hours=${hours}, condition=${condition}:`, error);
          }
      }
      
      return true;
  } catch (error) {
      this.error('Chyba v checkAveragePrice:', error);
      return false;
  }
}

  /**
   * Registrace capabilities
   */
  async _registerCapabilities() {
      const capabilities = [
          'measure_current_spot_price_CZK',
          'measure_current_spot_index',
          'daily_average_price',
          'primary_api_fail',
          'spot_price_update_status',
          ...Array.from({ length: 24 }, (_, i) => [
              `hour_price_CZK_${i}`, 
              `hour_price_index_${i}`
          ]).flat()
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
  }
  
  /**
   * Gettery pro nastavení
   */
  getLowIndexHours() {
      return this.getSetting('low_index_hours') || 8;
  }
  
  getHighIndexHours() {
      return this.getSetting('high_index_hours') || 8;
  }
  
  getPriceInKWh() {
      return this.getSetting('price_in_kwh') || false;
  }
  
  /**
   * Generování ID zařízení
   */
  generateDeviceId() {
      return this.homey.util.generateUniqueId();
  }
    /**
 * Handler pro změnu nastavení zařízení
 */
    async onSettings({ oldSettings, newSettings, changedKeys }) {
      const changedValues = changedKeys.reduce((acc, key) => {
        acc[key] = {
            oldValue: oldSettings[key],
            newValue: newSettings[key]
        };
        return acc;
    }, {});
    
    this.homey.log('Settings changed, checking updates...', { 
        changedKeys, 
        changes: changedValues 
    });
    
      try {
          // Aktualizace interních proměnných
          if (changedKeys.includes('low_index_hours')) {
              this.lowIndexHours = newSettings.low_index_hours;
              this.homey.log('Updated lowIndexHours to:', this.lowIndexHours);
          }
          if (changedKeys.includes('high_index_hours')) {
              this.highIndexHours = newSettings.high_index_hours;
              this.homey.log('Updated highIndexHours to:', this.highIndexHours);
          }
          if (changedKeys.includes('price_in_kwh')) {
              this.priceInKWh = newSettings.price_in_kwh;
              this.homey.log('Updated priceInKWh to:', this.priceInKWh);
          }
    
          // Kontrola změn v tarifních nastaveních nebo jednotkách
          const needsRecalculation = changedKeys.some(key => 
              key.startsWith('hour_') || 
              key === 'high_tariff_price' || 
              key === 'low_tariff_price' ||
              key === 'price_in_kwh'
          );
    
          if (needsRecalculation) {
              this.homey.log('Recalculating prices with new settings...');
              
              // Vyčištění cache pro zajištění čerstvého přepočtu
              this.priceCalculator.clearCache();
              
              // Získání aktuálních cen
              const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
              
              // Přepočet cen s novými nastaveními
              const processedPrices = dailyPrices.map(priceData => ({
                  ...priceData,
                  priceCZK: this.priceCalculator.addDistributionPrice(
                      priceData.priceCZK,
                      newSettings,
                      priceData.hour
                  )
              }));
    
              // Aktualizace všech cen pomocí existující metody
              await this.updateAllPrices(processedPrices);
              
              this.homey.log('Price recalculation completed');
          }
    
          // Informujeme o změně nastavení pro aktualizaci widgetů a dalších komponent
          this.homey.emit('settings_changed');
          this.homey.log('Settings update completed successfully');
    
          return true;
    
      } catch (error) {
          this.error('Error processing settings change:', error);
          throw error;
      }
    }

   /**
 * Hlavní metoda pro aktualizaci cen
 */
async fetchAndUpdateSpotPrices() {
  await this.setCapabilityValue('spot_price_update_status', false);
  this.homey.log('Fetching and updating spot prices');
  
  try {
      // Získání cen z API
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      
      if (!this.priceCalculator.validatePriceData(dailyPrices)) {
          throw new Error('Invalid daily prices data received from API');
      }

      // Přidání distribučního tarifu k cenám
      const settings = this.getSettings();
      const processedPrices = dailyPrices.map(priceData => ({
          ...priceData,
          priceCZK: this.priceCalculator.addDistributionPrice(
              priceData.priceCZK,
              settings,
              priceData.hour
          )
      }));

      // Aktualizace všech cen
      await this.updateAllPrices(processedPrices);

      // Nastavení dostupnosti a status flagu
      await this.setAvailable();
      await this.setCapabilityValue('spot_price_update_status', true);
      
      // Emit události pro aktualizaci UI
      await this.homey.emit('spot_prices_updated', {
          deviceId: this.getData().id,
          currentPrice: await this.getCapabilityValue('measure_current_spot_price_CZK'),
          currentIndex: await this.getCapabilityValue('measure_current_spot_index'),
          averagePrice: await this.getCapabilityValue('daily_average_price')
      });

      return true;

  } catch (error) {
      this.error('Error fetching spot prices:', error);
      await this.homey.notifications.createNotification({
          excerpt: `Error fetching spot prices: ${error.message}`
      });
      return false;
  }
}

/**
* Aktualizace všech cenových dat
*/
async updateAllPrices(processedPrices) {
  try {
      // Ujistíme se, že máme inicializovaný PriceCalculator
      if (!this.priceCalculator) {
          this.homey.error('PriceCalculator není inicializován');
          throw new Error('PriceCalculator není inicializován');
      }

      const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
          processedPrices,
          this.getLowIndexHours(),
          this.getHighIndexHours()
      );

      // Paralelní aktualizace všech capabilities
      await Promise.all([
          this._updateHourlyCapabilities(pricesWithIndexes),
          this._updateCurrentPrice(pricesWithIndexes),
          this._updateDailyAverage(pricesWithIndexes)
      ]);

      return true;
  } catch (error) {
      this.error('Error updating prices:', error);
      throw error;
  }
}

/**
* Helper pro aktualizaci hodinových capabilities
*/
async _updateHourlyCapabilities(pricesWithIndexes) {
  // Použití this.priceInKWh namísto přímého přístupu k nastavení pro konzistenci
  const currentPriceInKWh = this.priceInKWh;

  // Převod a aktualizace hodnot pro každou hodinu
  const updatePromises = pricesWithIndexes.map(async priceData => {
      
      // Převod ceny podle aktuálního nastavení (priceInKWh)
      const convertedPrice = this.priceCalculator.convertPrice(
          priceData.priceCZK,
          currentPriceInKWh
      );

      // Logování pro kontrolu hodnot
      this.homey.log('Updating capability with:', {
          hour: priceData.hour,
          originalPrice: priceData.priceCZK,
          convertedPrice,
          priceInKWh: currentPriceInKWh
      });

      // Paralelní aktualizace capabilities pro danou hodinu
      return Promise.all([
          this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, convertedPrice),
          this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level)
      ]);
  });

  // Vrátíme Promise pro všechny aktualizace najednou
  return Promise.all(updatePromises);
}


/**
* Helper pro aktualizaci aktuální ceny
*/
async _updateCurrentPrice(pricesWithIndexes) {
  try {
      // Získání aktuálního času s respektováním časové zóny
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();

      // Použití uložené hodnoty priceInKWh pro konzistenci
      const currentPriceInKWh = this.priceInKWh;

      this.homey.log('Začátek aktualizace current price:', {
          hour: timeInfo.hour,
          priceInKWh: currentPriceInKWh
      });

      // Hledání dat pro aktuální hodinu
      const currentHourData = pricesWithIndexes.find(price => price.hour === timeInfo.hour);
      if (!currentHourData) {
          this.error('Nenalezena data pro aktuální hodinu:', {
              hour: timeInfo.hour,
              availableHours: pricesWithIndexes.map(p => p.hour).join(', ')
          });
          return;
      }

      // Konverze ceny s použitím uložené hodnoty priceInKWh
      const convertedPrice = this.priceCalculator.convertPrice(
          currentHourData.priceCZK,
          currentPriceInKWh // používáme přímo this.priceInKWh
      );

      this.homey.log('Cena před aktualizací capabilities:', {
          originalPrice: currentHourData.priceCZK,
          convertedPrice,
          priceInKWh: currentPriceInKWh
      });

      // Aktualizace capabilities s lepším error handlingem
      await Promise.all([
          this.setCapabilityValue('measure_current_spot_price_CZK', convertedPrice)
              .catch(err => {
                  this.error('Chyba při aktualizaci current price capability:', err);
                  throw err;
              }),
          this.setCapabilityValue('measure_current_spot_index', currentHourData.level)
              .catch(err => {
                  this.error('Chyba při aktualizaci current index capability:', err);
                  throw err;
              })
      ]);

      // Trigger pro změnu ceny s rozšířenými informacemi
      await this.triggerCurrentPriceChanged({
          price: convertedPrice,
          index: currentHourData.level,
          hour: timeInfo.hour,
          timestamp: new Date().toISOString(),
          priceInKWh: currentPriceInKWh // přidáno pro kontext
      });
      
      // Rozšířené logování pro debugging
      this.homey.log('Aktuální cena aktualizována:', {
          hour: timeInfo.hour,
          systemHour: new Date().getHours(),
          price: convertedPrice,
          originalPrice: currentHourData.priceCZK,
          index: currentHourData.level,
          timezone: this.homey.clock.getTimezone(),
          settingPriceInKWh: currentPriceInKWh,
          methodPriceInKWh: this.getPriceInKWh() // pro porovnání s hodnotou z nastavení
      });

  } catch (error) {
      this.error('Chyba při aktualizaci aktuální ceny:', error);
      throw error;
  }
}

/**
* Helper pro aktualizaci denního průměru
*/
async _updateDailyAverage(pricesWithIndexes) {
  try {
      // Vypočítání průměrné ceny
      const totalPrice = pricesWithIndexes.reduce((sum, price) => sum + price.priceCZK, 0);
      const averagePrice = this.priceCalculator.convertPrice(
          totalPrice / pricesWithIndexes.length,
          this.priceInKWh  // Použití přímo uložené hodnoty priceInKWh
      );
      
      // Nastavení průměrné ceny jako capability
      return this.setCapabilityValue('daily_average_price', averagePrice);
  } catch (error) {
      this.error('Chyba při aktualizaci denního průměru:', error);
      throw error;
  }
}


 /**
 * Registrace všech flow karet
 */
setupFlowCards() {
  this.homey.log('Setting up flow cards for device.');
  
  // Základní podmínkové karty
  this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', current => current < value);
  this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', current => current > value);
  this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', (current, target) => current === target);
  
  // Registrace karty pro průměrnou cenu
  this._registerAveragePriceCondition();

  // Základní trigger karty
  this._registerTriggerCard('current-price-lower-than-trigger', 'measure_current_spot_price_CZK', current => current < value);
  this._registerTriggerCard('current-price-higher-than-trigger', 'measure_current_spot_price_CZK', current => current > value);
  this._registerTriggerCard('current-price-index-trigger', 'measure_current_spot_index', (current, target) => current === target);

  // Speciální trigger karty
  this._registerApiFailureCard();
  this._registerPriceChangeCard();
  this._registerDistributionTariffChangeCard();
}

/**
* Registrace základní podmínkové karty
*/
_registerConditionCard(cardId, capability, comparison) {
  this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
          try {
              const currentValue = await this.getCapabilityValue(capability);
              
              if (currentValue === null || currentValue === undefined) {
                  throw new Error(`Value not available for ${capability}`);
              }

              const result = comparison(currentValue, args.value);
              this.homey.log(`Condition ${cardId} evaluated:`, {
                  current: currentValue,
                  target: args.value,
                  result
              });

              return result;
          } catch (error) {
              this.error(`Error in condition card ${cardId}:`, error);
              return false;
          }
      });
}

/**
* Registrace karty pro průměrnou cenu
*/
_registerAveragePriceCondition() {
  this.homey.flow.getConditionCard('average-price-condition')
      .registerRunListener(async (args, state) => {
          try {
              const { hours, condition } = args;
              const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
              const currentHour = timeInfo.hour;

              const allCombinations = await this.priceCalculator.calculateAveragePrices(this, hours, 0);
              const prices = allCombinations.sort((a, b) => a.avg - b.avg);
              const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];

              const result = currentHour >= targetCombination.startHour && 
                          currentHour < (targetCombination.startHour + hours);

              this.homey.log('Average price condition result:', {
                  currentHour,
                  targetStartHour: targetCombination.startHour,
                  hours,
                  condition,
                  result
              });

              return result;
          } catch (error) {
              this.error('Error in average price condition:', error);
              return false;
          }
      });
}

/**
* Registrace základní trigger karty
*/
_registerTriggerCard(cardId, capability, comparison) {
  this.homey.flow.getDeviceTriggerCard(cardId)
      .registerRunListener(async (args, state) => {
          try {
              const currentValue = await this.getCapabilityValue(capability);
              
              if (currentValue === null || currentValue === undefined) {
                  throw new Error(`Value not available for ${capability}`);
              }

              const result = comparison(currentValue, args.value);
              this.homey.log(`Trigger ${cardId} evaluated:`, {
                  current: currentValue,
                  target: args.value,
                  result
              });

              return result;
          } catch (error) {
              this.error(`Error in trigger card ${cardId}:`, error);
              return false;
          }
      });
}

/**
* Registrace karty pro API chyby
*/
_registerApiFailureCard() {
  this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger')
      .registerRunListener(async (args, state) => {
          this.homey.log('API failure trigger invoked:', { 
              args: args.type, 
              state: state.type 
          });
          return args.type === state.type;
      });
}

/**
* Registrace karty pro změnu ceny
*/
_registerPriceChangeCard() {
  this.homey.flow.getDeviceTriggerCard('when-current-price-changes')
      .registerRunListener(async (args, state) => {
          this.homey.log('Price change trigger invoked');
          return true;
      });
}

/**
* Registrace karty pro změnu distribučního tarifu
*/
_registerDistributionTariffChangeCard() {
  this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes')
      .registerRunListener(async (args, state) => {
          const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
          const currentHour = timeInfo.hour;
          const settings = this.getSettings();
          const currentTariff = this.priceCalculator.isLowTariff(currentHour, settings) ? 'low' : 'high';
          
          this.homey.log('Distribution tariff change trigger invoked:', {
              currentHour,
              currentTariff
          });
          
          return true;
      });
}

/**
* Trigger pro změnu aktuální ceny
*/
async triggerCurrentPriceChanged(tokens) {
  try {
      const triggerCard = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
      await triggerCard.trigger(this, tokens);
      this.homey.log('Current price changed trigger executed with tokens:', tokens);
  } catch (error) {
      this.error('Error triggering current price changed:', error);
  }
}

 /**
 * Cleanup při odstranění zařízení
 */
async onDeleted() {
  this.homey.log('Cleaning up device resources...');

  try {
      // Vyčištění všech intervalů
      if (this.intervalManager) {
          this.intervalManager.clearAll();
          this.homey.log('All intervals cleared');
      }

      // Vyčištění cache priceCalculatoru
      if (this.priceCalculator) {
          this.priceCalculator.clearCache();
          this.homey.log('Price calculator cache cleared');
      }

      // Vyčištění store hodnot
      const storeKeys = [
          'device_id',
          'previousTariff'
      ];

      await Promise.all(
          storeKeys.map(async key => {
              try {
                  await this.unsetStoreValue(key);
              } catch (error) {
                  this.error(`Failed to unset store value ${key}:`, error);
              }
          })
      );
      this.homey.log('Store values cleared');

      // Vyčištění referencí
      this.spotPriceApi = null;
      this.priceCalculator = null;
      this.intervalManager = null;

      this.homey.log('Device cleanup completed successfully');
  } catch (error) {
      this.error('Error during device cleanup:', error);
  }
}

/**
 * Helper pro získání aktuální hodiny a její data
 */
async getCurrentHourData() {
  try {
      const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour === 24 ? 0 : timeInfo.hour;
      
      return {
          hour: currentHour,
          price: await this.getCapabilityValue(`hour_price_CZK_${currentHour}`),
          index: await this.getCapabilityValue(`hour_price_index_${currentHour}`),
          isLowTariff: this.priceCalculator.isLowTariff(currentHour, this.getSettings())
      };
  } catch (error) {
      this.error('Error getting current hour data:', error);
      return null;
  }
}

/**
* Helper pro získání stavu všech capabilities najednou
*/
async getDeviceState() {
  try {
      const currentHourData = await this.getCurrentHourData();
      const dailyAverage = await this.getCapabilityValue('daily_average_price');
      const updateStatus = await this.getCapabilityValue('spot_price_update_status');
      const settings = this.getSettings();

      return {
          currentHour: currentHourData,
          dailyAverage,
          updateStatus,
          settings,
          deviceId: this.getData().id
      };
  } catch (error) {
      this.error('Error getting device state:', error);
      return null;
  }
}

/**
* Debug helper pro výpis stavů všech capabilities
*/
async logDeviceState() {
  try {
      const state = await this.getDeviceState();
      this.homey.log('Current device state:', JSON.stringify(state, null, 2));
  } catch (error) {
      this.error('Error logging device state:', error);
  }
}

/**
* Helper pro validaci capability hodnot
*/
async validateCapabilityValues() {
  const issues = [];

  try {
      // Kontrola základních capabilities
      const basicCapabilities = [
          'measure_current_spot_price_CZK',
          'measure_current_spot_index',
          'daily_average_price',
          'spot_price_update_status'
      ];

      for (const capability of basicCapabilities) {
          const value = await this.getCapabilityValue(capability);
          if (value === null || value === undefined) {
              issues.push(`Missing value for ${capability}`);
          }
      }

      // Kontrola hodinových capabilities
      for (let hour = 0; hour < 24; hour++) {
          const price = await this.getCapabilityValue(`hour_price_CZK_${hour}`);
          const index = await this.getCapabilityValue(`hour_price_index_${hour}`);

          if (price === null || price === undefined) {
              issues.push(`Missing price for hour ${hour}`);
          }
          if (index === null || index === undefined) {
              issues.push(`Missing index for hour ${hour}`);
          }
      }

      if (issues.length > 0) {
          this.homey.log('Capability validation issues found:', issues);
          return false;
      }

      this.homey.log('All capabilities validated successfully');
      return true;
  } catch (error) {
      this.error('Error validating capabilities:', error);
      return false;
  }
}

/**
* Helper pro reset stavu zařízení
*/
async resetDeviceState() {
  try {
      this.homey.log('Starting device state reset...');

      // Vyčištění cache
      this.priceCalculator.clearCache();

      // Reset všech capabilities na null
      const capabilities = this.getCapabilities();
      await Promise.all(
          capabilities.map(async capability => {
              try {
                  await this.setCapabilityValue(capability, null);
              } catch (error) {
                  this.error(`Error resetting capability ${capability}:`, error);
              }
          })
      );

      // Nastavení status flags
      await this.setCapabilityValue('spot_price_update_status', false);
      await this.setCapabilityValue('primary_api_fail', true);

      // Vynucení nové aktualizace dat
      await this.fetchAndUpdateSpotPrices();

      this.homey.log('Device state reset completed');
      return true;
  } catch (error) {
      this.error('Error resetting device state:', error);
      return false;
  }
}

/**
* Helper pro výpočet statistik
*/
async calculateStatistics() {
  try {
      const prices = [];
      for (let hour = 0; hour < 24; hour++) {
          const price = await this.getCapabilityValue(`hour_price_CZK_${hour}`);
          if (price !== null && price !== undefined) {
              prices.push(price);
          }
      }

      if (prices.length === 0) {
          throw new Error('No price data available');
      }

      const stats = {
          min: Math.min(...prices),
          max: Math.max(...prices),
          avg: prices.reduce((a, b) => a + b) / prices.length,
          count: prices.length,
          currentPrice: await this.getCapabilityValue('measure_current_spot_price_CZK'),
          currentIndex: await this.getCapabilityValue('measure_current_spot_index')
      };

      this.homey.log('Device statistics:', stats);
      return stats;
  } catch (error) {
      this.error('Error calculating statistics:', error);
      return null;
  }
}
}

module.exports = CZSpotPricesDevice;
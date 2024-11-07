'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/PriceCalculator');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    try {
        this.homey.log('CZSpotPricesDriver initialized');
        
        // Inicializace všech helperů
        this.spotPriceApi = new SpotPriceAPI(this.homey);
        this.intervalManager = new IntervalManager(this.homey);
        this.priceCalculator = new PriceCalculator(this.homey);

        // Validace instancí
        this.validateInstances();

        // Registrace flow karet
        await this.registerFlowCards();

        // Nastavení kontroly tarifu
        await this.setupTariffCheck();

        // Společné plánování půlnoční aktualizace pro všechna zařízení
        await this.scheduleMidnightUpdate();

        this.homey.log('Driver úspěšně inicializován');

    } catch (error) {
        this.error('Chyba při inicializaci driveru:', error);
        throw error; // Propagace chyby výš pro případné zachycení Homey
    }
}

validateInstances() {
  const validations = [
      { instance: this.spotPriceApi, name: 'SpotPriceAPI' },
      { instance: this.intervalManager, name: 'IntervalManager' },
      { instance: this.priceCalculator, name: 'PriceCalculator' }
  ];

  const missingInstances = validations
      .filter(({instance}) => !instance)
      .map(({name}) => name);

  if (missingInstances.length > 0) {
      throw new Error(`Chybí instance: ${missingInstances.join(', ')}`);
  }

  return true;
}

  async scheduleMidnightUpdate() {
    this.homey.log('Scheduling midnight update');
    
    // Callback pro půlnoční aktualizaci
    const midnightCallback = async () => {
        try {
            const devices = this.getDevices();
            const now = new Date();
            const todayMidnight = new Date(now).setHours(0,0,0,0);
            
            for (const device of Object.values(devices)) {
                const lastUpdate = await device.getStoreValue('lastMidnightUpdate');
                
                if (!lastUpdate || new Date(lastUpdate).getTime() < todayMidnight) {
                    await this.executeMidnightUpdate();
                    await device.setStoreValue('lastMidnightUpdate', now.getTime());
                    this.homey.log('Midnight update completed successfully');
                } else {
                    this.homey.log('Skipping midnight update - already done today');
                }
            }
        } catch (error) {
            this.error('Chyba při půlnoční aktualizaci:', error);
        }
    };

    // Výpočet času do půlnoci
    const calculateDelayToMidnight = () => {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow.getTime() - now.getTime();
    };

    // Nastavení intervalu
    const initialDelay = calculateDelayToMidnight();
    const { hours, minutes, seconds } = this._formatDelay(initialDelay);
    
    this.homey.log(`Příští aktualizace z API naplánována za ${hours} h, ${minutes} m a ${seconds} s`);

    this.intervalManager.setScheduledInterval(
        'midnight',
        midnightCallback,
        24 * 60 * 60 * 1000,
        initialDelay
    );
}

// Helper pro formátování času
_formatDelay(delay) {
    const hours = Math.floor(delay / (1000 * 60 * 60));
    const minutes = Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((delay % (1000 * 60)) / 1000);
    return { hours, minutes, seconds };
}

  async executeMidnightUpdate(retryCount = 0) {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 5 * 60 * 1000;

    this.homey.log(`Spouštím půlnoční aktualizaci (pokus: ${retryCount} z ${MAX_RETRIES})`);
    
    const device = this._getFirstDevice();
    if (!device) {
      this.error('Nenalezeno žádné zařízení pro aktualizaci');
      return;
    }

    const success = await this._tryUpdatePrices(device);

    if (success) {
      await this._handleUpdateSuccess(device, retryCount);
    } else {
      await this._handleUpdateFailure(device, retryCount, MAX_RETRIES, BASE_DELAY);
    }
  }

  _getFirstDevice() {
    const devices = this.getDevices();
    return Object.values(devices)[0];
  }

  async _tryUpdatePrices(device) {
    try {
      await device.setCapabilityValue('spot_price_update_status', false);
      const updateResult = await this.tryUpdateDevice(device);
      if (updateResult) {
        await device.setCapabilityValue('spot_price_update_status', true);
      }
      return updateResult;
    } catch (error) {
      this.error(`Chyba při aktualizaci zařízení ${device.getName()}:`, error);
      return false;
    }
  }

  async _handleUpdateSuccess(device, retryCount) {
    // Vyčištění všech retry intervalů při úspěchu
    for (let i = 0; i <= retryCount; i++) {
      const retryIntervalId = `retry_midnight_${i}`;
      this.intervalManager.clearScheduledInterval(retryIntervalId);
    }
    this.homey.log('Půlnoční aktualizace úspěšně dokončena');
  }

  async _handleUpdateFailure(device, retryCount, maxRetries, baseDelay) {
    if (retryCount < maxRetries) {
      await this._scheduleRetry(device, retryCount, baseDelay);
    } else {
      await this._handleMaxRetriesReached(device);
    }
  }

  async _scheduleRetry(device, retryCount, baseDelay) {
    const delay = baseDelay * Math.pow(2, retryCount);
    this.homey.log(`Plánuji další pokus ${retryCount + 1} za ${delay/60000} minut`);
    
    await this.triggerAPIFailure(device, {
      primaryAPI: 'Aktualizace selhala',
      backupAPI: 'Aktualizace selhala',
      willRetry: true,
      retryCount: retryCount + 1,
      nextRetryIn: Math.round(delay / 60000)
    });

    this.intervalManager.setScheduledInterval(
      `retry_midnight_${retryCount}`,
      () => this.executeMidnightUpdate(retryCount + 1),
      null,
      delay
    );
  }

  async _handleMaxRetriesReached(device) {
    this.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.');
    await this.triggerAPIFailure(device, {
      primaryAPI: 'Aktualizace selhala',
      backupAPI: 'Aktualizace selhala',
      willRetry: false,
      maxRetriesReached: true
    });
  }

  async tryUpdateDevice(device) {
    try {
        const dailyPrices = await this.spotPriceApi.getDailyPrices(device);
        // Použijeme PriceCalculator z device instance
        if (!device.priceCalculator) {
            this.error('PriceCalculator není dostupný v device instanci');
            return false;
        }

        if (!device.priceCalculator.validatePriceData(dailyPrices)) {
            throw new Error('Neplatná data z API');
        }

        const settings = device.getSettings();
        const processedPrices = dailyPrices.map(priceData => ({
            ...priceData,
            priceCZK: device.priceCalculator.addDistributionPrice(
                priceData.priceCZK,
                settings,
                priceData.hour
            )
        }));

        await device.updateAllPrices(processedPrices);
        return true;
    } catch (error) {
        this.homey.error('Chyba při aktualizaci dat:', error);
        return false;
    }
}

  setupTariffCheck() {
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    const tariffCheckCallback = async () => {
        this.checkTariffChange();
    };

    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const initialDelay = nextHour.getTime() - now.getTime();

    this.intervalManager.setScheduledInterval(
        'tariff',
        tariffCheckCallback,
        60 * 60 * 1000,
        initialDelay
    );

    this.checkTariffChange();
    this.homey.log(`Next tariff check scheduled in ${Math.round(initialDelay / 1000)} seconds`);
  }

  checkTariffChange() {
    const devices = this.getDevices();
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;

    this.homey.log('Checking tariff change at exact hour:', currentHour);

    for (const device of Object.values(devices)) {
      this._checkDeviceTariffChange(device, currentHour);
    }
  }

  async _checkDeviceTariffChange(device, currentHour) {
    const settings = device.getSettings();
    const previousTariff = device.getStoreValue('previousTariff');
    const currentTariff = this.priceCalculator.isLowTariff(currentHour, settings) ? 'low' : 'high';

    if (previousTariff !== currentTariff) {
      try {
        await device.setStoreValue('previousTariff', currentTariff);
        await this.tariffChangeTrigger.trigger(device, { tariff: currentTariff });
        this.homey.log('Tariff change trigger successfully executed');
      } catch (error) {
        this.error('Error in tariff change process:', error);
      }
    } else {
      this.homey.log(`No tariff change at hour ${currentHour}: stayed at ${currentTariff}`);
    }
  }

  async triggerAPIFailure(device, errorInfo) {
    try {
      const apiFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
      const tokens = {
        error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
        will_retry: errorInfo.willRetry || false,
        retry_count: errorInfo.retryCount || 0,
        next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
        max_retries_reached: errorInfo.maxRetriesReached || false
      };
  
      await apiFailTrigger.trigger(device, tokens);
      this.homey.log('API failure trigger executed with tokens:', tokens);
    } catch (error) {
      this.error('Error triggering API failure:', error);
    }
  }

  registerFlowCards() {
    this.homey.log('Registering flow cards...');
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards();
  }

  _registerTriggerFlowCards() {
    try {
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getDeviceTriggerCard(cardId);
      });
      this.homey.log('Basic price and index trigger cards registered.');

      this.homey.flow.getDeviceTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));
      this.homey.log('Average price trigger card registered.');

      this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger')
        .registerRunListener(async (args, state) => {
          this.homey.log(`API call fail trigger invoked with type: ${args.type}`);
          return args.type === state.type;
        });

      this.homey.flow.getDeviceTriggerCard('when-current-price-changes')
        .registerRunListener(async (args, state) => {
          this.homey.log('Current price change trigger invoked.');
          return true;
        });

      this.tariffChangeTrigger = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');
      this.homey.log('Distribution tariff change trigger registered.');

    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
    }
  }

 
  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    try {
        // Použít PriceCalculator místo device metod
        const allCombinations = await this.priceCalculator.calculateAveragePrices(device, hours, 0);
        const prices = allCombinations.sort((a, b) => a.avg - b.avg);
        const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];
        
        const result = currentHour >= targetCombination.startHour && 
                    currentHour < (targetCombination.startHour + hours);
        
        this.homey.log(`Trigger result: ${result} (currentHour ${currentHour} is${result ? '' : ' not'} within window ${targetCombination.startHour}-${targetCombination.startHour + hours})`);
        
        return result;
    } catch (error) {
        this.error('Error in average price trigger:', error);
        return false;
    }
  }

_registerConditionFlowCards() {
  try {
      this.homey.log('Registering condition flow cards...');

      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');

      this.homey.flow.getConditionCard('distribution-tariff-is')
      .registerRunListener(async (args, state) => {
        const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
        const currentHour = timeInfo.hour;
        const device = args.device;
        const settings = device.getSettings();
        const isLowTariff = this.priceCalculator.isLowTariff(currentHour, settings);
        const result = args.tariff === (isLowTariff ? 'low' : 'high');
        this.homey.log(`Distribution tariff condition checked: expected ${args.tariff}, actual ${isLowTariff ? 'low' : 'high'}`);
        return result;
      });
  } catch (error) {
      this.error('Error registering condition Flow cards:', error);
  }
}

_registerAveragePriceConditionCard() {
  this.homey.flow.getConditionCard('average-price-condition')
    .registerRunListener(async (args, state) => {
      try {
        const { hours, condition } = args;
        const device = args.device;
        const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
  
        const allCombinations = await this.priceCalculator.calculateAveragePrices(device, hours, 0);
        const prices = allCombinations.sort((a, b) => a.avg - b.avg);
        const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];
        
        const result = currentHour >= targetCombination.startHour && 
                      currentHour < (targetCombination.startHour + hours);
        
        this.homey.log(`Average price condition evaluated to ${result}`);
        return result;
      } catch (error) {
        this.error('Error processing average price condition:', error);
        return false;
      }
    });
}

  _registerConditionCard(cardId, capability, operator) {
    this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const currentValue = await device.getCapabilityValue(capability);
        this.homey.log(`Condition card ${cardId} invoked with current value: ${currentValue} and target: ${args.value}`);

        if (currentValue === null || currentValue === undefined) {
          throw new Error(`Capability value for ${capability} is not available`);
        }
        
        switch(operator) {
          case '>': return currentValue > args.value;
          case '<': return currentValue < args.value;
          case '=': return currentValue === args.value;
          default: return false;
        }
      });
  }
  _registerActionFlowCards() {
    try {
      this.homey.log('Registering action flow cards...');
  
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args) => {
          const device = args.device;
          if (!device) {
            this.error('No device provided for update_data_via_api action');
            return false;
          }
  
          this.homey.log('Update daily prices via API action invoked.');
          try {
            await device.fetchAndUpdateSpotPrices();
            await device.setAvailable();
            return true;
          } catch (error) {
            const errorMessage = device.spotPriceApi.getErrorMessage(error);
            this.error(`Error updating daily prices for device ${device.getName()}:`, errorMessage);
            await device.setAvailable();
            device.spotPriceApi.triggerApiCallFail(errorMessage, device);
            return false;
          }
        });
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }

  async triggerCurrentPriceChangedFlow(device, tokens) {
    const triggerCard = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
    try {
      await triggerCard.trigger(device, tokens);
      this.homey.log(`Current price changed trigger executed for device ${device.getName()}.`);
    } catch (error) {
      this.error('Error triggering current price changed flow:', error);
    }
  }

  async onPairListDevices() {
    try {
      const deviceId = crypto.randomUUID();
      return [{
        name: 'CZ Spot Prices Device',
        data: { id: deviceId }
      }];
    } catch (error) {
      this.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
    try {
      const devices = this.getDevices();
      for (const device of Object.values(devices)) {
        await device.fetchAndUpdateSpotPrices();
      }
      // Vyčistíme cache PriceCalculatoru při změně nastavení
      this.priceCalculator.clearCache();
    } catch (error) {
      this.error("Error updating prices after settings change:", error);
    }
  }

  // Cleanup při odstranění driveru
  async onUninit() {
    if (this.intervalManager) {
      this.intervalManager.clearAll();
    }
    if (this.priceCalculator) {
      this.priceCalculator.clearCache();
    }
    this.homey.log('Driver uninitialized, all intervals cleared and cache cleared');
  }
}

module.exports = CZSpotPricesDriver;
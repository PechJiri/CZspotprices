'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.homey.log('CZSpotPricesDriver initialized');
    
    // Inicializace SpotPriceAPI instance pro tento driver
    this.spotPriceApi = new SpotPriceAPI(this.homey);

    // Přidat inicializaci IntervalManageru
    this.intervalManager = new IntervalManager(this.homey);
    
    // Načtení intervalů tarifů
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];

    // Registrace flow karet
    this.registerFlowCards();

    // Nastavení kontroly tarifu
    this.setupTariffCheck();

    // Společné plánování půlnoční aktualizace pro všechna zařízení
    this.scheduleMidnightUpdate();
}

scheduleMidnightUpdate() {
  this.homey.log('Scheduling midnight update');
  
  // Callback pro půlnoční aktualizaci
  const midnightCallback = async () => {
      try {
          await this.executeMidnightUpdate();
          this.homey.log('Midnight update completed successfully');
      } catch (error) {
          this.error('Chyba při půlnoční aktualizaci:', error);
      }
  };

  // Výpočet času do půlnoci
  const calculateDelayToMidnight = () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return tomorrow.getTime() - Date.now();
  };

  const initialDelay = calculateDelayToMidnight();

  // Převod zpoždění na hodiny, minuty a sekundy pro log
  const hours = Math.floor(initialDelay / (1000 * 60 * 60));
  const minutes = Math.floor((initialDelay % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((initialDelay % (1000 * 60)) / 1000);

  this.homey.log(`Příští aktualizace z API naplánována za ${hours} h, ${minutes} m a ${seconds} s`);

  // Nastavení intervalu pomocí IntervalManageru
  this.intervalManager.setScheduledInterval(
      'midnight',
      midnightCallback,
      24 * 60 * 60 * 1000, // 24 hodin
      initialDelay
  );

  // Spustíme callback okamžitě pro první aktualizaci
  this.homey.log('Running initial midnight update...');
  midnightCallback()
      .catch(error => this.error('Error in initial midnight update:', error));

  this.homey.log('Midnight update schedule initialized');
}

async executeMidnightUpdate(retryCount = 0) {
  const MAX_RETRIES = 5;
  const BASE_DELAY = 5 * 60 * 1000; // 5 minut v milisekundách

  this.homey.log(`Spouštím půlnoční aktualizaci (pokus: ${retryCount} z ${MAX_RETRIES})`);
  
  // Získáme první (a jediné) zařízení
  const devices = this.getDevices();
  const device = Object.values(devices)[0];
  
  if (!device) {
    this.error('Nenalezeno žádné zařízení pro aktualizaci');
    return;
  }

  let success = true;

  try {
    // Nastavení spot_price_update_status na false před aktualizací
    await device.setCapabilityValue('spot_price_update_status', false);
    const updateResult = await this.tryUpdateDevice(device);
    
    if (!updateResult) {
      success = false;
      this.homey.log(`Nepodařilo se aktualizovat zařízení ${device.getName()} pomocí obou API`);
    }
  } catch (error) {
    success = false;
    this.error(`Chyba při aktualizaci zařízení ${device.getName()}:`, error);
  }

  // Nastavení spot_price_update_status na true po úspěšné aktualizaci
  if (success) {
    await device.setCapabilityValue('spot_price_update_status', true);
    this.homey.log('Půlnoční aktualizace úspěšně dokončena');
    
    // Vyčištění všech retry intervalů při úspěchu
    for (let i = 0; i <= retryCount; i++) {
      const retryIntervalId = `retry_midnight_${i}`;
      if (this.intervalManager.intervals[retryIntervalId]) {
        this.intervalManager.clearScheduledInterval(retryIntervalId);
      }
    }
  }

  if (!success && retryCount < MAX_RETRIES) {
    const delay = BASE_DELAY * Math.pow(2, retryCount);
    this.homey.log(`Plánuji další pokus ${retryCount + 1} za ${delay/60000} minut`);
    
    await this.triggerAPIFailure(device, {
      primaryAPI: 'Aktualizace selhala',
      backupAPI: 'Aktualizace selhala',
      willRetry: true,
      retryCount: retryCount + 1,
      nextRetryIn: Math.round(delay / 60000)
    });

    // Unikátní ID pro každý retry pokus
    this.intervalManager.setScheduledInterval(
      `retry_midnight_${retryCount}`,  // unikátní ID pro každý retry
      () => this.executeMidnightUpdate(retryCount + 1),
      null,  // jednorázové spuštění
      delay
    );
  } else if (!success) {
    this.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.');
    await this.triggerAPIFailure(device, {
      primaryAPI: 'Aktualizace selhala',
      backupAPI: 'Aktualizace selhala',
      willRetry: false,
      maxRetriesReached: true
    });
  }
}

  async tryUpdateDevice(device) {
    let primaryError;
    try {
      // Pokus o primární API
      try {
        this.homey.log(`Attempting primary API update for device ${device.getName()}`);
        await this.spotPriceApi.getDailyPrices(device);
        const valid = await this.validatePriceData(device);
        if (valid) {
          this.homey.log(`Successfully updated device ${device.getName()} using primary API`);
          return true;
        }
        this.homey.log('Primary API data validation failed, will try backup API');
        primaryError = new Error('Data validation failed');
      } catch (error) {
        primaryError = error;
        this.homey.log('Primary API failed, will try backup API:', error.message);
      }

      // Pokus o záložní API
      try {
        this.homey.log(`Attempting backup API update for device ${device.getName()}`);
        await this.spotPriceApi.getBackupDailyPrices(device);
        const valid = await this.validatePriceData(device);
        if (valid) {
          this.homey.log(`Successfully updated device ${device.getName()} using backup API`);
          return true;
        }
        this.homey.log('Backup API data validation failed');
        throw new Error('Backup API data validation failed');
      } catch (backupError) {
        this.homey.log('Backup API failed:', backupError.message);
        
        await this.triggerAPIFailure(device, {
          primaryAPI: primaryError?.message || 'Unknown error',
          backupAPI: backupError.message,
          willRetry: true
        });
        
        return false;
      }
    } catch (error) {
      this.error('Error in tryUpdateDevice:', error);
      return false;
    }
  }

  async validatePriceData(device) {
    try {
      for (let hour = 0; hour < 24; hour++) {
        let checkedHour = (hour === 24) ? 0 : hour;
        const price = await device.getCapabilityValue(`hour_price_CZK_${hour}`);
        if (price === null || price === undefined || typeof price !== 'number' || !isFinite(price)) {
          this.homey.log(`Missing or invalid price for hour ${hour}: ${price}`);
          return false;
        }
      }
      
      return true;
    } catch (error) {
      this.error('Error validating price data:', error);
      return false;
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
  
      await apiFailTrigger.trigger(device, tokens)
        .then(() => {
          this.homey.log('API failure trigger executed with tokens:', tokens);
        })
        .catch(err => {
          this.error('Error triggering API failure:', err);
        });
    } catch (error) {
      this.error('Error in triggerAPIFailure:', error);
    }
  }

  setupTariffCheck() {
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    // Callback pro kontrolu změny tarifu
    const tariffCheckCallback = async () => {
        this.checkTariffChange();
    };

    // Vypočítáme zpoždění do příští hodiny
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const initialDelay = nextHour.getTime() - now.getTime();

    // Nastavení intervalu pomocí IntervalManageru
    this.intervalManager.setScheduledInterval(
        'tariff',
        tariffCheckCallback,
        60 * 60 * 1000, // 1 hodina
        initialDelay
    );

    // První kontrola
    this.checkTariffChange();

    this.homey.log(`Next tariff check scheduled in ${Math.round(initialDelay / 1000)} seconds`);
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

  checkTariffChange() {
    const devices = this.getDevices();
    
    // Získání aktuální hodiny pomocí SpotPriceAPI
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;

    this.homey.log('Checking tariff change at exact hour:', currentHour);

    for (const device of Object.values(devices)) {
      const previousTariff = device.getStoreValue('previousTariff');
      const currentTariff = this.isLowTariff(currentHour, device) ? 'low' : 'high';

      if (previousTariff !== currentTariff) {
        device.setStoreValue('previousTariff', currentTariff)
          .then(() => {
            return this.tariffChangeTrigger.trigger(device, { tariff: currentTariff });
          })
          .then(() => {
            this.homey.log('Tariff change trigger successfully executed');
          })
          .catch(error => {
            this.error('Error in tariff change process:', error);
          });
      } else {
        this.homey.log(`No tariff change at hour ${currentHour}: stayed at ${currentTariff}`);
      }
    }
}


  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    try {
      const allCombinations = await this._calculateAveragePrices(device, hours);
      
      const targetCombination = this._findTargetCombination(allCombinations, condition);
      
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
      this._registerAveragePriceConditionCard();

      this.homey.flow.getConditionCard('distribution-tariff-is')
        .registerRunListener(async (args, state) => {
          const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
          const currentHour = timeInfo.hour;
          const device = args.device;
          const isLowTariff = this.isLowTariff(currentHour, device);
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
    
          const allCombinations = await this._calculateAveragePrices(device, hours);
          const targetCombination = this._findTargetCombination(allCombinations, condition);
          const result = currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
          
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

  async onPairListDevices() {
    try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';
      this.homey.log('Pairing device with ID:', deviceId);
      return [{ name: deviceName, data: { id: deviceId } }];
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
    } catch (error) {
      this.error("Error updating prices after settings change:", error);
    }
  }

  isLowTariff(hour, device) {
    const tariffSettings = [];
    for (let i = 0; i < 24; i++) {
      const isLowTariffHour = device.getSetting(`hour_${i}`);
      tariffSettings.push({ hour: i, isLowTariff: isLowTariffHour });
    }
  
    const tariffHours = tariffSettings
      .filter(setting => setting.isLowTariff)
      .map(setting => setting.hour);
    this.homey.log(`Hours with low tariff enabled: ${tariffHours.join(', ')}`);
  
    const result = tariffHours.includes(hour);
    this.homey.log(`Is hour ${hour} in low tariff hours? Result: ${result}`);
    return result;
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

  // Cleanup při odstranění driveru
  async onUninit() {
    if (this.intervalManager) {
        this.intervalManager.clearAll();
    }
    this.homey.log('Driver uninitialized, all intervals cleared');
}
}

module.exports = CZSpotPricesDriver;
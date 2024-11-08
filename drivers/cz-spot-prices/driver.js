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
    try {
        const delay = baseDelay * Math.pow(2, retryCount);
        this.homey.log(`Plánuji další pokus ${retryCount + 1} za ${delay/60000} minut`);
        
        // Použijeme triggerAPIFailure z device instance
        if (device && typeof device.triggerAPIFailure === 'function') {
            await device.triggerAPIFailure({
                primaryAPI: 'Aktualizace selhala',
                backupAPI: 'Aktualizace selhala',
                willRetry: true,
                retryCount: retryCount + 1,
                nextRetryIn: Math.round(delay / 60000)
            });
        } else {
            this.homey.error('Device instance není dostupná pro API failure trigger');
        }

        // Naplánování dalšího pokusu
        this.intervalManager.setScheduledInterval(
            `retry_midnight_${retryCount}`,
            () => this.executeMidnightUpdate(retryCount + 1),
            null,
            delay
        );
        
        this.homey.log(`Další pokus naplánován za ${Math.round(delay/60000)} minut`);
    } catch (error) {
        this.error('Chyba při plánování dalšího pokusu:', error);
        // I když selže trigger, pokračujeme v plánování dalšího pokusu
    }
}

async _handleMaxRetriesReached(device) {
  try {
      this.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.');
      
      // Použijeme triggerAPIFailure z device instance
      if (device && typeof device.triggerAPIFailure === 'function') {
          await device.triggerAPIFailure({
              primaryAPI: 'Aktualizace selhala',
              backupAPI: 'Aktualizace selhala',
              willRetry: false,
              maxRetriesReached: true
          });
          
          this.homey.log('API failure trigger spuštěn pro maximální počet pokusů');
      } else {
          this.homey.error('Device instance není dostupná pro API failure trigger');
      }

      // Nastavení indikátoru chyby na zařízení, pokud je dostupné
      if (device && typeof device.setCapabilityValue === 'function') {
          await device.setCapabilityValue('primary_api_fail', true);
          await device.setCapabilityValue('spot_price_update_status', false);
      }

  } catch (error) {
      this.error('Chyba při zpracování maximálního počtu pokusů:', error);
  }
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

async onPairListDevices() {
  try {
    const deviceId = crypto.randomUUID();
    const deviceName = 'CZ Spot Prices Device';
    
    // Logování před vrácením hodnoty
    this.homey.log('Setting up device with name:', deviceName);

    return [{
      name: deviceName,
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
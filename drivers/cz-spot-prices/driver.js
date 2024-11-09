'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/PriceCalculator');
const Logger = require('../../helpers/Logger');

class CZSpotPricesDriver extends Homey.Driver {

    async onInit() {
        try {
            // Inicializace loggeru jako první
            this.logger = new Logger(this.homey, 'CZSpotPricesDriver');
            // Driver logger vždy zapnutý
            this.logger.setEnabled(true);
            
            this.logger.log('Inicializace CZSpotPricesDriver');
            
            // Inicializace všech helperů s jejich kontexty
            this.spotPriceApi = new SpotPriceAPI(this.homey, 'SpotPriceAPI');
            this.intervalManager = new IntervalManager(this.homey, 'IntervalManager');
            this.priceCalculator = new PriceCalculator(this.homey, 'PriceCalculator');

            // Předání loggeru všem komponentám
            if (this.spotPriceApi) this.spotPriceApi.setLogger(this.logger);
            if (this.intervalManager) this.intervalManager.setLogger(this.logger);
            if (this.priceCalculator) this.priceCalculator.setLogger(this.logger);

            // Validace instancí
            this.validateInstances();

            // Společné plánování půlnoční aktualizace pro všechna zařízení
            await this.scheduleMidnightUpdate();

            this.logger.log('Driver úspěšně inicializován');

        } catch (error) {
            this.logger.error('Chyba při inicializaci driveru', error, {
                driverId: this.id
            });
            throw error; // Propagace chyby výš pro případné zachycení Homey
        }
    }

  validateInstances() {
    this.logger.debug('Validace instancí komponent');
    
    const validations = [
        { instance: this.spotPriceApi, name: 'SpotPriceAPI' },
        { instance: this.intervalManager, name: 'IntervalManager' },
        { instance: this.priceCalculator, name: 'PriceCalculator' }
    ];

    const missingInstances = validations
        .filter(({instance}) => !instance)
        .map(({name}) => name);

    if (missingInstances.length > 0) {
        const error = new Error(`Chybí instance: ${missingInstances.join(', ')}`);
        this.logger.error('Chyba validace instancí', error, { 
            missing: missingInstances 
        });
        throw error;
    }

    // Validace nastavení loggeru
    const invalidLoggers = validations
        .filter(({instance}) => instance && (!instance.getLogger || !instance.getLogger()))
        .map(({name}) => name);

    if (invalidLoggers.length > 0) {
        this.logger.debug(`Komponenty bez loggeru: ${invalidLoggers.join(', ')}`);
    }

    this.logger.debug('Validace instancí úspěšná');
    return true;
  }

  async scheduleMidnightUpdate() {
    if (this.logger) {
        this.logger.log('Plánování midnight update');
    }

    // Callback pro půlnoční aktualizaci
    const midnightCallback = async () => {
        try {
            const devices = this.getDevices();
            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
            
            if (this.logger) {
                this.logger.debug('Spouštím midnight callback', {
                    hour: timeInfo.hour,
                    date: timeInfo.date
                });
            }

            // Spustíme update pro všechna zařízení
            for (const device of Object.values(devices)) {
                // Kontrola inicializace zařízení
                const maxWaitTime = 30000; // 30 sekund
                const startWait = Date.now();

                while (!device.isInitialized && (Date.now() - startWait < maxWaitTime)) {
                    if (this.logger) {
                        this.logger.debug('Čekám na inicializaci zařízení', {
                            deviceId: device.getData().id,
                            waitTime: Date.now() - startWait
                        });
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                if (!device.isInitialized) {
                    this.logger.warn('Zařízení není inicializováno, přeskakuji update', {
                        deviceId: device.getData().id
                    });
                    continue;
                }

                if (!device.priceCalculator || !device.spotPriceApi) {
                    this.logger.warn('Chybí required dependencies, přeskakuji update', {
                        deviceId: device.getData().id,
                        hasPriceCalculator: !!device.priceCalculator,
                        hasSpotPriceApi: !!device.spotPriceApi
                    });
                    continue;
                }

                try {
                    await this.executeMidnightUpdate();
                    await device.setStoreValue('lastMidnightUpdate', Date.now());

                    if (this.logger) {
                        this.logger.log('Midnight update dokončen', { 
                            deviceId: device.getData().id 
                        });
                    }
                } catch (error) {
                    this.logger.error('Chyba při midnight update zařízení', {
                        deviceId: device.getData().id,
                        error: error.message,
                        stack: error.stack
                    });
                }
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba v midnight callback', error);
            }
        }
    };

    // Výpočet času do další půlnoci
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;
    
    // Výpočet zpoždění do další půlnoci (v ms)
    const hoursUntilMidnight = (24 - currentHour - 1);
    const initialDelay = (hoursUntilMidnight * 60 * 60 * 1000) + (1000); // +1 sekunda po půlnoci

    // Okamžité spuštění při startu aplikace - s malým zpožděním pro inicializaci
    setTimeout(async () => {
        await midnightCallback();
    }, 5000); // 5 sekund zpoždění pro inicializaci zařízení

    if (this.logger) {
        const nextUpdate = new Date(Date.now() + initialDelay);
        this.logger.log('Plánuji další midnight update', {
            aktualniHodina: currentHour,
            hodinDoPulnoci: hoursUntilMidnight,
            pristi: nextUpdate.toISOString(),
            zpozdeni: initialDelay
        });
    }

    // Nastavení pravidelného intervalu
    this.intervalManager.setScheduledInterval(
        'midnight',
        midnightCallback,
        24 * 60 * 60 * 1000, // 24 hodin
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

  if (this.logger) {
      this.logger.log(`Spouštím půlnoční aktualizaci (pokus: ${retryCount} z ${MAX_RETRIES})`);
  }

  const device = this._getFirstDevice();
  if (!device) {
      if (this.logger) {
          this.logger.error('Nenalezeno žádné zařízení pro aktualizaci');
      }
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
            if (this.logger) {
                this.logger.log(`Aktualizace zařízení ${device.getName()} proběhla úspěšně`);
            }
        }

        return updateResult;
    } catch (error) {
        if (this.logger) {
            this.logger.error(`Chyba při aktualizaci zařízení ${device.getName()}`, error);
        }
        return false;
    }
}

async _handleUpdateSuccess(device, retryCount) {
  // Vyčištění všech retry intervalů při úspěchu
  for (let i = 0; i <= retryCount; i++) {
      const retryIntervalId = `retry_midnight_${i}`;
      this.intervalManager.clearScheduledInterval(retryIntervalId);
  }

  if (this.logger) {
      this.logger.log('Půlnoční aktualizace úspěšně dokončena', { deviceId: device.getData().id });
  }
}

async _handleUpdateFailure(device, retryCount, maxRetries, baseDelay) {
  if (retryCount < maxRetries) {
      if (this.logger) {
          this.logger.warn('Půlnoční aktualizace selhala, plánuje se další pokus', { 
              deviceId: device.getData().id, 
              retryCount 
          });
      }
      await this._scheduleRetry(device, retryCount, baseDelay);
  } else {
      if (this.logger) {
          this.logger.error('Půlnoční aktualizace selhala po dosažení maximálního počtu pokusů', {
              deviceId: device.getData().id,
              retryCount
          });
      }
      await this._handleMaxRetriesReached(device);
  }
}

async _scheduleRetry(device, retryCount, baseDelay) {
  try {
      const delay = baseDelay * Math.pow(2, retryCount);

      if (this.logger) {
          this.logger.warn(`Plánuji další pokus ${retryCount + 1} za ${delay / 60000} minut`, {
              deviceId: device.getData().id,
              retryCount,
              delayMinutes: Math.round(delay / 60000)
          });
      }

      // Použijeme triggerAPIFailure z device instance
      if (device && typeof device.triggerAPIFailure === 'function') {
          await device.triggerAPIFailure({
              primaryAPI: 'Aktualizace selhala',
              backupAPI: 'Aktualizace selhala',
              willRetry: true,
              retryCount: retryCount + 1,
              nextRetryIn: Math.round(delay / 60000)
          });
      } else if (this.logger) {
          this.logger.error('Device instance není dostupná pro API failure trigger', { deviceId: device ? device.getData().id : null });
      }

      // Naplánování dalšího pokusu
      this.intervalManager.setScheduledInterval(
          `retry_midnight_${retryCount}`,
          () => this.executeMidnightUpdate(retryCount + 1),
          null,
          delay
      );

      if (this.logger) {
          this.logger.log(`Další pokus naplánován za ${Math.round(delay / 60000)} minut`, {
              deviceId: device.getData().id,
              nextRetry: delay / 60000
          });
      }
  } catch (error) {
      if (this.logger) {
          this.logger.error('Chyba při plánování dalšího pokusu', error);
      }
  }
}

async _handleMaxRetriesReached(device) {
  try {
      if (this.logger) {
          this.logger.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.', { deviceId: device.getData().id });
      }

      // Použijeme triggerAPIFailure z device instance
      if (device && typeof device.triggerAPIFailure === 'function') {
          await device.triggerAPIFailure({
              primaryAPI: 'Aktualizace selhala',
              backupAPI: 'Aktualizace selhala',
              willRetry: false,
              maxRetriesReached: true
          });

          if (this.logger) {
              this.logger.log('API failure trigger spuštěn pro maximální počet pokusů', { deviceId: device.getData().id });
          }
      } else if (this.logger) {
          this.logger.error('Device instance není dostupná pro API failure trigger', { deviceId: device ? device.getData().id : null });
      }

      // Nastavení indikátoru chyby na zařízení, pokud je dostupné
      if (device && typeof device.setCapabilityValue === 'function') {
          await device.setCapabilityValue('primary_api_fail', true);
          await device.setCapabilityValue('spot_price_update_status', false);

          if (this.logger) {
              this.logger.debug('Indikátory chyby nastaveny na zařízení', { deviceId: device.getData().id });
          }
      }

  } catch (error) {
      if (this.logger) {
          this.logger.error('Chyba při zpracování maximálního počtu pokusů', error);
      }
  }
}

async tryUpdateDevice(device) {
    try {
        if (!device || !device.updateAllPrices) {
            this.logger.error('Neplatné zařízení pro tryUpdateDevice');
            return false;
        }

        // Kontrola, zda je zařízení plně inicializováno
        if (!device.isInitialized) {
            this.logger.warn('Zařízení není plně inicializováno, přeskakuji update');
            return false;
        }

        // Přidání kontroly závislostí
        if (!device.priceCalculator || !device.spotPriceApi) {
            this.logger.error('Chybí required dependencies pro tryUpdateDevice');
            return false;
        }

        await device.setCapabilityValue('spot_price_update_status', false);
        
        // Získání a zpracování dat
        try {
            const dailyPrices = await device.spotPriceApi.getDailyPrices(device);
            const settings = device.getSettings();
            
            // Zpracování cen
            const processedPrices = dailyPrices.map(priceData => ({
                hour: priceData.hour,
                priceCZK: device.priceCalculator.addDistributionPrice(
                    priceData.priceCZK,
                    settings,
                    priceData.hour
                )
            }));

            // Aktualizace zařízení s zpracovanými cenami
            const updateResult = await device.updateAllPrices(processedPrices);
            
            if (updateResult) {
                await device.setCapabilityValue('spot_price_update_status', true);
                if (this.logger) {
                    this.logger.log(`Aktualizace zařízení ${device.getName()} proběhla úspěšně`);
                }
            }

            return updateResult;
        } catch (error) {
            if (this.logger) {
                this.logger.error(`Chyba při aktualizaci zařízení ${device.getName()}`, error);
            }
            return false;
        }

    } catch (error) {
        if (this.logger) {
            this.logger.error(`Chyba při aktualizaci zařízení ${device.getName()}`, error);
        }
        return false;
    }
}



async onPairListDevices() {
  try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';

      if (this.logger) {
          this.logger.log('Setting up device for pairing', { deviceName, deviceId });
      }

      return [{
          name: deviceName,
          data: { id: deviceId }
      }];
  } catch (error) {
      if (this.logger) {
          this.logger.error('Error during pairing', error);
      }
      throw error;
  }
}

async settingsChanged(data) {
  try {
      const devices = this.getDevices();

      if (this.logger) {
          this.logger.log('Settings changed, updating all devices', { changedData: data });
      }

      for (const device of Object.values(devices)) {
          await device.fetchAndUpdateSpotPrices();
          if (this.logger) {
              this.logger.debug('Device prices updated', { deviceId: device.getData().id });
          }
      }

      // Vyčistíme cache PriceCalculatoru při změně nastavení
      this.priceCalculator.clearCache();

      if (this.logger) {
          this.logger.debug('PriceCalculator cache cleared after settings change');
      }
  } catch (error) {
      if (this.logger) {
          this.logger.error('Error updating prices after settings change', error);
      }
  }
}

  // Cleanup při odstranění driveru
  async onUninit() {
    if (this.intervalManager) {
        this.intervalManager.clearAll();
        if (this.logger) {
            this.logger.debug('All intervals cleared');
        }
    }
    if (this.priceCalculator) {
        this.priceCalculator.clearCache();
        if (this.logger) {
            this.logger.debug('PriceCalculator cache cleared');
        }
    }
    if (this.logger) {
        this.logger.log('Driver uninitialized successfully');
    }
  }
}

module.exports = CZSpotPricesDriver;
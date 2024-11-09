'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/PriceCalculator');
const FlowCardManager = require('./FlowCardManager');
const Logger = require('../../helpers/Logger');

class CZSpotPricesDevice extends Homey.Device {

    async onInit() {
        try {
            this.isInitialized = false;
            // Vytvoření instance loggeru jako první věc, pouze pokud neexistuje
            if (!this.logger) {
                this.logger = new Logger(this.homey, 'CZSpotPricesDevice');
                const enableLogging = this.getSetting('enable_logging') || false;
                this.logger.setEnabled(enableLogging);
                this.logger.debug('Logger inicializován');
            }
            
            // Inicializace `flowCardManager` pouze pokud ještě neexistuje
            if (!this.flowCardManager) {
                this.flowCardManager = new FlowCardManager(this.homey, this);
                if (this.flowCardManager) {
                    this.flowCardManager.setLogger(this.logger);
                    this.logger.debug('Logger nastaven pro FlowCardManager');
                }
            }
    
            this.logger.debug('Začátek inicializace zařízení');
    
            // Inicializace základních nastavení
            await this.initializeBasicSettings();
            this.logger.log('Základní nastavení inicializována');
    
            // Inicializace FlowCardManageru
            if (this.flowCardManager) {
                try {
                    this.logger.debug('Inicializace FlowCardManageru');
                    await this.flowCardManager.initialize();
                    this.logger.log('FlowCardManager úspěšně inicializován');
                } catch (error) {
                    this.logger.error('Chyba při inicializaci FlowCardManageru', error);
                    throw error;
                }
            }
    
            // Nastavení timeoutu pro inicializaci
            const initTimeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error('Device initialization timeout after 30s'));
                }, 30000);
            });
    
            // Načtení dat s retry mechanismem
            const dataPromise = this._loadInitialData();
    
            // Použití Promise.race pro handling timeoutu
            await Promise.race([dataPromise, initTimeoutPromise]);
    
            // Nastavení plánovaných úloh
            this.logger.debug('Nastavování plánovaných úloh');
            await this.setupScheduledTasks(false);
            this.logger.log('Plánované úlohy nastaveny');
    
            this.isInitialized = true;
            this.logger.log('Inicializace zařízení dokončena', {
                deviceId: this.getData().id,
                name: this.getName(),
                loggingEnabled: this.logger.enabled
            });
    
        } catch (error) {
            this.isInitialized = false;
            this.logger.error('Selhání inicializace zařízení', error, {
                deviceId: this.getData().id,
                name: this.getName()
            });
            await this.setUnavailable(`Initialization failed: ${error.message}`);
            throw error; // Propagujeme error dál
        }
    }
    
    // Pomocná metoda pro načtení dat
    async _loadInitialData() {
        const lastUpdate = await this.getStoreValue('lastDataUpdate');
        const now = Date.now();
    
        this.logger.debug('Kontrola posledního updatu', {
            lastUpdate,
            now,
            diff: now - lastUpdate,
            needsUpdate: !lastUpdate || (now - lastUpdate > 15 * 60 * 1000)
        });
    
        if (!lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
            let retryCount = 0;
            const maxRetries = 3;
    
            while (retryCount < maxRetries) {
                try {
                    this.logger.debug(`Pokus o načtení dat #${retryCount + 1}`);
                    await this.initialDataFetch();
                    await this.setStoreValue('lastDataUpdate', now);
                    this.logger.log('Data úspěšně načtena');
                    return true;
                } catch (error) {
                    retryCount++;
                    this.logger.error(`Pokus ${retryCount} o načtení dat selhal`, error, {
                        retryCount,
                        maxRetries,
                        nextRetryIn: retryCount < maxRetries ? `${5 * retryCount}s` : 'N/A'
                    });
    
                    if (retryCount === maxRetries) {
                        this.logger.error('Dosažen maximální počet pokusů o načtení dat');
                        throw new Error('Max retries reached for initial data fetch');
                    }
                    await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
                }
            }
        } else {
            this.logger.log('Použití nedávných dat - přeskakuji načítání');
            return true;
        }
    } 
  
    async initializeBasicSettings() {
        try {
            if (this.logger) {
                this.logger.log('Začátek inicializace základních nastavení');
            }
    
            // Inicializace helperů s vlastními loggery a kontextem
            this.logger.debug('Inicializace helper tříd');
            
            // Inicializace s předáním kontextu
            this.priceCalculator = new PriceCalculator(this.homey, 'PriceCalculator');
            this.spotPriceApi = new SpotPriceAPI(this.homey, 'SpotPriceAPI');
            this.intervalManager = new IntervalManager(this.homey);
            
            // Nastavení loggerů pro všechny komponenty
            if (this.priceCalculator) {
                this.priceCalculator.setLogger(this.logger);
                this.logger.debug('Logger nastaven pro PriceCalculator');
            }
            
            if (this.spotPriceApi) {
                this.spotPriceApi.setLogger(this.logger);
                this.logger.debug('Logger nastaven pro SpotPriceAPI');
            }
            
            if (this.intervalManager) {
                this.intervalManager.setLogger(this.logger);
                this.logger.debug('Logger nastaven pro IntervalManager');
            }
    
            // Kontrola závislostí včetně kontroly nastavení loggerů
            const requiredDependencies = [
                { 
                    name: 'SpotPriceAPI', 
                    instance: this.spotPriceApi,
                    checkLogger: true 
                },
                { 
                    name: 'IntervalManager', 
                    instance: this.intervalManager,
                    checkLogger: true 
                },
                { 
                    name: 'PriceCalculator', 
                    instance: this.priceCalculator,
                    checkLogger: true 
                }
            ];
    
            this.logger.debug('Kontrola inicializace závislostí a jejich loggerů');
            
            for (const { name, instance, checkLogger } of requiredDependencies) {
                if (!instance) {
                    const errorMessage = `Komponenta ${name} není inicializována`;
                    this.logger.error(errorMessage, new Error(errorMessage));
                    throw new Error(errorMessage);
                }
    
                if (checkLogger && (!instance.getLogger || !instance.getLogger())) {
                    const errorMessage = `Logger není správně nastaven pro ${name}`;
                    this.logger.error(errorMessage, new Error(errorMessage));
                    throw new Error(errorMessage);
                }
    
                this.logger.debug(`${name} úspěšně inicializován včetně loggeru`);
            }
    
            this.logger.log('Všechny komponenty a jejich loggery jsou inicializovány');
    
            // Inicializace device ID
            this.logger.debug('Začátek inicializace Device ID');
            try {
                await this.initializeDeviceId();
                this.logger.log('Device ID úspěšně inicializováno');
            } catch (error) {
                this.logger.error('Chyba při inicializaci Device ID', error, {
                    deviceId: this.getData().id
                });
                throw error;
            }
    
            // Načtení nastavení
            this.logger.debug('Začátek načítání nastavení');
            try {
                await this.initializeSettings();
                const settings = this.getSettings();
                this.logger.log('Nastavení zařízení inicializováno', {
                    deviceId: this.getData().id,
                    settings: {
                        lowIndexHours: settings.low_index_hours || 8,
                        highIndexHours: settings.high_index_hours || 8,
                        priceInKWh: settings.price_in_kwh || false
                    }
                });
            } catch (error) {
                this.logger.error('Chyba při načítání nastavení zařízení', error, {
                    deviceId: this.getData().id
                });
                throw error;
            }
    
            // Registrace capabilities
            this.logger.debug('Začátek registrace capabilities');
            try {
                await this._registerCapabilities();
                this.logger.log('Capabilities úspěšně registrovány');
            } catch (error) {
                this.logger.error('Chyba při registraci capabilities', error, {
                    deviceId: this.getData().id
                });
                throw error;
            }
    
            // Nastavení iniciálního tarifu
            this.logger.debug('Začátek nastavení iniciálního tarifu');
            try {
                await this.initializeInitialTariff();
                this.logger.log('Iniciální tarif nastaven');
            } catch (error) {
                this.logger.error('Chyba při nastavení počátečního tarifu', error, {
                    deviceId: this.getData().id
                });
                throw error;
            }
    
            // Ověření dostupnosti všech kritických metod
            this.logger.debug('Kontrola dostupnosti kritických metod');
            if (!this.spotPriceApi.getCurrentTimeInfo) {
                throw new Error('Metoda getCurrentTimeInfo není dostupná v SpotPriceAPI');
            }
    
            this.logger.log('Inicializace základních nastavení dokončena úspěšně', {
                deviceId: this.getData().id,
                componentsInitialized: requiredDependencies.map(d => d.name)
            });
            
        } catch (error) {
            this.logger.error('Kritická chyba při inicializaci základních nastavení', error, {
                deviceId: this.getData().id
            });
            throw error;
        }
    }
    
  
    async initializeDeviceId() {
        const deviceId = this.getData().id || this.getStoreValue('device_id');
    
        if (this.logger) {
            this.logger.debug('Current Device ID', { deviceId });
        }
    
        if (!deviceId) {
            const newDeviceId = this.generateDeviceId();
            await this.setStoreValue('device_id', newDeviceId);
    
            if (this.logger) {
                this.logger.log('Generated new device ID', { newDeviceId });
            }
        } else {
            if (this.logger) {
                this.logger.log('Device initialized with existing ID', { deviceId });
            }
        }
    }    
  
    async initializeSettings() {
        this.lowIndexHours = this.getLowIndexHours();
        this.highIndexHours = this.getHighIndexHours();
        this.priceInKWh = this.getSetting('price_in_kwh') || false;
    
        if (this.logger) {
            this.logger.debug('Device settings initialized', { 
                lowIndexHours: this.lowIndexHours, 
                highIndexHours: this.highIndexHours, 
                priceInKWh: this.priceInKWh 
            });
        }
    }
    
  
    async initializeInitialTariff() {
        const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
        const currentHour = timeInfo.hour;
        const initialTariff = this.priceCalculator.isLowTariff(currentHour, this.getSettings()) ? 'low' : 'high';
        await this.setStoreValue('previousTariff', initialTariff);
    
        if (this.logger) {
            this.logger.log('Initial tariff set', { initialTariff, currentHour });
        }
    }
    
  
    async initialDataFetch() {
        const lastUpdate = await this.getStoreValue('lastDataUpdate');
        const now = Date.now();
        const firstInit = await this.getStoreValue('firstInit');
    
        if (this.logger) {
            this.logger.debug('Kontrola potřeby počátečního načtení dat', { lastUpdate, now, firstInit });
        }
    
        if (!firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
            try {
                await this.fetchAndUpdateSpotPrices();
                await this.setStoreValue('lastDataUpdate', now);
                await this.setStoreValue('firstInit', true);
                await this.setAvailable();
    
                if (this.logger) {
                    this.logger.log('Initial data fetch completed');
                }
    
                return true;
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Initial data fetch failed', error);
                }
                await this.setUnavailable('Initial data fetch failed');
                return false;
            }
        } else {
            if (this.logger) {
                this.logger.log('Using cached data');
            }
            return true;
        }
    }    
  
    async setupScheduledTasks(runImmediately = false) {
        if (this.logger) {
            this.logger.log('Setting up scheduled tasks...');
        }
        
        // Ověření, že máme všechny potřebné instance
        if (!this.intervalManager || !this.spotPriceApi || !this.priceCalculator) {
            const errorMessage = 'Chybí potřebné instance pro scheduled tasks';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage));
            }
            return;
        }
    
        const initialDelay = this.intervalManager.calculateDelayToNextHour();
    
        // Nastavení hodinové aktualizace
        const hourlyCallback = async () => {
            try {
                await this.updateHourlyData();
                await this.setStoreValue('lastHourlyUpdate', new Date().getTime());
    
                if (this.logger) {
                    this.logger.log('Hourly update completed successfully');
                }
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Hourly update failed', error);
                }
            }
        };
    
        // Nastavení průměrných cen
        const averagePriceCallback = async () => {
            try {
                await this.checkAveragePrice();
                await this.setStoreValue('lastAverageUpdate', new Date().getTime());
    
                if (this.logger) {
                    this.logger.log('Average price check completed');
                }
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Average price check failed', error);
                }
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
            } else if (this.logger) {
                this.logger.log('Skipping initial hourly update - already done this hour');
            }
    
            if (!lastAverageUpdate || new Date(lastAverageUpdate).getTime() < currentHour) {
                tasks.push(averagePriceCallback());
            } else if (this.logger) {
                this.logger.log('Skipping initial average price check - already done this hour');
            }
    
            if (tasks.length > 0) {
                await Promise.all(tasks);
            }
        }
    
        // Formátování a logování následující aktualizace
        const { hours, minutes, seconds } = this._formatDelay(initialDelay);
        if (this.logger) {
            this.logger.log(`Next update scheduled in ${hours ? hours + 'h ' : ''}${minutes}m ${seconds}s`);
        }
    }    

    async setupTariffCheck() {
        try {
            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
            const currentHour = timeInfo.hour;
    
            if (this.logger) {
                this.logger.debug('Počáteční kontrola tarifu', { currentHour });
            }
    
            // První kontrola při startu
            await this._checkTariffChange(currentHour);
    
            // Nastavení hodinové kontroly
            const nextHour = new Date();
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            const initialDelay = nextHour.getTime() - Date.now();
    
            this.intervalManager.setScheduledInterval(
                'tariff',
                () => this._checkTariffChange(currentHour),
                60 * 60 * 1000,
                initialDelay
            );
    
            if (this.logger) {
                this.logger.log('Kontrola tarifu nastavena', { initialDelay });
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při nastavování kontroly tarifu', error);
            }
        }
    }    

    async _checkTariffChange(currentHour) {
        try {
            const settings = this.getSettings();
            const previousTariff = await this.getStoreValue('previousTariff');
            const currentTariff = this.priceCalculator.isLowTariff(currentHour, settings) ? 'low' : 'high';
    
            if (this.logger) {
                this.logger.debug('Kontrola změny tarifu', { currentHour, previousTariff, currentTariff });
            }
    
            if (previousTariff !== currentTariff) {
                await this.setStoreValue('previousTariff', currentTariff);
    
                // Spuštění triggeru
                if (this.tariffChangeTrigger) {
                    await this.tariffChangeTrigger.trigger(this, { tariff: currentTariff });
                    
                    if (this.logger) {
                        this.logger.log('Tariff change trigger proveden', { currentTariff });
                    }
                }
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při kontrole změny tarifu', error);
            }
        }
    }    

    async updateHourlyData() {
        try {
            // Získání aktuálního času s respektováním časové zóny
            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    
            if (this.logger) {
                this.logger.log('Začátek hodinové aktualizace', {
                    hour: timeInfo.hour,
                    systemHour: new Date().getHours(),
                    timezone: this.homey.clock.getTimezone()
                });
            }
    
            // Získání aktuální ceny a indexu pro danou hodinu
            const [currentPrice, currentIndex] = await Promise.all([
                this.getCapabilityValue(`hour_price_CZK_${timeInfo.hour}`),
                this.getCapabilityValue(`hour_price_index_${timeInfo.hour}`)
            ]);
    
            // Validace získaných dat
            if (currentPrice === null || currentIndex === null) {
                if (this.logger) {
                    this.logger.error('Chybí data pro hodinu', {
                        hour: timeInfo.hour,
                        price: currentPrice,
                        index: currentIndex
                    });
                }
                return false;
            }
    
            // Aktualizace current capabilities s lepším error handlingem
            try {
                await Promise.all([
                    this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice)
                        .catch(err => {
                            if (this.logger) {
                                this.logger.error('Chyba při aktualizaci current price capability', err);
                            }
                            throw err;
                        }),
                    this.setCapabilityValue('measure_current_spot_index', currentIndex)
                        .catch(err => {
                            if (this.logger) {
                                this.logger.error('Chyba při aktualizaci current index capability', err);
                            }
                            throw err;
                        })
                ]);
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Chyba při aktualizaci capabilities', error);
                }
                return false;
            }
    
            // Trigger pro změnu ceny s rozšířenými informacemi
            await this.triggerCurrentPriceChanged({
                price: currentPrice,
                index: currentIndex,
                hour: timeInfo.hour,
                timestamp: new Date().toISOString()
            });
    
            // Rozšířené logování pro debugging
            if (this.logger) {
                this.logger.log('Hodinová aktualizace dokončena', {
                    hour: timeInfo.hour,
                    systemHour: new Date().getHours(),
                    price: currentPrice,
                    index: currentIndex,
                    timezone: this.homey.clock.getTimezone(),
                    timeString: new Date().toLocaleString('en-US', { 
                        timeZone: this.homey.clock.getTimezone() 
                    })
                });
            }
    
            return true;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Kritická chyba při hodinové aktualizaci', error);
            }
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
            const errorMessage = 'Nenalezena average-price-trigger karta';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage));
            }
            throw new Error(errorMessage);
        }

        // Získat všechny flow s jejich argumenty
        const flows = await triggerCard.getArgumentValues(this);
        if (this.logger) {
            this.logger.log('Kontrola průměrných cen', { currentHour, flowCount: flows.length });
        }

        // Zpracovat každý flow zvlášť
        for (const flow of flows) {
            const { hours, condition } = flow;

            try {
                // Použít PriceCalculator místo lokální metody
                const allCombinations = await this.priceCalculator.calculateAveragePrices(this, hours, 0);
                if (!allCombinations || allCombinations.length === 0) {
                    if (this.logger) {
                        this.logger.error('Nebyly nalezeny žádné kombinace pro výpočet průměru');
                    }
                    continue;
                }

                // Seřadit kombinace podle průměrné ceny
                const prices = allCombinations.sort((a, b) => a.avg - b.avg);
                const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];

                // Kontrola, zda aktuální je začátkem intervalu
                if (targetCombination.startHour === currentHour) {
                    if (this.logger) {
                        this.logger.log(`Nalezen interval pro trigger - ${condition} kombinace pro ${hours} hodin`, {
                            startHour: targetCombination.startHour,
                            currentHour,
                            averagePrice: targetCombination.avg
                        });
                    }

                    // Vytvoření tokenu s průměrnou cenou
                    const tokens = {
                        average_price: parseFloat(targetCombination.avg.toFixed(2))
                    };

                    // Trigger flow
                    await triggerCard.trigger(this, tokens, {
                        hours,
                        condition
                    });

                    if (this.logger) {
                        this.logger.log('Average price trigger proveden úspěšně', {
                            hours,
                            condition,
                            averagePrice: tokens.average_price
                        });
                    }
                } else if (this.logger) {
                    this.logger.log(`Hodina ${currentHour} není začátkem ${condition} ${hours}-hodinového okna`, {
                        startHour: targetCombination.startHour
                    });
                }
            } catch (error) {
                if (this.logger) {
                    this.logger.error(`Chyba při zpracování flow s hours=${hours}, condition=${condition}`, error);
                }
            }
        }

        return true;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba v checkAveragePrice', error);
        }
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
                if (this.logger) {
                    this.logger.log(`Capability ${capability} added successfully.`);
                }
            } catch (error) {
                if (this.logger) {
                    this.logger.error(`Failed to add capability ${capability}`, error);
                }
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
        // Zpracování nastavení loggeru jako první věc
        if (changedKeys.includes('enable_logging')) {
            this.logger.setEnabled(newSettings.enable_logging);
            this.logger.log(`Logování ${newSettings.enable_logging ? 'zapnuto' : 'vypnuto'}`);
        }
    
        const changedValues = changedKeys.reduce((acc, key) => {
            acc[key] = {
                oldValue: oldSettings[key],
                newValue: newSettings[key]
            };
            return acc;
        }, {});
        
        this.logger.debug('Změna nastavení', { 
            changedKeys, 
            changes: changedValues 
        });
        
        try {
            // Kontrola změn v nastavení indexů nebo tarifu
            const needsRecalculation = changedKeys.some(key => 
                key === 'low_index_hours' || 
                key === 'high_index_hours' ||
                key.startsWith('hour_') || 
                key === 'high_tariff_price' || 
                key === 'low_tariff_price' ||
                key === 'price_in_kwh'
            );
    
            if (needsRecalculation) {
                this.logger.debug('Zahájení přepočtu cen a indexů', {
                    changedSettings: changedKeys.filter(key => 
                        key === 'low_index_hours' || 
                        key === 'high_index_hours' ||
                        key.startsWith('hour_') || 
                        key === 'high_tariff_price' || 
                        key === 'low_tariff_price'
                    ),
                    priceInKWhChanged: changedKeys.includes('price_in_kwh')
                });
                
                // Vyčištění cache pro zajištění čerstvého přepočtu
                this.priceCalculator.clearCache();
                this.logger.debug('Cache vyčištěna');
                
                // Aktualizace interních proměnných před přepočtem
                if (changedKeys.includes('low_index_hours')) {
                    this.lowIndexHours = newSettings.low_index_hours;
                    this.logger.debug('Aktualizován lowIndexHours', {
                        newValue: this.lowIndexHours,
                        oldValue: oldSettings.low_index_hours
                    });
                }
                if (changedKeys.includes('high_index_hours')) {
                    this.highIndexHours = newSettings.high_index_hours;
                    this.logger.debug('Aktualizován highIndexHours', {
                        newValue: this.highIndexHours,
                        oldValue: oldSettings.high_index_hours
                    });
                }
                if (changedKeys.includes('price_in_kwh')) {
                    this.priceInKWh = newSettings.price_in_kwh;
                    this.logger.debug('Aktualizován priceInKWh', {
                        newValue: this.priceInKWh,
                        oldValue: oldSettings.price_in_kwh
                    });
                }
                
                // Získání aktuálních cen
                const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
                this.logger.debug('Získána nová denní data', {
                    pricesCount: dailyPrices.length
                });
                
                // Přepočet cen s novými nastaveními
                const processedPrices = dailyPrices.map(priceData => ({
                    hour: priceData.hour,
                    priceCZK: this.priceCalculator.addDistributionPrice(
                        priceData.priceCZK,
                        newSettings,
                        priceData.hour
                    )
                }));
    
                // Přidání indexů podle nového nastavení
                const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
                    processedPrices,
                    newSettings.low_index_hours,
                    newSettings.high_index_hours
                );
    
                // Logování statistik indexů pro kontrolu
                const indexStats = pricesWithIndexes.reduce((acc, curr) => {
                    acc[curr.level] = (acc[curr.level] || 0) + 1;
                    return acc;
                }, {});
    
                this.logger.debug('Statistiky nově vypočtených indexů', {
                    stats: indexStats,
                    expected: {
                        low: newSettings.low_index_hours,
                        high: newSettings.high_index_hours,
                        medium: 24 - newSettings.low_index_hours - newSettings.high_index_hours
                    }
                });
    
                // Aktualizace všech cen a indexů
                await this.updateAllPrices(pricesWithIndexes);
                
                this.logger.log('Přepočet cen a indexů dokončen', {
                    processedPrices: pricesWithIndexes.length,
                    indexStats
                });
            }
    
            // Informujeme o změně nastavení
            this.homey.emit('settings_changed');
            this.logger.log('Aktualizace nastavení úspěšně dokončena', {
                changedSettings: changedKeys.join(', ')
            });
    
            return true;
    
        } catch (error) {
            this.logger.error('Chyba při zpracování změny nastavení', error, {
                changedKeys,
                deviceId: this.getData().id
            });
            throw error;
        }
    }

   /**
 * Hlavní metoda pro aktualizaci cen
 */
   async fetchAndUpdateSpotPrices() {
    await this.setCapabilityValue('spot_price_update_status', false);

    if (this.logger) {
        this.logger.log('Fetching and updating spot prices');
    }

    try {
        // Získání cen z API
        const dailyPrices = await this.spotPriceApi.getDailyPrices(this);

        if (!this.priceCalculator.validatePriceData(dailyPrices)) {
            const errorMessage = 'Invalid daily prices data received from API';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage));
            }
            throw new Error(errorMessage);
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

        if (this.logger) {
            this.logger.log('Spot prices fetched and updated successfully');
        }

        return true;

    } catch (error) {
        if (this.logger) {
            this.logger.error('Error fetching spot prices', error);
        }
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
        if (this.logger) {
            this.logger.debug('Začátek updateAllPrices', {
                processedPricesCount: processedPrices?.length
            });
        }

        // Kontrola všech potřebných závislostí
        if (!this.priceCalculator || !this.spotPriceApi) {
            throw new Error('Chybí required dependencies pro updateAllPrices');
        }

        // Získání a validace nastavení
        const settings = this.getSettings();
        const lowIndexHours = settings.low_index_hours || 8;
        const highIndexHours = settings.high_index_hours || 8;

        // Validace vstupních dat
        if (!Array.isArray(processedPrices) || processedPrices.length !== 24) {
            throw new Error('Neplatná vstupní data pro updateAllPrices');
        }

        // Použití lokálního PriceCalculatoru
        const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
            processedPrices,
            lowIndexHours,
            highIndexHours
        );

        // Aktualizace capabilities s try/catch pro každou operaci
        try {
            await this._updateHourlyCapabilities(pricesWithIndexes);
            await this._updateCurrentPrice(pricesWithIndexes);
            await this._updateDailyAverage(pricesWithIndexes);

            if (this.logger) {
                this.logger.log('Všechny ceny a indexy úspěšně aktualizovány', {
                    indexStats: {
                        low: pricesWithIndexes.filter(p => p.level === 'low').length,
                        medium: pricesWithIndexes.filter(p => p.level === 'medium').length,
                        high: pricesWithIndexes.filter(p => p.level === 'high').length
                    },
                    timestamp: new Date().toISOString()
                });
            }

            return true;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při aktualizaci capabilities', {
                    message: error.message,
                    stack: error.stack
                });
            }
            throw error;
        }

    } catch (error) {
        if (this.logger) {
            this.logger.error('Kritická chyba v updateAllPrices', {
                message: error.message,
                stack: error.stack,
                deviceId: this.getData().id
            });
        }
        throw error;
    }
}

async triggerAPIFailure(errorInfo) {
    try {
        if (!this.apiFailTrigger) {
            this.apiFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
        }

        const tokens = {
            error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
            will_retry: errorInfo.willRetry || false,
            retry_count: errorInfo.retryCount || 0,
            next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
            max_retries_reached: errorInfo.maxRetriesReached || false
        };

        await this.apiFailTrigger.trigger(this, tokens);

        if (this.logger) {
            this.logger.log('API failure trigger spuštěn s tokeny', tokens);
        }
    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při spouštění API failure triggeru', error);
        }
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
        if (this.logger) {
            this.logger.debug('Aktualizuji capability', {
                hour: priceData.hour,
                price: convertedPrice,
                level: priceData.level
            });
        }

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
        // Kontrola inicializace spotPriceApi
        if (!this.spotPriceApi) {
            throw new Error('SpotPriceApi není inicializován');
        }

        // Získání aktuálního času s respektováním časové zóny
        const timeInfo = this.spotPriceApi.getCurrentTimeInfo();

        // Použití uložené hodnoty priceInKWh pro konzistenci
        const currentPriceInKWh = this.priceInKWh;

        if (this.logger) {
            this.logger.debug('Začátek aktualizace current price', {
                hour: timeInfo.hour,
                priceInKWh: currentPriceInKWh
            });
        }

        // Hledání dat pro aktuální hodinu
        const currentHourData = pricesWithIndexes.find(price => price.hour === timeInfo.hour);
        if (!currentHourData) {
            if (this.logger) {
                this.logger.error('Nenalezena data pro aktuální hodinu', {
                    hour: timeInfo.hour,
                    availableHours: pricesWithIndexes.map(p => p.hour).join(', ')
                });
            }
            return;
        }

        // Konverze ceny s použitím uložené hodnoty priceInKWh
        const convertedPrice = this.priceCalculator.convertPrice(
            currentHourData.priceCZK,
            currentPriceInKWh
        );

        // Aktualizace capabilities s lepším error handlingem
        await Promise.all([
            this.setCapabilityValue('measure_current_spot_price_CZK', convertedPrice)
                .catch(err => {
                    if (this.logger) {
                        this.logger.error('Chyba při aktualizaci current price capability', err);
                    }
                    throw err;
                }),
            this.setCapabilityValue('measure_current_spot_index', currentHourData.level)
                .catch(err => {
                    if (this.logger) {
                        this.logger.error('Chyba při aktualizaci current index capability', err);
                    }
                    throw err;
                })
        ]);

        if (this.logger) {
            this.logger.debug('Aktuální cena aktualizována', {
                hour: timeInfo.hour,
                price: convertedPrice,
                index: currentHourData.level
            });
        }

    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při aktualizaci aktuální ceny', error);
        }
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
            this.priceInKWh
        );

        if (this.logger) {
            this.logger.debug('Vypočítaná průměrná cena', {
                totalPrice,
                averagePrice,
                priceInKWh: this.priceInKWh
            });
        }

        // Nastavení průměrné ceny jako capability
        await this.setCapabilityValue('daily_average_price', averagePrice);

        if (this.logger) {
            this.logger.log('Denní průměrná cena aktualizována', { averagePrice });
        }

        return averagePrice;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při aktualizaci denního průměru', error);
        }
        throw error;
    }
}

//nove proxy metody pro flowcardmanager
async triggerCurrentPriceChanged(tokens) {
    if (this.flowCardManager) {
        await this.flowCardManager.triggerCurrentPriceChanged(tokens);
    }
}

async triggerAPIFailure(errorInfo) {
    if (this.flowCardManager) {
        await this.flowCardManager.triggerApiFailure(errorInfo);
    }
}

 /**
 * Cleanup při odstranění zařízení
 */
 async onDeleted() {
    if (this.logger) {
        this.logger.log('Cleaning up device resources...');
    }

    try {
        // Vyčištění všech intervalů
        if (this.intervalManager) {
            this.intervalManager.clearAll();
            if (this.logger) {
                this.logger.log('All intervals cleared');
            }
        }

        // Vyčištění cache priceCalculatoru
        if (this.priceCalculator) {
            this.priceCalculator.clearCache();
            if (this.logger) {
                this.logger.log('Price calculator cache cleared');
            }
        }

        // Vyčištění FlowCardManageru
        if (this.flowCardManager) {
            this.flowCardManager.destroy();
            this.flowCardManager = null;
            if (this.logger) {
                this.logger.log('Flow card manager destroyed');
            }
        }

        // Pokus o odstranění store hodnot s chytáním konkrétní chyby 404
        const storeKeys = ['device_id', 'previousTariff'];
        for (const key of storeKeys) {
            try {
                await this.unsetStoreValue(key);
                if (this.logger) {
                    this.logger.log(`Store value ${key} unset successfully`);
                }
            } catch (error) {
                if (error.statusCode === 404) {
                    if (this.logger) {
                        this.logger.log(`Store value ${key} already deleted or device not found.`);
                    }
                } else {
                    if (this.logger) {
                        this.logger.error(`Failed to unset store value ${key}`, error);
                    }
                }
            }
        }

        // Vyčištění referencí
        this.spotPriceApi = null;
        this.priceCalculator = null;
        this.intervalManager = null;
        this.flowCardManager = null;

        if (this.logger) {
            this.logger.log('Device cleanup completed successfully');
        }
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error during device cleanup', error);
        }
    }
}

/**
 * Helper pro získání aktuální hodiny a její data
 */
async getCurrentHourData() {
    try {
        const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
        const currentHour = timeInfo.hour === 24 ? 0 : timeInfo.hour;

        const hourData = {
            hour: currentHour,
            price: await this.getCapabilityValue(`hour_price_CZK_${currentHour}`),
            index: await this.getCapabilityValue(`hour_price_index_${currentHour}`),
            isLowTariff: this.priceCalculator.isLowTariff(currentHour, this.getSettings())
        };

        if (this.logger) {
            this.logger.debug('Current hour data retrieved', hourData);
        }

        return hourData;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error getting current hour data', error);
        }
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

        const deviceState = {
            currentHour: currentHourData,
            dailyAverage,
            updateStatus,
            settings,
            deviceId: this.getData().id
        };

        if (this.logger) {
            this.logger.debug('Device state retrieved', deviceState);
        }

        return deviceState;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error getting device state', error);
        }
        return null;
    }
}

/**
* Debug helper pro výpis stavů všech capabilities
*/
async logDeviceState() {
    try {
        const state = await this.getDeviceState();
        
        if (this.logger) {
            this.logger.debug('Current device state', state);
        }
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error logging device state', error);
        }
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
            if (this.logger) {
                this.logger.warn('Capability validation issues found', { issues });
            }
            return false;
        }

        if (this.logger) {
            this.logger.log('All capabilities validated successfully');
        }
        return true;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error validating capabilities', error);
        }
        return false;
    }
}


/**
* Helper pro reset stavu zařízení
*/
async resetDeviceState() {
    try {
        if (this.logger) {
            this.logger.log('Starting device state reset...');
        }

        // Vyčištění cache
        this.priceCalculator.clearCache();

        // Reset všech capabilities na null
        const capabilities = this.getCapabilities();
        await Promise.all(
            capabilities.map(async capability => {
                try {
                    await this.setCapabilityValue(capability, null);
                } catch (error) {
                    if (this.logger) {
                        this.logger.error(`Error resetting capability ${capability}`, error);
                    }
                }
            })
        );

        // Nastavení status flags
        await this.setCapabilityValue('spot_price_update_status', false);
        await this.setCapabilityValue('primary_api_fail', true);

        // Vynucení nové aktualizace dat
        await this.fetchAndUpdateSpotPrices();

        if (this.logger) {
            this.logger.log('Device state reset completed');
        }

        return true;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error resetting device state', error);
        }
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
            const errorMessage = 'No price data available';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage));
            }
            throw new Error(errorMessage);
        }

        const stats = {
            min: Math.min(...prices),
            max: Math.max(...prices),
            avg: prices.reduce((a, b) => a + b) / prices.length,
            count: prices.length,
            currentPrice: await this.getCapabilityValue('measure_current_spot_price_CZK'),
            currentIndex: await this.getCapabilityValue('measure_current_spot_index')
        };

        if (this.logger) {
            this.logger.debug('Device statistics calculated', stats);
        }

        return stats;
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error calculating statistics', error);
        }
        return null;
    }
}

}

module.exports = CZSpotPricesDevice;
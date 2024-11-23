'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/PriceCalculator');
const FlowCardManager = require('./FlowCardManager');
const Logger = require('../../helpers/Logger');
const LockManager = require('../../helpers/LockManager');


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

            // Inicializace LockManageru před voláním initializeBasicSettings
            if (!this.lockManager) {
                this.lockManager = new LockManager(this.homey, 'DeviceLockManager');
                this.lockManager.setLogger(this.logger);
                this.logger.debug('LockManager inicializován včetně loggeru');
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
            this.intervalManager = new IntervalManager(this.homey), 'IntervalManager';
            this.LockManager = new LockManager(this.homey, 'DeviceLockManager');
            
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

            if (this.LockManager) {
                this.LockManager.setLogger(this.logger);
                this.logger.debug('Logger nastaven pro LockManager');
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
                },
                { 
                    name: 'LockManager', 
                    instance: this.lockManager,
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
        try {
            const lastUpdate = await this.getStoreValue('lastDataUpdate');
            const now = Date.now();
            const firstInit = await this.getStoreValue('firstInit');
    
            if (this.logger) {
                this.logger.debug('Kontrola potřeby počátečního načtení dat', { 
                    lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : 'nikdy',
                    timeSinceLastUpdate: lastUpdate ? Math.floor((now - lastUpdate) / 1000 / 60) + ' minut' : 'N/A',
                    firstInit,
                    needsUpdate: !firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000)
                });
            }
    
            // Kontrola, zda potřebujeme aktualizovat data
            if (!firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
                try {
                    // Získání a aktualizace dat
                    const success = await this.fetchAndUpdateSpotPrices();
                    
                    if (!success) {
                        throw new Error('Fetch and update failed');
                    }
    
                    // Získání aktuálních cen pro zpracování
                    const dailyPrices = [];
                    for (let hour = 0; hour < 24; hour++) {
                        const price = await this.getCapabilityValue(`hour_price_CZK_${hour}`);
                        if (price !== null && price !== undefined) {
                            dailyPrices.push({ hour, priceCZK: price });
                        }
                    }
    
                    if (dailyPrices.length !== 24) {
                        throw new Error(`Neplatný počet hodinových cen: ${dailyPrices.length}`);
                    }
    
                    // Provedení aktualizací
                    await Promise.all([
                        this._updateMinMaxPrices(dailyPrices),
                        this._updateCurrentAndNextHourPrices(dailyPrices)
                    ]);
    
                    // Aktualizace store hodnot
                    await Promise.all([
                        this.setStoreValue('lastDataUpdate', now),
                        this.setStoreValue('firstInit', true)
                    ]);
    
                    await this.setAvailable();
    
                    if (this.logger) {
                        this.logger.log('Počáteční načtení dat dokončeno', {
                            timestamp: new Date(now).toISOString(),
                            pricesLoaded: dailyPrices.length,
                            firstPrice: dailyPrices[0],
                            lastPrice: dailyPrices[23]
                        });
                    }
    
                    return true;
    
                } catch (error) {
                    if (this.logger) {
                        this.logger.error('Chyba při počátečním načtení dat', error, {
                            errorType: error.name,
                            errorMessage: error.message,
                            stack: error.stack
                        });
                    }
                    await this.setUnavailable(`Initial data fetch failed: ${error.message}`);
                    return false;
                }
            } else {
                if (this.logger) {
                    this.logger.log('Použití cached dat', {
                        lastUpdate: new Date(lastUpdate).toISOString(),
                        age: Math.floor((now - lastUpdate) / 1000 / 60) + ' minut'
                    });
                }
                return true;
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Kritická chyba v initialDataFetch', error);
            }
            await this.setUnavailable('Critical error in initial data fetch');
            return false;
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
                this.logger.debug('Kontrola změny tarifu', { 
                    currentHour, 
                    previousTariff, 
                    currentTariff 
                });
            }
    
            if (previousTariff !== currentTariff) {
                // Uložíme nový stav
                await this.setStoreValue('previousTariff', currentTariff);
                
                // Spustíme jednoduchý trigger
                await this.triggerTariffChange(previousTariff, currentTariff);
    
                if (this.logger) {
                    this.logger.log('Změna tarifu detekována a zpracována', {
                        previousTariff,
                        currentTariff,
                        hour: currentHour
                    });
                }
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při kontrole změny tarifu', error, {
                    deviceId: this.getData().id,
                    hour: currentHour
                });
            }
        }
    }

    async triggerTariffChange(previousTariff, currentTariff) {
        try {
            const triggerCard = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');
            
            if (!triggerCard) {
                throw new Error('Trigger karta není k dispozici');
            }
    
            // Jednoduchý trigger bez tokenů
            await triggerCard.trigger(this);
    
            if (this.logger) {
                this.logger.log('Tariff change trigger spuštěn', {
                    previousTariff,
                    currentTariff,
                    deviceId: this.getData().id
                });
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při spouštění tariff change triggeru', error, {
                    deviceId: this.getData().id,
                    previousTariff,
                    currentTariff
                });
            }
        }
    }

    async updateHourlyData() {
        try {
            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
            const currentHour = timeInfo.hour;
    
            if (this.logger) {
                this.logger.log('Začátek hodinové aktualizace', {
                    hour: currentHour,
                    systemHour: new Date().getHours(),
                    timezone: this.homey.clock.getTimezone()
                });
            }
    
            // Získání aktuální ceny, indexu a next hour price
            const [currentPrice, currentIndex, nextHourPrice] = await Promise.all([
                this.getCapabilityValue(`hour_price_CZK_${currentHour}`),
                this.getCapabilityValue(`hour_price_index_${currentHour}`),
                currentHour === 23 ? 
                    this.getCapabilityValue(`hour_price_CZK_${currentHour}`) : // Pro 23. hodinu použijeme aktuální cenu
                    this.getCapabilityValue(`hour_price_CZK_${currentHour + 1}`) // Pro ostatní hodiny cenu následující hodiny
            ]);
    
            if (currentPrice === null || currentIndex === null) {
                if (this.logger) {
                    this.logger.error('Chybí data pro hodinu', {
                        hour: currentHour,
                        price: currentPrice,
                        index: currentIndex,
                        nextPrice: nextHourPrice
                    });
                }
                return false;
            }
    
            // Paralelní provedení všech aktualizací
            await Promise.all([
                // 1. Aktualizace capabilities a spuštění price change triggeru
                Promise.all([
                    this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice),
                    this.setCapabilityValue('measure_current_spot_index', currentIndex),
                    this.setCapabilityValue('measure_next_hour_price', nextHourPrice)
                ]).then(() => this.triggerCurrentPriceChanged({
                    price: currentPrice,
                    index: currentIndex,
                    nextPrice: nextHourPrice,
                    hour: currentHour,
                    timestamp: new Date().toISOString()
                })),
    
                // 2. Kontrola změny tarifu
                this._checkTariffChange(currentHour),
    
                // 3. Kontrola average price triggerů
                (async () => {
                    try {
                        const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
                        const flows = await triggerCard.getArgumentValues(this);
    
                        for (const flow of flows) {
                            const { hours, condition } = flow;
                            const combinations = await this.priceCalculator.calculateAveragePrices(
                                this,
                                hours,
                                0
                            );
    
                            if (!combinations || combinations.length === 0) {
                                continue;
                            }
    
                            const sortedByAverage = combinations.sort((a, b) => 
                                condition === 'lowest' ? 
                                    a.averagePrice - b.averagePrice : 
                                    b.averagePrice - a.averagePrice
                            );
    
                            const bestCombination = sortedByAverage[0];
    
                            if (currentHour === bestCombination.startHour) {
                                await triggerCard.trigger(this, {
                                    average_price: parseFloat(bestCombination.averagePrice.toFixed(2))
                                }, {
                                    hours,
                                    condition
                                });
                            }
                        }
                    } catch (error) {
                        if (this.logger) {
                            this.logger.error('Chyba při kontrole average price triggerů', error);
                        }
                    }
                })()
            ]);
    
            if (this.logger) {
                this.logger.log('Hodinová aktualizace dokončena', {
                    hour: currentHour,
                    price: currentPrice,
                    index: currentIndex,
                    nextPrice: nextHourPrice
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

        if (this.logger) {
            this.logger.debug('Začátek kontroly average price', {
                currentHour,
                systemHour: new Date().getHours(),
                timezone: this.homey.clock.getTimezone()
            });
        }

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
            this.logger.debug('Nalezené flows pro average price', {
                currentHour,
                flowCount: flows.length,
                flows: flows.map(f => ({
                    hours: f.hours,
                    condition: f.condition
                }))
            });
        }

        // Zpracovat každý flow zvlášť
        for (const flow of flows) {
            const { hours, condition } = flow;

            try {
                // Použít PriceCalculator místo lokální metody
                const allCombinations = await this.priceCalculator.calculateAveragePrices(this, hours, 0);
                if (this.logger) {
                    this.logger.debug('Vypočtené kombinace pro flow', {
                        hours,
                        condition,
                        combinationsCount: allCombinations.length,
                        firstThree: allCombinations.slice(0, 3).map(c => ({
                            startHour: c.startHour,
                            avgPrice: c.averagePrice.toFixed(2)
                        }))
                    });
                }

                // Seřadit kombinace podle průměrné ceny
                const prices = allCombinations.sort((a, b) => a.avg - b.avg);
                const targetCombination = condition === 'lowest' ? prices[0] : prices[prices.length - 1];

                // Kontrola, zda aktuální je začátkem intervalu
                if (targetCombination.startHour === currentHour) {
                    if (this.logger) {
                        this.logger.log('Spouštím average price trigger', {
                            currentHour,
                            interval: `${targetCombination.startHour}:00-${(targetCombination.startHour + hours) % 24}:00`,
                            averagePrice: targetCombination.averagePrice.toFixed(2),
                            condition,
                            hours,
                            pricesInInterval: targetCombination.prices.map(p => ({
                                hour: p.hour,
                                price: p.price.toFixed(2)
                            }))
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
                    this.logger.debug('Nesplněny podmínky pro spuštění triggeru', {
                        currentHour,
                        expectedStartHour: targetCombination.startHour,
                        condition,
                        hours,
                        averagePrice: targetCombination.averagePrice.toFixed(2)
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
        'measure_today_min_price',
        'measure_today_max_price',
        'measure_next_hour_price',
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
                
                try {
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
    
                    // Aktualizace všech hodnot pomocí nových helper metod
                    await Promise.all([
                        this._updateHourlyCapabilities(pricesWithIndexes),
                        this._updateCurrentAndNextHourPrices(pricesWithIndexes),
                        this._updateMinMaxPrices(pricesWithIndexes),
                        this._updateDailyAverage(pricesWithIndexes)
                    ]);
    
                    // Logování statistik
                    const indexStats = pricesWithIndexes.reduce((acc, curr) => {
                        acc[curr.level] = (acc[curr.level] || 0) + 1;
                        return acc;
                    }, {});
    
                    this.logger.log('Přepočet cen a indexů dokončen', {
                        processedPrices: pricesWithIndexes.length,
                        indexStats,
                        priceInKWh: this.priceInKWh
                    });
    
                } catch (error) {
                    this.logger.error('Chyba při přepočítávání cen', error, {
                        deviceId: this.getData().id
                    });
                    throw error;
                }
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
    const operationId = `update-${Date.now()}`;
    
    try {
        if (this.logger) {
            this.logger.debug('Začátek updateAllPrices', {
                operationId,
                processedPricesCount: processedPrices?.length
            });
        }

        // Získání zámku
        const lockAcquired = await this.lockManager.acquireLock(this.getData().id, operationId);
        if (!lockAcquired) {
            const message = 'Nelze získat zámek pro aktualizaci - jiná operace právě probíhá';
            if (this.logger) {
                this.logger.warn(message, {
                    operationId,
                    lockInfo: this.lockManager.getLockInfo(this.getData().id)
                });
            }
            throw new Error(message);
        }

        try {
            // Kontrola všech potřebných závislostí
            if (!this.priceCalculator || !this.spotPriceApi) {
                throw new Error('Chybí required dependencies pro updateAllPrices');
            }

            // Získání a validace nastavení
            const settings = this.getSettings();
            const lowIndexHours = settings.low_index_hours || 8;
            const highIndexHours = settings.high_index_hours || 8;
            const priceInKWh = settings.price_in_kwh || false;

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

            // Paralelní aktualizace všech capabilities
            const [
                minMaxResult,
                currentPricesResult,
                averageResult
            ] = await Promise.all([
                this._updateMinMaxPrices(pricesWithIndexes),
                this._updateCurrentAndNextHourPrices(pricesWithIndexes),
                this._updateDailyAverage(pricesWithIndexes),
                this._updateHourlyCapabilities(pricesWithIndexes)
            ]);

            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
            const currentHour = timeInfo.hour === 24 ? 0 : timeInfo.hour;

            if (this.logger) {
                this.logger.log('Všechny ceny a indexy úspěšně aktualizovány', {
                    operationId,
                    indexStats: {
                        low: pricesWithIndexes.filter(p => p.level === 'low').length,
                        medium: pricesWithIndexes.filter(p => p.level === 'medium').length,
                        high: pricesWithIndexes.filter(p => p.level === 'high').length
                    },
                    priceStats: {
                        minMax: minMaxResult,
                        currentPrice: currentPricesResult,
                        averagePrice: averageResult,
                        currentHour: currentHour,
                        priceInKWh: priceInKWh
                    },
                    deviceId: this.getData().id
                });
            }

            return true;

        } finally {
            // Uvolnění zámku v finally bloku
            this.lockManager.releaseLock(this.getData().id, operationId);
            if (this.logger) {
                this.logger.debug('Zámek uvolněn po aktualizaci', {
                    operationId
                });
            }
        }

    } catch (error) {
        if (this.logger) {
            this.logger.error('Kritická chyba v updateAllPrices', {
                operationId,
                error: {
                    message: error.message,
                    stack: error.stack
                },
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
 * Helper pro aktualizaci current a next hour ceny
 */
async _updateCurrentAndNextHourPrices(pricesWithIndexes) {
    try {
        // Kontrola inicializace spotPriceApi
        if (!this.spotPriceApi) {
            throw new Error('SpotPriceApi není inicializován');
        }

        // Získání aktuálního času s respektováním časové zóny
        const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
        const currentHour = timeInfo.hour;
        const nextHour = (currentHour + 1) % 24;

        // Použití uložené hodnoty priceInKWh pro konzistenci
        const currentPriceInKWh = this.priceInKWh;

        if (this.logger) {
            this.logger.debug('Začátek aktualizace current a next hour price', {
                currentHour,
                nextHour,
                priceInKWh: currentPriceInKWh
            });
        }

        // Validace vstupních dat
        if (!Array.isArray(pricesWithIndexes)) {
            throw new Error('Neplatná vstupní data - není pole');
        }

        // Hledání dat pro aktuální a následující hodinu
        const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
        const nextHourData = pricesWithIndexes.find(price => price.hour === nextHour);

        if (!currentHourData) {
            if (this.logger) {
                this.logger.error('Nenalezena data pro aktuální hodinu', {
                    hour: currentHour,
                    availableHours: pricesWithIndexes.map(p => p.hour).join(', ')
                });
            }
            throw new Error(`Nenalezena data pro aktuální hodinu ${currentHour}`);
        }

        // Validace a normalizace indexu
        const validIndexes = ['low', 'medium', 'high', 'unknown'];
        const currentIndex = currentHourData.level && validIndexes.includes(currentHourData.level) 
            ? currentHourData.level 
            : 'unknown';

        // Konverze cen
        const convertedCurrentPrice = this.priceCalculator.convertPrice(
            currentHourData.priceCZK,
            currentPriceInKWh
        );

        const convertedNextPrice = nextHourData ? 
            this.priceCalculator.convertPrice(nextHourData.priceCZK, currentPriceInKWh) : 
            null;

        if (this.logger) {
            this.logger.debug('Zpracování dat před aktualizací', {
                currentHour,
                currentPrice: convertedCurrentPrice,
                rawLevel: currentHourData.level,
                normalizedIndex: currentIndex,
                nextHour,
                nextPrice: convertedNextPrice,
                priceInKWh: currentPriceInKWh
            });
        }

        // Aktualizace capabilities
        const updatePromises = [
            this.setCapabilityValue('measure_current_spot_price_CZK', convertedCurrentPrice)
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
        ];

        // Přidání aktualizace next hour price, pokud máme data
        if (convertedNextPrice !== null) {
            updatePromises.push(
                this.setCapabilityValue('measure_next_hour_price', convertedNextPrice)
                    .catch(err => {
                        if (this.logger) {
                            this.logger.error('Chyba při aktualizaci next hour price capability', err);
                        }
                        throw err;
                    })
            );
        }

        // Provedení všech aktualizací
        await Promise.all(updatePromises);

        if (this.logger) {
            this.logger.debug('Aktuální a následující ceny aktualizovány', {
                currentHour,
                currentPrice: convertedCurrentPrice,
                currentIndex,
                nextHour,
                nextPrice: convertedNextPrice
            });
        }

        return true;

    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při aktualizaci aktuální a následující ceny', error);
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

/**
 * Helper pro aktualizaci min/max cen
 */
async _updateMinMaxPrices(pricesWithIndexes) {
    try {
        const currentPriceInKWh = this.priceInKWh;

        if (this.logger) {
            this.logger.debug('Začátek aktualizace min/max cen', {
                priceInKWh: currentPriceInKWh,
                počet_cen: pricesWithIndexes.length
            });
        }

        // Získání min/max z nekonvertovaných cen
        const prices = pricesWithIndexes.map(p => p.priceCZK);
        const minRawPrice = Math.min(...prices);
        const maxRawPrice = Math.max(...prices);

        // Konverze cen podle aktuálního nastavení
        const convertedMinPrice = this.priceCalculator.convertPrice(minRawPrice, currentPriceInKWh);
        const convertedMaxPrice = this.priceCalculator.convertPrice(maxRawPrice, currentPriceInKWh);

        // Aktualizace capabilities
        await Promise.all([
            this.setCapabilityValue('measure_today_min_price', convertedMinPrice)
                .catch(err => {
                    if (this.logger) {
                        this.logger.error('Chyba při aktualizaci min price capability', err);
                    }
                    throw err;
                }),
            this.setCapabilityValue('measure_today_max_price', convertedMaxPrice)
                .catch(err => {
                    if (this.logger) {
                        this.logger.error('Chyba při aktualizaci max price capability', err);
                    }
                    throw err;
                })
        ]);

        if (this.logger) {
            this.logger.debug('Min/max ceny aktualizovány', {
                min: convertedMinPrice,
                max: convertedMaxPrice,
                rawMin: minRawPrice,
                rawMax: maxRawPrice
            });
        }

        return { minPrice: convertedMinPrice, maxPrice: convertedMaxPrice };

    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při aktualizaci min/max cen', error);
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
        this.logger.log('Cleaning up device resources...', {
            deviceId: this.getData().id
        });
    }

    try {
        // Zrušení případných probíhajících operací
        this.isInitialized = false;
        
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

        // V metodě onDeleted v device.js
        if (this.lockManager) {
            this.lockManager.clearAllLocks();
            if (this.logger) {
                this.logger.log('Lock manager cleared');
            }
        }       

        // Rozšířený seznam store hodnot
        const storeKeys = [
            'device_id', 
            'previousTariff',
            'lastDataUpdate',
            'lastMidnightUpdate',
            'lastHourlyUpdate',
            'lastAverageUpdate',
            'firstInit'
        ];

        // Pokus o odstranění store hodnot
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

        // Reset všech capabilities na null
        try {
            const capabilities = this.getCapabilities();
            await Promise.all(capabilities.map(capability => 
                this.setCapabilityValue(capability, null).catch(err => {
                    if (this.logger) {
                        this.logger.warn(`Failed to reset capability ${capability}`, err);
                    }
                })
            ));
            if (this.logger) {
                this.logger.log('All capabilities reset');
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Error resetting capabilities', error);
            }
        }

        // Odpojení event listenerů, pokud nějaké existují
        this.homey.removeAllListeners('spot_prices_updated');
        this.homey.removeAllListeners('settings_changed');

        // Vyčištění referencí
        this.spotPriceApi = null;
        this.priceCalculator = null;
        this.intervalManager = null;
        this.flowCardManager = null;

        // Vyčištění loggeru jako poslední
        if (this.logger) {
            this.logger.log('Device cleanup completed successfully', {
                deviceId: this.getData().id,
                timestamp: new Date().toISOString()
            });
            this.logger = null;
        }

    } catch (error) {
        if (this.logger) {
            this.logger.error('Error during device cleanup', error, {
                deviceId: this.getData().id,
                timestamp: new Date().toISOString()
            });
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
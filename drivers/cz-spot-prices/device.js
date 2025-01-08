'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/pricecalculation/PriceCalculator');
const TariffCalculator = require('../../helpers/pricecalculation/TariffCalculator');
const PriceCalculationEngine = require('../../helpers/pricecalculation/PriceCalculationEngine');
const DataValidator = require('../../helpers/DataValidator');
const CacheManager = require('../../helpers/CacheManager');
const ActionsManager = require('../../helpers/flowcards/ActionsManager');
const ConditionsManager = require('../../helpers/flowcards/ConditionsManager');
const TriggersManager = require('../../helpers/flowcards/TriggersManager');
const Logger = require('../../helpers/Logger');
const LockManager = require('../../helpers/LockManager');
const CapabilityManager = require('../../helpers/CapabilityManager');
const DeviceStateManager = require('../../helpers/DeviceStateManager');


class CZSpotPricesDevice extends Homey.Device {
    static CONTEXT = 'CZSpotPricesDevice';

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro Device');
        }
        CZSpotPricesDevice.homeyInstance = homey;
    }

    async onInit() {
        try {
            this.isInitialized = false;
            
            // Inicializace loggeru jako první (stále musí být první pro logování)
            this.logger = Logger.getInstance();
            this.logger.debug('Device Logger inicializován');
    
            // Inicializace DeviceStateManageru hned po loggeru
            this.deviceStateManager = DeviceStateManager.getInstance(this.homey);
            this.logger.debug('DeviceStateManager inicializován');
            
            // Inicializace všech helperů - necháme v device.js protože je důležité pro business logiku
            await this.initializeHelpers();
            
            // Nastavení timeoutu pro celou inicializaci
            const initTimeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error('Device initialization timeout after 30s'));
                }, 30000);
            });
    
            // Hlavní inicializační proces
            const initializationPromise = (async () => {
                try {
                    // Inicializace základního stavu přes DeviceStateManager
                    await this.deviceStateManager.initializeDeviceState(this);
                    
                    // Nastavení plánovaných úloh - necháme v device.js kvůli business logice
                    this.logger.debug('Nastavování plánovaných úloh');
                    await this.setupScheduledTasks(true);
                    this.logger.log('Plánované úlohy nastaveny');
    
                    return true;
                } catch (error) {
                    this.logger.error('Chyba během inicializace', error);
                    throw error;
                }
            })();
    
            // Race mezi inicializací a timeoutem
            await Promise.race([initializationPromise, initTimeoutPromise]);
            
            this.isInitialized = true;
            this.logger.log('Inicializace zařízení úspěšně dokončena', {
                deviceId: this.getData().id,
                name: this.getName()
            });
    
        } catch (error) {
            this.isInitialized = false;
            this.logger.error('Kritické selhání inicializace zařízení', error, {
                deviceId: this.getData().id,
                name: this.getName()
            });
            
            // Cleanup v případě chyby
            try {
                await this.deviceStateManager.cleanupDeviceState(this);
            } catch (cleanupError) {
                this.logger.error('Chyba při cleanup po selhání inicializace', cleanupError);
            }
    
            await this.setUnavailable(`Initialization failed: ${error.message}`);
            throw error;
        }
    }
    
    async initializeHelpers() {
        try {
            this.logger.debug('Začátek inicializace helperů');
    
            // Základní helpery
            this.spotPriceApi = SpotPriceAPI.getInstance(this.homey);
            this.intervalManager = IntervalManager.getInstance(this.homey);
            this.priceCalculator = PriceCalculator.getInstance(this.homey);
            this.lockManager = LockManager.getInstance(this.homey);
            this.tariffCalculator = TariffCalculator.getInstance(this.homey);
            this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
            this.dataValidator = DataValidator.getInstance(this.homey);
            this.cacheManager = CacheManager.getInstance(this.homey);
            this.capabilityManager = CapabilityManager.getInstance(this.homey);
            
            // Flow manažery
            this.actionsManager = ActionsManager.getInstance(this.homey, this);
            await this.actionsManager.initialize();

            this.conditionsManager = ConditionsManager.getInstance(this.homey, this);
            await this.conditionsManager.initialize();

            this.triggersManager = TriggersManager.getInstance(this.homey, this);
            await this.triggersManager.initialize();

            } catch (error) {
            this.logger.error('Chyba při inicializaci helperů', error);
            throw error;
        }
    }
    
    validateHelpers() {
        const requiredHelpers = [
            { name: 'spotPriceApi', instance: this.spotPriceApi },
            { name: 'intervalManager', instance: this.intervalManager },
            { name: 'priceCalculator', instance: this.priceCalculator },
            { name: 'lockManager', instance: this.lockManager },
            { name: 'actionsManager', instance: this.actionsManager },
            { name: 'conditionsManager', instance: this.conditionsManager },
            { name: 'triggersManager', instance: this.triggersManager },
            { name: 'tariffCalculator', instance: this.tariffCalculator },
            { name: 'priceCalculationEngine', instance: this.priceCalculationEngine },
            { name: 'dataValidator', instance: this.dataValidator },
            { name: 'cacheManager', instance: this.cacheManager },
            { name: 'capabilityManager', instance: this.capabilityManager },
            { name: 'triggersManager', instance: this.triggersManager },
            { name: 'conditionsManager', instance: this.conditionsManager },
            { name: 'actionsManager', instance: this.actionsManager }
        ];
    
        for (const helper of requiredHelpers) {
            if (!helper.instance) {
                const error = new Error(`Chybí required helper: ${helper.name}`);
                this.logger.error('Validace helperů selhala', error);
                throw error;
            }
        }
    
        // Kontrola kritických metod
        if (!this.spotPriceApi.getCurrentTimeInfo) {
            const error = new Error('SpotPriceAPI postrádá required metodu getCurrentTimeInfo');
            this.logger.error('Validace metod selhala', error);
            throw error;
        }
    
        this.logger.debug('Validace helperů úspěšná');
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
                    this.logger.log('Data úspěšně načtena - _loadInitialData');
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
    
    async registerCapabilities() {
        try {
            await this.capabilityManager.registerDeviceCapabilities(this);
            this.logger.log('Capabilities úspěšně registrovány');
        } catch (error) {
            this.logger.error('Chyba při registraci capabilities', error);
            throw error;
        }
    }
    
    async setInitialTariff() {
        try {
            await this.tariffCalculator.initializeInitialTariff(this);
            this.logger.log('Iniciální tarif nastaven');
        } catch (error) {
            this.logger.error('Chyba při nastavení počátečního tarifu', error);
            throw error;
        }
    }
    
    handleInitializationError(error) {
        this.logger.error('Kritická chyba při inicializaci základních nastavení', error);
        throw error;
    }
    
    //Spuštění stahování dat
    async initialDataFetch() {
        try {
            const needsUpdate = await this.checkUpdateNecessity();
            if (!needsUpdate) {
                this.logger.log('Použití cached dat');
                return true;
            }
    
            return await this.performDataFetch();
        } catch (error) {
            await this.handleDataFetchError(error);
            return false;
        }
    }
    
    async checkUpdateNecessity() {
        const lastUpdate = await this.getStoreValue('lastDataUpdate');
        const now = Date.now();
        const firstInit = await this.getStoreValue('firstInit');
    
        this.logger.debug('Kontrola potřeby načtení dat', {
            lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : 'nikdy',
            timeSinceLastUpdate: lastUpdate ? Math.floor((now - lastUpdate) / 1000 / 60) + ' minut' : 'N/A',
            firstInit,
            needsUpdate: !firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000),
        });
    
        return !firstInit || !lastUpdate || (now - lastUpdate > 15 * 60 * 1000);
    }
    
    async performDataFetch() {
        let retryCount = 0;
        const maxRetries = 5;
    
        while (retryCount < maxRetries) {
            try {
                this.logger.debug(`Pokus o načtení dat #${retryCount + 1}`);
                await this.fetchAndProcessData();
                await this.updateLastDataTimestamp();
                return true;
            } catch (error) {
                retryCount++;
                this.logger.error(`Pokus ${retryCount} o načtení dat selhal`, {
                    error,
                    retryCount,
                    maxRetries,
                    nextRetryIn: retryCount < maxRetries ? `${5 * retryCount}s` : 'N/A',
                });
    
                if (retryCount === maxRetries) {
                    throw new Error('Max retries reached for initial data fetch');
                }
    
                await this.delayRetry(retryCount);
            }
        }
    }
    
    async fetchAndProcessData() {
        try {
            const dailyPrices = await this.retrieveDailyPrices();
            await this.validateAndUpdatePrices(dailyPrices);
            
            if (this.logger) {
                this.logger.debug('Data úspěšně načtena a zpracována - fetchAndProcessData', {
                    pricesCount: dailyPrices.length
                });
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při načítání nebo zpracování dat', error);
            }
            throw error;
        }
    }
    
    async retrieveDailyPrices() {
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
    
        return dailyPrices;
    }
    
    async validateAndUpdatePrices(dailyPrices) {
        await Promise.all([
            this.capabilityManager.updateMinMaxPrices(this, dailyPrices),
            this.capabilityManager.updateCurrentAndNextHourPrices(this, dailyPrices),
        ]);
    }
    
    async updateLastDataTimestamp() {
        const now = Date.now();
        await Promise.all([
            this.setStoreValue('lastDataUpdate', now),
            this.setStoreValue('firstInit', true),
        ]);
        await this.setAvailable();
        this.logger.log('Data úspěšně načtena a aktualizována - updateLastDataTimestamp');
    }
    
    async handleDataFetchError(error) {
        this.logger.error('Chyba při počátečním načtení dat', error);
        await this.setUnavailable(`Initial data fetch failed: ${error.message}`);
    }
    
    async delayRetry(retryCount) {
        const delay = 5000 * retryCount;
        await new Promise(resolve => setTimeout(resolve, delay));
        this.logger.debug(`Čekání ${delay / 1000}s před dalším pokusem`);
    }
       
  
    async setupScheduledTasks(runImmediately = false) {
        try {
            await this.intervalManager.scheduleDeviceUpdates(this, runImmediately);
        } catch (error) {
            this.logger?.error('Chyba při nastavování plánovaných úloh', error);
            throw error;
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
            const { hour: currentHour } = this.spotPriceApi.getCurrentTimeInfo();
            
            this.logger?.log('Začátek hodinové aktualizace', {
                hour: currentHour,
                systemHour: new Date().getHours(),
                timezone: this.homey.clock.getTimezone()
            });
     
            const [currentPrice, currentIndex, nextHourPrice] = await Promise.all([
                this.getCapabilityValue(`hour_price_CZK_${currentHour}`),
                this.getCapabilityValue(`hour_price_index_${currentHour}`),
                currentHour === 23 ? 
                    this.getCapabilityValue(`hour_price_CZK_${currentHour}`) :
                    this.getCapabilityValue(`hour_price_CZK_${(currentHour + 1) % 24}`)
            ]);
     
            if (currentPrice === null || currentIndex === null) {
                this.logger?.error('Chybí data pro hodinu', {
                    hour: currentHour,
                    price: currentPrice,
                    index: currentIndex,
                    nextPrice: nextHourPrice
                });
                return false;
            }
     
            await Promise.all([
                // 1. Aktualizace capabilities
                Promise.all([
                    this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice),
                    this.setCapabilityValue('measure_current_spot_index', currentIndex),
                    this.setCapabilityValue('measure_next_hour_price', nextHourPrice)
                ]),
     
                // 2. Kontrola změny tarifu
                this.tariffCalculator.checkTariffChange(this, currentHour),
     
                // 3. Kontrola average price triggerů
                (async () => {
                    try {
                        const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
                        await this.priceCalculationEngine.checkAveragePriceAndTrigger(this, triggerCard);
                    } catch (error) {
                        this.logger?.error('Chyba při kontrole average price triggerů', error);
                    }
                })()
            ]);
     
            this.logger?.log('Hodinová aktualizace dokončena', {
                hour: currentHour,
                price: currentPrice,
                index: currentIndex,
                nextPrice: nextHourPrice
            });
     
            return true;
     
        } catch (error) {
            this.logger?.error('Kritická chyba při hodinové aktualizaci', error);
            return false;
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
        // Pokud došlo ke změně nastavení 'enable_logging'
        if (changedKeys.includes('enable_logging')) {
            // Nastavení globálního logování pro všechny komponenty
            Logger.setGlobalLogging(newSettings.enable_logging);
    
            // Logování stavu
            logger.log(`Globální logování ${newSettings.enable_logging ? 'zapnuto' : 'vypnuto'}`);
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
                key === 'price_in_kwh' ||
                key === 'commodity_price_with_vat'
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
                this.cacheManager.clearAll();
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
                        priceCZK: this.priceCalculationEngine.addDistributionPrice(
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
                        this.capabilityManager.updateHourlyCapabilities(this, pricesWithIndexes),
                        this.capabilityManager.updateCurrentAndNextHourPrices(this, pricesWithIndexes),
                        this.capabilityManager.updateMinMaxPrices(this, pricesWithIndexes),
                        this.capabilityManager.updateDailyAverage(this, pricesWithIndexes)
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

            if (!this.dataValidator.validatePriceData(dailyPrices)) {
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
                priceCZK: this.priceCalculationEngine.addDistributionPrice(
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
            await this.acquireUpdateLock(operationId);
            this.dataValidator.validateAndPreparePrices(processedPrices, this.getSettings());
            await this.updatePriceCapabilities(pricesWithIndexes);
    
            return true;
        } catch (error) {
            this.handlePriceUpdateError(operationId, error);
            throw error;
        } finally {
            this.releaseUpdateLock(operationId);
        }
    }

    async acquireUpdateLock(operationId) {
        const lockAcquired = await this.lockManager.acquireLock(this.getData().id, operationId);
        if (!lockAcquired) {
            this.logger?.warn('Nelze získat zámek pro aktualizaci', { operationId });
            throw new Error('Nelze získat zámek pro aktualizaci - jiná operace právě probíhá');
        }
    }

    async updatePriceCapabilities(pricesWithIndexes) {
        const [
            minMaxResult,
            currentPricesResult,
            averageResult,
            hourlyResult
        ] = await Promise.all([
            this.capabilityManager.updateMinMaxPrices(this, pricesWithIndexes),
            this.capabilityManager.updateCurrentAndNextHourPrices(this, pricesWithIndexes),
            this.capabilityManager.updateDailyAverage(this, pricesWithIndexes),
            this.capabilityManager.updateHourlyCapabilities(this, pricesWithIndexes)
        ]);
    
        return { minMaxResult, currentPricesResult, averageResult, hourlyResult };
    }

    handlePriceUpdateError(operationId, error) {
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
    }

    releaseUpdateLock(operationId) {
        this.lockManager.releaseLock(this.getData().id, operationId);
        if (this.logger) {
            this.logger.debug('Zámek uvolněn po aktualizaci', {
                operationId
            });
        }
    }

    /**
     * Spuštění triggeru při selhání API.
     */
    async triggerAPIFailure(errorInfo) {
        try {
            const tokens = {
                error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
                will_retry: errorInfo.willRetry || false,
                retry_count: errorInfo.retryCount || 0,
                next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
                max_retries_reached: errorInfo.maxRetriesReached || false
            };

            await this.triggersManager.triggerApiFailure(tokens);
            this.logger.log('API failure trigger spuštěn s tokeny', tokens);
        } catch (error) {
            this.logger.error('Chyba při spouštění API failure triggeru', error);
        }
    }

    /**
     * Spuštění triggeru pro změnu aktuální ceny.
     */
    async triggerCurrentPriceChanged(tokens) {
        try {
            if (!this.triggersManager) {
                throw new Error('TriggersManager není inicializován');
            }
            await this.triggersManager.triggerCurrentPriceChanged(tokens);
            this.logger.debug('Current price changed trigger spuštěn', { tokens });
        } catch (error) {
            this.logger.error('Chyba při spouštění current price changed triggeru', error);
            throw error;
        }
    }

    /**
     * Cleanup při odstranění zařízení
     */
    async onDeleted() {
        await this.deviceStateManager.cleanupDeviceState(this);
    }

    async resetDeviceState() {
        return await this.deviceStateManager.resetDeviceState(this);
    }

}

module.exports = CZSpotPricesDevice;
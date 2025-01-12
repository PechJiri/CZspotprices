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
const SettingsManager = require('../../helpers/SettingsManager');


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
            this.logger = Logger.getInstance(this.homey);
            
            // Inicializace všech helperů
            await this.initializeHelpers();
            
            // Registrace capabilities
            await this.capabilityManager.registerDeviceCapabilities(this);
            
            // Načtení dat
            const dailyPrices = await this.spotPriceApi.getDailyPrices(this);

            // Načtení nastavení zařízení
            const settings = this.settingsManager.getDeviceSettings(this);

            // Zahrnutí distribuce a DPH do cen
            const processedPrices = dailyPrices.map(price => ({
                hour: price.hour,
                priceCZK: this.priceCalculationEngine.addDistributionPrice(
                    price.priceCZK,
                    settings,
                    price.hour
                ),
            }));

            // Nastavení cenových indexů
            const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
                processedPrices,
                settings.lowIndexHours,
                settings.highIndexHours
            );

            // Aktualizace capabilities zařízení
            await this.capabilityManager.updateAllPrices(this, pricesWithIndexes);

            // Nastavení stavových flagů
            await this.capabilityManager.setStatusFlags(this, {
                updateStatus: true,
                apiFailure: false
            });
   
            // Nastavení intervalů
            await this.setupScheduledTasks();
            
            this.isInitialized = true;

            // Nastavení logování podle konfigurace zařízení
            const enableLogging = settings.enable_logging || false;
            Logger.setEnabled(enableLogging);
            this.logger?.debug('Nastavení logování podle konfigurace', {
                enableLogging,
                deviceId: this.getData().id
            });
            
        } catch (error) {
            this.logger?.error('Inicializace nedopadla', error);
            throw error;
        }
    }
    
    async initializeHelpers() {
        try {
            this.logger?.debug('Začátek inicializace helperů');
    
            // Inicializace všech singletonů
            this.DeviceStateManager = DeviceStateManager.getInstance(this.homey)
            this.spotPriceApi = SpotPriceAPI.getInstance(this.homey);
            this.intervalManager = IntervalManager.getInstance(this.homey);
            this.priceCalculator = PriceCalculator.getInstance(this.homey);
            this.tariffCalculator = TariffCalculator.getInstance(this.homey);
            this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
            this.dataValidator = DataValidator.getInstance(this.homey);
            this.cacheManager = CacheManager.getInstance(this.homey);
            this.settingsManager = SettingsManager.getInstance(this.homey);
            this.capabilityManager = CapabilityManager.getInstance(this.homey);
            this.lockManager = LockManager.getInstance(this.homey);
    
            // Flow manažery (tyto NEJSOU singletony pro device)
            this.actionsManager = ActionsManager.getInstance(this.homey, this);
            await this.actionsManager.initialize();
    
            this.conditionsManager = ConditionsManager.getInstance(this.homey, this);
            await this.conditionsManager.initialize();
    
            this.triggersManager = TriggersManager.getInstance(this.homey, this);
            await this.triggersManager.initialize();
    
            this.logger?.debug('Helpery úspěšně inicializovány');
            
            // Validace že všechny instance existují
            this.validateHelpers();
    
        } catch (error) {
            this.logger?.error('Chyba při inicializaci helperů', error);
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
            { name: 'actionsManager', instance: this.actionsManager },
            { name: 'capabilityManager', instance: this.capabilityManager },
            { name: 'settingsManager', instance: this.settingsManager },
            { name: 'deviceStateManager', instance: this.DeviceStateManager }
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
     * Generování ID zařízení
     */
    generateDeviceId() {
      return this.homey.util.generateUniqueId();
    }

    // Změna settings zařízení
    async onSettings({ oldSettings, newSettings, changedKeys }) {
        return await this.settingsManager.handleSettingsUpdate(this, { oldSettings, newSettings, changedKeys });
    }
    
    /**
     * Hlavní metoda pro aktualizaci cen
     */
    async fetchAndUpdateSpotPrices() {
        const operationId = `fetch-${Date.now()}`;
        
        try {
            // Status management 
            await this.capabilityManager.setStatusFlags(this, {
                updateStatus: false,
                apiFailure: false
            });
    
            this.logger?.log('Začátek aktualizace spot cen', {
                deviceId: this.getData().id,
                operationId
            });
    
            // Získání lock
            const lockAcquired = await this.lockManager.acquireLock(this.getData().id, operationId);
            if (!lockAcquired) {
                throw new Error('Nelze získat zámek pro aktualizaci - jiná operace právě probíhá');
            }
    
            try {
                // Získání dat
                const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
    
                // Validace dat
                const validationResult = this.dataValidator.validatePriceIndexData(
                    dailyPrices,
                    this.settingsManager.getLowIndexHours(this),
                    this.settingsManager.getHighIndexHours(this)
                );
    
                if (!validationResult.isValid) {
                    throw new Error(`Neplatná data z API: ${validationResult.errors.join(', ')}`);
                }
    
                // Nastavení
                const settings = this.settingsManager.getDeviceSettings(this);
    
                // Zpracování cen 
                const processedPrices = dailyPrices.map(priceData => ({
                    ...priceData,
                    priceCZK: this.priceCalculationEngine.addDistributionPrice(
                        priceData.priceCZK,
                        settings,
                        priceData.hour
                    )
                }));
    
                // Cache update
                this.cacheManager.set('lastProcessedPrices', processedPrices);
    
                // Update capabilities
                await this.capabilityManager.updateAllPrices(this, processedPrices);
    
                // Status a dostupnost
                await this.capabilityManager.setStatusFlags(this, {
                    updateStatus: true,  
                    apiFailure: false
                });
                await this.setAvailable();
    
                // Emit update události
                await this.DeviceStateManager.emitPriceUpdate(this, {
                    deviceId: this.getData().id,
                    currentPrice: await this.getCapabilityValue('measure_current_spot_price_CZK'),
                    currentIndex: await this.getCapabilityValue('measure_current_spot_index'), 
                    averagePrice: await this.getCapabilityValue('daily_average_price')
                });
    
                this.logger?.log('Spot ceny úspěšně aktualizovány', {
                    deviceId: this.getData().id,
                    operationId  
                });
    
                return true;
    
            } finally {
                await this.lockManager.releaseLock(this.getData().id, operationId);
            }
    
        } catch (error) {
            await this.triggerAPIFailure({
                primaryAPI: error.message,
                backupAPI: '',
                willRetry: false,
                maxRetriesReached: true
            });
    
            await this.capabilityManager.setStatusFlags(this, {
                updateStatus: false,
                apiFailure: true
            });
    
            this.logger?.error('Chyba při aktualizaci spot cen', error, {
                deviceId: this.getData().id,
                operationId
            });
    
            return false;
        }
    }

    /**
     * Spuštění triggeru při selhání API.
     */
    async triggerAPIFailure(errorInfo) {
        try {
            if (!errorInfo) {
                this.logger?.warn('triggerAPIFailure: chybí errorInfo');
                return;
            }
    
            const tokens = {
                error_message: `Primary API: ${errorInfo.primaryAPI || 'N/A'}, Backup API: ${errorInfo.backupAPI || 'N/A'}`,
                will_retry: Boolean(errorInfo.willRetry),
                retry_count: errorInfo.retryCount || 0,
                next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
                max_retries_reached: Boolean(errorInfo.maxRetriesReached)
            };
    
            await this.triggersManager.triggerApiFailure(tokens);
            this.logger?.debug('API failure trigger spuštěn s tokeny', tokens);
        } catch (error) {
            this.logger?.error('Chyba při spouštění API failure triggeru', error);
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
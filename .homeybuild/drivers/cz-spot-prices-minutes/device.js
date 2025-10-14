'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('../../helpers/api');
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

/**
 * CZ Spot Prices Device
 * 
 * Pracuje s 15minutovými sloty (96 slotů denně = 4 sloty/hodina)
 * Data čte primárně z cache, NE z capabilities (pouze 8 capabilities)
 * API volání 1x denně po půlnoci
 * Tarify zůstávají HODINOVÉ (distribuční tarify hour_0 až hour_23)
 * 
 * BREAKING CHANGE: Odstraněna podpora hodinových devices (24 slotů)
 */
class CZSpotPricesQuarterDevice extends Homey.Device {
    static CONTEXT = 'CZSpotPricesDevice';

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro Device');
        }
        CZSpotPricesQuarterDevice.homeyInstance = homey;
    }

    /**
     * Inicializace zařízení při startu
     */
    async onInit() {
        try {
            this.isInitialized = false;
            this.logger = Logger.getInstance(this.homey);
            
            // Inicializace všech helperů
            await this.initializeHelpers();
            
            // Registrace capabilities (pouze 8 pro device s 96 sloty)
            await this.capabilityManager.registerDeviceCapabilities(this);
            
            // Načtení dat z API/cache (96 slotů)
            const slotData = await this.spotPriceApi.getPrices(this);

            // Načtení nastavení zařízení
            const settings = this.settingsManager.getDeviceSettings(this);

            // ✅ PŘIDAT: Inicializace počátečního tarifu
            await this.tariffCalculator.initializeInitialTariff(this);

            // ✅ OPRAVA: Vytvořit tariffMap JEDNOU před zpracováním
            const tariffMap = this.tariffCalculator.getTariffMap(settings);
                
            this.logger?.debug('🗺️ TariffMap vytvořena pro onInit', {
                mapSize: tariffMap.size,
                lowTariffHours: Array.from(tariffMap.entries())
                    .filter(([_, isLow]) => isLow)
                    .map(([hour]) => hour)
            });

            // Zahrnutí distribučních tarifů a DPH do cen
            // ✅ Předej tariffMap do každého volání
            const processedPrices = slotData.today.map(price => ({
                hour: price.hour,
                minute: price.minute,
                priceCZK: this.priceCalculationEngine.addDistributionPrice(
                    price.priceCZK,
                    settings,
                    price.hour,
                    tariffMap  // ✅ Předej tariffMap!
                ),
            }));

            // Nastavení cenových indexů pro 96 slotů
            const pricesWithIndexes = this.priceCalculator.setIndexes(
                processedPrices,
                settings.low_index_intervals || 8,
                settings.high_index_intervals || 8
            );

            this.cacheManager.set('lastProcessedPrices', pricesWithIndexes, 'PRICE');

            // Aktualizace capabilities zařízení (jen 8 capabilities)
            await this.capabilityManager.updateDeviceCapabilities(this, pricesWithIndexes);

            // Nastavení stavových flagů
            await this.capabilityManager.setStatusFlags(this, {
                updateStatus: true,
                apiFailure: false
            });
    
            // Nastavení intervalů (15min update + midnight refresh)
            await this.setupScheduledTasks();
            
            this.isInitialized = true;
            
            this.logger?.debug('Device úspěšně inicializován', {
                deviceId: this.getData().id,
                slotsCount: pricesWithIndexes.length
            });
            
        } catch (error) {
            this.logger?.error('Inicializace selhala', error);
            throw error;
        }
    }
    
    /**
     * Inicializace všech helper tříd (singletony)
     * @private
     */
    async initializeHelpers() {
        try {
            this.logger?.debug('Začátek inicializace helperů');
    
            // Inicializace singleton instancí
            this.deviceStateManager = DeviceStateManager.getInstance(this.homey);
            this.settingsManager = SettingsManager.getInstance(this.homey);

            // Nastavení logování podle konfigurace
            const settings = this.settingsManager.getDeviceSettings(this);
            const enableLogging = settings.enable_logging || false;
            Logger.setEnabled(enableLogging);
            this.logger?.debug('Nastavení logování podle konfigurace', {
                enableLogging,
                deviceId: this.getData().id
            });

            // Ostatní helpery
            this.spotPriceApi = SpotPriceAPI.getInstance(this.homey);
            this.intervalManager = IntervalManager.getInstance(this.homey);
            this.priceCalculator = PriceCalculator.getInstance(this.homey);
            this.tariffCalculator = TariffCalculator.getInstance(this.homey);
            this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
            this.dataValidator = DataValidator.getInstance(this.homey);
            this.cacheManager = CacheManager.getInstance(this.homey);
            this.capabilityManager = CapabilityManager.getInstance(this.homey);
            this.lockManager = LockManager.getInstance(this.homey);
    
            // Flow card manažery
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
    
    /**
     * Validace že všechny required helpery jsou inicializované
     * @private
     */
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
            { name: 'settingsManager', instance: this.settingsManager },
            { name: 'deviceStateManager', instance: this.deviceStateManager }
        ];
    
        for (const helper of requiredHelpers) {
            if (!helper.instance) {
                const error = new Error(`Chybí required helper: ${helper.name}`);
                this.logger.error('Validace helperů selhala', error);
                throw error;
            }
        }
    
        // Kontrola kritických metod
        if (!this.spotPriceApi.getPrices) {
            const error = new Error('SpotPriceAPI postrádá required metodu getPrices');
            this.logger.error('Validace metod selhala', error);
            throw error;
        }
    
        this.logger.debug('Validace helperů úspěšná');
    }
    
    /**
     * Nastavení plánovaných úloh (15min update + midnight refresh)
     * @param {boolean} runImmediately - Spustit okamžitě (default false)
     */
    async setupScheduledTasks(runImmediately = false) {
        try {
            await this.intervalManager.scheduleUpdates(this, runImmediately);
            
            this.logger?.debug('Plánované úlohy nastaveny', {
                deviceId: this.getData().id
            });
        } catch (error) {
            this.logger?.error('Chyba při nastavování plánovaných úloh', error);
            throw error;
        }
    }

    /**
     * Aktualizace dat každých 15 minut
     * Aktualizuje JEN 4 capabilities: current_price, current_index, next_price, next_index
     * Min/max/average se NEMĚNÍ - ty se aktualizují jen při půlnoci nebo změně settings
     */
    async updateSlotData() {
        try {
            // 1️⃣ Načti HOTOVÉ sloty z cache
            let cachedPrices = this.cacheManager.get('lastProcessedPrices');
            
            if (!cachedPrices || cachedPrices.length !== 96) {
                this.logger?.warn('⚠️ Chybí data v cache, volám ensureCachedData()');
                await this.ensureCachedData();
                cachedPrices = this.cacheManager.get('lastProcessedPrices');
                
                if (!cachedPrices || cachedPrices.length !== 96) {
                    throw new Error('Cache stále prázdná po ensureCachedData()');
                }
            }
            
            // 2️⃣ Získej timeInfo
            const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
            const currentSlotIndex = timeInfo.hour * 4 + Math.floor(timeInfo.minute / 15);
            
            if (currentSlotIndex < 0 || currentSlotIndex >= 96) {
                throw new Error(`Neplatný slot index: ${currentSlotIndex}`);
            }

            const currentSlot = cachedPrices[currentSlotIndex];
            
            if (!currentSlot) {
                throw new Error(`Current slot nenalezen pro index ${currentSlotIndex}`);
            }

            this.logger?.debug('📊 Update slot data', {
                currentSlotIndex,
                currentTime: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`,
                currentSlot: `${currentSlot.hour}:${String(currentSlot.minute).padStart(2, '0')}`,
                currentPrice: currentSlot.priceCZK,
                currentLevel: currentSlot.level
            });

            // 3️⃣ ✅ OPRAVA: Předej správné parametry
            // - cachedPrices: celé pole pro kontext
            // - null: priceInKWh = použij getSetting() uvnitř metody
            await this.capabilityManager.updateCurrentAndNextSlotPrices(
                this,
                cachedPrices,
                null  // ✅ null = použij device.getSetting('price_in_kwh')
            );
            
            // 4️⃣ Tarify a triggery
            await this.tariffCalculator.checkTariffChange(this, currentSlot.hour);
            await this.checkAveragePrices(timeInfo);

            this.logger?.debug('✅ updateSlotData úspěšně dokončen', {
                deviceId: this.getData().id,
                slot: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`
            });

        } catch (error) {
            this.logger?.error('❌ Chyba v updateSlotData', error, {
                deviceId: this.getData().id,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Zajistí, že data jsou v cache
     * Načte z API a zpracuje, ALE neaktualizuje capabilities
     * Používá se při 15min update, když chybí cache
     * 
     * @private
     * @returns {Promise<boolean>} True pokud úspěšné
     */
    async ensureCachedData() {
        try {
            this.logger?.debug('Načítám data do cache bez update capabilities', {
                deviceId: this.getData().id
            });

            // 1️⃣ Získání 96 slotů z API
            const slotData = await this.spotPriceApi.getPrices(this);

            // 2️⃣ Validace dat
            const validationResult = this.dataValidator.validateIndexData(
                slotData.today,
                this.settingsManager.getLowIndexSlots(this),
                this.settingsManager.getHighIndexSlots(this)
            );

            if (!validationResult.isValid) {
                throw new Error(`Neplatná data z API: ${validationResult.errors.join(', ')}`);
            }

            // 3️⃣ Nastavení
            const settings = this.settingsManager.getDeviceSettings(this);

            // ✅ OPTIMALIZACE: Vytvoř tariffMap JEDNOU
            const tariffMap = this.tariffCalculator.getTariffMap(settings);

            // 4️⃣ Zpracování - předání tariffMap
            const processedPrices = slotData.today.map(priceData => ({
                ...priceData,
                priceCZK: this.priceCalculationEngine.addDistributionPrice(
                    priceData.priceCZK,
                    settings,
                    priceData.hour,
                    tariffMap  // ✅ Předej tariffMap!
                )
            }));

            // 5️⃣ Nastavení cenových indexů
            const pricesWithIndexes = this.priceCalculator.setIndexes(
                processedPrices,
                settings.low_index_intervals || 8,
                settings.high_index_intervals || 8
            );

            // 6️⃣ Uložení do cache
            this.logger?.debug('💾 UKLÁDÁM DO CACHE (bez update capabilities)', {
                klíč: 'lastProcessedPrices',
                počet: pricesWithIndexes.length
            });
            
            this.cacheManager.set('lastProcessedPrices', pricesWithIndexes);

            return true;

        } catch (error) {
            this.logger?.error('Chyba při načítání dat do cache', error);
            throw error;
        }
    }
    
    /**
     * Kontrola a spuštění average price triggerů
     * @param {Object} timeInfo - Časová informace {hour, minute, dateKey}
     * @private
     */
    async checkAveragePrices(timeInfo) {
        try {
            const triggerCard = this.homey.flow.getTriggerCard('average-price-trigger');
            
            if (!triggerCard) {
                this.logger?.debug('Average price trigger card není dostupná');
                return;
            }
            
            await this.priceCalculationEngine.checkAverageSlotPriceAndTrigger(
                this,          // device
                triggerCard,   // triggerCard
                timeInfo       // timeInfo
            );
            
            this.logger?.debug('✅ checkAveragePrices dokončen', {
                slot: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`
            });
        } catch (error) {
            this.logger?.error('❌ Chyba při kontrole average price triggerů', error);
        }
    }

    /**
     * Trigger pro změnu distribučního tarifu
     * Spouští se při přechodu z nízkého na vysoký tarif nebo naopak
     * 
     * @param {string} previousTariff - Předchozí tarif ('low' nebo 'high')
     * @param {string} currentTariff - Aktuální tarif ('low' nebo 'high')
     */
    async triggerTariffChange(previousTariff, currentTariff) {
        try {
            const triggerCard = this.homey.flow.getTriggerCard('when-distribution-tariff-changes');
            
            if (!triggerCard) {
                throw new Error('Trigger karta není k dispozici');
            }
    
            await triggerCard.trigger(this);
    
            this.logger?.debug('Tariff change trigger spuštěn', {
                previousTariff,
                currentTariff,
                deviceId: this.getData().id
            });
        } catch (error) {
            this.logger?.error('Chyba při spouštění tariff change triggeru', error);
        }
    }

    /**
     * Handler pro změnu nastavení zařízení
     * Deleguje na SettingsManager který zajistí přepočet cen
     */
    async onSettings({ oldSettings, newSettings, changedKeys }) {
        return await this.settingsManager.handleSettingsUpdate(
            this, 
            { oldSettings, newSettings, changedKeys }
        );
    }
    
    /**
     * Hlavní metoda pro aktualizaci spot cen z API
     * Volá se 1x denně po půlnoci (řídí IntervalManager)
     * 
     * Proces:
     * 1. Získá lock pro prevenci duplicitních volání
     * 2. Načte data z API (96 slotů)
     * 3. Validuje data
     * 4. Přidá distribuční tarify (hodinové)
     * 5. Nastaví cenové indexy
     * 6. Aktualizuje cache a capabilities
     * 7. Emituje update událost
     * 
     * @returns {Promise<boolean>} True pokud aktualizace proběhla úspěšně
     */
    async fetchAndUpdateSpotPrices() {
        const operationId = `fetch-prices-${Date.now()}`;
        
        try {
            // Status management 
            await this.capabilityManager.setStatusFlags(this, {
                updateStatus: false,
                apiFailure: false
            });

            this.logger?.debug('Začátek aktualizace spot cen', {
                deviceId: this.getData().id,
                operationId
            });

            // Získání lock pro prevenci duplicitních volání
            const lockAcquired = await this.lockManager.acquireLock(this.getData().id, operationId);
            if (!lockAcquired) {
                throw new Error('Nelze získat zámek - jiná operace právě probíhá');
            }

            try {
                // 1️⃣ Získání dat z API
                const slotData = await this.spotPriceApi.getPrices(this);

                // 2️⃣ Validace
                const validationResult = this.dataValidator.validateIndexData(
                    slotData.today,
                    this.settingsManager.getLowIndexSlots(this),
                    this.settingsManager.getHighIndexSlots(this)
                );

                if (!validationResult.isValid) {
                    throw new Error(`Neplatná data: ${validationResult.errors.join(', ')}`);
                }

                // 3️⃣ Nastavení
                const tariffMap = this.tariffCalculator.getTariffMap(settings);

                this.logger?.debug('🗺️ TariffMap vytvořena pro batch zpracování', {
                    mapSize: tariffMap.size,
                    lowTariffHours: Array.from(tariffMap.entries())
                        .filter(([_, isLow]) => isLow)
                        .map(([hour]) => hour)
                });

                // 4️⃣ Zpracování - přidání distribučních tarifů (HODINOVÝCH)
                const processedPrices = slotData.today.map(priceData => ({
                    ...priceData,
                    priceCZK: this.priceCalculationEngine.addDistributionPrice(
                        priceData.priceCZK,
                        settings,
                        priceData.hour,
                        tariffMap
                    )
                }));

                this.logger?.debug('✅ Batch zpracování s tariffMap dokončeno', {
                    processedSlots: processedPrices.length
                });

                // 5️⃣ Nastavení cenových indexů (low/medium/high)
                const pricesWithIndexes = this.priceCalculator.setIndexes(
                    processedPrices,
                    settings.low_index_intervals || 8,
                    settings.high_index_intervals || 8
                );

                // 6️⃣ Cache update
                this.logger?.debug('💾 UKLÁDÁM DO CACHE', {
                    klíč: 'lastProcessedPrices',
                    počet: pricesWithIndexes.length,
                    ukázka_slot_16_45: pricesWithIndexes.find(s => s.hour === 16 && s.minute === 45)
                });
                this.cacheManager.set('lastProcessedPrices', pricesWithIndexes, 'PRICE');

                // 7️⃣ Update capabilities (pouze 8 capabilities)
                await this.capabilityManager.updateDeviceCapabilities(this, pricesWithIndexes);

                // 8️⃣ Status a dostupnost
                await this.capabilityManager.setStatusFlags(this, {
                    updateStatus: true,  
                    apiFailure: false
                });
                await this.setAvailable();

                // 9️⃣ Emit update události pro flow triggery
                await this.deviceStateManager.emitPriceUpdate(this, {
                    deviceId: this.getData().id,
                    currentPrice: await this.getCapabilityValue('measure_current_price'),
                    currentIndex: await this.getCapabilityValue('current_index'), 
                    averagePrice: await this.getCapabilityValue('daily_average')
                });

                this.logger?.debug('Spot ceny úspěšně aktualizovány', {
                    deviceId: this.getData().id,
                    operationId,
                    slotsCount: pricesWithIndexes.length
                });

                return true;

            } finally {
                // Vždy uvolníme lock
                await this.lockManager.releaseLock(this.getData().id, operationId);
            }

        } catch (error) {
            // Spustíme API failure trigger
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
     * Spuštění triggeru při selhání API
     * @param {Object} errorInfo - Informace o chybě
     * @param {string} errorInfo.primaryAPI - Chyba z primárního API
     * @param {string} errorInfo.backupAPI - Chyba z backup API
     * @param {boolean} errorInfo.willRetry - Zda se bude opakovat
     * @param {boolean} errorInfo.maxRetriesReached - Zda byl dosažen max počet pokusů
     * @param {number} errorInfo.retryCount - Počet pokusů
     * @param {number} errorInfo.nextRetryIn - Za kolik minut další pokus
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
     * Spuštění triggeru pro změnu aktuální ceny
     * @param {Object} tokens - Tokeny pro trigger {price, index}
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
     * Vyčistí intervaly, cache, store
     */
    async onDeleted() {
        await this.deviceStateManager.cleanupDeviceState(this);
    }

    /**
     * Reset stavu zařízení (pro debugging)
     * @returns {Promise<boolean>}
     */
    async resetDeviceState() {
        return await this.deviceStateManager.resetDeviceState(this);
    }
}

module.exports = CZSpotPricesQuarterDevice;
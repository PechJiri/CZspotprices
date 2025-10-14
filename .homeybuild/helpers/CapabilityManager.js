'use strict';

const Logger = require('./Logger');
const LockManager = require('./LockManager');
const DeviceStateManager = require('./DeviceStateManager');

/**
 * CapabilityManager
 * 
 * Spravuje capabilities pro device s 15minutovými sloty (96 slotů denně)
 * Pouze 8 capabilities: measure_current_price, current_index, next_price, next_index,
 *                       lowest_price, highest_price, daily_average
 * 
 * BREAKING CHANGE: Odstraněna podpora hodinových devices (24 hodin, 48 capabilities)
 * 
 * KLÍČOVÉ:
 * - Používá device.getSetting('price_in_kwh') přímo, NE settingsManager
 * - Zaokrouhlování: MWh=2 desetinná místa, kWh=4 desetinná místa
 * - Data pro sloty čte z cache, NE z capabilities
 */
class CapabilityManager {
    static instance = null;
    static CONTEXT = 'CapabilityManager';

    static getInstance(homey) {
        if (!CapabilityManager.instance) {
            CapabilityManager.instance = new CapabilityManager(homey);
        }
        return CapabilityManager.instance;
    }

    constructor(homeyInstance) {
        if (CapabilityManager.instance) {
            throw new Error('Použijte CapabilityManager.getInstance()');
        }
        this.homey = homeyInstance;
        this.logger = Logger.getInstance();
        this.LockManager = LockManager.getInstance();
        this.deviceStateManager = DeviceStateManager.getInstance();
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro CapabilityManager');
        }
        CapabilityManager.homeyInstance = homey;
    }

    // ==================== ZAOKROUHLOVÁNÍ ====================

    /**
     * Zaokrouhlí cenu podle typu jednotky
     * @param {number} price - Cena k zaokrouhlení
     * @param {boolean} isKWh - Je cena v kWh? (true = kWh, false = MWh)
     * @returns {number} Zaokrouhlená cena
     */
    roundPrice(price, isKWh) {
        if (price === null || price === undefined || isNaN(price)) {
            return 0;
        }
        
        // kWh = 4 desetinná místa, MWh = 2 desetinná místa
        const decimals = isKWh ? 4 : 2;
        const multiplier = Math.pow(10, decimals);
        
        return Math.round(price * multiplier) / multiplier;
    }

    // ==================== CURRENT/NEXT SLOT UPDATE ====================
    /**
     * Aktualizace current a next slot capabilities
     * ČTE data z parametru (už zpracované z cache), NE z capabilities
     * 
     * @param {Device} device - Instance zařízení
     * @param {Array} slotsWithIndexes - Pole 96 slotů s indexy z cache
     * @param {boolean|null} priceInKWh - Explicitní nastavení (nebo null = použij getSetting)
     * @returns {Promise<Object>} {currentPrice, currentIndex, nextPrice, nextIndex}
     */
    async updateCurrentAndNextSlotPrices(device, slotsWithIndexes, priceInKWh = null) {
        try {
            if (!device.spotPriceApi) {
                throw new Error('SpotPriceApi není inicializován');
            }

            const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
            
            // ✅ OPRAVA: Preferuj explicitně předaný parametr před getSetting
            const currentPriceInKWh = priceInKWh !== null 
                ? priceInKWh 
                : (device.getSetting('price_in_kwh') || false);

            this.logger?.debug('Aktualizace current a next slot', {
                hour: timeInfo.hour,
                minute: timeInfo.minute,
                priceInKWh: currentPriceInKWh
            });

            if (!Array.isArray(slotsWithIndexes) || slotsWithIndexes.length !== 96) {
                throw new Error(`Neplatná vstupní data - očekáváno 96 slotů, dostáno ${slotsWithIndexes?.length || 0}`);
            }

            // Najdi aktuální slot podle času
            const currentSlotData = slotsWithIndexes.find(slot => 
                slot.hour === timeInfo.hour && slot.minute === timeInfo.minute
            );

            // Najdi další slot (následující index)
            const currentIndex = slotsWithIndexes.findIndex(slot =>
                slot.hour === timeInfo.hour && slot.minute === timeInfo.minute
            );
            const nextSlotData = currentIndex !== -1 && currentIndex < slotsWithIndexes.length - 1
                ? slotsWithIndexes[currentIndex + 1]
                : null;

            if (!currentSlotData) {
                this.logger?.error('Nenalezen aktuální slot', {
                    hour: timeInfo.hour,
                    minute: timeInfo.minute,
                    availableSlots: slotsWithIndexes.length
                });
                throw new Error(`Nenalezen aktuální slot ${timeInfo.hour}:${timeInfo.minute}`);
            }

            // Validace index levelů
            const validIndexes = ['low', 'medium', 'high', 'unknown'];
            const currentIndexLevel = currentSlotData.level && validIndexes.includes(currentSlotData.level)
                ? currentSlotData.level
                : 'unknown';

            // ✅ Konverze a zaokrouhlení current price
            const rawCurrentPrice = device.priceCalculationEngine.convertPrice(
                currentSlotData.priceCZK,
                currentPriceInKWh
            );
            const currentPrice = this.roundPrice(rawCurrentPrice, currentPriceInKWh);

            // ✅ Konverze a zaokrouhlení next price
            const rawNextPrice = nextSlotData ? 
                device.priceCalculationEngine.convertPrice(nextSlotData.priceCZK, currentPriceInKWh) : 
                null;
            const nextPrice = rawNextPrice ? this.roundPrice(rawNextPrice, currentPriceInKWh) : null;

            const nextIndexLevel = nextSlotData && nextSlotData.level && validIndexes.includes(nextSlotData.level)
                ? nextSlotData.level
                : 'unknown';

            // Update capabilities
            const updatePromises = [
                device.setCapabilityValue('measure_current_price', currentPrice),
                device.setCapabilityValue('current_index', currentIndexLevel)
            ];

            if (nextPrice !== null) {
                updatePromises.push(
                    device.setCapabilityValue('next_price', nextPrice),
                    device.setCapabilityValue('next_index', nextIndexLevel)
                );
            }

            await Promise.all(updatePromises);

            this.logger?.debug('Current a next slot aktualizovány', {
                currentSlot: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`,
                currentPrice,
                currentIndex: currentIndexLevel,
                nextPrice,
                nextIndex: nextIndexLevel,
                usedPriceInKWh: currentPriceInKWh
            });

            return {
                currentPrice,
                currentIndex: currentIndexLevel,
                nextPrice,
                nextIndex: nextIndexLevel
            };

        } catch (error) {
            this.logger?.error('Chyba při aktualizaci current/next slot', error);
            throw error;
        }
    }

    // ==================== MIN/MAX A PRŮMĚR ====================

    /**
     * Aktualizace denního průměru
     * 
     * @param {Device} device - Instance zařízení
     * @param {Array} pricesWithIndexes - Pole 96 slotů s cenami a indexy
     * @param {boolean|null} priceInKWh - Explicitní nastavení (nebo null = použij getSetting)
     * @returns {Promise<number>} Průměrná cena
     */
    async updateDailyAverage(device, pricesWithIndexes, priceInKWh = null) {
        try {
            // ✅ OPRAVA: Použij parametr pokud je poskytnut
            const currentPriceInKWh = priceInKWh !== null 
                ? priceInKWh 
                : (device.getSetting('price_in_kwh') || false);
                
            const totalPrice = pricesWithIndexes.reduce((sum, price) => sum + price.priceCZK, 0);
            
            // Konverze a zaokrouhlení
            const rawAveragePrice = device.priceCalculationEngine.convertPrice(
                totalPrice / pricesWithIndexes.length,
                currentPriceInKWh
            );
            const averagePrice = this.roundPrice(rawAveragePrice, currentPriceInKWh);

            this.logger?.debug('Vypočítaná průměrná cena', {
                totalPrice,
                averagePrice,
                itemsCount: pricesWithIndexes.length,
                priceInKWh: currentPriceInKWh
            });

            await device.setCapabilityValue('daily_average', averagePrice);

            this.logger?.debug('Denní průměrná cena aktualizována', { 
                averagePrice,
                priceInKWh: currentPriceInKWh 
            });

            return averagePrice;
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci denního průměru', error);
            throw error;
        }
    }

    /**
     * Aktualizace minimální a maximální ceny dne
     * 
     * @param {Device} device - Instance zařízení
     * @param {Array} pricesWithIndexes - Pole 96 slotů s cenami a indexy
     * @param {boolean|null} priceInKWh - Explicitní nastavení (nebo null = použij getSetting)
     * @returns {Promise<Object>} {minPrice, maxPrice}
     */
    async updateMinMaxPrices(device, pricesWithIndexes, priceInKWh = null) {
        try {
            // ✅ OPRAVA: Použij parametr pokud je poskytnut, jinak getSetting
            const currentPriceInKWh = priceInKWh !== null 
                ? priceInKWh 
                : (device.getSetting('price_in_kwh') || false);

            this.logger?.debug('Aktualizace min/max cen', {
                priceInKWh: currentPriceInKWh,
                itemsCount: pricesWithIndexes.length
            });

            const prices = pricesWithIndexes.map(p => p.priceCZK);
            const minRawPrice = Math.min(...prices);
            const maxRawPrice = Math.max(...prices);

            // Konverze a zaokrouhlení
            const rawMinPrice = device.priceCalculationEngine.convertPrice(minRawPrice, currentPriceInKWh);
            const rawMaxPrice = device.priceCalculationEngine.convertPrice(maxRawPrice, currentPriceInKWh);
            
            const minPrice = this.roundPrice(rawMinPrice, currentPriceInKWh);
            const maxPrice = this.roundPrice(rawMaxPrice, currentPriceInKWh);

            await Promise.all([
                device.setCapabilityValue('lowest_price', minPrice),
                device.setCapabilityValue('highest_price', maxPrice)
            ]);

            this.logger?.debug('Min/max ceny aktualizovány', {
                min: minPrice,
                max: maxPrice,
                priceInKWh: currentPriceInKWh
            });

            return { minPrice, maxPrice };

        } catch (error) {
            this.logger?.error('Chyba při aktualizaci min/max cen', error);
            throw error;
        }
    }

    // ==================== KOMPLETNÍ UPDATE ====================

    /**
     * Aktualizace všech capabilities device
     * Pouze 8 capabilities pro 96 slotů
     * 
     * @param {Device} device - Instance zařízení
     * @param {Array} slotsWithIndexes - Pole 96 slotů s cenami a indexy
     * @returns {Promise<boolean>} True pokud update proběhl úspěšně
     */
    async updateDeviceCapabilities(device, slotsWithIndexes, priceInKWh = null) {
        try {
            if (!device.dataValidator.validatePriceData(slotsWithIndexes)) {
                throw new Error('Neplatná data pro aktualizaci capabilities');
            }

            if (slotsWithIndexes.length !== 96) {
                throw new Error(`Očekáváno 96 slotů, dostáno ${slotsWithIndexes.length}`);
            }

            this.logger?.debug('Začátek update capabilities', {
                deviceId: device.getData().id,
                slotsCount: slotsWithIndexes.length,
                priceInKWh: priceInKWh !== null ? priceInKWh : 'from settings'
            });

            // ✅ OPRAVA: Předej priceInKWh do všech metod
            const updateTasks = [
                this.updateCurrentAndNextSlotPrices(device, slotsWithIndexes, priceInKWh),
                this.updateMinMaxPrices(device, slotsWithIndexes, priceInKWh),
                this.updateDailyAverage(device, slotsWithIndexes, priceInKWh)
            ];

            await Promise.all(updateTasks);

            this.logger?.debug('Capabilities aktualizovány', {
                deviceId: device.getData().id
            });

            return true;
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }

    // ==================== REGISTRACE CAPABILITIES ====================

    /**
     * Registrace všech capabilities při inicializaci device
     * Pouze 8 capabilities + 2 status capabilities
     * 
     * @param {Device} device - Instance zařízení
     */
    async registerDeviceCapabilities(device) {
        const capabilities = [
            // Cenové capabilities (8)
            'measure_current_price',
            'current_index',
            'next_price',
            'next_index',
            'lowest_price',
            'highest_price',
            'daily_average',
            // Status capabilities (2)
            'primary_api_fail',
            'spot_price_update_status'
        ];

        this.logger?.debug('Registrace capabilities', {
            deviceId: device.getData().id,
            count: capabilities.length
        });

        for (const capability of capabilities) {
            if (!device.hasCapability(capability)) {
                try {
                    await device.addCapability(capability);
                    this.logger?.debug(`Capability ${capability} přidána`);
                } catch (error) {
                    this.logger?.error(`Chyba při přidání capability ${capability}`, error);
                }
            }
        }
    }

    /**
     * Reset všech capabilities na výchozí hodnoty
     * 
     * @param {Device} device - Instance zařízení
     * @returns {Promise<boolean>} True pokud reset proběhl úspěšně
     */
    async resetDeviceCapabilities(device) {
        try {
            const capabilities = device.getCapabilities();
            
            this.logger?.debug('Reset capabilities', {
                deviceId: device.getData().id,
                count: capabilities.length
            });

            await Promise.all(capabilities.map(capability =>
                device.setCapabilityValue(capability, null).catch(err => {
                    this.logger?.warn(`Nelze resetovat capability ${capability}`, err);
                })
            ));
            
            // Status capabilities nastavíme explicitně
            await device.setCapabilityValue('spot_price_update_status', false);
            await device.setCapabilityValue('primary_api_fail', true);

            this.logger?.debug('Capabilities resetovány', {
                deviceId: device.getData().id
            });

            return true;
        } catch (error) {
            this.logger?.error('Chyba při resetu capabilities', error);
            return false;
        }
    }

    // ==================== STATUS FLAGS ====================

    /**
     * Nastaví status flagy zařízení
     * 
     * @param {Device} device - Instance zařízení
     * @param {Object} flags - Status flagy
     * @param {boolean} flags.updateStatus - Stav update (true = úspěšný)
     * @param {boolean} flags.apiFailure - Stav API (true = selhání)
     */
    async setStatusFlags(device, { updateStatus, apiFailure }) {
        try {
            await Promise.all([
                device.setCapabilityValue('spot_price_update_status', updateStatus),
                device.setCapabilityValue('primary_api_fail', apiFailure)
            ]);

            this.logger?.debug('Status flagy nastaveny', {
                deviceId: device.getData().id,
                updateStatus,
                apiFailure
            });
        } catch (error) {
            this.logger?.error('Chyba při nastavování status flagů', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }

    // ==================== ERROR HANDLING ====================

    /**
     * Zpracování chyby při update capabilities
     * Nastaví error flagy a spustí API failure trigger
     * 
     * @param {Device} device - Instance zařízení
     * @param {string} operationId - ID operace
     * @param {Error} error - Chyba
     */
    async handleCapabilityError(device, operationId, error) {
        try {
            this.logger?.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id,
                operationId
            });

            // Nastavení error flagů
            await this.setStatusFlags(device, {
                updateStatus: false,
                apiFailure: true
            });

            // Spuštění API failure triggeru pokud existuje
            if (device.triggerAPIFailure) {
                await device.triggerAPIFailure({
                    primaryAPI: error.message,
                    backupAPI: '',
                    willRetry: false,
                    maxRetriesReached: true
                });
            }
        } catch (handlingError) {
            this.logger?.error('Chyba při zpracování capability erroru', handlingError);
        }
    }

    // ==================== UNIVERZÁLNÍ UPDATE S LOCKEM ====================

    /**
     * Univerzální update všech cen s lock mechanismem
     * Hlavní vstupní bod pro aktualizaci capabilities
     * 
     * @param {Device} device - Instance zařízení
     * @param {Array} processedPrices - Zpracované ceny (96 slotů)
     * @returns {Promise<boolean>} True pokud update proběhl úspěšně
     */
    async updateAllPrices(device, processedPrices) {
        const operationId = `update-${Date.now()}`;
        
        try {
            // Získání lock
            const lockAcquired = await this.LockManager.acquireLock(device, operationId);
            if (!lockAcquired) {
                this.logger?.warn('Nelze získat zámek pro aktualizaci capabilities', {
                    deviceId: device.getData().id,
                    operationId
                });
                return false;
            }
    
            try {
                this.logger?.debug('Update všech cen', {
                    deviceId: device.getData().id,
                    pricesCount: processedPrices.length
                });

                // Validace dat (96 slotů)
                const lowSlots = device.getSetting('low_index_intervals') || 8;
                const highSlots = device.getSetting('high_index_intervals') || 8;
                
                const validationResult = device.dataValidator.validateIndexData(
                    processedPrices,
                    lowSlots,
                    highSlots
                );

                if (!validationResult.isValid) {
                    throw new Error(`Neplatná vstupní data: ${validationResult.errors.join(', ')}`);
                }

                // Nastavení indexů (low/medium/high)
                const settings = device.settingsManager.getDeviceSettings(device);
                const pricesWithIndexes = device.priceCalculator.setIndexes(
                    processedPrices,
                    settings.low_index_intervals || 8,
                    settings.high_index_intervals || 8
                );

                // Aktualizace capabilities
                await this.updateDeviceCapabilities(device, pricesWithIndexes);

                // Nastavení status flagů
                await this.setStatusFlags(device, {
                    updateStatus: true,
                    apiFailure: false
                });

                // Nastavení dostupnosti zařízení
                await device.setAvailable();

                // Emit událostí
                if (!this.deviceStateManager) {
                    throw new Error('DeviceStateManager není inicializován');
                }

                await this.deviceStateManager.emitPriceUpdate(device, {
                    deviceId: device.getData().id,
                    currentPrice: await device.getCapabilityValue('measure_current_price'),
                    currentIndex: await device.getCapabilityValue('current_index'),
                    averagePrice: await device.getCapabilityValue('daily_average')
                });

                this.logger?.debug('Všechny ceny aktualizovány', {
                    deviceId: device.getData().id
                });

                return true;

            } finally {
                // Vždy uvolníme lock
                await this.LockManager.releaseLock(device, operationId);
            }

        } catch (error) {
            await this.handleCapabilityError(device, operationId, error);
            throw error;
        }
    }

    // ==================== BACKWARD COMPATIBILITY ====================

    /**
     * @deprecated Použijte updateAllPrices()
     */
    async updatePriceCapabilities(device, pricesWithIndexes) {
        this.logger?.warn('Použita deprecated metoda updatePriceCapabilities, použijte updateAllPrices()');
        return this.updateAllPrices(device, pricesWithIndexes);
    }
}

module.exports = CapabilityManager;
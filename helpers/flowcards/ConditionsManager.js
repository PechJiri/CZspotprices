'use strict';

const Logger = require('../Logger');
const SettingsManager = require('../SettingsManager');

/**
 * ConditionsManager - správa flow podmínek pro 15minutový device
 * ✅ Pouze pro 15minutové sloty (96 slotů denně)
 * 
 * BREAKING CHANGE: Odstraněna veškerá podpora hodinového device
 */
class ConditionsManager {
    static instance = null;
    static CONTEXT = 'ConditionsManager';

    /**
     * Získá nebo vytvoří instanci ConditionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     * @returns {ConditionsManager} Singleton instance
     */
    static getInstance(homey) {
        if (!ConditionsManager.instance) {
            ConditionsManager.instance = new ConditionsManager(homey);
        }
        return ConditionsManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro ConditionsManager');
        }
        ConditionsManager.homeyInstance = homey;
    }

    /**
     * Vytvoří novou instanci ConditionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     */
    constructor(homey) {
        if (ConditionsManager.instance) {
            throw new Error('Použijte ConditionsManager.getInstance() místo new ConditionsManager()');
        }

        this.homey = homey;
        this.logger = Logger.getInstance(homey);
        this.isInitialized = false;
        this.settingsManager = SettingsManager.getInstance(homey);
        this._conditions = new Map();

        // Základní typy podmínek - pouze pro 15min device
        this._basicConditions = [
            {
                id: 'price-index-is-condition',
                capability: 'current_index',
                comparison: (current, value) => current === value
            }
        ];

        this.logger.debug('ConditionsManager inicializován (pouze 15min device)');
    }

    // ==================== INICIALIZACE ====================

    /**
     * Inicializuje všechny podmínky
     */
    async initialize() {
        try {
            this.logger?.debug('Začíná inicializace podmínek');
            
            if (this.isInitialized) {
                this.logger?.debug('Podmínky již byly inicializovány, přeskakuji');
                return;
            }

            await this._initializeBasicConditions();      
            await this._initializeSpecialConditions();    
            
            this.isInitialized = true;
            this.logger?.debug('Podmínky úspěšně inicializovány', {
                počet: this._conditions.size,
                registrované: Array.from(this._conditions.keys())
            });
            
        } catch (error) {
            this.logger?.error('Chyba při inicializaci podmínek', error);
            throw error;
        }
    }

    // ==================== ZÁKLADNÍ PODMÍNKY ====================

    /**
     * Inicializuje základní cenové podmínky
     * @private
     */
    async _initializeBasicConditions() {
        try {
            for (const condition of this._basicConditions) {
                await this._registerBasicConditionCard(condition);
            }
        } catch (error) {
            this.logger.error('Chyba při inicializaci základních podmínek', error);
            throw error;
        }
    }

    /**
     * Registruje základní podmínkovou kartu
     * Pouze pro 15min device - používá capability 'current_index'
     * @private
     */
    async _registerBasicConditionCard(conditionConfig) {
        try {
            if (this._conditions.has(conditionConfig.id)) {
                this.logger.debug(`Condition karta ${conditionConfig.id} již je registrována`);
                return;
            }

            const card = this.homey.flow.getConditionCard(conditionConfig.id);

            card.registerRunListener(async (args) => {
                try {
                    // Získej aktuální hodnotu z 15min device
                    const currentValue = await args.device.getCapabilityValue(conditionConfig.capability);

                    if (currentValue === null || currentValue === undefined) {
                        throw new Error(`Hodnota není dostupná pro ${conditionConfig.capability}`);
                    }

                    const expectedValue = args.index;
                    const result = conditionConfig.comparison(currentValue, expectedValue);

                    this.logger.debug(`Condition ${conditionConfig.id} vyhodnocena:`, {
                        currentIndex: currentValue,
                        expectedIndex: expectedValue,
                        result
                    });

                    return result;

                } catch (error) {
                    this.logger.error(`Chyba v condition kartě ${conditionConfig.id}:`, error);
                    return false;
                }
            });

            this._conditions.set(conditionConfig.id, card);
            this.logger.debug(`Condition karta ${conditionConfig.id} úspěšně registrována`);

        } catch (error) {
            this.logger.error(`Chyba při registraci condition karty ${conditionConfig.id}`, error);
            throw error;
        }
    }

    // ==================== SPECIÁLNÍ PODMÍNKY ====================

    /**
     * Inicializuje speciální podmínky
     * @private
     */
    async _initializeSpecialConditions() {
        try {
            await this._registerAveragePriceCondition();
            await this._registerRemainingDayPriceCondition();
            await this._registerTariffCondition();
        } catch (error) {
            this.logger.error('Chyba při inicializaci speciálních podmínek', error);
            throw error;
        }
    }

    /**
     * Registruje podmínku pro průměrnou cenu
     * Pouze pro 15minutové intervaly (96 slotů)
     * 
     * ✅ OPRAVA: Odstraněno findCurrentSlot() - počítá index přímo
     * @private
     */
    async _registerAveragePriceCondition() {
        const card = this.homey.flow.getConditionCard('average-price-condition');

        card.registerRunListener(async (args) => {
            try {
                const { count, condition, interval_type, device } = args;
                const timeInfo = device.spotPriceApi.getCurrentTimeInfo();

                // ✅ Přepočet hodin na sloty
                const actualSlotCount = device.priceCalculationEngine.convertToSlotCount(
                    count, 
                    interval_type
                );

                this.logger?.debug('🔍 Average price condition', {
                    count,
                    interval_type,
                    actualSlotCount,
                    condition
                });

                // ✅ OPRAVA: Získat data Z CACHE (bez findCurrentSlot)
                const cacheKey = `device_${device.getData().id}_lastProcessedPrices`;
                const cachedPrices = device.cacheManager.get(cacheKey);
                
                if (!cachedPrices || cachedPrices.length !== 96) {
                    this.logger?.warn('⚠️ Chybí data v cache pro condition', {
                        found: cachedPrices?.length || 0
                    });
                    return false;
                }

                // ✅ OPRAVA: Vypočítat index PŘÍMO (bez findCurrentSlot)
                // Eliminuje duplicitní vytváření TariffMap
                const currentSlotIndex = timeInfo.hour * 4 + Math.floor(timeInfo.minute / 15);

                // Kontrola zda máme dostatek slotů
                if (currentSlotIndex + actualSlotCount > 96) {
                    this.logger?.debug('⚠️ Nedostatek slotů', {
                        currentSlotIndex,
                        actualSlotCount
                    });
                    return false;
                }

                // Vypočítej průměrné ceny
                // Lock mechanismus v PriceCalculationEngine zajistí, že pro stejné parametry
                // proběhne výpočet pouze jednou (ostatní čekají na výsledek)
                const combinations = await device.priceCalculationEngine.calculateAverageSlotPrices(
                    device,
                    actualSlotCount,
                    0
                );

                if (!combinations || combinations.length === 0) {
                    return false;
                }

                // Seřaď podle průměrné ceny
                const sortedByAverage = combinations.sort((a, b) =>
                    condition === 'lowest' ?
                        a.averagePrice - b.averagePrice :
                        b.averagePrice - a.averagePrice
                );

                const bestCombination = sortedByAverage[0];
                const isInInterval = currentSlotIndex >= bestCombination.startSlotIndex &&
                    currentSlotIndex < (bestCombination.startSlotIndex + actualSlotCount);

                this.logger?.debug('✅ Average price condition vyhodnocena', {
                    isInInterval,
                    currentSlotIndex,
                    bestStartSlotIndex: bestCombination.startSlotIndex,
                    actualSlots: actualSlotCount
                });

                return isInInterval;
            } catch (error) {
                this.logger?.error('❌ Chyba v average price condition', error);
                return false;
            }
        });

        this._conditions.set('average-price-condition', card);
        this.logger?.debug('Average price condition registrována');
    }

    /**
     * Registruje podmínku pro zbývající den
     * Pouze pro 15minutové intervaly (96 slotů)
     * 
     * ✅ OPRAVA: Odstraněno findCurrentSlot() - počítá index přímo
     * @private
     */
    async _registerRemainingDayPriceCondition() {
        const card = this.homey.flow.getConditionCard('remaining-day-price-condition');

        card.registerRunListener(async (args) => {
            try {
                const { count, condition, interval_type, device } = args;
                const timeInfo = device.spotPriceApi.getCurrentTimeInfo();

                // ✅ Přepočet hodin na sloty
                const actualSlotCount = device.priceCalculationEngine.convertToSlotCount(
                    count, 
                    interval_type
                );

                this.logger?.debug('🔍 Remaining day price condition', {
                    count,
                    interval_type,
                    actualSlotCount,
                    condition
                });

                // ✅ OPRAVA: Získat data Z CACHE (bez findCurrentSlot)
                const cacheKey = `device_${device.getData().id}_lastProcessedPrices`;
                const cachedPrices = device.cacheManager.get(cacheKey);
                
                if (!cachedPrices || cachedPrices.length !== 96) {
                    this.logger?.warn('⚠️ Chybí data v cache pro condition', {
                        found: cachedPrices?.length || 0
                    });
                    return false;
                }

                // ✅ OPRAVA: Vypočítat index PŘÍMO (bez findCurrentSlot)
                // Eliminuje duplicitní vytváření TariffMap
                const currentSlotIndex = timeInfo.hour * 4 + Math.floor(timeInfo.minute / 15);

                // Kontrola zda máme dostatek slotů do konce dne
                if (currentSlotIndex + actualSlotCount > 96) {
                    this.logger?.debug('⚠️ Nedostatek slotů', {
                        currentSlotIndex,
                        actualSlotCount
                    });
                    return false;
                }

                // Vypočítej průměrné ceny pro zbývající den
                // Lock mechanismus v PriceCalculationEngine zajistí, že pro stejné parametry
                // (např. slots=2, startFrom=63) proběhne výpočet pouze jednou
                // Pokud druhá condition (highest vs lowest) zavolá se stejnými parametry,
                // počká na dokončení prvního výpočtu a použije výsledek z cache
                const combinations = await device.priceCalculationEngine.calculateRemainingSlotPrices(
                    device,
                    actualSlotCount,
                    currentSlotIndex
                );

                if (!combinations || combinations.length === 0) {
                    return false;
                }

                // Seřaď podle průměrné ceny
                const sortedByAverage = combinations.sort((a, b) =>
                    condition === 'lowest' ?
                        a.averagePrice - b.averagePrice :
                        b.averagePrice - a.averagePrice
                );

                const bestCombination = sortedByAverage[0];
                const isInInterval = currentSlotIndex >= bestCombination.startSlotIndex &&
                    currentSlotIndex < (bestCombination.startSlotIndex + actualSlotCount);

                this.logger?.debug('✅ Remaining day price condition vyhodnocena', {
                    isInInterval,
                    currentSlotIndex,
                    bestStartSlotIndex: bestCombination.startSlotIndex,
                    actualSlots: actualSlotCount
                });

                return isInInterval;
            } catch (error) {
                this.logger?.error('❌ Chyba v remaining day price condition', error);
                return false;
            }
        });

        this._conditions.set('remaining-day-price-condition', card);
        this.logger?.debug('Remaining day price condition registrována');
    }

    /**
     * Registruje podmínku pro tarif
     * - APP-LEVEL condition nemá args.device
     * - Musíme získat všechna devices a vyhodnotit pro každé
     * @private
     */
    async _registerTariffCondition() {
        const card = this.homey.flow.getConditionCard('distribution-tariff-is');

        card.registerRunListener(async (args) => {
            try {
                // ✅ OPRAVA: Správné driver ID (bez podtržítek)
                const driver = this.homey.drivers.getDriver('cz-spot-prices-minutes');
                if (!driver) {
                    this.logger?.error('Driver není dostupný');
                    return false;
                }

                const devices = driver.getDevices();
                if (!devices || devices.length === 0) {
                    this.logger?.error('Žádná devices k dispozici');
                    return false;
                }

                // ✅ Použij první device
                const device = devices[0];
                
                if (!device || !device.spotPriceApi || !device.tariffCalculator) {
                    this.logger?.error('Device nebo jeho API nejsou dostupné', {
                        hasDevice: !!device,
                        hasSpotPriceApi: !!device?.spotPriceApi,
                        hasTariffCalculator: !!device?.tariffCalculator
                    });
                    return false;
                }

                // ✅ Získat aktuální hodinu
                const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;
                
                // ✅ Získat tariff pomocí getTariffMap
                const settings = device.getSettings();
                const tariffMap = device.tariffCalculator.getTariffMap(settings);
                const isLowTariff = tariffMap.get(currentHour) || false;
                
                // ✅ Porovnej s očekávaným tarifem z flow karty
                const result = args.tariff === (isLowTariff ? 'low' : 'high');

                this.logger?.debug('Distribution tariff condition vyhodnocena:', {
                    currentHour,
                    isLowTariff,
                    expected: args.tariff,
                    result
                });

                return result;
                
            } catch (error) {
                this.logger?.error('Chyba v tariff condition:', error, {
                    hasArgs: !!args,
                    tariff: args?.tariff
                });
                return false;
            }
        });

        this._conditions.set('distribution-tariff-is', card);
        this.logger?.debug('Distribution tariff condition registrována');
    }

    // ==================== VEŘEJNÉ METODY ====================

    /**
     * Získá podmínku podle ID
     * @param {string} conditionId - ID podmínky
     * @returns {Condition|null} Instance podmínky nebo null
     */
    getCondition(conditionId) {
        return this._conditions.get(conditionId) || null;
    }

    /**
     * Vyčistí všechny podmínky
     */
    destroy() {
        try {
            this._conditions.clear();
            this.logger.debug('Všechny podmínky byly vyčištěny');
        } catch (error) {
            this.logger.error('Chyba při čištění podmínek:', error);
        }
    }

    /**
     * Získá počet registrovaných podmínek
     * @returns {number} Počet podmínek
     */
    getConditionsCount() {
        return this._conditions.size;
    }

    /**
     * Získá list všech registrovaných ID podmínek
     * @returns {string[]} Seznam ID podmínek
     */
    getRegisteredConditionIds() {
        return Array.from(this._conditions.keys());
    }
}

module.exports = ConditionsManager;
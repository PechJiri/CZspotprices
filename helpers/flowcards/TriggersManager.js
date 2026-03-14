'use strict';

const Logger = require('../Logger');
const PriceCalculationEngine = require('../pricecalculation/PriceCalculationEngine');

/**
 * TriggersManager - správa flow triggerů pro 15minutový device
 * ✅ APP-LEVEL TRIGGERS - registrují se na úrovni aplikace
 * ✅ Pouze pro 15minutové sloty (96 slotů denně)
 * 
 * BREAKING CHANGE: Odstraněna veškerá podpora hodinového device
 */
class TriggersManager {
    static instance = null;
    static CONTEXT = 'TriggersManager';

    /**
     * Získá nebo vytvoří instanci TriggersManageru
     */
    static getInstance(homey) {
        if (!TriggersManager.instance) {
            TriggersManager.instance = new TriggersManager(homey);
        }
        return TriggersManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro TriggerManager');
        }
        TriggersManager.homeyInstance = homey;
    }

    constructor(homey) {
        if (TriggersManager.instance) {
            throw new Error('Použijte TriggersManager.getInstance() místo new TriggersManager()');
        }

        this.homey = homey;
        this.logger = Logger.getInstance(homey);
        this.isInitialized = false;
        this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
        this._triggers = new Map();

        // Cenové triggery - pouze pro 15min device
        this._priceBasedTriggers = [
            {
                id: 'when-price-changes',
                capability: 'measure_current_price',
                type: 'PRICE_CHANGE'
            },
            {
                id: 'current-price-index-trigger',
                capability: 'current_index',
                comparison: (current, value) => current === value,
                type: 'PRICE_INDEX'
            },
            {
                id: 'average-price-trigger',
                type: 'PRICE_AVERAGE'
            }
        ];

        // Tarifní triggery (používají hodiny pro určení tarifu)
        this._tariffTriggers = [
            {
                id: 'when-high-tariff-starts',
                type: 'TARIFF_HIGH_START'
            },
            {
                id: 'when-low-tariff-starts',
                type: 'TARIFF_LOW_START'
            },
            {
                id: 'when-distribution-tariff-changes',
                type: 'TARIFF_CHANGE'
            }
        ];

        // Systémové triggery
        this._systemTriggers = [
            {
                id: 'when-api-call-fails-trigger',
                register: () => this._registerApiFailureTrigger()
            }
        ];

        this.logger.debug('TriggersManager inicializován (pouze 15min device)');
    }

    // ==================== INICIALIZACE ====================

    async initialize() {
        try {
            this.logger?.debug('Začíná inicializace triggerů');
            
            if (this.isInitialized) {
                this.logger?.debug('Triggery již byly inicializovány, přeskakuji');
                return;
            }

            // Cenové triggery
            this.logger?.debug('Inicializace cenových triggerů');
            await this._initializePriceBasedTriggers();
            
            // Tarifní triggery
            this.logger?.debug('Inicializace tarifních triggerů');
            await this._initializeTariffTriggers();
            
            // Systémové triggery
            this.logger?.debug('Inicializace systémových triggerů');
            await this._initializeSystemTriggers();
            
            this.isInitialized = true;
            
            this.logger?.debug('Triggery úspěšně inicializovány', {
                počet: this._triggers.size,
                registrované: Array.from(this._triggers.keys())
            });
            
        } catch (error) {
            this.logger?.error('Chyba při inicializaci triggerů', error);
            throw error;
        }
    }

    // ==================== CENOVÉ TRIGGERY ====================

    async _initializePriceBasedTriggers() {
        try {   
            for (const trigger of this._priceBasedTriggers) {
                switch (trigger.type) {
                    case 'PRICE_CHANGE':
                        await this._registerPriceChangeTrigger(trigger);
                        break;
                    case 'PRICE_INDEX':
                        await this._registerPriceIndexTrigger(trigger);
                        break;
                    case 'PRICE_AVERAGE':
                        await this._registerAveragePriceTrigger();
                        break;
                }
            }
        } catch (error) {
            this.logger.error('Chyba při inicializaci cenových triggerů', error);
            throw error;
        }
    }

    /**
     * Registruje trigger pro změnu aktuální ceny
     * Spustí se kdykoliv se změní measure_current_price
     */
    async _registerPriceChangeTrigger(config) {
        try {
            if (this._triggers.has(config.id)) {
                this.logger.debug(`Trigger ${config.id} již existuje`);
                return;
            }

            const card = this.homey.flow.getTriggerCard(config.id);

            // Tento trigger nemá žádné podmínky - spustí se vždy při změně
            card.registerRunListener(async () => {
                return true;
            });

            this._triggers.set(config.id, card);
            this.logger.debug(`Price change trigger ${config.id} registrován`);
        } catch (error) {
            this.logger.error(`Chyba při registraci price change triggeru ${config.id}`, error);
            throw error;
        }
    }

    /**
     * Registruje trigger pro konkrétní index (např. když je aktuální slot index 3)
     * Pouze pro 15min device - používá capability 'current_index'
     */
    async _registerPriceIndexTrigger(config) {
        try {
            if (this._triggers.has(config.id)) {
                this.logger.debug(`Trigger ${config.id} již existuje`);
                return;
            }

            const card = this.homey.flow.getTriggerCard(config.id);

            card.registerRunListener(async (args) => {
                try {
                    // Získej aktuální index z 15min device
                    const currentIndex = await args.device.getCapabilityValue('current_index');
                    
                    if (currentIndex === null || currentIndex === undefined) {
                        throw new Error('Aktuální index není dostupný');
                    }

                    const result = config.comparison(currentIndex, args.index);

                    this.logger.debug(`Trigger ${config.id} vyhodnocen:`, {
                        currentIndex,
                        expectedIndex: args.index,
                        result
                    });

                    return result;
                } catch (error) {
                    this.logger.error(`Chyba v triggeru ${config.id}`, error);
                    return false;
                }
            });

            this._triggers.set(config.id, card);
            this.logger.debug(`Price index trigger ${config.id} registrován`);
        } catch (error) {
            this.logger.error(`Chyba při registraci price index triggeru ${config.id}`, error);
            throw error;
        }
    }

    /**
     * Registruje trigger pro průměrnou cenu
     * Pouze pro 15minutové intervaly (96 slotů)
     */
    async _registerAveragePriceTrigger() {
        try {
            const id = 'average-price-trigger';
            if (this._triggers.has(id)) {
                return;
            }

            const card = this.homey.flow.getTriggerCard(id);

            card.registerRunListener(async (args) => {
                try {
                    const device = this._getDevice();
                    if (!device) {
                        this.logger?.warn('Zádné zařízení není k dispozici pro vyhodnocení average-price-trigger');
                        return false;
                    }

                    const { count, condition, interval_type } = args;

                    // ✅ Přepočet hodin na sloty
                    const actualSlotCount = this.priceCalculationEngine.convertToSlotCount(
                        count, 
                        interval_type
                    );

                    const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
                    
                    // ✅ OPRAVA: Získat data Z CACHE
                    const cacheKey = `device_${device.getData().id}_lastProcessedPrices`;
                    const cachedPrices = device.cacheManager.get(cacheKey);
                    
                    if (!cachedPrices || cachedPrices.length !== 96) {
                        this.logger?.warn('⚠️ Chybí data v cache pro trigger');
                        return false;
                    }

                    // ✅ OPRAVA: Předat data jako PRVNÍ parametr
                    const currentSlot = device.spotPriceApi.findCurrentSlot(
                        cachedPrices,
                        timeInfo
                    );
                    
                    if (!currentSlot) {
                        return false;
                    }

                    const currentSlotIndex = currentSlot.hour * 4 + Math.floor(currentSlot.minute / 15);

                    if (currentSlotIndex + actualSlotCount > 96) {
                        return false;
                    }

                    const combinations = await this.priceCalculationEngine.calculateAverageSlotPrices(
                        device,
                        actualSlotCount,
                        0
                    );

                    if (!combinations || combinations.length === 0) {
                        return false;
                    }

                    const sortedByAverage = combinations.sort((a, b) =>
                        condition === 'lowest' ?
                            a.averagePrice - b.averagePrice :
                            b.averagePrice - a.averagePrice
                    );

                    const bestCombination = sortedByAverage[0];
                    return currentSlotIndex === bestCombination.startSlotIndex;
                } catch (error) {
                    this.logger?.error('Chyba v average price triggeru', error);
                    return false;
                }
            });

            this._triggers.set(id, card);
            this.logger?.debug('Average price trigger registrován');
        } catch (error) {
            this.logger?.error('Chyba při registraci average price triggeru', error);
            throw error;
        }
    }

    // ==================== TARIFNÍ TRIGGERY ====================

    async _initializeTariffTriggers() {
        try {      
            for (const trigger of this._tariffTriggers) {
                switch (trigger.type) {
                    case 'TARIFF_HIGH_START':
                    case 'TARIFF_LOW_START':
                        await this._registerTariffStartTrigger(trigger);
                        break;
                    case 'TARIFF_CHANGE':
                        await this._registerTariffChangeTrigger();
                        break;
                }
            }
        } catch (error) {
            this.logger.error('Chyba při inicializaci tarifních triggerů', error);
            throw error;
        }
    }

    /**
     * Registruje trigger pro začátek vysokého/nízkého tarifu
     * Tarify jsou stále hodinové (určuje se podle hodiny, ne 15min slotu)
     */
    async _registerTariffStartTrigger(config) {
        try {
            if (this._triggers.has(config.id)) {
                this.logger.debug(`Tariff trigger ${config.id} již existuje`);
                return;
            }

            const card = this.homey.flow.getTriggerCard(config.id);

            card.registerRunListener(async (args, state) => {
                try {
                    const device = this._getDevice();
                    if (!device) {
                        this.logger?.warn(`Žádné zřízení není k dispozici pro ${config.id}`);
                        return false;
                    }
                    const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
                    const currentHour = timeInfo.hour;

                    // ✅ JEDNODUCHÉ: Přímo použij getTariffMap z TariffCalculator
                    const settings = device.getSettings();
                    const tariffMap = device.tariffCalculator.getTariffMap(settings);
                    const isLowTariff = tariffMap.get(currentHour) || false;
                    
                    const isTariffMatch = config.type === 'TARIFF_HIGH_START' ?
                        !isLowTariff : isLowTariff;
                    const previousTariffMatch = config.type === 'TARIFF_HIGH_START' ? 
                        state?.previousTariff === 'low' : 
                        state?.previousTariff === 'high';

                    this.logger.debug(`Tariff trigger ${config.id} vyhodnocen:`, {
                        currentHour,
                        isLowTariff,
                        previousTariff: state?.previousTariff,
                        result: isTariffMatch && previousTariffMatch
                    });

                    return isTariffMatch && previousTariffMatch;
                } catch (error) {
                    this.logger.error(`Chyba v tariff triggeru ${config.id}`, error);
                    return false;
                }
            });

            this._triggers.set(config.id, card);
            this.logger.debug(`Tariff trigger ${config.id} registrován`);
        } catch (error) {
            this.logger.error(`Chyba při registraci tariff triggeru ${config.id}`, error);
            throw error;
        }
    }

    /**
     * Registruje trigger pro změnu tarifu
     */
    async _registerTariffChangeTrigger() {
        const id = 'when-distribution-tariff-changes';
        if (this._triggers.has(id)) {
            this.logger.debug('Tariff change trigger již existuje');
            return;
        }
    
        const card = this.homey.flow.getTriggerCard(id);
        card.registerRunListener(() => true);
    
        this._triggers.set(id, card);
        this.logger.debug('Tariff change trigger registrován');
    }

    // ==================== SYSTÉMOVÉ TRIGGERY ====================

    async _initializeSystemTriggers() {
        try {    
            for (const trigger of this._systemTriggers) {
                try {
                    if (typeof trigger.register === 'function') {
                        await trigger.register();
                        this.logger.debug(`Trigger ${trigger.id} úspěšně inicializován`);
                    } else {
                        this.logger.warn(`Pro trigger ${trigger.id} nebyla nalezena registrační metoda`);
                    }
                } catch (triggerError) {
                    this.logger.error(`Chyba při inicializaci triggeru ${trigger.id}`, triggerError);
                }
            }
        } catch (error) {
            this.logger.error('Chyba při inicializaci systémových triggerů', error);
        }
    }

    /**
     * Registruje trigger pro selhání API
     */
    async _registerApiFailureTrigger() {
        const id = 'when-api-call-fails-trigger';
        try {
            if (this._triggers.has(id)) {
                this.logger.debug('API failure trigger již existuje');
                return;
            }

            const card = this.homey.flow.getTriggerCard(id);

            card.registerRunListener(async (args, state) => {
                try {
                    return args.type === state.type;
                } catch (error) {
                    this.logger.error('Chyba v API failure triggeru', error);
                    return false;
                }
            });

            this._triggers.set(id, card);
            this.logger.debug('API failure trigger registrován');
        } catch (error) {
            this.logger.error('Chyba při registraci API failure triggeru', error);
            throw error;
        }
    }

    // ==================== VEŘEJNÉ METODY PRO SPOUŠTĚNÍ TRIGGERŮ ====================

    /**
     * Spustí trigger pro změnu aktuální ceny
     * @param {Object} tokens - Tokeny pro trigger
     * @param {number} tokens.price - Nová cena
     * @param {number} tokens.index - Nový index
     */
    async triggerPriceChanged(tokens) {
        try {
            const card = this._triggers.get('when-price-changes');
            if (!card) {
                throw new Error('Price change trigger není registrován');
            }

            // ✅ APP-LEVEL trigger - spustí se pro VŠECHNA zařízení
            await card.trigger(tokens);
            this.logger.debug('Price changed trigger spuštěn', { tokens });
        } catch (error) {
            this.logger.error('Chyba při spouštění price changed triggeru', error);
        }
    }

    /**
     * Spustí trigger pro selhání API
     * @param {Object} errorInfo - Informace o chybě
     */
    async triggerApiFailure(errorInfo) {
        try {
            const card = this._triggers.get('when-api-call-fails-trigger');
            if (!card) {
                throw new Error('API failure trigger není registrován');
            }

            const tokens = {
                error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
                will_retry: errorInfo.willRetry || false,
                retry_count: errorInfo.retryCount || 0,
                next_retry: errorInfo.nextRetryIn ? 
                    `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
                max_retries_reached: errorInfo.maxRetriesReached || false
            };

            // ✅ APP-LEVEL trigger - spustí se pro VŠECHNA zařízení
            await card.trigger(tokens);
            this.logger.debug('API failure trigger spuštěn', { tokens });
        } catch (error) {
            this.logger.error('Chyba při spouštění API failure triggeru', error);
        }
    }

    // ==================== POMOCNÉ METODY ====================

    /**
     * Vrátí první aktivní instanci zařízení
     * Využívá se pro app-level karty, které v `args` nedostávají kontext zařízení
     * @private
     */
    _getDevice() {
        if (!this.homey || !this.homey.drivers) return null;
        try {
            const driver = this.homey.drivers.getDriver('cz-spot-prices-minutes');
            if (driver) {
                const devices = driver.getDevices();
                return devices.length > 0 ? devices[0] : null;
            }
        } catch (err) {
            this.logger?.warn('Nelze získat driver cz-spot-prices-minutes: ' + err.message);
        }
        return null;
    }

    /**
     * Získá trigger podle ID
     * @param {string} triggerId - ID triggeru
     * @returns {Object|null} Trigger card nebo null
     */
    getTrigger(triggerId) {
        return this._triggers.get(triggerId) || null;
    }

    /**
     * Získá počet registrovaných triggerů
     * @returns {number} Počet triggerů
     */
    getTriggersCount() {
        return this._triggers.size;
    }

    /**
     * Získá seznam všech registrovaných ID triggerů
     * @returns {string[]} Pole ID triggerů
     */
    getRegisteredTriggerIds() {
        return Array.from(this._triggers.keys());
    }

    /**
     * Vyčistí všechny triggery
     */
    destroy() {
        try {
            this._triggers.clear();
            this.logger.debug('Všechny triggery byly vyčištěny');
        } catch (error) {
            this.logger.error('Chyba při čištění triggerů:', error);
        }
    }
}

module.exports = TriggersManager;
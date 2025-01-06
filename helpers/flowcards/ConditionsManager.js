'use strict';

const Logger = require('../Logger');

class ConditionsManager {
    static instance = null;
    static CONTEXT = 'ConditionsManager';

    /**
     * Získá nebo vytvoří instanci ConditionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     * @returns {ConditionsManager} Singleton instance
     */
    static getInstance(homey, device = null) {
        if (!ConditionsManager.instance) {
            ConditionsManager.instance = new ConditionsManager(homey, device);
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
    constructor(homey, device) {
        if (ConditionsManager.instance) {
            throw new Error('Použijte ConditionsManager.getInstance() místo new ConditionsManager()');
        }

        this.homey = homey;
        this.device = device;
        this.logger = Logger.getInstance()
        this._conditions = new Map();

        // Základní typy podmínek
        this._basicConditions = [
            {
                id: 'price-lower-than-condition',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current < value
            },
            {
                id: 'price-higher-than-condition',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current > value
            },
            {
                id: 'price-index-is-condition',
                capability: 'measure_current_spot_index',
                comparison: (current, value) => current === value
            }
        ];

        this.logger.debug('ConditionsManager inicializován');
    }

    /**
     * Inicializuje všechny podmínky
     */
    async initialize() {
        try {
            this.logger.debug('Začíná inicializace podmínek');
            
            await this._initializeBasicConditions();
            await this._initializeSpecialConditions();
            
            this.logger.log('Podmínky úspěšně inicializovány');
        } catch (error) {
            this.logger.error('Chyba při inicializaci podmínek', error);
            throw error;
        }
    }

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
                    const currentValue = await this.device.getCapabilityValue(conditionConfig.capability);

                    if (currentValue === null || currentValue === undefined) {
                        throw new Error(`Hodnota není dostupná pro ${conditionConfig.capability}`);
                    }

                    let expectedValue;
                    if (conditionConfig.id === 'price-index-is-condition') {
                        expectedValue = args.index;
                    } else {
                        expectedValue = args.value;
                    }

                    const result = conditionConfig.comparison(currentValue, expectedValue);

                    this.logger.debug(`Condition ${conditionConfig.id} vyhodnocena:`, {
                        current: currentValue,
                        expected: expectedValue,
                        result
                    });

                    return result;

                } catch (error) {
                    this.logger.error(`Chyba v condition kartě ${conditionConfig.id}:`, error);
                    return false;
                }
            });

            this._conditions.set(conditionConfig.id, card);
            this.logger.log(`Condition karta ${conditionConfig.id} úspěšně registrována`);

        } catch (error) {
            this.logger.error(`Chyba při registraci condition karty ${conditionConfig.id}`, error);
            throw error;
        }
    }

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
     * @private
     */
    async _registerAveragePriceCondition() {
        const card = this.homey.flow.getConditionCard('average-price-condition');

        card.registerRunListener(async (args) => {
            try {
                const { hours, condition } = args;
                const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;

                if (currentHour + hours > 24) {
                    this.logger.debug('Nedostatek hodin pro dokončení intervalu', {
                        currentHour,
                        požadovanéHodiny: hours,
                        konecIntervalu: currentHour + hours
                    });
                    return false;
                }

                const combinations = await this.device.priceCalculator.calculateAveragePrices(
                    this.device,
                    hours,
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
                const isInInterval = currentHour >= bestCombination.startHour &&
                    currentHour < (bestCombination.startHour + hours);

                this.logger.debug('Average price condition vyhodnocena:', {
                    isInInterval,
                    currentHour,
                    bestStartHour: bestCombination.startHour,
                    averagePrice: bestCombination.averagePrice
                });

                return isInInterval;
            } catch (error) {
                this.logger.error('Chyba v average price condition:', error);
                return false;
            }
        });

        this._conditions.set('average-price-condition', card);
    }

    /**
     * Registruje podmínku pro zbývající den
     * @private
     */
    async _registerRemainingDayPriceCondition() {
        const card = this.homey.flow.getConditionCard('remaining-day-price-condition');

        card.registerRunListener(async (args) => {
            try {
                const { hours, condition } = args;
                const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;

                if (currentHour + hours > 24) {
                    return false;
                }

                const combinations = await this.device.priceCalculationEngine.calculateRemainingDayPrices(
                    this.device,
                    hours,
                    currentHour
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
                const isInInterval = currentHour >= bestCombination.startHour &&
                    currentHour < (bestCombination.startHour + hours);

                this.logger.debug('Remaining day price condition vyhodnocena:', {
                    isInInterval,
                    currentHour,
                    bestStartHour: bestCombination.startHour
                });

                return isInInterval;
            } catch (error) {
                this.logger.error('Chyba v remaining day price condition:', error);
                return false;
            }
        });

        this._conditions.set('remaining-day-price-condition', card);
    }

    /**
     * Registruje podmínku pro tarif
     * @private
     */
    async _registerTariffCondition() {
        const card = this.homey.flow.getConditionCard('distribution-tariff-is');

        card.registerRunListener(async (args) => {
            try {
                const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;
                const settings = this.device.getSettings();
                const isLowTariff = this.device.priceCalculator.isLowTariff(currentHour, settings);
                const result = args.tariff === (isLowTariff ? 'low' : 'high');

                this.logger.debug('Distribution tariff condition vyhodnocena:', {
                    currentHour,
                    isLowTariff,
                    expected: args.tariff,
                    result
                });

                return result;
            } catch (error) {
                this.logger.error('Chyba v tariff condition:', error);
                return false;
            }
        });

        this._conditions.set('distribution-tariff-is', card);
    }

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
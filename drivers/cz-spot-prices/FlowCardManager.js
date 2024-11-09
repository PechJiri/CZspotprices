'use strict';

const Homey = require('homey');

class FlowCardManager {
    constructor(homey, device) {
        this.homey = homey;
        this.device = device;
        this.logger = null;
        
        // Reference na flow karty
        this._flowCards = {
            triggers: new Map(),
            conditions: new Map(),
            actions: new Map()
        };    

        if (this.logger) this.logger.debug('Inicializace FlowCardManageru');

        // Registrace základních typů karet
        this._basicTriggers = [
            {
                id: 'current-price-lower-than-trigger',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current < value
            },
            {
                id: 'current-price-higher-than-trigger',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current > value
            },
            {
                id: 'current-price-index-trigger',
                capability: 'measure_current_spot_index',
                comparison: (current, value) => current === value
            }
        ];

        if (this.logger) this.logger.debug(`Základní triggery nastaveny: ${this._basicTriggers.length}`);

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

        if (this.logger) this.logger.debug(`Základní podmínky nastaveny: ${this._basicConditions.length}`);
    }

    // Metody pro práci s loggerem
    setLogger(logger) {
        this.logger = logger;
        if (this.logger) this.logger.debug('Logger nastaven pro FlowCardManager');
    }

    getLogger() {
        return this.logger;
    }

    /**
     * Inicializace všech flow karet
     */
    async initialize() {
        try {
            if (this.logger) {
                this.logger.log('Initializing Flow cards...');
            }
    
            await this._initializeTriggers();
            await this._initializeConditions();
            await this._initializeActions();
    
            // Logování všech registrovaných karet
            const registeredTriggers = Array.from(this._flowCards.triggers.keys());
            const registeredConditions = Array.from(this._flowCards.conditions.keys());
            const registeredActions = Array.from(this._flowCards.actions.keys());
    
            if (this.logger) {
                this.logger.debug('Registered Flow triggers', { registeredTriggers });
                this.logger.debug('Registered Flow conditions', { registeredConditions });
                this.logger.debug('Registered Flow actions', { registeredActions });
                this.logger.log('Flow cards initialized successfully.');
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Error during Flow card initialization', error);
            }
            throw error;
        }
    }    

    /**
     * Inicializace trigger karet
     */
    async _initializeTriggers() {
        try {
            if (this.logger) {
                this.logger.log('Initializing Flow card triggers...');
            }
    
            // Registrace základních triggerů
            for (const trigger of this._basicTriggers) {
                await this._registerBasicTriggerCard(trigger);
                if (this.logger) {
                    this.logger.debug('Basic trigger registered', { trigger });
                }
            }
    
            // Registrace speciálních triggerů
            await this._registerAveragePriceTrigger();
            await this._registerApiFailureTrigger();
            await this._registerPriceChangeTrigger();
            await this._registerTariffChangeTrigger();
    
            if (this.logger) {
                this.logger.log('Flow card triggers initialized successfully');
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při inicializaci trigger karet', error);
            }
            throw error;
        }
    }
    
    /**
     * Registrace základní trigger karty
     */
    async _registerBasicTriggerCard(triggerConfig) {
        if (this._flowCards.triggers.has(triggerConfig.id)) {
            if (this.logger) {
                this.logger.debug(`Trigger karta ${triggerConfig.id} již je registrována`);
            }
            return;
        }
    
        const card = this.homey.flow.getDeviceTriggerCard(triggerConfig.id);
        
        card.registerRunListener(async (args, state) => {
            try {
                const currentValue = await this.device.getCapabilityValue(triggerConfig.capability);
                if (currentValue === null || currentValue === undefined) {
                    throw new Error(`Hodnota není dostupná pro ${triggerConfig.capability}`);
                }
    
                const result = triggerConfig.comparison(currentValue, args.value);
    
                if (this.logger) {
                    this.logger.debug(`Trigger ${triggerConfig.id} vyhodnocen`, {
                        current: currentValue,
                        target: args.value,
                        result
                    });
                }
    
                return result;
            } catch (error) {
                if (this.logger) {
                    this.logger.error(`Chyba v trigger kartě ${triggerConfig.id}`, error);
                }
                return false;
            }
        });
    
        this._flowCards.triggers.set(triggerConfig.id, card);
    
        if (this.logger) {
            this.logger.log(`Trigger karta ${triggerConfig.id} úspěšně registrována`);
        }
    }
    
    /**
     * Registrace průměrné ceny trigger
     */
    async _registerAveragePriceTrigger() {
        if (this._flowCards.triggers.has('average-price-trigger')) {
            if (this.logger) {
                this.logger.debug('Average price trigger již je registrován');
            }
            return;
        }
    
        const card = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
    
        card.registerRunListener(async (args, state) => {
            try {
                const { hours, condition } = args;
                if (this.logger) {
                    this.logger.debug('Average price trigger check začíná', {
                        hours,
                        condition,
                        state
                    });
                }
                const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                const currentHour = timeInfo.hour;
    
                const combinations = await this.device.priceCalculator.calculateAveragePrices(
                    this.device,
                    hours,
                    0
                );
    
                if (!combinations || combinations.length === 0) {
                    if (this.logger) {
                        this.logger.error('Žádné platné kombinace pro průměrnou cenu');
                    }
                    return false;
                }
    
                // Seřazení podle průměrné ceny
                const sortedByAverage = combinations.sort((a, b) => 
                    condition === 'lowest' ? 
                        a.averagePrice - b.averagePrice : 
                        b.averagePrice - a.averagePrice
                );
    
                const bestCombination = sortedByAverage[0];
    
                // Trigger se spustí pouze v hodinu, kdy interval začíná
                const result = currentHour === bestCombination.startHour;
    
                if (this.logger) {
                    this.logger.debug('Vyhodnocení average price triggeru', {
                        currentHour,
                        bestCombinationStartHour: bestCombination.startHour,
                        averagePrice: bestCombination.averagePrice,
                        condition,
                        willTrigger: result
                    });
                }
    
                return result;
    
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Chyba v average price triggeru', error);
                }
                return false;
            }
        });
    
        this._flowCards.triggers.set('average-price-trigger', card);
    }

    /**
     * Registrace API failure triggeru
     */
    async _registerApiFailureTrigger() {
        if (this._flowCards.triggers.has('when-api-call-fails-trigger')) {
            if (this.logger) {
                this.logger.debug('API failure trigger již je registrován');
            }
            return;
        }
    
        const card = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
    
        card.registerRunListener(async (args, state) => {
            if (this.logger) {
                this.logger.debug('API failure trigger spuštěn', {
                    argsType: args.type,
                    stateType: state.type
                });
            }
            return args.type === state.type;
        });
    
        this._flowCards.triggers.set('when-api-call-fails-trigger', card);
    
        if (this.logger) {
            this.logger.log('API failure trigger úspěšně registrován');
        }
    }    

    /**
     * Registrace price change triggeru
     */
    async _registerPriceChangeTrigger() {
        if (this._flowCards.triggers.has('when-current-price-changes')) {
            if (this.logger) {
                this.logger.debug('Price change trigger již je registrován');
            }
            return;
        }
    
        if (this.logger) {
            this.logger.log('Registrace price change triggeru...');
        }
    
        const card = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
    
        card.registerRunListener(async (args, state) => {
            if (this.logger) {
                this.logger.debug('Price change trigger spuštěn');
            }
            return true;
        });
    
        this._flowCards.triggers.set('when-current-price-changes', card);
    
        if (this.logger) {
            this.logger.log('Price change trigger registrován');
        }
    }    

    /**
     * Registrace tariff change triggeru
     */
    async _registerTariffChangeTrigger() {
        try {
            // Kontrola existence triggeru
            if (this._flowCards.triggers.has('when-distribution-tariff-changes')) {
                if (this.logger) {
                    this.logger.debug('Tariff change trigger již je registrován');
                }
                return;
            }
    
            // Získání trigger karty
            const card = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');
            
            if (!card) {
                throw new Error('Nepodařilo se získat trigger kartu pro změnu tarifu');
            }
    
            // Registrace run listeneru s validací
            card.registerRunListener(async (args, state) => {
                try {
                    // Kontrola dostupnosti required dependencies
                    if (!this.device || !this.device.spotPriceApi || !this.device.priceCalculator) {
                        throw new Error('Chybí required dependencies pro tariff trigger');
                    }
    
                    const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                    const currentHour = timeInfo.hour;
                    const settings = this.device.getSettings();
    
                    // Kontrola validity currentHour
                    if (currentHour < 0 || currentHour >= 24) {
                        throw new Error(`Neplatná hodina: ${currentHour}`);
                    }
    
                    const currentTariff = this.device.priceCalculator.isLowTariff(currentHour, settings) ? 'low' : 'high';
                    
                    // Přidání validace pro state
                    const expectedTariff = state ? state.tariff : null;
                    const tariffMatches = !expectedTariff || expectedTariff === currentTariff;
    
                    if (this.logger) {
                        this.logger.debug('Distribution tariff change trigger vyhodnocen', {
                            currentHour,
                            currentTariff,
                            expectedTariff,
                            tariffMatches,
                            args,
                            state
                        });
                    }
    
                    return tariffMatches;
    
                } catch (error) {
                    if (this.logger) {
                        this.logger.error('Chyba v run listeneru tariff triggeru', error, {
                            args,
                            state
                        });
                    }
                    return false;
                }
            });
    
            // Registrace triggeru
            this._flowCards.triggers.set('when-distribution-tariff-changes', card);
    
            // Logování úspěšné registrace
            if (this.logger) {
                this.logger.log('Tariff change trigger úspěšně registrován', {
                    triggerId: 'when-distribution-tariff-changes',
                    deviceId: this.device?.getData()?.id
                });
            }
    
            // Můžeme vrátit kartu pro další použití
            return card;
    
        } catch (error) {
            if (this.logger) {
                this.logger.error('Kritická chyba při registraci tariff triggeru', error);
            }
            throw error; // Propagujeme error výš pro správné zachycení
        }
    }

    /**
     * Inicializace condition karet
     */
    async _initializeConditions() {
        try {
            // Registrace základních podmínek
            for (const condition of this._basicConditions) {
                await this._registerBasicConditionCard(condition);
            }

            // Registrace speciálních podmínek
            await this._registerAveragePriceCondition();
            await this._registerTariffCondition();

        } catch (error) {
            this.homey.error('Chyba při inicializaci condition karet:', error);
            throw error;
        }
    }

    /**
     * Registrace základní condition karty
     */
    async _registerBasicConditionCard(conditionConfig) {
        if (this._flowCards.conditions.has(conditionConfig.id)) {
            this.homey.log(`Condition karta ${conditionConfig.id} již je registrována`);
            return;
        }

        const card = this.homey.flow.getConditionCard(conditionConfig.id);
        
        card.registerRunListener(async (args, state) => {
            try {
                const currentValue = await this.device.getCapabilityValue(conditionConfig.capability);
                if (currentValue === null || currentValue === undefined) {
                    throw new Error(`Hodnota není dostupná pro ${conditionConfig.capability}`);
                }

                const result = conditionConfig.comparison(currentValue, args.value);
                this.homey.log(`Condition ${conditionConfig.id} vyhodnocena:`, {
                    current: currentValue,
                    target: args.value,
                    result
                });

                return result;
            } catch (error) {
                this.homey.error(`Chyba v condition kartě ${conditionConfig.id}:`, error);
                return false;
            }
        });

        this._flowCards.conditions.set(conditionConfig.id, card);
    }

/**
     * Registrace průměrné ceny condition
     */
async _registerAveragePriceCondition() {
    if (this._flowCards.conditions.has('average-price-condition')) {
        if (this.logger) {
            this.logger.debug('Average price condition již je registrována');
        }
        return;
    }

    const card = this.homey.flow.getConditionCard('average-price-condition');
    
    card.registerRunListener(async (args, state) => {
        try {
            const { hours, condition } = args;
            const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
            const currentHour = timeInfo.hour;

            const combinations = await this.device.priceCalculator.calculateAveragePrices(
                this.device, 
                hours, 
                0
            );
            
            if (!combinations || combinations.length === 0) {
                if (this.logger) {
                    this.logger.error('Nenalezeny žádné kombinace pro výpočet průměru');
                }
                return false;
            }

            // Seřazení podle průměrné ceny
            const sortedByAverage = combinations.sort((a, b) => 
                condition === 'lowest' ? 
                    a.averagePrice - b.averagePrice : 
                    b.averagePrice - a.averagePrice
            );

            const bestCombination = sortedByAverage[0];

            // Podmínka je splněna, pokud jsme v intervalu nejlepší kombinace
            const isInInterval = currentHour >= bestCombination.startHour && 
                               currentHour < (bestCombination.startHour + hours);

            if (this.logger) {
                this.logger.log('Average price condition vyhodnocena:', {
                    currentHour,
                    startHour: bestCombination.startHour,
                    endHour: bestCombination.startHour + hours,
                    averagePrice: bestCombination.averagePrice,
                    hours,
                    condition,
                    isInInterval
                });
            }

            return isInInterval;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba v average price condition:', error);
            }
            return false;
        }
    });

    this._flowCards.conditions.set('average-price-condition', card);
}

/**
 * Registrace tariff condition
 */
async _registerTariffCondition() {
    if (this._flowCards.conditions.has('distribution-tariff-is')) {
        this.homey.log('Tariff condition již je registrována');
        return;
    }

    const card = this.homey.flow.getConditionCard('distribution-tariff-is');
    
    card.registerRunListener(async (args, state) => {
        try {
            const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
            const currentHour = timeInfo.hour;
            const settings = this.device.getSettings();
            const isLowTariff = this.device.priceCalculator.isLowTariff(currentHour, settings);
            const result = args.tariff === (isLowTariff ? 'low' : 'high');

            this.homey.log('Distribution tariff condition vyhodnocena:', {
                currentHour,
                isLowTariff,
                expected: args.tariff,
                result
            });

            return result;
        } catch (error) {
            this.homey.error('Chyba v tariff condition:', error);
            return false;
        }
    });

    this._flowCards.conditions.set('distribution-tariff-is', card);
}

/**
 * Inicializace action karet
 */
async _initializeActions() {
    try {
        await this._registerUpdateDataAction();
    } catch (error) {
        this.homey.error('Chyba při inicializaci action karet:', error);
        throw error;
    }
}

/**
 * Registrace update data action
 */
async _registerUpdateDataAction() {
    if (this._flowCards.actions.has('update_data_via_api')) {
        this.homey.log('Update data action již je registrována');
        return;
    }

    const card = this.homey.flow.getActionCard('update_data_via_api');
    
    card.registerRunListener(async (args) => {
        try {
            await this.device.fetchAndUpdateSpotPrices();
            await this.device.setAvailable();
            return true;
        } catch (error) {
            this.homey.error('Chyba při aktualizaci dat přes API:', error);
            return false;
        }
    });

    this._flowCards.actions.set('update_data_via_api', card);
}

/**
 * Veřejné metody pro triggery
 */
async triggerCurrentPriceChanged(tokens) {
    try {
        const card = this._flowCards.triggers.get('when-current-price-changes');
        if (!card) {
            throw new Error('Price change trigger není registrován');
        }

        await card.trigger(this.device, tokens);
        this.homey.log('Current price changed trigger spuštěn s tokeny:', tokens);
    } catch (error) {
        this.homey.error('Chyba při spouštění current price changed triggeru:', error);
    }
}

async triggerApiFailure(errorInfo) {
    try {
        const card = this._flowCards.triggers.get('when-api-call-fails-trigger');
        if (!card) {
            throw new Error('API failure trigger není registrován');
        }

        const tokens = {
            error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
            will_retry: errorInfo.willRetry || false,
            retry_count: errorInfo.retryCount || 0,
            next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
            max_retries_reached: errorInfo.maxRetriesReached || false
        };

        await card.trigger(this.device, tokens);
        this.homey.log('API failure trigger spuštěn s tokeny:', tokens);
    } catch (error) {
        this.homey.error('Chyba při spouštění API failure triggeru:', error);
    }
}

/**
 * Cleanup při odstranění zařízení
 */
destroy() {
    try {
        // Vyčištění všech referencí na karty
        this._flowCards.triggers.clear();
        this._flowCards.conditions.clear();
        this._flowCards.actions.clear();

        this.homey.log('FlowCardManager byl úspěšně vyčištěn');
    } catch (error) {
        this.homey.error('Chyba při čištění FlowCardManageru:', error);
    }
}
}

module.exports = FlowCardManager;
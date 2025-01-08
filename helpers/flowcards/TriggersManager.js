'use strict';

const Logger = require('../Logger');

class TriggersManager {
    static instance = null;
    static CONTEXT = 'TriggersManager';

    static getInstance(homey, device = null) {
        if (!TriggersManager.instance) {
            TriggersManager.instance = new TriggersManager(homey, device);
        }
        return TriggersManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro TriggerManager');
        }
        TriggersManager.homeyInstance = homey;
    }

    constructor(homey, device) {
        if (TriggersManager.instance) {
            throw new Error('Použijte TriggersManager.getInstance() místo new TriggersManager()');
        }

        this.homey = homey;
        this.device = device;
        this.logger = Logger.getInstance()
        this._triggers = new Map();

        // Cenové triggery
        this._priceBasedTriggers = [
            {
                id: 'current-price-lower-than-trigger',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current < value,
                type: 'PRICE_VALUE'
            },
            {
                id: 'current-price-higher-than-trigger',
                capability: 'measure_current_spot_price_CZK',
                comparison: (current, value) => current > value,
                type: 'PRICE_VALUE'
            },
            {
                id: 'current-price-index-trigger',
                capability: 'measure_current_spot_index',
                comparison: (current, value) => current === value,
                type: 'PRICE_INDEX'
            },
            {
                id: 'average-price-trigger',
                type: 'PRICE_AVERAGE'
            }
        ];

        // Tarifní triggery
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
                register: () => this._registerApiFailureTrigger() // Přidána registrační metoda
            },
            {
                id: 'when-current-price-changes',
                register: () => this._registerPriceUpdateTrigger() // Přidána registrační metoda
            }
        ];

        this.logger.debug('TriggersManager inicializován');
    }

    async initialize() {
        try {
            this.logger.debug('Začíná inicializace triggerů');
            
            await Promise.all([
                this._initializePriceBasedTriggers(),
                this._initializeTariffTriggers(),
                this._initializeSystemTriggers()
            ]);
            
            this.logger.log('Triggery úspěšně inicializovány', {
                počet: this.getTriggersCount(),
                registrované: this.getRegisteredTriggerIds()
            });
        } catch (error) {
            this.logger.error('Chyba při inicializaci triggerů', error);
            throw error;
        }
    }

    async _initializePriceBasedTriggers() {
        try {
            this.logger.debug('Inicializace cenových triggerů');
     
            // Registrace triggeru pro změnu ceny
            const priceChangeCard = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
            if (priceChangeCard) {
                this._triggers.set('when-current-price-changes', priceChangeCard);
                this.logger.debug('Price change trigger registrován');
            }
            
            // Registrace ostatních cenových triggerů
            for (const trigger of this._priceBasedTriggers) {
                switch (trigger.type) {
                    case 'PRICE_VALUE':
                    case 'PRICE_INDEX':
                        await this._registerPriceValueTrigger(trigger);
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

    async _registerPriceValueTrigger(config) {
        try {
            if (this._triggers.has(config.id)) {
                this.logger.debug(`Trigger ${config.id} již existuje`);
                return;
            }

            const card = this.homey.flow.getDeviceTriggerCard(config.id);

            card.registerRunListener(async (args) => {
                try {
                    const currentValue = await this.device.getCapabilityValue(config.capability);
                    
                    if (currentValue === null || currentValue === undefined) {
                        throw new Error(`Hodnota není dostupná pro ${config.capability}`);
                    }

                    const compareValue = config.type === 'PRICE_INDEX' ? args.index : args.value;
                    const result = config.comparison(currentValue, compareValue);

                    this.logger.debug(`Trigger ${config.id} vyhodnocen:`, {
                        current: currentValue,
                        expected: compareValue,
                        result
                    });

                    return result;
                } catch (error) {
                    this.logger.error(`Chyba v triggeru ${config.id}`, error);
                    return false;
                }
            });

            this._triggers.set(config.id, card);
            this.logger.debug(`Price value trigger ${config.id} registrován`);
        } catch (error) {
            this.logger.error(`Chyba při registraci price value triggeru ${config.id}`, error);
            throw error;
        }
    }

    async _registerAveragePriceTrigger() {
        try {
            const id = 'average-price-trigger';
            if (this._triggers.has(id)) {
                this.logger.debug('Average price trigger již existuje');
                return;
            }

            const card = this.homey.flow.getDeviceTriggerCard(id);

            card.registerRunListener(async (args) => {
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
                        return false;
                    }

                    const sortedByAverage = combinations.sort((a, b) =>
                        condition === 'lowest' ?
                            a.averagePrice - b.averagePrice :
                            b.averagePrice - a.averagePrice
                    );

                    const bestCombination = sortedByAverage[0];
                    const result = currentHour === bestCombination.startHour;

                    this.logger.debug('Average price trigger vyhodnocen:', {
                        currentHour,
                        bestStartHour: bestCombination.startHour,
                        result
                    });

                    return result;
                } catch (error) {
                    this.logger.error('Chyba v average price triggeru', error);
                    return false;
                }
            });

            this._triggers.set(id, card);
            this.logger.debug('Average price trigger registrován');
        } catch (error) {
            this.logger.error('Chyba při registraci average price triggeru', error);
            throw error;
        }
    }

    async _initializeTariffTriggers() {
        try {
            this.logger.debug('Inicializace tarifních triggerů');
            
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

    async _registerTariffStartTrigger(config) {
        try {
            if (this._triggers.has(config.id)) {
                this.logger.debug(`Tariff trigger ${config.id} již existuje`);
                return;
            }

            const card = this.homey.flow.getDeviceTriggerCard(config.id);

            card.registerRunListener(async (args, state) => {
                try {
                    const timeInfo = this.device.spotPriceApi.getCurrentTimeInfo();
                    const currentHour = timeInfo.hour;
                    const settings = this.device.getSettings();

                    const isLowTariff = this.device.priceCalculator.isLowTariff(currentHour, settings);
                    const isTariffMatch = config.type === 'TARIFF_HIGH_START' ? !isLowTariff : isLowTariff;
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

    async _registerTariffChangeTrigger() {
        const id = 'when-distribution-tariff-changes';
        if (this._triggers.has(id)) {
            this.logger.debug('Tariff change trigger již existuje');
            return;
        }
    
        const card = this.homey.flow.getDeviceTriggerCard(id);
        
        // Zjednodušená registrace run listeneru
        card.registerRunListener(() => true);
    
        this._triggers.set(id, card);
        this.logger.debug('Tariff change trigger registrován');
    }    

    async _initializeSystemTriggers() {
        try {
            this.logger.debug('Inicializace systémových triggerů');
    
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
                    // Pokračujeme i přes chybu, aby se mohly inicializovat ostatní triggery
                }
            }
        } catch (error) {
            this.logger.error('Chyba při inicializaci systémových triggerů', error);
            // Zde už neodhazujeme chybu, aby nepadala celá inicializace
        }
    }
    

    async _registerApiFailureTrigger() {
        const id = 'when-api-call-fails-trigger';
        try {
            if (this._triggers.has(id)) {
                this.logger.debug('API failure trigger již existuje');
                return;
            }

            const card = this.homey.flow.getDeviceTriggerCard(id);

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

    async _registerPriceUpdateTrigger() {
        const id = 'when-current-price-changes';
        try {
            const card = this.homey.flow.getDeviceTriggerCard(id);
            if (!card) {
                throw new Error(`Trigger karta ${id} není k dispozici`);
            }
            
            card.registerRunListener(() => true);
            this._triggers.set(id, card);
            this.logger.debug('Price update trigger registrován');
            
        } catch (error) {
            this.logger.error('Chyba při registraci price update triggeru', error);
            throw error;
        }
    }

    // Veřejné metody pro spouštění triggerů
    async triggerCurrentPriceChanged(tokens) {
        try {
            const card = this._triggers.get('when-current-price-changes');
            if (!card) {
                throw new Error('Price change trigger není registrován');
            }

            await card.trigger(this.device, tokens);
            this.logger.debug('Current price changed trigger spuštěn', { tokens });
        } catch (error) {
            this.logger.error('Chyba při spouštění current price changed triggeru', error);
        }
    }

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
                next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
                max_retries_reached: errorInfo.maxRetriesReached || false
            };

            await card.trigger(this.device, tokens);
            this.logger.debug('API failure trigger spuštěn', { tokens });
        } catch (error) {
            this.logger.error('Chyba při spouštění API failure triggeru', error);
        }
    }

    // Pomocné metody
    getTrigger(triggerId) {
        return this._triggers.get(triggerId) || null;
    }

    getTriggersCount() {
        return this._triggers.size;
    }

    getRegisteredTriggerIds() {
        return Array.from(this._triggers.keys());
    }

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
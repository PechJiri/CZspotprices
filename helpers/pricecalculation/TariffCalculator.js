'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const SpotPriceAPI = require('../../drivers/cz-spot-prices/api');

class TariffCalculator {
    static instance = null;
    static homeyInstance = null;
    static CONTEXT = 'TariffCalculator';

    static setHomeyInstance(homey) {
        TariffCalculator.homeyInstance = homey;
    }

    constructor(homeyInstance) {
        if (TariffCalculator.instance) {
            throw new Error('Použijte TariffCalculator.getInstance() místo volání new.');
        }
        
        const instanceToUse = homeyInstance || TariffCalculator.homeyInstance;
        
        if (!instanceToUse) {
            throw new Error('HomeyInstance musí být poskytnut');
        }

        this.logger = Logger.getInstance()
        this.homey = instanceToUse;
        this.validator = DataValidator.getInstance(instanceToUse);
    }

    getSpotPriceAPI() {
        if (!this._spotPriceApi) {
            this._spotPriceApi = SpotPriceAPI.getInstance(this.homey);
        }
        return this._spotPriceApi;
    }

    static getInstance(homeyInstance) {
        if (!TariffCalculator.instance) {
            TariffCalculator.instance = new TariffCalculator(homeyInstance);
        }
        return TariffCalculator.instance;
    }

    /**
     * Získá hodiny s nízkým tarifem
     * @param {Object} settings - Nastavení tarifu
     * @returns {Array<number>} - Pole hodin s nízkým tarifem
     */
    getTariffHours(settings) {
        try {
            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení tarifu');
                return [];
            }

            const tarifniHodiny = Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);

            this.logger?.debug('Získání hodin tarifu', {
                tarifniHodiny,
                počet: tarifniHodiny.length
            });

            return tarifniHodiny;
        } catch (error) {
            this.logger?.error('Chyba při získávání hodin tarifu:', error, { settings });
            return [];
        }
    }

    /**
     * Kontroluje, zda je v danou hodinu nízký tarif
     * @param {number} hour - Hodina ke kontrole
     * @param {Object} settings - Nastavení tarifu
     * @returns {boolean} - Zda je v danou hodinu nízký tarif
     */
    isLowTariff(hour, settings) {
        try {
            if (!this.validator.validateTariffHour(hour)) {
                this.logger?.warn('Neplatná hodina pro kontrolu tarifu', { hour });
                return false;
            }

            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení pro kontrolu tarifu');
                return false;
            }

            // Normalizace hodiny pro případ hodnoty 24
            const normalizedHour = hour === 24 ? 0 : hour;

            const tarifniHodiny = this.getTariffHours(settings);
            const jeNizkyTarif = tarifniHodiny.includes(normalizedHour);

            this.logger?.debug('Kontrola nízkého tarifu', {
                hour: normalizedHour,
                jeNizkyTarif,
                počet_NT_hodin: tarifniHodiny.length
            });

            return jeNizkyTarif;
        } catch (error) {
            this.logger?.error('Chyba při kontrole nízkého tarifu:', error, {
                hour,
                settings
            });
            return false;
        }
    }

    async initializeInitialTariff(device) {
        const { hour: currentHour } = this.getSpotPriceAPI().getCurrentTimeInfo();
        
        const initialTariff = this.isLowTariff(currentHour, device.getSettings()) ? 'low' : 'high';
        await device.setStoreValue('previousTariff', initialTariff);
    
        if (this.logger) {
            this.logger.log('Initial tariff set', { initialTariff, currentHour });
        }
    }

    async checkTariffChange(device, currentHour) {
        try {
            const settings = device.getSettings();
            const previousTariff = await device.getStoreValue('previousTariff');
            const currentTariff = this.isLowTariff(currentHour, settings) ? 'low' : 'high';
    
            if (previousTariff !== currentTariff) {
                this.logger?.debug('Detekována změna tarifu', {
                    previousTariff,
                    currentTariff,
                    currentHour
                });
    
                await device.setStoreValue('previousTariff', currentTariff);
                const triggerData = { previousTariff, currentTariff };
    
                // Spouštění příslušných triggerů
                if (currentTariff === 'high') {
                    const highTariffTrigger = device.triggersManager.getTrigger('when-high-tariff-starts');
                    if (highTariffTrigger) {
                        await highTariffTrigger.trigger(device, {}, triggerData);
                        this.logger?.debug('High tariff start trigger spuštěn');
                    }
                } else {
                    const lowTariffTrigger = device.triggersManager.getTrigger('when-low-tariff-starts');
                    if (lowTariffTrigger) {
                        await lowTariffTrigger.trigger(device, {}, triggerData);
                        this.logger?.debug('Low tariff start trigger spuštěn');
                    }
                }
    
                // Obecný trigger pro změnu tarifu
                const changeTrigger = device.triggersManager.getTrigger('when-distribution-tariff-changes');
                if (changeTrigger) {
                    await changeTrigger.trigger(device, {}, triggerData);
                    this.logger?.debug('Tariff change trigger spuštěn');
                }
    
                this.logger?.log('Změna tarifu úspěšně zpracována', triggerData);
            }
        } catch (error) {
            this.logger?.error('Chyba při kontrole změny tarifu', error, {
                hour: currentHour,
                deviceId: device.getData().id
            });
        }
    }
}

module.exports = TariffCalculator;
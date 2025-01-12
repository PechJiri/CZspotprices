'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const SpotPriceAPI = require('../../drivers/cz-spot-prices/api');
const CacheManager = require('../CacheManager');

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
        this.cacheManager = CacheManager.getInstance(instanceToUse);
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
            // Vytvoření unikátního klíče pro cache na základě nastavení
            const cacheKey = `tariff_hours_${JSON.stringify(settings)}`;
            
            // Pokus o získání z cache
            const cachedHours = this.cacheManager.get(cacheKey);
            if (cachedHours !== null) {
                this.logger?.debug('Tarif získán z cache', { 
                    cacheKey, 
                    tarifniHodiny: cachedHours 
                });
                return cachedHours;
            }

            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení tarifu');
                return [];
            }

            const tarifniHodiny = Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);

            // Uložení do cache s neomezenou platností (mění se jen při změně nastavení)
            this.cacheManager.set(cacheKey, tarifniHodiny, 'DEFAULT');

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

            // Vytvoření unikátního klíče pro cache
            const cacheKey = `low_tariff_${hour}_${JSON.stringify(settings)}`;
            
            // Pokus o získání z cache
            const cachedResult = this.cacheManager.get(cacheKey);
            if (cachedResult !== null) {
                this.logger?.debug('Tarif získán z cache', { 
                    hour,
                    isLowTariff: cachedResult 
                });
                return cachedResult;
            }

            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení pro kontrolu tarifu');
                return false;
            }

            // Normalizace hodiny pro případ hodnoty 24
            const normalizedHour = hour === 24 ? 0 : hour;

            const tarifniHodiny = this.getTariffHours(settings);
            const jeNizkyTarif = tarifniHodiny.includes(normalizedHour);

            // Uložení do cache s platností do půlnoci
            this.cacheManager.set(cacheKey, jeNizkyTarif, 'PRICE');

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
            // Použijeme již existující timeInfo
            const settings = device.getSettings();
            const isLowTariff = this.isLowTariff(currentHour, settings);
            
            // Cache pro celou hodinu
            const cacheKey = `tariff_${currentHour}_${device.getId()}`;
            const previousTariff = await device.getStoreValue('previousTariff');
            const currentTariff = isLowTariff ? 'low' : 'high';
    
            if (previousTariff !== currentTariff) {
                this.logger?.debug('Detekována změna tarifu', {
                    previousTariff,
                    currentTariff,
                    currentHour
                });
    
                await device.setStoreValue('previousTariff', currentTariff);
                const triggerData = { previousTariff, currentTariff };
    
                // Spustit příslušné triggery
                if (currentTariff === 'high') {
                    const trigger = device.triggersManager.getTrigger('when-high-tariff-starts');
                    if (trigger) {
                        await trigger.trigger(device, {}, triggerData);
                        this.logger?.debug('High tariff start trigger spuštěn');
                    }
                } else {
                    const trigger = device.triggersManager.getTrigger('when-low-tariff-starts');
                    if (trigger) {
                        await trigger.trigger(device, {}, triggerData);
                        this.logger?.debug('Low tariff start trigger spuštěn');
                    }
                }
    
                // Obecný trigger pro změnu tarifu
                const trigger = device.triggersManager.getTrigger('when-distribution-tariff-changes');
                if (trigger) {
                    await trigger.trigger(device, {}, triggerData);
                    this.logger?.debug('Tariff change trigger spuštěn');
                }
    
                this.logger?.log('Změna tarifu úspěšně zpracována', triggerData);
            }
        } catch (error) {
            this.logger?.error('Chyba při kontrole změny tarifu', error, {
                deviceId: device.getData().id
            });
        }
    }
}

module.exports = TariffCalculator;
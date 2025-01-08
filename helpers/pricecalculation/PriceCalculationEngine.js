'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const TariffCalculator = require('./TariffCalculator');
const CacheManager = require('../CacheManager');
const SettingsManager = require('../SettingsManager');

class PriceCalculationEngine {
    static instance = null;
    static CONTEXT = 'PriceCalculationEngine';

    static getInstance(homey, deviceContext = 'PriceCalculatorEngine') {
        if (!PriceCalculationEngine.instance) {
            PriceCalculationEngine.instance = new PriceCalculationEngine(homey, deviceContext);
        }
        return PriceCalculationEngine.instance;
    }

    constructor(homeyInstance, deviceContext) {
        if (PriceCalculationEngine.instance) {
            throw new Error('Použijte PriceCalculationEngine.getInstance() místo volání new.');
        }
        
        // Logger, validator, a kalkulátor tarifu
        this.logger = Logger.getInstance()
        this.validator = DataValidator.getInstance(homeyInstance);
        this.tariffCalculator = TariffCalculator.getInstance(homeyInstance);
        this.SettingsManager = SettingsManager.getInstance(homeyInstance);
        
        this.homey = homeyInstance;
        this.deviceContext = deviceContext;

        // Inicializace CacheManager
        this.cacheManager = CacheManager.getInstance(homeyInstance);
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro PriceCalculationEngine');
        }
        PriceCalculationEngine.homeyInstance = homey;
    }

    /**
     * Přidání distribučního tarifu a případného DPH k základní ceně
     * @param {number} basePrice - Základní cena komodity
     * @param {object} settings - Nastavení zařízení
     * @param {boolean} settings.commodity_price_with_vat - Zda se má k ceně komodity připočíst DPH
     * @param {number} settings.low_tariff_price - Cena pro nízký tarif distribuce
     * @param {number} settings.high_tariff_price - Cena pro vysoký tarif distribuce
     * @param {number} hour - Aktuální hodina (0-23)
     * @returns {number} - Konečná cena včetně distribuce a případného DPH
     */
    addDistributionPrice(basePrice, settings, hour) {
        try {
            // Změna: použití validatePrice místo validateBasePrice
            if (!this.validator.validatePrice(basePrice, 'základní cena pro distribuci')) {
                return basePrice;
            }
            
            // Interní funkce pro přidání DPH
            const addVAT = (price) => {
                if (!settings.commodity_price_with_vat) {
                    return price;  
                }
                const priceWithVAT = price * 1.21;
                this.logger?.debug('Přidáno DPH k ceně', {
                    původníCena: price,
                    sDPH: priceWithVAT, 
                    sazba: '21%'
                });
                return priceWithVAT;
            }
    
            const priceWithVAT = addVAT(basePrice);
            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;
            const isLowTariff = this.tariffCalculator.isLowTariff(hour, settings);
            
            const finalPrice = priceWithVAT + (isLowTariff ? lowTariffPrice : highTariffPrice);
    
            this.logger?.debug('Výpočet ceny s tarifem', {
                hour,
                basePrice,
                priceWithVAT,
                distribuční_tarif: isLowTariff ? 'nízký' : 'vysoký',
                cena_distribuce: isLowTariff ? lowTariffPrice : highTariffPrice,
                finalPrice
            });
    
            return finalPrice;
        } catch (error) {
            this.logger?.error('Chyba při výpočtu ceny:', error);
            return basePrice;
        }
    }

    /**
     * Konverze ceny na jinou jednotku (např. z MWh na kWh)
     * @param {number} price - Cena k převodu
     * @param {boolean} priceInKWh - Zda je cena v kWh
     * @returns {number} - Převáděná cena
     */
    convertPrice(price, priceInKWh) {
        try {
            if (!priceInKWh) {
                return price;
            }
    
            if (!this.validator.validatePrice(price, 'cena pro konverzi')) {
                return price;
            }
    
            const result = price / 1000;
    
            this.logger?.debug('Konverze ceny', {
                vstupní: price,
                výsledek: result,
                jednotka: 'kWh'
            });
    
            return result;
        } catch (error) {
            this.logger?.error('Chyba při konverzi ceny:', error);
            return price;
        }
    }

    calculateMinMaxPrices(prices) {
        try {
            if (!this.validator.validatePriceArray(prices)) {
                throw new Error('Neplatná data pro výpočet min/max cen');
            }

            const priceValues = prices.map(p => p.priceCZK);
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);

            this.logger?.debug('Min/max ceny vypočteny', {
                min: minPrice,
                max: maxPrice,
                počet_cen: prices.length
            });

            return { minPrice, maxPrice };
        } catch (error) {
            this.logger?.error('Chyba při výpočtu min/max cen', error);
            throw error;
        }
    }

    getNextHourPrice(prices, currentHour) {
        try {
            if (!this.validator.validatePriceArray(prices)) {
                throw new Error('Neplatná data pro výpočet next hour price');
            }

            if (!this.validator.validateHourRange(currentHour)) {
                throw new Error('Neplatná hodina pro výpočet next hour price');
            }

            const nextHourPrice = currentHour === 23 ? 
                prices[currentHour].priceCZK : 
                prices[currentHour + 1].priceCZK;

            this.logger?.debug('Next hour price vypočtena', {
                currentHour,
                nextHourPrice,
                is23Hour: currentHour === 23
            });

            return nextHourPrice;
        } catch (error) {
            this.logger?.error('Chyba při výpočtu next hour price', error);
            throw error;
        }
    }
    
    /**
     * Metody pro výpočet kolem průměrů cen
     */
    async calculateAveragePrices(device, hours, startFromHour = 0) {
        try {
            const cacheResult = await this.checkAveragePricesCache(device, hours, startFromHour);
            if (cacheResult) return cacheResult;

            const combinations = await this.calculatePriceCombinations(device, hours, startFromHour);
            this.updateAveragePricesCache(combinations, hours, startFromHour, device);

            return combinations;
        } catch (error) {
            this.logCalculationError('calculateAveragePrices', error);
            return [];
        }
    }

    async checkAveragePricesCache(device, hours, startFromHour) {
        if (!this.cacheManager) {
            this.logger?.error('CacheManager není inicializován');
            return null;
        }
    
        const currentHour = new Date().getHours();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${SettingsManager.getPriceInKWh()}`;
    
        if (this.cacheManager.has(cacheKey) && this.lastCalculationHour === currentHour) {
            const cachedData = this.cacheManager.get(cacheKey); // Použij správnou metodu
            if (this.isCacheValid(cachedData.timestamp)) {
                this.logger?.debug('Použití dat z průměrné cache', { cacheKey });
                return cachedData.data;
            }
        }
        return null;
    }
    

    async calculatePriceCombinations(device, hours, startFromHour) {
        const combinations = [];
        
        for (let startHour = startFromHour; startHour <= 24 - hours; startHour++) {
            const intervalData = await this.calculateIntervalData(device, startHour, hours);
            if (intervalData) combinations.push(intervalData);
        }

        this.logCombinationsCalculated(combinations, hours);
        return combinations;
    }

    async calculateIntervalData(device, startHour, hours) {
        let totalPrice = 0;
        const intervalPrices = [];

        for (let i = 0; i < hours; i++) {
            const hourData = await this.getHourPrice(device, startHour + i);
            if (!hourData) return null;
            
            intervalPrices.push(hourData);
            totalPrice += hourData.price;
        }

        return {
            startHour,
            averagePrice: totalPrice / hours,
            prices: intervalPrices,
            intervalLength: hours
        };
    }

    async getHourPrice(device, hour) {
        const hourNumber = hour % 24;
        const price = await device.getCapabilityValue(`hour_price_CZK_${hourNumber}`);
        
        if (price === null || price === undefined) {
            this.logger?.warn(`Chybí cena pro hodinu ${hourNumber}`);
            return null;
        }

        return {
            hour: hourNumber,
            price: price
        };
    }

    async calculateRemainingDayPrices(device, hours, startFromHour = null) {
        try {
            const currentHour = this.determineStartHour(startFromHour);
            const cacheResult = await this.checkRemainingDayCache(device, hours, currentHour);
            if (cacheResult) return cacheResult;

            const combinations = await this.calculateRemainingCombinations(device, hours, currentHour);
            this.updateRemainingDayCache(combinations, hours, currentHour, device);

            return combinations;
        } catch (error) {
            this.logCalculationError('calculateRemainingDayPrices', error);
            return [];
        }
    }

    determineStartHour(startFromHour) {
        return startFromHour !== null ? startFromHour : new Date().getHours();
    }

    async checkRemainingDayCache(device, hours, currentHour) {
        const cacheKey = `remaining-${hours}-${currentHour}-${SettingsManager.getPriceInKWh()}`;

        if (this.cacheManager.has(cacheKey) && this.lastCalculationHour === currentHour) {
            const cachedData = this.cacheManager.get(cacheKey);
            if (this.isCacheValid(cachedData.timestamp)) {
                this.logger?.debug('Použití dat z remaining day cache', { cacheKey });
                return cachedData.data;
            }
        }
        return null;
    }

    async calculateRemainingCombinations(device, hours, currentHour) {
        const combinations = [];
        
        for (let startHour = currentHour; startHour <= 24 - hours; startHour++) {
            const intervalData = await this.calculateIntervalData(device, startHour, hours);
            if (intervalData) combinations.push(intervalData);
        }

        this.logRemainingCombinationsCalculated(combinations, hours, currentHour);
        return combinations;
    }

    updateRemainingDayCache(combinations, hours, currentHour) {
        const cacheKey = `remaining-${hours}-${currentHour}-${SettingsManager.getPriceInKWh()}`;
        this.cacheManager.set(cacheKey, {
            data: combinations,
            timestamp: Date.now()
        });
        this.lastCalculationHour = currentHour;
    }

    updateAveragePricesCache(combinations, hours, startFromHour) {
        const currentHour = new Date().getHours();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${SettingsManager.getPriceInKWh()}`;
        
        this.cacheManager.set(cacheKey, {
            data: combinations,
            timestamp: Date.now()
        });
        this.lastCalculationHour = currentHour;
    }

    isCacheValid(timestamp) {
        const now = Date.now();
        const maxAge = this.cacheManager?.TTL.AVERAGE || 15 * 60 * 1000; // Fallback na 15 minut
        return now - timestamp < maxAge;
    }
    

    logCalculationError(methodName, error) {
        if (this.logger) {
            this.logger.error(`Chyba v metodě ${methodName}:`, error);
        }
    }

    logCombinationsCalculated(combinations, hours) {
        if (this.logger) {
            this.logger.debug('Vypočtené kombinace průměrných cen', {
                počet: combinations.length,
                hodinVIntervalu: hours,
                příklad: combinations[0] ? {
                    začátek: combinations[0].startHour,
                    průměr: combinations[0].averagePrice,
                    početCen: combinations[0].prices.length
                } : 'žádné kombinace'
            });
        }
    }

    logRemainingCombinationsCalculated(combinations, hours, currentHour) {
        if (this.logger) {
            this.logger.debug('Vypočtené kombinace zbývajících průměrných cen', {
                počet: combinations.length,
                hodinVIntervalu: hours,
                odHodiny: currentHour,
                příklad: combinations[0] ? {
                    začátek: combinations[0].startHour,
                    průměr: combinations[0].averagePrice,
                    početCen: combinations[0].prices.length
                } : 'žádné kombinace'
            });
        }
    }

    async calculateAveragePriceCombinations(device, hours) {
        const combinations = await this.calculatePriceCombinations(device, hours, 0);
        this.logger.debug('Vypočtené kombinace pro average price', {
            hours,
            combinationsCount: combinations.length,
            firstThree: combinations.slice(0, 3).map(c => ({
                startHour: c.startHour,
                avgPrice: c.averagePrice.toFixed(2),
            }))
        });
        return combinations;
    }
    
    getTargetCombination(combinations, condition) {
        const sortedCombinations = combinations.sort((a, b) =>
            condition === 'lowest' ? a.averagePrice - b.averagePrice : b.averagePrice - a.averagePrice
        );
        return sortedCombinations[0];
    }
    
    isCurrentHourMatch(combination, currentHour) {
        if (!combination || typeof combination !== 'object') {
            this.logger.info('isCurrentHourMatch: no combination object => returning false', { combination });
            return false;
        }
        const isMatch = combination.startHour === currentHour;
        this.logger.debug('isCurrentHourMatch: combination check', {
            combination,
            currentHour,
            isMatch
        });
        return isMatch;
    }

    async checkAveragePriceAndTrigger(device, triggerCard) {
        try {
            const flows = await triggerCard.getArgumentValues(device);
            const currentHour = new Date().getHours();
    
            for (const flow of flows) {
                const { hours, condition } = flow;
                const combinations = await this.calculatePriceCombinations(device, hours, 0);
                const targetCombination = this.getTargetCombination(combinations, condition);
    
                if (this.isCurrentHourMatch(targetCombination, currentHour)) {
                    await triggerCard.trigger(device, {
                        average_price: parseFloat(targetCombination.averagePrice.toFixed(2))
                    }, flow);
                    
                    this.logger?.debug('Average price trigger activated', {
                        hours,
                        condition, 
                        averagePrice: targetCombination.averagePrice
                    });
                }
            }
    
            return true;
        } catch (error) {
            this.logger?.error('Error in checkAveragePriceAndTrigger', error);
            return false;
        }
    }
}

module.exports = PriceCalculationEngine;

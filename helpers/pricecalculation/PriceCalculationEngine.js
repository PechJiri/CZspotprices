'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const TariffCalculator = require('./TariffCalculator');
const CacheManager = require('../CacheManager');
const SettingsManager = require('../SettingsManager');
const SpotPriceAPI = require('../../drivers/cz-spot-prices/api');

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
        
        if (!this.SettingsManager) {
            throw new Error('SettingsManager není inicializován');
        }
    
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

    getSpotPriceAPI() {
        if (!this._spotPriceApi) {
            this._spotPriceApi = SpotPriceAPI.getInstance(this.homey);
        }
        return this._spotPriceApi;
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
            // Vytvoření klíče pro cache
            const cacheKey = `distribution_${basePrice}_${hour}_${JSON.stringify(settings)}`;
            
            // Kontrola cache
            const cachedPrice = this.cacheManager.get(cacheKey);
            if (cachedPrice !== null) {
                this.logger?.debug('Distribuční cena získána z cache', {
                    basePrice,
                    hour,
                    finalPrice: cachedPrice
                });
                return cachedPrice;
            }
    
            // Debug log pro vstupní parametry
            this.logger?.debug('Výpočet ceny - vstupní parametry', {
                basePrice,
                settings,
                hour
            });
    
            if (!this.validator.validatePrice(basePrice, 'základní cena pro distribuci')) {
                return basePrice;
            }
    
            // Interní funkce pro přidání DPH
            const addVAT = (price) => {
                if (!settings.commodity_price_with_vat) {
                    return price;
                }
                return price * 1.21;
            };
    
            const priceWithVAT = addVAT(basePrice);
    
            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;
            const isLowTariff = this.tariffCalculator.isLowTariff(hour, settings);
    
            const finalPrice = priceWithVAT + (isLowTariff ? lowTariffPrice : highTariffPrice);
    
            // Cache s platností do půlnoci
            this.cacheManager.set(cacheKey, finalPrice, 'PRICE');
    
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

    async calculateMinMaxPrices(prices) {
        try {
            // Vytvoření unikátního klíče pro cache
            const cacheKey = `minmax_${prices.map(p => p.priceCZK).join('_')}`;
            
            // Kontrola cache
            const cachedResult = this.cacheManager.get(cacheKey);
            if (cachedResult) {
                this.logger?.debug('Min/max ceny získány z cache', {
                    min: cachedResult.minPrice,
                    max: cachedResult.maxPrice
                });
                return cachedResult;
            }
    
            if (!this.validator.validatePriceArray(prices)) {
                throw new Error('Neplatná data pro výpočet min/max cen');
            }
    
            const priceValues = prices.map(p => p.priceCZK);
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);
    
            const result = { minPrice, maxPrice };
    
            // Uložení do cache s platností do další hodiny
            this.cacheManager.set(cacheKey, result, 'AVERAGE');
    
            this.logger?.debug('Min/max ceny vypočteny', {
                min: minPrice,
                max: maxPrice,
                počet_cen: prices.length
            });
    
            return result;
        } catch (error) {
            this.logger?.error('Chyba při výpočtu min/max cen', error);
            throw error;
        }
    }

    getNextHourPrice(prices, currentHour) {
        try {
            // Vytvoření klíče pro cache
            const cacheKey = `next_hour_${currentHour}_${prices.map(p => p.priceCZK).join('_')}`;
            
            // Kontrola cache
            const cachedPrice = this.cacheManager.get(cacheKey);
            if (cachedPrice !== null) {
                this.logger?.debug('Next hour price získána z cache', {
                    currentHour,
                    nextHourPrice: cachedPrice
                });
                return cachedPrice;
            }
    
            if (!this.validator.validatePriceArray(prices)) {
                throw new Error('Neplatná data pro výpočet next hour price');
            }
    
            if (!this.validator.validateHourRange(currentHour)) {
                throw new Error('Neplatná hodina pro výpočet next hour price');
            }
    
            const nextHourPrice = currentHour === 23 ? 
                prices[currentHour].priceCZK : 
                prices[currentHour + 1].priceCZK;
    
            // Cache s platností do další hodiny
            this.cacheManager.set(cacheKey, nextHourPrice, 'AVERAGE');
    
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
    
        const { hour: currentHour } = this.getSpotPriceAPI().getCurrentTimeInfo();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${this.SettingsManager.getPriceInKWh(device)}`;
    
        if (this.cacheManager.has(cacheKey) && this.lastCalculationHour === currentHour) {
            const cachedData = this.cacheManager.get(cacheKey);
            if (this.isCacheValid(cachedData.timestamp)) {
                this.logger?.debug('Použití dat z průměrné cache', { cacheKey });
                return cachedData.data;
            }
        }
        return null;
    }

    determineStartHour(startFromHour) {
        return startFromHour !== null ? startFromHour : this.getSpotPriceAPI().getCurrentTimeInfo().hour;
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

    async checkRemainingDayCache(device, hours, currentHour) {
        const cacheKey = `remaining-${hours}-${currentHour}-${this.SettingsManager.getPriceInKWh(device)}`;
    
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

    updateRemainingDayCache(combinations, hours, currentHour, device) {
        const cacheKey = `remaining-${hours}-${currentHour}-${this.SettingsManager.getPriceInKWh(device)}`;
        this.cacheManager.set(cacheKey, {
            data: combinations,
            timestamp: Date.now()
        });
        this.lastCalculationHour = currentHour;
    }

    updateAveragePricesCache(combinations, hours, startFromHour, device) {
        const { hour: currentHour } = this.getSpotPriceAPI().getCurrentTimeInfo();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${this.SettingsManager.getPriceInKWh(device)}`;
        
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
            this.logger.debug('isCurrentHourMatch: no combination object => returning false', { combination });
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

    async checkAveragePriceAndTrigger(device, triggerCard, timeInfo) {
        try {
            // Použijeme již existující timeInfo místo nového získávání
            const currentHour = timeInfo.hour;
            
            const flows = await triggerCard.getArgumentValues(device);
    
            for (const flow of flows) {
                const { hours, condition } = flow;
                const combinations = await this.calculateAveragePrices(device, hours, currentHour);
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

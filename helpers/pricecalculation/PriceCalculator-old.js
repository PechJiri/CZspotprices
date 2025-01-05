'use strict';

const Logger = require('../Logger');

class PriceCalculator {
    // Statická proměnná pro uložení jediné instance
    static instance = null;

    // Statická metoda pro získání nebo vytvoření instance
    static getInstance(homey, deviceContext = 'PriceCalculator') {
        if (!PriceCalculator.instance) {
            PriceCalculator.instance = new PriceCalculator(homey, deviceContext);
        }
        return PriceCalculator.instance;
    }

    constructor(homey, deviceContext = 'PriceCalculator') {
        if (PriceCalculator.instance) {
            throw new Error('Použijte PriceCalculator.getInstance() místo volání new PriceCalculator().');
        }
        this.homey = homey;
        this.logger = Logger.getInstance(this.homey, deviceContext);
        this.logger.debug('PriceCalculator inicializován');
        this.logger.setEnabled(true);
        this.priceCache = new Map();
        this.averagePriceCache = new Map();
        this.lastCalculationHour = null;
        // Konstanty pro cache
        this.PRICE_CACHE_TTL = 60 * 60 * 1000; // 1 hodina
        this.AVERAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minut
        
        // Nastavení automatického čištění cache
        this.setupCacheCleanup();
        
        this.logger.debug('PriceCalculator inicializován');
    }

    /**
     * Nastavení automatického čištění cache
     * @private
     */
    setupCacheCleanup() {
        this.homey.setInterval(() => {
            this.cleanupCache();
        }, this.PRICE_CACHE_TTL);

        if (this.logger) {
            this.logger.debug('Cache cleanup nastaven', {
                interval: this.PRICE_CACHE_TTL,
                nextCleanup: new Date(Date.now() + this.PRICE_CACHE_TTL).toISOString()
            });
        }
    }

    /**
     * Vyčištění starých záznamů z cache
     * @private
     */
    cleanupCache() {
        const now = Date.now();
        const beforeCleanup = {
            priceCache: this.priceCache.size,
            averageCache: this.averagePriceCache.size
        };
        
        for (const [key, value] of this.priceCache.entries()) {
            if (now - value.timestamp > this.PRICE_CACHE_TTL) {
                this.priceCache.delete(key);
            }
        }

        for (const [key, value] of this.averagePriceCache.entries()) {
            if (now - value.timestamp > this.AVERAGE_CACHE_TTL) {
                this.averagePriceCache.delete(key);
            }
        }

        const afterCleanup = {
            priceCache: this.priceCache.size,
            averageCache: this.averagePriceCache.size
        };

        if (this.logger) {
            this.logger.debug('Cache vyčištěna', {
                before: beforeCleanup,
                after: afterCleanup,
                removed: {
                    priceCache: beforeCleanup.priceCache - afterCleanup.priceCache,
                    averageCache: beforeCleanup.averageCache - afterCleanup.averageCache
                }
            });
        }
    }

    validatePriceData(data) {
        if (!Array.isArray(data)) {
            if (this.logger) {
                this.logger.debug('Vstupní data pro validaci', { 
                    receivedType: typeof data,
                    receivedValue: data 
                });
            }
            
            if (this.logger) {
                this.logger.error('Neplatná data - není pole', new Error('Invalid data type'));
            }
            return false;
        }

        if (data.length !== 24) {
            if (this.logger) {
                this.logger.error('Neplatná data - nesprávný počet hodin', new Error('Invalid data length'), {
                    expectedLength: 24,
                    actualLength: data.length
                });
            }
            return false;
        }

        const validationResults = data.map((item, index) => {
            // Kontrolujeme pouze povinné vlastnosti - hour a priceCZK
            const hasValidPrice = typeof item.priceCZK === 'number' && !isNaN(item.priceCZK);
            const hasValidHour = typeof item.hour === 'number' && item.hour >= 0 && item.hour < 24;
            
            // Level je volitelná vlastnost - přijde jen z primárního API
            // Pokud není, dopočítáme ji později v setPriceIndexes
            
            if (!hasValidPrice || !hasValidHour) {
                if (this.logger) {
                    this.logger.debug('Neplatná data pro hodinu', {
                        index,
                        item,
                        validPrice: hasValidPrice,
                        validHour: hasValidHour,
                        hasLevel: Boolean(item.level) // jen pro logging
                    });
                }
            }
            
            return hasValidPrice && hasValidHour;
        });

        const isValid = validationResults.every(result => result);
        
        if (this.logger) {
            this.logger.debug('Validace dat dokončena', {
                isValid,
                hasLevels: data.every(item => Boolean(item.level)), // pro logging
                invalidHours: validationResults
                    .map((result, index) => ({ index, valid: result }))
                    .filter(item => !item.valid)
                    .map(item => item.index)
            });
        }

        return isValid;
    }

    /**
     * Přidání DPH k ceně
     * @param {number} price - Základní cena bez DPH
     * @param {boolean} applyVAT - Zda se má aplikovat DPH
     * @returns {number} - Cena s nebo bez DPH podle nastavení
     */
    addVAT(price, applyVAT) {
        try {
            if (typeof price !== 'number' || isNaN(price)) {
                const error = new Error('Neplatná cena pro výpočet DPH');
                if (this.logger) {
                    this.logger.error('Chyba při výpočtu DPH:', error, { price });
                }
                throw error;
            }

            if (!applyVAT) {
                return price;
            }

            const priceWithVAT = price * 1.21; // 21% DPH

            if (this.logger) {
                this.logger.debug('Přidáno DPH k ceně', {
                    původníCena: price,
                    sDPH: priceWithVAT,
                    sazba: '21%'
                });
            }

            return priceWithVAT;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při přidávání DPH:', error, { price, applyVAT });
            }
            return price;
        }
    }

    /**
     * Přidání distribučního tarifu k základní ceně
     */
    addDistributionPrice(basePrice, settings, hour) {
        try {
            if (typeof basePrice !== 'number' || isNaN(basePrice)) {
                const error = new Error('Neplatná základní cena');
                if (this.logger) {
                    this.logger.error('Chyba při výpočtu distribuční ceny:', error, { basePrice });
                }
                throw error;
            }
    
            const priceWithVAT = this.addVAT(basePrice, settings.commodity_price_with_vat || false);
            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;
            const isLowTariff = this.isLowTariff(hour, settings);
    
            const finalPrice = priceWithVAT + (isLowTariff ? lowTariffPrice : highTariffPrice);
    
            if (this.logger) {
                this.logger.debug(`Výpočet cen: hour: ${hour}, basePrice: ${basePrice}, priceWithVAT: ${priceWithVAT}, tariffPrice: ${isLowTariff ? lowTariffPrice : highTariffPrice}, finalPrice: ${finalPrice}`);
            }
    
            return finalPrice;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při výpočtu ceny:', error, { basePrice, settings, hour });
            }
            return basePrice;
        }
    }

    /**
     * Kontrola nízkého tarifu pro danou hodinu
     */
    isLowTariff(hour, settings) {
        try {
            if (hour < 0 || hour >= 24) {
                const chyba = new Error('Neplatná hodina');
                if (this.logger) {
                    this.logger.error('Chyba při kontrole nízkého tarifu:', chyba, { hour });
                }
                throw chyba;
            }
    
            const tarifniHodiny = this.getTariffHours(settings);
            const jeNizkyTarif = tarifniHodiny.includes(hour);
    
            if (this.logger) {
                this.logger.debug(`Kontrola nízkého tarifu: hour=${hour}, jeNizkyTarif=${jeNizkyTarif}`);
            }
    
            return jeNizkyTarif;
        } catch (chyba) {
            if (this.logger) {
                this.logger.error('Chyba při kontrole nízkého tarifu:', chyba, { hour, settings });
            }
            return false;
        }
    }

    /**
     * Získání hodin s nízkým tarifem
     */
    getTariffHours(settings) {
        try {
            const tarifniHodiny = Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);
    
            if (this.logger) {
                this.logger.debug('Získání hodin tarifu', { tarifniHodiny });
            }
    
            return tarifniHodiny;
        } catch (chyba) {
            if (this.logger) {
                this.logger.error('Chyba při získávání hodin tarifu:', chyba, { settings });
            }
            return [];
        }
    }

    /**
     * Nastavení cenových indexů s cachováním
     */
    setPriceIndexes(hoursToday, lowIndexHours, highIndexHours) {
        try {
            // Validace vstupních dat
            if (!this.validatePriceData(hoursToday)) {
                const chyba = new Error('Neplatná vstupní data pro výpočet indexů');
                if (this.logger) {
                    this.logger.error('Chyba při nastavování cenových indexů:', chyba);
                }
                throw chyba;
            }
    
            // Cache kontrola pro vypočítané hodnoty
            const cacheKey = `${hoursToday.map(h => h.priceCZK).join('-')}-${lowIndexHours}-${highIndexHours}`;
    
            if (this.priceCache.has(cacheKey)) {
                const cachedData = this.priceCache.get(cacheKey);
                if (Date.now() - cachedData.timestamp < this.PRICE_CACHE_TTL) {
                    if (this.logger) {
                        this.logger.debug('Použití dat z cenové cache', { 
                            cacheKey,
                            cachedStats: {
                                low: cachedData.data.filter(h => h.level === 'low').length,
                                medium: cachedData.data.filter(h => h.level === 'medium').length,
                                high: cachedData.data.filter(h => h.level === 'high').length
                            }
                        });
                    }
                    return cachedData.data;
                }
            }
    
            // Výpočet hodnot
            if (this.logger) {
                this.logger.debug('Začátek výpočtu cenových indexů', {
                    požadovanéIndexy: {
                        low: lowIndexHours,
                        high: highIndexHours,
                        medium: 24 - lowIndexHours - highIndexHours
                    },
                    počet_hodin: hoursToday.length,
                    vstupníData: {
                        prvníHodina: hoursToday[0],
                        poslednĺHodina: hoursToday[23]
                    }
                });
            }
    
            // Seřazení hodin podle ceny od nejnižší po nejvyšší
            const serazeneCeny = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
    
            if (this.logger) {
                this.logger.debug('Seřazené ceny', {
                    nejnižší3: serazeneCeny.slice(0, 3).map(h => ({
                        hour: h.hour,
                        price: h.priceCZK
                    })),
                    nejvyšší3: serazeneCeny.slice(-3).map(h => ({
                        hour: h.hour,
                        price: h.priceCZK
                    }))
                });
            }
    
            // Vytvoření mapy indexů pro každou hodinu
            const indexMap = new Map();
            
            // Přiřazení "low" indexů pro nejnižší ceny
            const lowPrices = serazeneCeny.slice(0, lowIndexHours);
            lowPrices.forEach(data => {
                indexMap.set(data.hour, 'low');
            });
    
            if (this.logger) {
                this.logger.debug('Přiřazeny LOW indexy', {
                    počet: lowPrices.length,
                    hodiny: lowPrices.map(h => ({
                        hour: h.hour,
                        price: h.priceCZK
                    }))
                });
            }
    
            // Přiřazení "high" indexů pro nejvyšší ceny
            const highPrices = serazeneCeny.slice(-highIndexHours);
            highPrices.forEach(data => {
                indexMap.set(data.hour, 'high');
            });
    
            if (this.logger) {
                this.logger.debug('Přiřazeny HIGH indexy', {
                    počet: highPrices.length,
                    hodiny: highPrices.map(h => ({
                        hour: h.hour,
                        price: h.priceCZK
                    }))
                });
            }
    
            // Přiřazení "medium" indexů pro zbytek
            const vysledek = hoursToday.map(hodinoveData => {
                let level = indexMap.get(hodinoveData.hour);
                if (!level) {
                    level = 'medium';
                }
                return { ...hodinoveData, level };
            });
    
            // Uložení do cache
            this.priceCache.set(cacheKey, {
                data: vysledek,
                timestamp: Date.now()
            });
    
            return vysledek;
    
        } catch (chyba) {
            if (this.logger) {
                this.logger.error('Chyba při nastavování cenových indexů:', chyba);
            }
            // V případě chyby vrátíme data s 'unknown' hodnotou
            return hoursToday.map(hodinoveData => ({ 
                ...hodinoveData, 
                level: 'unknown'
            }));
        }
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

    isCacheValid(timestamp) {
        return Date.now() - timestamp < this.AVERAGE_CACHE_TTL;
    }

    updateAveragePricesCache(combinations, hours, startFromHour, device) {
        const currentHour = new Date().getHours();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${device.getPriceInKWh()}`;
        
        this.averagePriceCache.set(cacheKey, {
            data: combinations,
            timestamp: Date.now()
        });
        this.lastCalculationHour = currentHour;
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
        const currentHour = new Date().getHours();
        const cacheKey = `${hours}-${startFromHour}-${currentHour}-${device.getPriceInKWh()}`;

        if (this.averagePriceCache.has(cacheKey) && this.lastCalculationHour === currentHour) {
            const cachedData = this.averagePriceCache.get(cacheKey);
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
        const cacheKey = `remaining-${hours}-${currentHour}-${device.getPriceInKWh()}`;

        if (this.averagePriceCache.has(cacheKey) && this.lastCalculationHour === currentHour) {
            const cachedData = this.averagePriceCache.get(cacheKey);
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
        const cacheKey = `remaining-${hours}-${currentHour}-${device.getPriceInKWh()}`;
        this.averagePriceCache.set(cacheKey, {
            data: combinations,
            timestamp: Date.now()
        });
        this.lastCalculationHour = currentHour;
    }

    clearCache() {
        const beforeSize = {
            priceCache: this.priceCache.size,
            averageCache: this.averagePriceCache.size
        };

        this.priceCache.clear();
        this.averagePriceCache.clear();
        this.lastCalculationHour = null;

        if (this.logger) {
            this.logger.debug('Cache vyčištěna', {
                before: beforeSize,
                after: {
                    priceCache: 0,
                    averageCache: 0
                }
            });
        }
    }

    calculateMinMaxPrices(prices) {
        try {
            if (!Array.isArray(prices) || prices.length === 0) {
                throw new Error('Neplatná data pro výpočet min/max cen');
            }

            const priceValues = prices.map(p => p.priceCZK);
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);

            if (this.logger) {
                this.logger.debug('Min/max ceny vypočteny', {
                    min: minPrice,
                    max: maxPrice,
                    počet_cen: prices.length
                });
            }

            return { minPrice, maxPrice };
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při výpočtu min/max cen', error);
            }
            throw error;
        }
    }

    getNextHourPrice(prices, currentHour) {
        try {
            if (!Array.isArray(prices) || prices.length === 0) {
                throw new Error('Neplatná data pro výpočet next hour price');
            }

            if (currentHour < 0 || currentHour >= 24) {
                throw new Error('Neplatná hodina pro výpočet next hour price');
            }

            const nextHourPrice = currentHour === 23 ? 
                prices[currentHour].priceCZK : 
                prices[currentHour + 1].priceCZK;

            if (this.logger) {
                this.logger.debug('Next hour price vypočtena', {
                    currentHour,
                    nextHourPrice,
                    is23Hour: currentHour === 23
                });
            }

            return nextHourPrice;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při výpočtu next hour price', error);
            }
            throw error;
        }
    }

    convertPrice(price, priceInKWh) {
        try {
            if (!priceInKWh) {
                return price;
            }
    
            if (typeof price !== 'number' || isNaN(price)) {
                const error = new Error('Neplatná cena pro konverzi');
                if (this.logger) {
                    this.logger.error('Chyba při konverzi ceny', error, { price });
                }
                throw error;
            }
    
            const result = price / 1000;
            
            if (this.logger) {
                this.logger.debug('Konverze ceny', {
                    vstupní: price,
                    výsledek: result,
                    kWh: true
                });
            }
    
            return result;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při konverzi ceny', error, {
                    price,
                    priceInKWh
                });
            }
            return price;
        }
    }
}

module.exports = PriceCalculator;
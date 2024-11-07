'use strict';

class PriceCalculator {
    constructor(homey) {
        this.homey = homey;
        this.priceCache = new Map();
        this.averagePriceCache = new Map();
        this.lastCalculationHour = null;
        
        // Konstanty pro cache
        this.PRICE_CACHE_TTL = 60 * 60 * 1000; // 1 hodina
        this.AVERAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minut
        
        // Nastavení automatického čištění cache
        this.setupCacheCleanup();
    }

    /**
     * Nastavení automatického čištění cache
     * @private
     */
    setupCacheCleanup() {
        this.homey.setInterval(() => {
            this.cleanupCache();
        }, this.PRICE_CACHE_TTL);
    }

    /**
     * Vyčištění starých záznamů z cache
     * @private
     */
    cleanupCache() {
        const now = Date.now();
        
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

        this.homey.log('Cache vyčištěna', {
            priceCacheSize: this.priceCache.size,
            averageCacheSize: this.averagePriceCache.size
        });
    }

    /**
     * Validace vstupních dat pro výpočet ceny
     */
    validatePriceData(data) {
        if (!Array.isArray(data)) {
            this.homey.error('Neplatná data - není pole');
            return false;
        }

        if (data.length !== 24) {
            this.homey.error('Neplatná data - nesprávný počet hodin');
            return false;
        }

        return data.every(item => {
            const hasValidPrice = typeof item.priceCZK === 'number' && !isNaN(item.priceCZK);
            const hasValidHour = typeof item.hour === 'number' && item.hour >= 0 && item.hour < 24;
            
            if (!hasValidPrice || !hasValidHour) {
                this.homey.log('Neplatná data pro hodinu', item);
            }
            
            return hasValidPrice && hasValidHour;
        });
    }

    /**
     * Přidání distribučního tarifu k základní ceně
     */
    addDistributionPrice(basePrice, settings, hour) {
        try {
            if (typeof basePrice !== 'number' || isNaN(basePrice)) {
                throw new Error('Neplatná základní cena');
            }

            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;
            const isLowTariff = this.isLowTariff(hour, settings);

            const finalPrice = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
            
            this.homey.log('Výpočet distribuční ceny:', {
                hour,
                basePrice,
                isLowTariff,
                tariffPrice: isLowTariff ? lowTariffPrice : highTariffPrice,
                finalPrice
            });

            return finalPrice;
        } catch (error) {
            this.homey.error('Chyba při výpočtu distribuční ceny:', error);
            return basePrice;
        }
    }

    /**
     * Kontrola nízkého tarifu pro danou hodinu
     */
    isLowTariff(hour, settings) {
        try {
            if (hour < 0 || hour >= 24) {
                throw new Error('Neplatná hodina');
            }

            const tariffHours = this.getTariffHours(settings);
            return tariffHours.includes(hour);
        } catch (error) {
            this.homey.error('Chyba při kontrole nízkého tarifu:', error);
            return false;
        }
    }

    /**
     * Získání hodin s nízkým tarifem
     */
    getTariffHours(settings) {
        try {
            return Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);
        } catch (error) {
            this.homey.error('Chyba při získávání hodin tarifu:', error);
            return [];
        }
    }

    /**
     * Nastavení cenových indexů s cachováním
     */
    setPriceIndexes(hoursToday, lowIndexHours, highIndexHours) {
        try {
            if (!this.validatePriceData(hoursToday)) {
                throw new Error('Neplatná vstupní data pro výpočet indexů');
            }

            const cacheKey = `${hoursToday.map(h => h.priceCZK).join('-')}-${lowIndexHours}-${highIndexHours}`;
            
            if (this.priceCache.has(cacheKey)) {
                const cachedData = this.priceCache.get(cacheKey);
                if (Date.now() - cachedData.timestamp < this.PRICE_CACHE_TTL) {
                    return cachedData.data;
                }
            }

            const sortedPrices = [...hoursToday]
                .sort((a, b) => a.priceCZK - b.priceCZK)
                .map((price, index) => ({
                    ...price,
                    sortedIndex: index
                }));

            const totalHours = sortedPrices.length;
            const result = sortedPrices.map(hourData => {
                let level;
                if (hourData.sortedIndex < lowIndexHours) {
                    level = 'low';
                } else if (hourData.sortedIndex >= totalHours - highIndexHours) {
                    level = 'high';
                } else {
                    level = 'medium';
                }
                return { ...hourData, level };
            }).sort((a, b) => a.hour - b.hour);

            this.priceCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            return result;
        } catch (error) {
            this.homey.error('Chyba při nastavování cenových indexů:', error);
            return hoursToday.map(hourData => ({ ...hourData, level: 'unknown' }));
        }
    }

    /**
     * Výpočet průměrných cen s cachováním
     */
    async calculateAveragePrices(device, hours, startFromHour = 0) {
        try {
            const currentHour = new Date().getHours();
            const cacheKey = `${hours}-${startFromHour}-${currentHour}`;

            if (this.averagePriceCache.has(cacheKey) && 
                this.lastCalculationHour === currentHour) {
                const cachedData = this.averagePriceCache.get(cacheKey);
                if (Date.now() - cachedData.timestamp < this.AVERAGE_CACHE_TTL) {
                    return cachedData.data;
                }
            }

            const allCombinations = [];
            
            for (let startHour = startFromHour; startHour <= 24 - hours; startHour++) {
                let total = 0;
                let validPrices = true;
                const prices = [];

                for (let i = startHour; i < startHour + hours; i++) {
                    const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
                    if (price === null || price === undefined) {
                        validPrices = false;
                        break;
                    }
                    prices.push(price);
                    total += price;
                }

                if (validPrices) {
                    allCombinations.push({
                        startHour,
                        avg: total / hours,
                        prices
                    });
                }
            }

            this.averagePriceCache.set(cacheKey, {
                data: allCombinations,
                timestamp: Date.now()
            });
            this.lastCalculationHour = currentHour;

            return allCombinations;
        } catch (error) {
            this.homey.error('Chyba při výpočtu průměrných cen:', error);
            return [];
        }
    }

    /**
     * Vyčištění všech cache
     */
    clearCache() {
        this.priceCache.clear();
        this.averagePriceCache.clear();
        this.lastCalculationHour = null;
        this.homey.log('Cache vyčištěna');
    }

    /**
 * Konverze ceny mezi MWh a kWh
 * @param {number} price - Cena k převodu
 * @param {boolean} priceInKWh - Převést na kWh?
 * @returns {number} - Převedená cena
 */
    convertPrice(price, priceInKWh) {
        try {
            if (typeof price !== 'number' || isNaN(price)) {
                throw new Error('Neplatná cena pro konverzi');
            }
    
            // Kontrola že priceInKWh je skutečně boolean
            const shouldConvert = Boolean(priceInKWh);
            const result = shouldConvert ? price / 1000 : price;
            
            this.homey.log('Konverze ceny:', {
                vstupní: price,
                výsledek: result,
                kWh: shouldConvert,
                requestedConversion: priceInKWh  // přidáme pro debug
            });
    
            return result;
        } catch (error) {
            this.homey.error('Chyba při konverzi ceny:', error);
            return price;  
        }
    }
}

module.exports = PriceCalculator;
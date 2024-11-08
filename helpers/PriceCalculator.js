'use strict';

const Logger = require('./Logger');

class PriceCalculator {
    constructor(homey, deviceContext = 'PriceCalculator') {
        this.homey = homey;
        this.homey = homey;
        this.logger = new Logger(this.homey, deviceContext);
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

    // Přidáme metody pro práci s loggerem
    setLogger(logger) {
        this.logger = logger;
        if (this.logger) {
            this.logger.debug('PriceCalculator: Logger inicializován');
        }
    }

    getLogger() {
        return this.logger;
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
    
            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;
            const isLowTariff = this.isLowTariff(hour, settings);
    
            const finalPrice = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
    
            if (this.logger) {
                this.logger.debug(`Výpočet distribuční ceny: hour: ${hour}, basePrice: ${basePrice}, tariffPrice: ${isLowTariff ? lowTariffPrice : highTariffPrice}, finalPrice: ${finalPrice}`);
            }
    
            return finalPrice;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při výpočtu distribuční ceny:', error, { basePrice, settings, hour });
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
    
            // Pokud všechna data již obsahují level, použijeme ho přímo
            const allHaveLevel = hoursToday.every(hour => hour.level && typeof hour.level === 'string');
            if (allHaveLevel) {
                if (this.logger) {
                    this.logger.debug('Použití existujících level hodnot z API', {
                        sample: hoursToday[0]
                    });
                }
    
                return hoursToday;
            }
    
            // Cache kontrola pro vypočítané hodnoty
            const cacheKey = `${hoursToday.map(h => h.priceCZK).join('-')}-${lowIndexHours}-${highIndexHours}`;
    
            if (this.priceCache.has(cacheKey)) {
                const cachedData = this.priceCache.get(cacheKey);
                if (Date.now() - cachedData.timestamp < this.PRICE_CACHE_TTL) {
                    if (this.logger) {
                        this.logger.debug('Použití dat z cenové cache', { cacheKey });
                    }
                    return cachedData.data;
                }
            }
    
            // Výpočet hodnot pokud nejsou v API ani v cache
            if (this.logger) {
                this.logger.debug('Výpočet nových cenových indexů', {
                    lowIndexHours,
                    highIndexHours,
                    totalHours: hoursToday.length
                });
            }
    
            const serazeneVP = [...hoursToday]
                .sort((a, b) => a.priceCZK - b.priceCZK)
                .map((cena, index) => ({
                    ...cena,
                    serazenyIndex: index
                }));
    
            const celkovePocetHodin = serazeneVP.length;
            const vysledek = serazeneVP.map(hodinoveData => {
                let level;
                if (hodinoveData.serazenyIndex < lowIndexHours) {
                    level = 'low';
                } else if (hodinoveData.serazenyIndex >= celkovePocetHodin - highIndexHours) {
                    level = 'high';
                } else {
                    level = 'medium';
                }
                return { ...hodinoveData, level };
            }).sort((a, b) => a.hour - b.hour);
    
            // Uložení do cache
            this.priceCache.set(cacheKey, {
                data: vysledek,
                timestamp: Date.now()
            });
    
            if (this.logger) {
                this.logger.debug('Nastavení cenových indexů dokončeno', {
                    cacheKey,
                    sampleData: vysledek[0],
                    totalProcessed: vysledek.length
                });
            }
    
            return vysledek;
    
        } catch (chyba) {
            if (this.logger) {
                this.logger.error('Chyba při nastavování cenových indexů:', chyba, {
                    inputLength: hoursToday?.length,
                    firstItem: hoursToday?.[0]
                });
            }
            // V případě chyby vrátíme data s 'unknown' hodnotou
            return hoursToday.map(hodinoveData => ({ 
                ...hodinoveData, 
                level: 'unknown'
            }));
        }
    }

    /**
     * Výpočet průměrných cen s cachováním
     */
    async calculateAveragePrices(device, hours, startFromHour = 0) {
        try {
            const aktualniHodina = new Date().getHours();
            const cacheKey = `${hours}-${startFromHour}-${aktualniHodina}`;
    
            if (this.averagePriceCache.has(cacheKey) && 
                this.lastCalculationHour === aktualniHodina) {
                const cachedData = this.averagePriceCache.get(cacheKey);
                if (Date.now() - cachedData.timestamp < this.AVERAGE_CACHE_TTL) {
                    if (this.logger) {
                        this.logger.debug('Použití dat z průměrné cache', { cacheKey });
                    }
                    return cachedData.data;
                }
            }
    
            const vsechnyKombinace = [];
            
            for (let startHodina = startFromHour; startHodina <= 24 - hours; startHodina++) {
                let celkem = 0;
                let platneVP = true;
                const ceny = [];
    
                for (let i = startHodina; i < startHodina + hours; i++) {
                    const cena = await device.getCapabilityValue(`hour_price_CZK_${i}`);
                    if (cena === null || cena === undefined) {
                        platneVP = false;
                        break;
                    }
                    ceny.push(cena);
                    celkem += cena;
                }
    
                if (platneVP) {
                    vsechnyKombinace.push({
                        startHodina,
                        prumer: celkem / hours,
                        ceny
                    });
                }
            }
    
            this.averagePriceCache.set(cacheKey, {
                data: vsechnyKombinace,
                timestamp: Date.now()
            });
            this.lastCalculationHour = aktualniHodina;
    
            if (this.logger) {
                this.logger.debug('Výpočet průměrných cen', { cacheKey, vsechnyKombinace });
            }
    
            return vsechnyKombinace;
        } catch (chyba) {
            if (this.logger) {
                this.logger.error('Chyba při výpočtu průměrných cen:', chyba);
            }
            return [];
        }
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
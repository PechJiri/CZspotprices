'use strict';

const Logger = require('./Logger');

class DataValidator {
    static instance = null;
    static homeyInstance = null;
    static CONTEXT = 'DataValidator';

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro DataValidator');
        }
        DataValidator.homeyInstance = homey;
    }

    constructor(homeyInstance) {
        if (DataValidator.instance) {
            throw new Error('Použijte DataValidator.getInstance() místo volání new.');
        }
        
        const instanceToUse = homeyInstance || DataValidator.homeyInstance;
        
        if (!instanceToUse) {
            throw new Error('HomeyInstance musí být poskytnut');
        }

        this.logger = Logger.getInstance()
        this.homey = instanceToUse;
    }

    static getInstance(homeyInstance) {
        if (!DataValidator.instance) {
            DataValidator.instance = new DataValidator(homeyInstance);
        }
        return DataValidator.instance;
    }

    /**
     * Univerzální validace číselných hodnot
     * @param {number} price - Cena k validaci
     * @param {string} context - Kontext pro chybovou hlášku
     * @returns {boolean} - True pokud je cena platná
     */
    validatePrice(price, context = 'cena') {
        if (typeof price !== 'number' || isNaN(price) || price < 0) {
            this.logger?.error(`Neplatná ${context}`, {
                value: price,
                type: typeof price
            });
            return false;
        }
        return true;
    }

    /**
     * Validace cenových dat
     */
    validatePriceData(data) {
        try {
            if (!Array.isArray(data)) {
                if (this.logger) {
                    this.logger.debug('Vstupní data pro validaci', { 
                        receivedType: typeof data,
                        receivedValue: data,
                        stack: new Error().stack
                    });
                    
                    this.logger.error('Neplatná data - není pole', new Error('Invalid data type'));
                }
                return false;
            }
    
            if (data.length !== 24) {
                if (this.logger) {
                    this.logger.error('Neplatná data - nesprávný počet hodin', new Error('Invalid data length'), {
                        expectedLength: 24,
                        actualLength: data.length,
                        data: data.map(item => item ? {
                            hour: item.hour || null,
                            hasPrice: 'priceCZK' in item
                        } : {
                            hour: null,
                            hasPrice: false
                        })
                    });
                }
                return false;
            }
    
            const validationResults = data.map((item, index) => {
                const hasValidPrice = this.validatePrice(item.priceCZK, `cena pro hodinu ${index}`);
                const hasValidHour = typeof item.hour === 'number' && item.hour >= 0 && item.hour < 24;
                
                if (!hasValidPrice || !hasValidHour) {
                    if (this.logger) {
                        this.logger.debug('Neplatná data pro hodinu', {
                            index,
                            item,
                            validations: {
                                price: {
                                    isValid: hasValidPrice,
                                    value: item.priceCZK,
                                    type: typeof item.priceCZK
                                },
                                hour: {
                                    isValid: hasValidHour,
                                    value: item.hour,
                                    type: typeof item.hour
                                }
                            },
                            hasLevel: Boolean(item.level)
                        });
                    }
                }
    
                return hasValidPrice && hasValidHour;
            });
    
            const isValid = validationResults.every(result => result);
            
            if (this.logger) {
                this.logger.debug('Validace dat dokončena', {
                    isValid,
                    summary: {
                        totalRecords: data.length,
                        validRecords: validationResults.filter(Boolean).length,
                        hasLevels: data.every(item => Boolean(item.level))
                    },
                    invalidHours: validationResults
                        .map((result, index) => ({ index, valid: result }))
                        .filter(item => !item.valid)
                        .map(item => ({
                            hour: data[item.index].hour,
                            issues: {
                                hasPrice: typeof data[item.index].priceCZK === 'number',
                                validHour: typeof data[item.index].hour === 'number' && 
                                         data[item.index].hour >= 0 && 
                                         data[item.index].hour < 24
                            }
                        }))
                });
            }
    
            return isValid;
    
        } catch (error) {
            if (this.logger) {
                this.logger.error('Neočekávaná chyba při validaci dat', error, {
                    dataLength: data?.length,
                    stack: error.stack
                });
            }
            return false;
        }
    }

    /**
     * Validace vstupních dat pro výpočet cenových indexů
     */
    validatePriceIndexData(data, lowIndexHours, highIndexHours) {
        try {
            const errors = [];
            
            if (!this.validatePriceData(data)) {
                errors.push('Neplatná cenová data');
                return { isValid: false, errors };
            }

            if (!this.validateIndexHours(lowIndexHours, highIndexHours)) {
                errors.push('Neplatný počet hodin pro indexy');
                return { isValid: false, errors };
            }

            if (!this.validateUniqueHours(data)) {
                errors.push('Duplicitní hodiny v datech');
                return { isValid: false, errors };
            }

            return { isValid: true, errors };
        } catch (error) {
            this.logger?.error('Chyba při validaci dat pro cenové indexy', error);
            return { isValid: false, errors: [error.message] };
        }
    }

    /**
     * Validace počtu hodin pro indexy
     */
    validateIndexHours(lowIndexHours, highIndexHours) {
        try {
            if (typeof lowIndexHours !== 'number' || typeof highIndexHours !== 'number') {
                this.logger?.error('Neplatný typ pro počet hodin', {
                    lowIndexHours: typeof lowIndexHours,
                    highIndexHours: typeof highIndexHours
                });
                return false;
            }

            if (lowIndexHours < 0 || highIndexHours < 0) {
                this.logger?.error('Záporný počet hodin není povolen', {
                    lowIndexHours,
                    highIndexHours
                });
                return false;
            }

            if ((lowIndexHours + highIndexHours) > 24) {
                this.logger?.error('Součet hodin přesahuje 24', {
                    lowIndexHours,
                    highIndexHours,
                    sum: lowIndexHours + highIndexHours
                });
                return false;
            }

            return true;
        } catch (error) {
            this.logger?.error('Chyba při validaci počtu hodin', error);
            return false;
        }
    }

    /**
     * Validace unikátnosti hodin
     */
    validateUniqueHours(data) {
        try {
            const hours = data.map(item => item.hour);
            const uniqueHours = new Set(hours);

            if (hours.length !== uniqueHours.size) {
                this.logger?.error('Nalezeny duplicitní hodiny', {
                    allHours: hours,
                    uniqueHours: Array.from(uniqueHours)
                });
                return false;
            }

            return true;
        } catch (error) {
            this.logger?.error('Chyba při validaci unikátnosti hodin', error);
            return false;
        }
    }

    /**
     * Validace existence ceny pro konkrétní hodinu
     */
    validateHourlyPrice(data, hour) {
        try {
            if (!Array.isArray(data)) {
                this.logger?.error('Data nejsou pole nebo jsou neplatná', {
                    receivedType: typeof data,
                    data: data || null
                });
                return { isValid: false, price: null };
            }
    
            const priceData = data.find(d => d?.hour === hour);
    
            if (!priceData || priceData.priceCZK === undefined) {
                this.logger?.error('Základní cena pro danou hodinu nenalezena', { 
                    hour,
                    dataLength: data.length,
                    foundData: priceData || null
                });
                return { isValid: false, price: null };
            }
    
            if (!this.validatePrice(priceData.priceCZK, 'hodinová cena')) {
                return { isValid: false, price: null };
            }
    
            return { isValid: true, price: priceData.priceCZK };
            
        } catch (error) {
            this.logger?.error('Chyba při validaci hodinové ceny', error, {
                hour,
                dataLength: data?.length || 0
            });
            return { isValid: false, price: null };
        }
    }

    /**
     * Validace nastavení tarifu
     */
    validateTariffSettings(settings) {
        if (!settings || typeof settings !== 'object') {
            this.logger?.debug('Chybí nastavení nebo není objekt', {
                type: typeof settings
            });
            return false;
        }

        for (let i = 0; i < 24; i++) {
            const key = `hour_${i}`;
            if (!(key in settings)) {
                this.logger?.debug(`Chybí nastavení pro hodinu ${i}`);
                return false;
            }
            if (typeof settings[key] !== 'boolean') {
                this.logger?.debug(`Neplatný typ hodnoty pro hodinu ${i}`, {
                    hour: i,
                    type: typeof settings[key]
                });
                return false;
            }
        }

        return true;
    }

    /**
     * Validace hodiny pro tarif
     */
    validateTariffHour(hour) {
        try {
            if (typeof hour !== 'number') {
                this.logger?.debug('Neplatný typ hodiny', {
                    hour,
                    type: typeof hour
                });
                return false;
            }

            if (isNaN(hour)) {
                this.logger?.debug('Hodina je NaN');
                return false;
            }

            // Speciální případ - hodina 24 se považuje za 0
            if (hour === 24) {
                return true;
            }

            return hour >= 0 && hour < 24;
        } catch (error) {
            this.logger?.error('Chyba při validaci hodiny pro tarif', error);
            return false;
        }
    }

    validateBackupDataStructure(data) {
        return data?.data?.dataLine?.some(line => 
            line.title === "Cena (EUR/MWh)" && 
            Array.isArray(line.point) && 
            line.point.length >= 24
        );
    }

    validateBackupApiResponse(data) {
        return Boolean(
            data?.data?.dataLine &&
            Array.isArray(data.data.dataLine)
        );
    }
    
    validatePriceLine(line) {
        return Boolean(
            line &&
            Array.isArray(line.point) &&
            line.point.length >= 24 &&
            line.point.every(p => 
                p.x && 
                p.y && 
                !isNaN(parseFloat(p.y))
            )
        );
    }

    validateAndPreparePrices(processedPrices) {
        if (!this.dataValidator.validatePriceData(processedPrices)) {
            throw new Error('Neplatná vstupní data pro updateAllPrices');
        }
    
        const settings = this.getSettings();
        const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
            processedPrices,
            settings.low_index_hours || 8,
            settings.high_index_hours || 8
        );
    
        return pricesWithIndexes;
    }
}

module.exports = DataValidator;
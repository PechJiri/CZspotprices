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

    //hlavní metody
    validateValue(value, type, minValue = null, maxValue = null, context = '') {
        const isValidType = typeof value === type;
        const isInRange = minValue === null || (value >= minValue && (maxValue === null || value <= maxValue));
    
        if (!isValidType || !isInRange) {
            this.logger?.error(`Neplatná hodnota ${context}`, {
                value,
                type: typeof value,
                expectedType: type,
                minValue,
                maxValue
            });
            return false;
        }
        return true;
    }

    validateArray(array, length, context = '') {
        if (!Array.isArray(array) || array.length !== length) {
            this.logger?.error(`Neplatné ${context}`, {
                receivedType: typeof array,
                expectedLength: length,
                actualLength: array?.length || 0
            });
            return false;
        }
        return true;
    }

    validatePriceItem(item) {
        return (
            this.validatePrice(item.priceCZK, `cena pro hodinu ${item.hour}`) &&
            this.validateValue(item.hour, 'number', 0, 23, 'hodina')
        );
    }    

    //původní metody
    validatePrice(price, context = 'cena') {
        return this.validateValue(price, 'number', 0, null, context);
    }
    

    /**
     * Validace cenových dat
     */
    validatePriceData(data) {
        if (!this.validateArray(data, 24, 'cenová data')) return false;
    
        return data.every(item => this.validatePriceItem(item));
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
        if (
            !this.validateValue(lowIndexHours, 'number', 0, 24, 'lowIndexHours') ||
            !this.validateValue(highIndexHours, 'number', 0, 24, 'highIndexHours')
        ) {
            return false;
        }
    
        if (lowIndexHours + highIndexHours > 24) {
            this.logger?.error('Součet hodin přesahuje 24', {
                lowIndexHours,
                highIndexHours,
                sum: lowIndexHours + highIndexHours
            });
            return false;
        }
    
        return true;
    }
    

    /**
     * Validace unikátnosti hodin
     */
    validateUniqueHours(data) {
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
    }
    

    /**
     * Validace existence ceny pro konkrétní hodinu
     */
    validateHourlyPrice(data, hour) {
        if (!this.validateArray(data, null, 'cenová data')) return { isValid: false, price: null };
    
        const priceData = data.find(d => d?.hour === hour);
    
        if (!priceData || priceData.priceCZK === undefined) {
            this.logger?.error('Základní cena pro danou hodinu nenalezena', { hour });
            return { isValid: false, price: null };
        }
    
        if (!this.validatePrice(priceData.priceCZK, 'hodinová cena')) {
            return { isValid: false, price: null };
        }
    
        return { isValid: true, price: priceData.priceCZK };
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

    validateDeviceState(device) {
        try {
            if (!device || !device.updateAllPrices) {
                this.logger?.error('Neplatné zařízení pro update', {
                    exists: !!device,
                    hasUpdateMethod: !!device?.updateAllPrices
                });
                return false;
            }
        
            if (!device.isInitialized) {
                this.logger?.warn('Zařízení není plně inicializováno', {
                    deviceId: device.getData()?.id
                });
                return false;
            }
        
            if (!device.priceCalculator || !device.spotPriceApi) {
                this.logger?.error('Chybí required dependencies', {
                    deviceId: device.getData()?.id,
                    hasPriceCalculator: !!device.priceCalculator,
                    hasSpotPriceApi: !!device.spotPriceApi
                });
                return false;
            }
        
            return true;
        } catch (error) {
            this.logger?.error('Chyba při validaci stavu zařízení', error);
            return false;
        }
    }
}

module.exports = DataValidator;
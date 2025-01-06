'use strict';

const Logger = require('./Logger');

class DataValidator {
    static instance = null;
    static homeyInstance = null; // Přidán statický homeyInstance
    static CONTEXT = 'DataValidator';

    // Metoda pro nastaveníHomeyInstance
    static setHomeyInstance(homey) {
        DataValidator.homeyInstance = homey;
    }

    constructor(homeyInstance) {
        if (DataValidator.instance) {
            throw new Error('Použijte DataValidator.getInstance() místo volání new.');
        }
        
        // Použij předaný homeyInstance nebo statický homeyInstance
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
     * Validace cenových dat
     * @param {Array} data - Pole obsahující data o cenách
     * @returns {boolean} - True, pokud jsou data platná
     */
    validatePriceData(data) {
        try {
            // Základní kontrola, zda data existují a jsou pole
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
    
            // Kontrola délky pole (24 hodin)
            if (data.length !== 24) {
                if (this.logger) {
                    this.logger.error('Neplatná data - nesprávný počet hodin', new Error('Invalid data length'), {
                        expectedLength: 24,
                        actualLength: data.length,
                        data: data.map(item => item ? { // Ověří, zda item existuje
                            hour: item.hour || null, // Bezpečný přístup k item.hour
                            hasPrice: 'priceCZK' in item // Kontrola existence vlastnosti priceCZK
                        } : {
                            hour: null, // Pokud item neexistuje, nastaví výchozí hodnoty
                            hasPrice: false
                        })
                    });
                }
                return false;
            }
    
            // Validace jednotlivých hodinových záznamů
            const validationResults = data.map((item, index) => {
                // Kontrola povinných vlastností
                const hasValidPrice = typeof item.priceCZK === 'number' && !isNaN(item.priceCZK);
                const hasValidHour = typeof item.hour === 'number' && item.hour >= 0 && item.hour < 24;
                
                // Level je volitelná vlastnost - přijde jen z primárního API
                // Pokud není, dopočítá se později v setPriceIndexes
                
                // Detailní logování při nevalidních datech
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
                            hasLevel: Boolean(item.level) // jen pro logging
                        });
                    }
                }
    
                // Kontrola rozsahu ceny (nemůže být záporná)
                if (hasValidPrice && item.priceCZK < 0) {
                    if (this.logger) {
                        this.logger.error('Záporná cena není povolena', {
                            hour: item.hour,
                            price: item.priceCZK
                        });
                    }
                    return false;
                }
                
                return hasValidPrice && hasValidHour;
            });
    
            // Vyhodnocení celkové validace
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
     * @param {Array} data - Cenová data
     * @param {number} lowIndexHours - Počet hodin pro nízký index
     * @param {number} highIndexHours - Počet hodin pro vysoký index
     * @returns {Object} - Výsledek validace {isValid, errors}
     */
    validatePriceIndexData(data, lowIndexHours, highIndexHours) {
        try {
            const errors = [];
            
            // 1. Základní validace dat
            if (!this.validatePriceData(data)) {
                errors.push('Neplatná cenová data');
                return { isValid: false, errors };
            }

            // 2. Validace počtu hodin pro indexy
            if (!this.validateIndexHours(lowIndexHours, highIndexHours)) {
                errors.push('Neplatný počet hodin pro indexy');
                return { isValid: false, errors };
            }

            // 3. Validace unikátnosti hodin
            if (!this.validateUniqueHours(data)) {
                errors.push('Duplicitní hodiny v datech');
                return { isValid: false, errors };
            }

            // 4. Validace cenových hodnot
            if (!this.validatePriceValues(data)) {
                errors.push('Neplatné cenové hodnoty');
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
            // Kontrola, zda jsou hodnoty čísla
            if (typeof lowIndexHours !== 'number' || typeof highIndexHours !== 'number') {
                this.logger?.error('Neplatný typ pro počet hodin', {
                    lowIndexHours: typeof lowIndexHours,
                    highIndexHours: typeof highIndexHours
                });
                return false;
            }

            // Kontrola rozsahu
            if (lowIndexHours < 0 || highIndexHours < 0) {
                this.logger?.error('Záporný počet hodin není povolen', {
                    lowIndexHours,
                    highIndexHours
                });
                return false;
            }

            // Kontrola součtu hodin
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
     * Validace cenových hodnot
     */
    validatePriceValues(data) {
        try {
            return data.every((item, index) => {
                const isValid = typeof item.priceCZK === 'number' && 
                              !isNaN(item.priceCZK) && 
                              item.priceCZK >= 0;

                if (!isValid) {
                    this.logger?.error('Neplatná cenová hodnota', {
                        index,
                        hour: item.hour,
                        price: item.priceCZK
                    });
                }

                return isValid;
            });
        } catch (error) {
            this.logger?.error('Chyba při validaci cenových hodnot', error);
            return false;
        }
    }

    /**
     * Validace existence ceny pro konkrétní hodinu
     * @param {Array} data - Cenová data
     * @param {number} hour - Hodina pro kontrolu
     * @returns {Object} - Výsledek validace {isValid: boolean, price: number|null}
     */
    validateHourlyPrice(data, hour) {
        try {
            // Zajištění, že data jsou platná
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
    
            // Validace hodnoty ceny
            if (!this.validatePriceForVAT(priceData.priceCZK)) {
                this.logger?.error('Cena není platná pro výpočet DPH', {
                    hour: priceData.hour,
                    price: priceData.priceCZK
                });
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
     * Validace ceny pro výpočet DPH
     */
    validatePriceForVAT(price) {
        if (typeof price !== 'number' || isNaN(price)) {
            this.logger?.error('Neplatná cena pro výpočet DPH', {
                price,
                type: typeof price
            });
            return false;
        }
        return true;
    }

    /**
     * Validace základní ceny pro distribuční výpočet
     */
    validateBasePrice(basePrice) {
        if (typeof basePrice !== 'number' || isNaN(basePrice)) {
            this.logger?.error('Neplatná základní cena pro distribuční výpočet', {
                basePrice,
                type: typeof basePrice
            });
            return false;
        }
        return true;
    }

    /**
     * Validace hodin pro next hour price
     */
    validateHourRange(hour) {
        if (hour < 0 || hour >= 24) {
            this.logger?.error('Neplatný rozsah hodin', {
                hour,
                validRange: '0-23'
            });
            return false;
        }
        return true;
    }

    /**
     * Validace ceny pro konverzi
     */
    validatePriceForConversion(price) {
        if (typeof price !== 'number' || isNaN(price)) {
            this.logger?.error('Neplatná cena pro konverzi', {
                price,
                type: typeof price
            });
            return false;
        }
        return true;
    }

    /**
     * Validace pole cen pro min/max výpočet
     */
    validatePriceArray(prices) {
        if (!Array.isArray(prices) || prices.length === 0) {
            this.logger?.error('Neplatná data pro výpočet min/max cen', {
                type: typeof prices,
                length: prices?.length || 0
            });
            return false;
        }
        return true;
    }

    /**
     * Validace nastavení tarifu
     * @param {Object} settings - Objekt s nastavením tarifu
     * @returns {boolean} - Zda jsou nastavení platná
     */
    validateTariffSettings(settings) {
        try {
            // Kontrola existence settings
            if (!settings || typeof settings !== 'object') {
                this.logger?.debug('Chybí nastavení nebo není objekt', {
                    type: typeof settings
                });
                return false;
            }

            // Kontrola existence nastavení hodin
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
        } catch (error) {
            this.logger?.error('Chyba při validaci nastavení tarifu', error);
            return false;
        }
    }

    /**
     * Validace hodiny pro tarif
     * @param {number} hour - Hodina ke kontrole
     * @returns {boolean} - Zda je hodina platná
     */
    validateTariffHour(hour) {
        try {
            // Kontrola typu
            if (typeof hour !== 'number') {
                this.logger?.debug('Neplatný typ hodiny', {
                    hour,
                    type: typeof hour
                });
                return false;
            }

            // Kontrola NaN
            if (isNaN(hour)) {
                this.logger?.debug('Hodina je NaN');
                return false;
            }

            // Speciální případ - hodina 24 se považuje za 0
            if (hour === 24) {
                return true;
            }

            // Standardní kontrola rozsahu
            return this.validateHourRange(hour);
        } catch (error) {
            this.logger?.error('Chyba při validaci hodiny pro tarif', error);
            return false;
        }
    }
}

module.exports = DataValidator;

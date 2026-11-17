'use strict';

const Logger = require('./Logger');

/**
 * DataValidator - validace cenových dat (15minutové sloty)
 * 
 * VALIDUJE:
 * - 96 slotů/den (15min intervaly)
 * - Strukturu dat z API
 * - Low/high index nastavení
 * - Tarify (stále hodinové - distribuční tarify jsou vždy po hodinách!)
 * 
 * BATCH REŽIM:
 * - Místo 96× jednotlivých logů → 1× summary log
 * - Tichá validace pro použití v loops
 * - Error-only logging pro normální operace
 * 
 * @class DataValidator
 * @singleton
 */
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

        this.logger = Logger.getInstance();
        this.homey = instanceToUse;
        
        // Konstanty pro validaci
        this.SLOTS_PER_DAY = 96;          // 96 × 15min = 24 hodin
        this.HOURS_PER_DAY = 24;          // Pro tarify (stále hodinové!)
        this.VALID_MINUTES = [0, 15, 30, 45];
        
        this.logger?.debug('DataValidator inicializován', {
            slotsPerDay: this.SLOTS_PER_DAY,
            validMinutes: this.VALID_MINUTES
        });
    }

    static getInstance(homeyInstance) {
        if (!DataValidator.instance) {
            DataValidator.instance = new DataValidator(homeyInstance);
        }
        return DataValidator.instance;
    }

    // ==================== TICHÁ VALIDACE (pro použití v loops) ====================

    /**
     * TICHÁ validace hodnoty - bez logování
     * Pro použití v batch operacích
     * 
     * @param {*} value - hodnota k validaci
     * @param {string} type - očekávaný typ ('number', 'string', 'boolean')
     * @param {number} [minValue] - minimální hodnota (pro čísla)
     * @param {number} [maxValue] - maximální hodnota (pro čísla)
     * @returns {boolean}
     */
    validateValueSilent(value, type, minValue = null, maxValue = null) {
        const isValidType = typeof value === type;
        const isInRange = minValue === null || (value >= minValue && (maxValue === null || value <= maxValue));
        return isValidType && isInRange;
    }

    /**
     * TICHÁ validace ceny - bez logování
     * Pro použití v batch loops
     * 
     * POZNÁMKA: Záporné ceny jsou legitimní - na energetickém trhu
     * se vyskytují při přebytku výroby z obnovitelných zdrojů.
     * 
     * @param {number} price - cena (může být záporná!)
     * @returns {boolean}
     */
    validatePrice(price) {
        return typeof price === 'number' && isFinite(price);
    }

    /**
     * TICHÁ validace minuty - bez logování
     * 
     * @param {number} minute - minuta k validaci
     * @returns {boolean}
     */
    validateMinuteSilent(minute) {
        return this.VALID_MINUTES.includes(minute);
    }

    /**
     * TICHÁ validace slotu - bez logování
     * 
     * @param {Object} item - slot k validaci { hour, minute, priceCZK }
     * @returns {Object} { isValid: boolean, errors: Array<string> }
     */
    validateSlotSilent(item) {
        const errors = [];

        if (!item || typeof item !== 'object') {
            errors.push('Slot není objekt');
            return { isValid: false, errors };
        }

        // Validace hour (0-23)
        if (!this.validateValueSilent(item.hour, 'number', 0, 23)) {
            errors.push(`Neplatná hodina: ${item.hour}`);
        }

        // Validace minute (0, 15, 30, 45)
        if (!this.validateMinuteSilent(item.minute)) {
            errors.push(`Neplatná minuta: ${item.minute}`);
        }

        // Validace ceny
        if (!this.validatePrice(item.priceCZK)) {
            errors.push(`Neplatná cena: ${item.priceCZK}`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    // ==================== BATCH VALIDACE ====================

    /**
     * Batch validace cenových dat s jediným summary logem
     * Místo 96× jednotlivých logů → 1× summary log
     * 
     * @param {Array} slots - Pole 96 slotů s cenami
     * @returns {Object} { isValid: boolean, validCount: number, invalidSlots: Array, errors: Array, duration: number }
     * 
     * @example
     * const result = validator.validatePriceDataBatch(slots);
     * if (!result.isValid) {
     *   console.error('Validace selhala:', result.errors);
     * }
     */
    validatePriceDataBatch(slots) {
        try {
            const startTime = Date.now();
            const invalidSlots = [];
            const errors = [];
            let validCount = 0;

            // Validace struktury pole
            if (!Array.isArray(slots)) {
                errors.push('Data nejsou pole');
                this.logger?.error('❌ Batch validace selhala', { 
                    reason: 'Není pole',
                    receivedType: typeof slots 
                });
                return { 
                    isValid: false, 
                    validCount: 0, 
                    invalidSlots: [], 
                    errors, 
                    duration: Date.now() - startTime 
                };
            }

            // Kontrola počtu slotů
            if (slots.length !== this.SLOTS_PER_DAY) {
                errors.push(`Nesprávný počet slotů: ${slots.length}, očekáváno ${this.SLOTS_PER_DAY}`);
            }

            // Batch validace všech slotů (TICHÁ - bez logování)
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                const validation = this.validateSlotSilent(slot);

                if (!validation.isValid) {
                    invalidSlots.push({
                        index: i,
                        slot: slot ? `${slot.hour}:${String(slot.minute).padStart(2, '0')}` : 'N/A',
                        errors: validation.errors
                    });
                    errors.push(...validation.errors);
                } else {
                    validCount++;
                }
            }

            const duration = Date.now() - startTime;
            const isValid = invalidSlots.length === 0 && slots.length === this.SLOTS_PER_DAY;

            // 🎯 JEDINÝ LOG - summary všech validací
            if (isValid) {
                this.logger?.debug('✅ Batch validace cenových dat úspěšná', {
                    totalSlots: slots.length,
                    validSlots: validCount,
                    duration: `${duration}ms`
                });
            } else {
                this.logger?.error('❌ Batch validace cenových dat selhala', {
                    totalSlots: slots.length,
                    validSlots: validCount,
                    invalidSlots: invalidSlots.length,
                    firstErrors: invalidSlots.slice(0, 3).map(s => ({
                        slot: s.slot,
                        errors: s.errors
                    })),
                    duration: `${duration}ms`
                });
            }

            return {
                isValid,
                validCount,
                invalidSlots,
                errors: [...new Set(errors)], // Unikátní chyby
                duration
            };

        } catch (error) {
            this.logger?.error('❌ Kritická chyba v batch validaci', error);
            return {
                isValid: false,
                validCount: 0,
                invalidSlots: [],
                errors: [error.message],
                duration: 0
            };
        }
    }

    /**
     * Validace unikátnosti slotů (kombinace hour + minute)
     * TICHÁ - loguje jen při nalezení duplicit
     * 
     * @param {Array} data - pole slotů
     * @returns {boolean}
     */
    validateUniqueSlots(data) {
        const slots = data.map(item => `${item.hour}-${item.minute}`);
        const uniqueSlots = new Set(slots);
    
        if (slots.length !== uniqueSlots.size) {
            const duplicates = slots.filter((slot, index) => slots.indexOf(slot) !== index);
            
            // ❌ Log jen při chybě
            this.logger?.error('Nalezeny duplicitní sloty', {
                totalSlots: slots.length,
                uniqueSlots: uniqueSlots.size,
                duplicates: [...new Set(duplicates)]
            });
            return false;
        }
    
        return true;
    }

    // ==================== VALIDACE INDEXŮ ====================

    /**
     * TICHÁ validace počtu slotů pro low/high indexy
     * 
     * @param {number} lowIndexSlots - počet slotů pro low index
     * @param {number} highIndexSlots - počet slotů pro high index
     * @returns {Object} { isValid: boolean, errors: Array<string> }
     */
    validateIndexSlotsSilent(lowIndexSlots, highIndexSlots) {
        const errors = [];

        if (!this.validateValueSilent(lowIndexSlots, 'number', 0, 96)) {
            errors.push(`Neplatný lowIndexSlots: ${lowIndexSlots}`);
        }

        if (!this.validateValueSilent(highIndexSlots, 'number', 0, 96)) {
            errors.push(`Neplatný highIndexSlots: ${highIndexSlots}`);
        }

        if (lowIndexSlots + highIndexSlots > 96) {
            errors.push(`Součet slotů přesahuje maximum: ${lowIndexSlots + highIndexSlots} > 96`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validace vstupních dat pro výpočet cenových indexů
     * BATCH režim - jediný summary log
     * 
     * @param {Array} data - pole slotů
     * @param {number} lowIndexSlots - počet low index slotů
     * @param {number} highIndexSlots - počet high index slotů
     * @returns {Object} { isValid: boolean, errors: Array<string> }
     */
    validateIndexData(data, lowIndexSlots, highIndexSlots) {
        try {
            const startTime = Date.now();
            const errors = [];

            // 1. Batch validace cenových dat (TICHÁ)
            const priceValidation = this.validatePriceDataBatch(data);
            if (!priceValidation.isValid) {
                errors.push(...priceValidation.errors);
            }

            // 2. Validace počtu slotů (TICHÁ)
            const indexValidation = this.validateIndexSlotsSilent(lowIndexSlots, highIndexSlots);
            if (!indexValidation.isValid) {
                errors.push(...indexValidation.errors);
            }

            // 3. Validace unikátnosti (loguje jen při duplicitách)
            if (!this.validateUniqueSlots(data)) {
                errors.push('Duplicitní sloty v datech');
            }

            const isValid = errors.length === 0;
            const duration = Date.now() - startTime;

            // 🎯 JEDINÝ LOG pro index validaci
            if (isValid) {
                this.logger?.debug('✅ Validace dat pro cenové indexy úspěšná', {
                    dataLength: data?.length,
                    lowIndexSlots,
                    highIndexSlots,
                    duration: `${duration}ms`
                });
            } else {
                this.logger?.error('❌ Validace dat pro indexy selhala', { 
                    errors: errors.slice(0, 5), // Max 5 chyb
                    duration: `${duration}ms`
                });
            }

            return { isValid, errors };
            
        } catch (error) {
            this.logger?.error('❌ Chyba při validaci dat pro cenové indexy', error);
            return { isValid: false, errors: [error.message] };
        }
    }

    // ==================== LEGACY METODY (zpětná kompatibilita) ====================

    /**
     * DEPRECATED: Použijte validatePriceDataBatch()
     * Zachováno pro zpětnou kompatibilitu
     */
    validatePriceData(data) {
        const result = this.validatePriceDataBatch(data);
        return result.isValid;
    }

    /**
     * DEPRECATED: Použijte validateSlotSilent()
     * Zachováno pro zpětnou kompatibilitu
     */
    validateSlot(item) {
        const result = this.validateSlotSilent(item);
        return result.isValid;
    }

    /**
     * Validace existence ceny pro konkrétní slot
     * TICHÁ - loguje jen při chybě
     * 
     * @param {Array} data - pole slotů
     * @param {number} hour - hodina (0-23)
     * @param {number} minute - minuta (0, 15, 30, 45)
     * @returns {Object} { isValid: boolean, price: number|null }
     */
    validateSlotPrice(data, hour, minute) {
        if (!Array.isArray(data)) {
            this.logger?.error('Data nejsou pole');
            return { isValid: false, price: null };
        }

        if (!this.validateMinuteSilent(minute)) {
            this.logger?.error('Neplatná minuta', { minute });
            return { isValid: false, price: null };
        }
    
        const priceData = data.find(d => d?.hour === hour && d?.minute === minute);
    
        if (!priceData || priceData.priceCZK === undefined) {
            // ❌ Log jen při chybě
            this.logger?.error('Cena pro daný slot nenalezena', { 
                hour, 
                minute,
                formattedSlot: `${hour}:${String(minute).padStart(2, '0')}`
            });
            return { isValid: false, price: null };
        }
    
        if (!this.validatePrice(priceData.priceCZK)) {
            // ❌ Log jen při chybě
            this.logger?.error('Neplatná cena slotu', {
                hour,
                minute,
                price: priceData.priceCZK
            });
            return { isValid: false, price: null };
        }
    
        return { isValid: true, price: priceData.priceCZK };
    }

    // ==================== VALIDACE TARIFU (ŽÁDNÁ VALIDACE - graceful degradation) ====================

    /**
     * TICHÁ validace hodiny pro tarif
     * Bez logování - pouze return true/false
     * 
     * @param {number} hour - hodina k validaci (0-23, speciálně 24 = 0)
     * @returns {boolean}
     */
    validateTariffHour(hour) {
        if (typeof hour !== 'number' || isNaN(hour)) {
            return false;
        }

        // Speciální případ - hodina 24 se považuje za 0 (půlnoc)
        if (hour === 24) {
            return true;
        }

        return hour >= 0 && hour < this.HOURS_PER_DAY;
    }

    // ==================== POMOCNÉ METODY ====================

    /**
     * Validace pole - TICHÁ
     * 
     * @param {Array} array - pole k validaci
     * @param {number} [length] - očekávaná délka (null = nekontrolovat)
     * @returns {boolean}
     */
    validateArray(array, length = null) {
        if (!Array.isArray(array)) {
            return false;
        }

        if (length !== null && array.length !== length) {
            return false;
        }

        return true;
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí validator instanci
     */
    destroy() {
        this.logger?.debug('DataValidator instance ukončena');
        DataValidator.instance = null;
    }
}

module.exports = DataValidator;
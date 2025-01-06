'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');

class TariffCalculator {
    static instance = null;
    static homeyInstance = null; // Přidán statický homeyInstance
    static CONTEXT = 'TariffCalculator';

    // Metoda pro nastavení HomeyInstance
    static setHomeyInstance(homey) {
        TariffCalculator.homeyInstance = homey;
    }

    constructor(homeyInstance) {
        if (TariffCalculator.instance) {
            throw new Error('Použijte TariffCalculator.getInstance() místo volání new.');
        }
        
        // Použij předaný homeyInstance nebo statický homeyInstance
        const instanceToUse = homeyInstance || TariffCalculator.homeyInstance;
        
        if (!instanceToUse) {
            throw new Error('HomeyInstance musí být poskytnut');
        }

        this.logger = Logger.getInstance()
        this.homey = instanceToUse;
        this.validator = DataValidator.getInstance(instanceToUse);
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
            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení tarifu');
                return [];
            }

            const tarifniHodiny = Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);

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

            if (!this.validator.validateTariffSettings(settings)) {
                this.logger?.warn('Neplatná nastavení pro kontrolu tarifu');
                return false;
            }

            // Normalizace hodiny pro případ hodnoty 24
            const normalizedHour = hour === 24 ? 0 : hour;

            const tarifniHodiny = this.getTariffHours(settings);
            const jeNizkyTarif = tarifniHodiny.includes(normalizedHour);

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
}

module.exports = TariffCalculator;
'use strict';

const Logger = require('../Logger');

/**
 * ActionsManager - správa flow akcí
 * ✅ Univerzální - neřeší typ device, pouze volá metody na device
 * 
 * POZNÁMKA: Tento manager nepotřebuje breaking changes, protože
 * akce pouze delegují volání na device.fetchAndUpdateSpotPrices()
 */
class ActionsManager {
    static instance = null;
    static CONTEXT = 'ActionsManager';

    /**
     * Získá nebo vytvoří instanci ActionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     * @returns {ActionsManager} Singleton instance
     */
    static getInstance(homey) {
        if (!ActionsManager.instance) {
            ActionsManager.instance = new ActionsManager(homey);
        }
        return ActionsManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro ActionsManager');
        }
        ActionsManager.homeyInstance = homey;
    }

    /**
     * Vytvoří novou instanci ActionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     */
    constructor(homey) {
        if (ActionsManager.instance) {
            throw new Error('Použijte ActionsManager.getInstance() místo new ActionsManager()');
        }

        this.homey = homey;
        this.logger = Logger.getInstance(homey);
        this.isInitialized = false;
        this._actions = new Map();
        
        this.logger.debug('ActionsManager inicializován');
    }

    // ==================== INICIALIZACE ====================

    /**
     * Inicializuje všechny akce
     */
    async initialize() {
        try {
            this.logger?.debug('Začíná inicializace akcí');
            
            if (this.isInitialized) {
                this.logger?.debug('Akce již byly inicializovány, přeskakuji');
                return;
            }

            await this._registerUpdateDataAction();
            
            this.isInitialized = true;
            this.logger?.debug('Akce úspěšně inicializovány', {
                počet: this._actions.size,
                registrované: Array.from(this._actions.keys())
            });
            
        } catch (error) {
            this.logger?.error('Chyba při inicializaci akcí', error);
            throw error;
        }
    }

    // ==================== REGISTRACE AKCÍ ====================

    /**
     * Registruje akci pro manuální aktualizaci dat přes API
     * Volá device.fetchAndUpdateSpotPrices() který sám ví jak zpracovat data
     * @private
     */
    async _registerUpdateDataAction() {
        try {
            if (this._actions.has('update_data_via_api')) {
                this.logger.debug('Update data action již je registrována');
                return;
            }

            const card = this.homey.flow.getActionCard('update_data_via_api');
            
            card.registerRunListener(async (args) => {
                try {
                    // OPRAVA: Použijeme args.device místo this.device
                    await args.device.fetchAndUpdateSpotPrices();
                    
                    // Bezpečnostní kontrola, zda zařízení nebylo mezitím smazáno
                    if (!args.device._isDeleted) {
                        await args.device.setAvailable().catch(() => {});
                    }
                    
                    this.logger.debug('Data úspěšně aktualizována přes API');
                    return true;
                } catch (error) {
                    // Ignorujeme chyby smazaných zařízení
                    if (error.message.includes('Not Found: Device with ID')) {
                        return false;
                    }
                    this.logger.error('Chyba při aktualizaci dat přes API:', error);
                    return false;
                }
            });

            this._actions.set('update_data_via_api', card);
            this.logger.debug('Update data action úspěšně registrována');

        } catch (error) {
            this.logger.error('Chyba při registraci update data action:', error);
            throw error;
        }
    }

    // ==================== VEŘEJNÉ METODY ====================

    /**
     * Získá akci podle ID
     * @param {string} actionId - ID akce
     * @returns {Action|null} Instance akce nebo null
     */
    getAction(actionId) {
        return this._actions.get(actionId) || null;
    }

    /**
     * Vyčistí všechny akce
     */
    destroy() {
        try {
            this._actions.clear();
            this.logger.debug('Všechny akce byly vyčištěny');
        } catch (error) {
            this.logger.error('Chyba při čištění akcí:', error);
        }
    }

    /**
     * Získá počet registrovaných akcí
     * @returns {number} Počet akcí
     */
    getActionsCount() {
        return this._actions.size;
    }

    /**
     * Získá seznam všech registrovaných ID akcí
     * @returns {string[]} Seznam ID akcí
     */
    getRegisteredActionIds() {
        return Array.from(this._actions.keys());
    }
}

module.exports = ActionsManager;
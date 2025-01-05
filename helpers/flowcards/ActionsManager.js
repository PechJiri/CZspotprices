'use strict';

const Logger = require('../Logger');

class ActionsManager {
    // Statická instance pro singleton
    static instance = null;

    /**
     * Získá nebo vytvoří instanci ActionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     * @returns {ActionsManager} Singleton instance
     */
    static getInstance(homey, device = null) {
        if (!ActionsManager.instance) {
            ActionsManager.instance = new ActionsManager(homey, device);
        }
        return ActionsManager.instance;
    }

    /**
     * Vytvoří novou instanci ActionsManageru
     * @param {Homey} homey - Instance Homey
     * @param {Device} device - Instance zařízení
     */
    constructor(homey, device) {
        if (ActionsManager.instance) {
            throw new Error('Použijte ActionsManager.getInstance() místo new ActionsManager()');
        }

        this.homey = homey;
        this.device = device;
        this.logger = Logger.getInstance(this.homey, 'ActionsManager');
        this._actions = new Map();

        this.logger.debug('ActionsManager inicializován');
    }

    /**
     * Inicializuje všechny akce
     */
    async initialize() {
        try {
            this.logger.debug('Začíná inicializace akcí');
            await this._registerUpdateDataAction();
            this.logger.log('Akce úspěšně inicializovány');
        } catch (error) {
            this.logger.error('Chyba při inicializaci akcí', error);
            throw error;
        }
    }

    /**
     * Registruje akci pro aktualizaci dat přes API
     * @private
     */
    async _registerUpdateDataAction() {
        try {
            if (this._actions.has('update_data_via_api')) {
                this.logger.debug('Update data action již je registrována');
                return;
            }

            const card = this.homey.flow.getActionCard('update_data_via_api');
            
            card.registerRunListener(async () => {
                try {
                    await this.device.fetchAndUpdateSpotPrices();
                    await this.device.setAvailable();
                    
                    this.logger.debug('Data úspěšně aktualizována přes API');
                    return true;
                } catch (error) {
                    this.logger.error('Chyba při aktualizaci dat přes API:', error);
                    return false;
                }
            });

            this._actions.set('update_data_via_api', card);
            this.logger.log('Update data action úspěšně registrována');

        } catch (error) {
            this.logger.error('Chyba při registraci update data action:', error);
            throw error;
        }
    }

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
     * Získá list všech registrovaných ID akcí
     * @returns {string[]} Seznam ID akcí
     */
    getRegisteredActionIds() {
        return Array.from(this._actions.keys());
    }
}

module.exports = ActionsManager;
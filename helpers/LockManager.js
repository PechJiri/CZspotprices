'use strict';

const Logger = require('./Logger');

class LockManager {
    static instance = null;

    static getInstance(homey) {
        if (!LockManager.instance) {
            LockManager.instance = new LockManager(homey);
        }
        return LockManager.instance;
    }
    
    static CONTEXT = 'LockManager';

    constructor(homey) {
        this.homey = homey;
        this.locks = new Map();
        this.lockTimeout = 30000; // 30 sekund timeout pro zámek

        // Automatická inicializace loggeru jako singletonu
        this.logger = Logger.getInstance()
        this.logger.debug('LockManager: Inicializace dokončena');
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro LockManager');
        }
        LockManager.homeyInstance = homey;
    }

    /**
     * Získání zámku
     * @param {string} resourceId - Identifikátor zdroje
     * @param {string} operationId - Identifikátor operace
     * @returns {Promise<boolean>} - True pokud byl zámek získán
     */
    async acquireLock(resourceId, operationId) {
        try {
            const lockKey = `${resourceId}`;
            const now = Date.now();

            if (this.locks.has(lockKey)) {
                const existingLock = this.locks.get(lockKey);

                // Kontrola timeoutu existujícího zámku
                if (now - existingLock.timestamp < this.lockTimeout) {
                    this.logger.debug('Zámek je již držen', {
                        resourceId,
                        existingOperation: existingLock.operationId,
                        requestingOperation: operationId,
                        heldFor: now - existingLock.timestamp
                    });
                    return false;
                }

                // Automatické uvolnění timeoutovaného zámku
                this.logger.warn('Uvolňuji timeoutovaný zámek', {
                    resourceId,
                    existingOperation: existingLock.operationId,
                    timeout: this.lockTimeout
                });
                this.locks.delete(lockKey);
            }

            // Vytvoření nového zámku
            this.locks.set(lockKey, {
                operationId,
                timestamp: now
            });

            this.logger.debug('Zámek získán', {
                resourceId,
                operationId
            });

            return true;
        } catch (error) {
            this.logger.error('Chyba při získávání zámku', error);
            return false;
        }
    }

    /**
     * Uvolnění zámku
     * @param {string} resourceId - Identifikátor zdroje
     * @param {string} operationId - Identifikátor operace
     * @returns {boolean} - True pokud byl zámek úspěšně uvolněn
     */
    releaseLock(resourceId, operationId) {
        try {
            const lockKey = `${resourceId}`;
            const existingLock = this.locks.get(lockKey);

            if (!existingLock) {
                this.logger.warn('Pokus o uvolnění neexistujícího zámku', {
                    resourceId,
                    operationId
                });
                return false;
            }

            // Kontrola vlastníka zámku
            if (existingLock.operationId !== operationId) {
                this.logger.warn('Pokus o uvolnění cizího zámku', {
                    resourceId,
                    existingOperation: existingLock.operationId,
                    requestingOperation: operationId
                });
                return false;
            }

            this.locks.delete(lockKey);

            this.logger.debug('Zámek uvolněn', {
                resourceId,
                operationId
            });

            return true;
        } catch (error) {
            this.logger.error('Chyba při uvolňování zámku', error);
            return false;
        }
    }

    /**
     * Kontrola stavu zámku
     * @param {string} resourceId - Identifikátor zdroje
     * @returns {Object|null} - Informace o zámku nebo null
     */
    getLockInfo(resourceId) {
        try {
            const lockKey = `${resourceId}`;
            const lock = this.locks.get(lockKey);

            if (!lock) {
                return null;
            }

            return {
                operationId: lock.operationId,
                timestamp: lock.timestamp,
                age: Date.now() - lock.timestamp
            };
        } catch (error) {
            this.logger.error('Chyba při získávání informací o zámku', error);
            return null;
        }
    }

    /**
     * Vyčištění všech zámků
     */
    clearAllLocks() {
        try {
            const count = this.locks.size;
            this.locks.clear();

            this.logger.debug('Všechny zámky vyčištěny', { count });
        } catch (error) {
            this.logger.error('Chyba při čištění zámků', error);
        }
    }
}

module.exports = LockManager;

'use strict';

const Logger = require('./Logger');

/**
 * LockManager - správa zamykání zdrojů
 * 
 * POUŽITÍ:
 * - Prevence souběžných operací nad stejným zdrojem
 * - Automatické expirování locku po timeoutu
 * - Thread-safe operace
 * 
 * @class LockManager
 * @singleton
 * 
 * @example
 * const lockManager = LockManager.getInstance(homey);
 * 
 * // Získat lock
 * const acquired = await lockManager.acquireLock('resource-1', 'operation-123');
 * if (acquired) {
 *   try {
 *     // Proveď operaci
 *   } finally {
 *     lockManager.releaseLock('resource-1', 'operation-123');
 *   }
 * }
 */
class LockManager {
    static instance = null;
    static CONTEXT = 'LockManager';

    constructor(homey) {
        if (LockManager.instance) {
            throw new Error('LockManager je singleton. Použijte LockManager.getInstance()');
        }
        
        this.homey = homey;
        this.locks = new Map();
        this.lockTimeout = 30000; // 30 sekund
        this.logger = Logger.getInstance();
        
        this.logger?.debug('LockManager inicializován', {
            lockTimeout: this.lockTimeout
        });
    }

    static getInstance(homey) {
        if (!LockManager.instance) {
            LockManager.instance = new LockManager(homey);
        }
        return LockManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro LockManager');
        }
        LockManager.homeyInstance = homey;
    }

    // ==================== LOCK OPERACE ====================

    /**
     * Pokusí se získat lock na zdroj
     * 
     * LOGIKA:
     * - Pokud lock neexistuje → vytvoří ho a vrátí true
     * - Pokud lock existuje a je mladší než timeout → vrátí false
     * - Pokud lock existuje ale expiroval → smaže ho a vytvoří nový
     * 
     * @param {string} resourceId - ID zdroje k zamčení
     * @param {string} operationId - ID operace (pro párování s release)
     * @returns {Promise<boolean>} true pokud lock získán
     * 
     * @example
     * const acquired = await lockManager.acquireLock('midnight_update', 'op_123');
     */
    async acquireLock(resourceId, operationId) {
        try {
            if (!resourceId || !operationId) {
                this.logger?.error('Neplatné parametry pro acquireLock', {
                    resourceId,
                    operationId
                });
                return false;
            }

            const lockKey = resourceId;
            const now = Date.now();

            // Kontrola existujícího zámku
            if (this.locks.has(lockKey)) {
                const existingLock = this.locks.get(lockKey);
                const lockAge = now - existingLock.timestamp;

                // Lock stále platný
                if (lockAge < this.lockTimeout) {
                    this.logger?.debug('Lock už existuje', {
                        resourceId,
                        existingOperationId: existingLock.operationId,
                        lockAge,
                        remainingTime: this.lockTimeout - lockAge
                    });
                    return false;
                }

                // Lock expiroval - vyčistíme ho
                this.logger?.debug('Lock expiroval, vyčišťuji', {
                    resourceId,
                    expiredOperationId: existingLock.operationId,
                    lockAge
                });
                this.locks.delete(lockKey);
            }

            // Vytvoření nového zámku
            this.locks.set(lockKey, {
                operationId,
                timestamp: now
            });

            this.logger?.debug('Lock získán', {
                resourceId,
                operationId,
                activeLocks: this.locks.size
            });

            return true;

        } catch (error) {
            this.logger?.error('Chyba při získávání locku', error, {
                resourceId,
                operationId
            });
            return false;
        }
    }

    /**
     * Uvolní lock na zdroj
     * 
     * VALIDACE:
     * - Lock musí existovat
     * - operationId musí souhlasit (nelze uvolnit cizí lock)
     * 
     * @param {string} resourceId - ID zdroje
     * @param {string} operationId - ID operace (musí souhlasit s acquire)
     * @returns {boolean} true pokud lock uvolněn
     * 
     * @example
     * lockManager.releaseLock('midnight_update', 'op_123');
     */
    releaseLock(resourceId, operationId) {
        try {
            if (!resourceId || !operationId) {
                this.logger?.error('Neplatné parametry pro releaseLock', {
                    resourceId,
                    operationId
                });
                return false;
            }

            const lockKey = resourceId;
            const existingLock = this.locks.get(lockKey);

            // Lock neexistuje
            if (!existingLock) {
                this.logger?.warn('Lock neexistuje pro uvolnění', {
                    resourceId,
                    operationId
                });
                return false;
            }

            // operationId nesouhlasí
            if (existingLock.operationId !== operationId) {
                this.logger?.warn('operationId nesouhlasí', {
                    resourceId,
                    requestedOperationId: operationId,
                    existingOperationId: existingLock.operationId
                });
                return false;
            }

            // Uvolnění locku
            this.locks.delete(lockKey);

            this.logger?.debug('Lock uvolněn', {
                resourceId,
                operationId,
                activeLocks: this.locks.size
            });

            return true;

        } catch (error) {
            this.logger?.error('Chyba při uvolňování locku', error, {
                resourceId,
                operationId
            });
            return false;
        }
    }

    /**
     * Vyčistí všechny locky
     * 
     * POUŽITÍ:
     * - Při cleanup device
     * - Při restartu systému
     * - Pro debugging
     */
    clearAllLocks() {
        const lockCount = this.locks.size;
        this.locks.clear();
        
        this.logger?.debug('Všechny locky vyčištěny', {
            clearedLocks: lockCount
        });
    }

    /**
     * Vyčistí expirované locky
     * 
     * Projde všechny locky a smaže ty, které překročily timeout
     * 
     * @returns {number} počet vyčištěných locků
     */
    cleanupExpiredLocks() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [resourceId, lock] of this.locks.entries()) {
            const lockAge = now - lock.timestamp;
            
            if (lockAge >= this.lockTimeout) {
                this.locks.delete(resourceId);
                cleanedCount++;
                
                this.logger?.debug('Expirovaný lock vyčištěn', {
                    resourceId,
                    operationId: lock.operationId,
                    lockAge
                });
            }
        }

        if (cleanedCount > 0) {
            this.logger?.debug('Cleanup expirovaných locků dokončen', {
                cleanedCount,
                remainingLocks: this.locks.size
            });
        }

        return cleanedCount;
    }

    // ==================== DIAGNOSTIKA ====================

    /**
     * Vrátí informace o všech aktivních lockách
     * 
     * @returns {Array<Object>} pole aktivních locků
     * 
     * @example
     * const locks = lockManager.getActiveLocks();
     * console.log('Aktivní locky:', locks);
     */
    getActiveLocks() {
        const now = Date.now();
        const activeLocks = [];

        for (const [resourceId, lock] of this.locks.entries()) {
            const lockAge = now - lock.timestamp;
            activeLocks.push({
                resourceId,
                operationId: lock.operationId,
                timestamp: lock.timestamp,
                age: lockAge,
                remainingTime: Math.max(0, this.lockTimeout - lockAge),
                isExpired: lockAge >= this.lockTimeout
            });
        }

        return activeLocks;
    }

    /**
     * Zkontroluje, jestli zdroj má aktivní lock
     * 
     * @param {string} resourceId - ID zdroje
     * @returns {boolean} true pokud má aktivní lock
     */
    hasLock(resourceId) {
        if (!this.locks.has(resourceId)) {
            return false;
        }

        const lock = this.locks.get(resourceId);
        const lockAge = Date.now() - lock.timestamp;

        return lockAge < this.lockTimeout;
    }

    /**
     * Vrátí počet aktivních locků
     * 
     * @returns {number} počet aktivních locků
     */
    getActiveLockCount() {
        return this.locks.size;
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí LockManager instanci
     */
    destroy() {
        this.clearAllLocks();
        this.logger?.debug('LockManager instance ukončena');
        LockManager.instance = null;
    }
}

module.exports = LockManager;
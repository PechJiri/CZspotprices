'use strict';

const Logger = require('./Logger');

class LockManager {
    static instance = null;
    static CONTEXT = 'LockManager';

    constructor(homey) {
        this.homey = homey;
        this.locks = new Map();
        this.lockTimeout = 30000; // 30 sekund
        this.logger = Logger.getInstance();
    }

    static getInstance(homey) {
        if (!LockManager.instance) {
            LockManager.instance = new LockManager(homey);
        }
        return LockManager.instance;
    }

    async acquireLock(resourceId, operationId) {
        const lockKey = resourceId;
        const now = Date.now();

        // Kontrola existujícího zámku
        if (this.locks.has(lockKey)) {
            const existingLock = this.locks.get(lockKey);
            if (now - existingLock.timestamp < this.lockTimeout) {
                return false;
            }
            this.locks.delete(lockKey);
        }

        // Vytvoření nového zámku
        this.locks.set(lockKey, {
            operationId,
            timestamp: now
        });

        return true;
    }

    releaseLock(resourceId, operationId) {
        const lockKey = resourceId;
        const existingLock = this.locks.get(lockKey);

        if (!existingLock || existingLock.operationId !== operationId) {
            return false;
        }

        this.locks.delete(lockKey);
        return true;
    }

    clearAllLocks() {
        this.locks.clear();
    }
}

module.exports = LockManager;
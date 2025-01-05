'use strict';

const Logger = require('./Logger');

class CacheManager {
    static instance = null;

    constructor() {
        if (CacheManager.instance) {
            throw new Error('Použijte CacheManager.getInstance() místo volání new.');
        }
        this.logger = Logger.getInstance();
        
        // Hlavní úložiště cache
        this.caches = new Map();
        
        // Konstanty pro TTL
        this.TTL = {
            PRICE: 60 * 60 * 1000,        // 1 hodina
            AVERAGE: 15 * 60 * 1000,      // 15 minut
            DEFAULT: 30 * 60 * 1000       // 30 minut
        };

        // Nastavení automatického čištění
        this.setupCacheCleanup();
        
        this.logger?.debug('CacheManager inicializován', {
            cacheTTL: this.TTL
        });
    }

    static getInstance() {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    /**
     * Nastavení automatického čištění cache
     * @private
     */
    setupCacheCleanup() {
        // Čištění každou hodinu
        setInterval(() => {
            this.cleanupExpired();
        }, this.TTL.PRICE);

        this.logger?.debug('Automatické čištění cache nastaveno', {
            interval: this.TTL.PRICE,
            nextCleanup: new Date(Date.now() + this.TTL.PRICE).toISOString()
        });
    }

    /**
     * Přidání nebo aktualizace záznamu v cache
     * @param {string} key - Klíč cache
     * @param {any} data - Data k uložení
     * @param {string} type - Typ cache (PRICE, AVERAGE, DEFAULT)
     * @returns {boolean} - Úspěch operace
     */
    setCache(key, data, type = 'DEFAULT') {
        try {
            const ttl = this.TTL[type] || this.TTL.DEFAULT;
            const cacheEntry = {
                data,
                timestamp: Date.now(),
                expiresAt: Date.now() + ttl,
                type
            };

            this.caches.set(key, cacheEntry);

            this.logger?.debug('Data uložena do cache', {
                key,
                type,
                expiresAt: new Date(cacheEntry.expiresAt).toISOString()
            });

            return true;
        } catch (error) {
            this.logger?.error('Chyba při ukládání do cache', error, { key, type });
            return false;
        }
    }

    /**
     * Získání dat z cache
     * @param {string} key - Klíč cache
     * @returns {any|null} - Cached data nebo null
     */
    getCache(key) {
        try {
            const entry = this.caches.get(key);
            
            if (!entry) {
                this.logger?.debug('Cache nenalezena', { key });
                return null;
            }

            if (Date.now() > entry.expiresAt) {
                this.logger?.debug('Cache expirovala', {
                    key,
                    expiredAt: new Date(entry.expiresAt).toISOString()
                });
                this.caches.delete(key);
                return null;
            }

            this.logger?.debug('Data načtena z cache', {
                key,
                type: entry.type,
                age: Date.now() - entry.timestamp
            });

            return entry.data;
        } catch (error) {
            this.logger?.error('Chyba při čtení z cache', error, { key });
            return null;
        }
    }

    /**
     * Vyčištění všech expirovaných záznamů
     */
    cleanupExpired() {
        const now = Date.now();
        const beforeCount = this.caches.size;
        let deletedCount = 0;

        for (const [key, entry] of this.caches.entries()) {
            if (now > entry.expiresAt) {
                this.caches.delete(key);
                deletedCount++;
            }
        }

        this.logger?.debug('Vyčištění expirované cache dokončeno', {
            beforeCount,
            afterCount: this.caches.size,
            deletedCount
        });
    }

    /**
     * Vymazání konkrétního záznamu
     * @param {string} key - Klíč k vymazání
     */
    deleteCache(key) {
        const deleted = this.caches.delete(key);
        
        if (deleted) {
            this.logger?.debug('Cache záznam vymazán', { key });
        } else {
            this.logger?.debug('Cache záznam pro vymazání nenalezen', { key });
        }
        
        return deleted;
    }

    /**
     * Vymazání všech cache záznamů
     */
    clearAll() {
        const count = this.caches.size;
        this.caches.clear();
        
        this.logger?.debug('Všechny cache záznamy vymazány', {
            deletedCount: count
        });
    }

    /**
     * Získání statistik cache
     * @returns {Object} Statistiky cache
     */
    getCacheStats() {
        const stats = {
            totalEntries: this.caches.size,
            byType: {},
            expiredCount: 0
        };

        const now = Date.now();

        for (const [_, entry] of this.caches.entries()) {
            stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
            if (now > entry.expiresAt) {
                stats.expiredCount++;
            }
        }

        return stats;
    }
}

module.exports = CacheManager;
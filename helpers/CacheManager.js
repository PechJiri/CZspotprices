'use strict';

const Logger = require('./Logger');

class CacheManager {
    static instance = null;
    static CONTEXT = 'CacheManager';

    constructor(homey) {
        // ✅ SPRÁVNĚ: Nejdřív kontrola, PAK nastavení instance
        if (CacheManager.instance) {
            throw new Error('Použijte CacheManager.getInstance() místo volání new.');
        }
        
        // ✅ KLÍČOVÁ ZMĚNA: Nastavit instanci IHNED v konstruktoru
        CacheManager.instance = this;
        
        this.logger = Logger.getInstance();
        this.homey = homey;

        // Hlavní úložiště cache
        this.caches = new Map();

        // Nastavení automatického čištění
        this.setupCacheCleanup();

        this.logger?.debug('CacheManager inicializován (HYBRID cache strategy)');
    }

    // Pomocné metody pro výpočet TTL
    calculateTTLToNextMidnight() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 5, 0, 0);  // 00:05:00 další den
        return tomorrow - now;
    }

    calculateTTLToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 1, 0);  // XX:00:01 další hodina
        return nextHour - now;
    }

    static getInstance(homey) {
        if (!CacheManager.instance) {
            // Instance se nastaví v konstruktoru
            new CacheManager(homey);
        }
        return CacheManager.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro CacheManager');
        }
        CacheManager.homeyInstance = homey;
    }

    setupCacheCleanup() {
        // Použití IntervalManager pro jeden master timer místo mnoha syrových intervalů
        try {
            const IntervalManager = require('./IntervalManager');
            const intervalManager = IntervalManager.getInstance(this.homey);
            
            intervalManager.setScheduledInterval(
                'cache_cleanup',
                () => {
                    this.cleanupExpired();
                },
                15 * 60 * 1000 // 15 minut
            );

            this.logger?.debug('Automatické čištění cache nastaveno přes IntervalManager', {
                interval: 15 * 60 * 1000
            });
        } catch (e) {
            this.logger?.error('Chyba při nastavování čištění cache', e);
        }
    }

    has(key) {
        const entry = this.caches.get(key);
        if (!entry) {
            return false;
        }
            
        if (Date.now() > entry.expiresAt) {
            this.caches.delete(key);
            return false;
        }
    
        return true;
    }

    set(key, data, type = 'DEFAULT') {
        try {
            // Dynamický TTL podle typu - vždy přepočítán, aby se správně
            // reflektoval aktuální čas (TTL do půlnoci/hodiny se mění v čase).
            let ttl;
            switch (type) {
                case 'PRICE':
                case 'MIDNIGHT':
                    ttl = this.calculateTTLToNextMidnight();
                    break;
                case 'AVERAGE':
                case 'HOURLY':
                    ttl = this.calculateTTLToNextHour();
                    break;
                case 'DEFAULT':
                default:
                    ttl = 5 * 60 * 1000; // 5 minut
            }

            const cacheEntry = {
                data,
                timestamp: Date.now(),
                expiresAt: Date.now() + ttl,
                type
            };

            this.caches.set(key, cacheEntry);
            return true;
        } catch (error) {
            this.logger?.error('Chyba při ukládání do cache', error, { key, type });
            return false;
        }
    }

    get(key) {
        try {
            const entry = this.caches.get(key);
            
            if (!entry) {
                return null;
            }

            if (Date.now() > entry.expiresAt) {
                this.caches.delete(key);
                return null;
            }

            return entry.data;
        } catch (error) {
            this.logger?.error('Chyba při čtení z cache', error, { key });
            return null;
        }
    }

    cleanupExpired() {
        const now = Date.now();
        const beforeCount = this.caches.size;
        let deletedCount = 0;

        // Odstraníme pouze záznamy, které už expirovaly - žádná dopředná marže
        // (stále platné záznamy mohou být znovu použity do jejich skutečné expirace)
        for (const [key, entry] of this.caches.entries()) {
            if (now > entry.expiresAt) {
                this.caches.delete(key);
                deletedCount++;
            }
        }

        // Logujeme pouze pokud bylo něco smazáno
        if (deletedCount > 0) {
            this.logger?.debug('Vyčištění expirované cache dokončeno', {
                beforeCount,
                afterCount: this.caches.size,
                deletedCount
            });
        }
    }

    deleteCache(key) {
        return this.caches.delete(key);
    }

    clearAll() {
        this.caches.clear();
    }
}

module.exports = CacheManager;
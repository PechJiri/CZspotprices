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
        
        // ✅ HYBRID: TTL konstanty optimalizované pro lazy evaluation
        this.TTL = {
            // Denní cenová data - platná do půlnoci
            PRICE: this.calculateTTLToNextMidnight(),
            
            // ✅ KRITICKÁ ZMĚNA: AVERAGE nyní také do půlnoci
            // Důvod: calculateAverageSlotPrices() používá dateKey v cache klíči
            // → Lazy evaluation: První trigger = compute, další = cache hit do půlnoci
            // → Automatická invalidace po půlnoci (nový dateKey)
            AVERAGE: this.calculateTTLToNextMidnight(),
            
            // Ostatní dočasná data
            DEFAULT: 5 * 60 * 1000  // 5 minut
        };

        // Nastavení automatického čištění
        this.setupCacheCleanup();
        
        this.logger?.debug('CacheManager inicializován (HYBRID cache strategy)', {
            cacheTTL: {
                PRICE: 'do půlnoci',
                AVERAGE: 'do půlnoci (lazy eval)',  // ← Vysvětluje strategii
                DEFAULT: '5 minut'
            }
        });
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
            // Určení TTL podle typu dat a klíče
            let ttl = this.TTL[type];
            
            // Pro cenová data použijeme TTL do půlnoci
            if (key.includes('price') || key.includes('Price')) {
                ttl = this.calculateTTLToNextMidnight();
            }
            // Pro průměry a indexy použijeme hodinové TTL
            else if (key.includes('average') || key.includes('index')) {
                ttl = this.calculateTTLToNextHour();
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

        // Agresivnější čištění - odstraníme i záznamy, které brzy vyprší
        for (const [key, entry] of this.caches.entries()) {
            // Smažeme pokud již expiroval nebo expiruje v příštích 5 minutách
            if (now > entry.expiresAt || (entry.expiresAt - now < 5 * 60 * 1000)) {
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
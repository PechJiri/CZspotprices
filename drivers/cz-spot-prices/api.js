'use strict';

const axios = require('axios');
const Logger = require('../../helpers/Logger');

class SpotPriceAPI {
    static instance = null;
    static CONTEXT = 'SpotPriceAPI';

    static getInstance(homey) {
        if (!SpotPriceAPI.instance) {
            SpotPriceAPI.instance = new SpotPriceAPI(homey);
        }
        return SpotPriceAPI.instance;
    }

    constructor(homeyInstance) {
        if (SpotPriceAPI.instance) {
            throw new Error('Použijte SpotPriceAPI.getInstance()');
        }
        
        this.homey = homeyInstance;
        if (!this.homey) {
            throw new Error('Homey instance není dostupná');
        }
    
        // Inicializace loggeru jako první
        this.logger = Logger.getInstance();
        if (!this.logger) {
            throw new Error('Logger inicializace selhala');
        }
    
        // Základní konfigurace
        this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
        const today = new Date().toISOString().slice(0, 10);
        this.backupUrl = `https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data?date=${today}`;
        this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
        this.exchangeRate = 25.25;
        this.homeyTimezone = this.homey.clock.getTimezone();
        this.lastRateUpdate = null;

        this.logger.debug('SpotPriceAPI inicializován');
    }

    // Metody pro lazy inicializaci závislostí
    getPriceCalculator() {
        if (!this._priceCalculator) {
            const PriceCalculator = require('../../helpers/pricecalculation/PriceCalculator');
            this._priceCalculator = PriceCalculator.getInstance(this.homey);
        }
        return this._priceCalculator;
    }

    getTariffCalculator() {
        if (!this._tariffCalculator) {
            const TariffCalculator = require('../../helpers/pricecalculation/TariffCalculator');
            this._tariffCalculator = TariffCalculator.getInstance(this.homey);
        }
        return this._tariffCalculator;
    }

    getPriceCalculationEngine() {
        if (!this._priceCalculationEngine) {
            const PriceCalculationEngine = require('../../helpers/pricecalculation/PriceCalculationEngine');
            this._priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
        }
        return this._priceCalculationEngine;
    }

    getDataValidator() {
        if (!this._dataValidator) {
            const DataValidator = require('../../helpers/DataValidator');
            this._dataValidator = DataValidator.getInstance(this.homey);
        }
        return this._dataValidator;
    }

    getCacheManager() {
        if (!this._cacheManager) {
            const CacheManager = require('../../helpers/CacheManager');
            this._cacheManager = CacheManager.getInstance(this.homey);
        }
        return this._cacheManager;
    }

    getLockManager() {
        if (!this._lockManager) {
            const LockManager = require('../../helpers/LockManager');
            this._lockManager = LockManager.getInstance(this.homey);
        }
        return this._lockManager;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro SpotPriceAPI');
        }
        SpotPriceAPI.homeyInstance = homey;
    }

    getCurrentTimeInfo() {
        const now = new Date();
        const options = { timeZone: this.homeyTimezone };
        
        let hour = parseInt(now.toLocaleString('en-US', { 
            ...options, 
            hour: 'numeric', 
            hour12: false 
        }));

        if (hour === 24) hour = 0;
        
        if (hour < 0 || hour > 23) {
            if (this.logger) this.logger.error('Neplatná hodina', { hour });
            hour = new Date().getHours();
        }

        if (this.logger) this.logger.debug('Časové informace', {
            hour,
            systemHour: new Date().getHours(),
            timezone: this.homeyTimezone
        });

        return {
            hour,
            date: now.toLocaleString('en-US', { 
                ...options, 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit' 
            }).split('/').reverse().join('')
        };
    }

    //Core metody
    async getDailyPrices(device) {
        if (!device || typeof device.triggerAPIFailure !== 'function') {
            const errorMessage = 'Neplatná device instance pro getDailyPrices';
            this.logger.error(errorMessage, new Error(errorMessage));
            throw new Error(errorMessage);
        }
    
        const timeInfo = this.getCurrentTimeInfo();
        const currentDate = timeInfo.date;
        const cacheManager = this.getCacheManager();
        const primaryCacheKey = `primary_dailyPrices_${currentDate}`;
        const backupCacheKey = `backup_dailyPrices_${currentDate}`;
    
        try {
            await device.setCapabilityValue('primary_api_fail', false);

            let primaryData = await this.fetchWithCache(
                primaryCacheKey,
                () => this.fetchAPI(`${this.baseUrl}/get-prices-json`),
                cacheManager
            );

            // Omezíme primaryData pouze na hoursToday s požadovanými klíči
            primaryData = primaryData.hoursToday.map(({ hour, priceCZK }) => ({ hour, priceCZK }));

            this.logger.debug('Primární data po zpracování', { primaryData });

            this.validatePriceData(primaryData);
            this.logger.debug('Data úspěšně získána z primárního API', {
                source: 'Primary API',
                sampleData: primaryData[0],
            });
    
            return primaryData.map(({ hour, priceCZK }) => ({ hour, priceCZK }));
    
        } catch (primaryError) {
            await device.setCapabilityValue('primary_api_fail', true);
            this.logger.debug('Selhalo primární API, přepínám na záložní API', {
                primaryError: primaryError.message,
            });
    
            try {
                const backupData = await this.fetchWithCache(
                    backupCacheKey,
                    () => this.fetchBackupData(device),
                    cacheManager
                );
    
                this.validatePriceData(backupData);
                this.logger.debug('Data úspěšně získána ze záložního API', {
                    source: 'Backup API',
                    sampleData: backupData[0],
                });
    
                return backupData.map(({ hour, priceCZK }) => ({ hour, priceCZK }));
            } catch (backupError) {
                this.logger.error('Selhalo i záložní API', {
                    primaryError: primaryError.message,
                    backupError: backupError.message,
                });
    
                await device.triggerAPIFailure({
                    primaryAPI: primaryError.message,
                    backupAPI: backupError.message,
                    willRetry: false,
                    maxRetriesReached: true,
                });
    
                throw new Error(`Selhání obou API: ${backupError.message}`);
            }
        }
    }
    
    async updateExchangeRate() {
        if (!this.lastRateUpdate || Date.now() - this.lastRateUpdate > 24 * 60 * 60 * 1000) {
            try {
                const { data } = await this.fetchAPI(this.exchangeRateUrl);
                if (data?.kurzy?.EUR?.dev_stred) {
                    this.exchangeRate = data.kurzy.EUR.dev_stred;
                    this.lastRateUpdate = Date.now();
                    this.logger.debug('Kurz aktualizován', { rate: this.exchangeRate });
                }
            } catch (error) {
                this.logger.debug('Použit výchozí kurz', { default: this.exchangeRate });
            }
        }
        return this.exchangeRate;
    }
    
    async updateCurrentValues(device) {
        const operationId = `update-${Date.now()}`;
        try {
            const lockAcquired = await this.getLockManager().acquireLock(device.getData().id, operationId);
            if (!lockAcquired) {
                this.logger.error('Nelze získat zámek pro aktualizaci', {
                    operationId,
                    deviceId: device.getData().id,
                });
                return false;
            }
    
            await device.setCapabilityValue('spot_price_update_status', false);
            const dailyPrices = await this.getDailyPrices(device);
    
            const processedPrices = dailyPrices.map(priceData => ({
                ...priceData,
                priceCZK: this.getPriceCalculationEngine().addDistributionPrice(
                    priceData.priceCZK,
                    device.getSettings(),
                    priceData.hour
                ),
            }));
    
            await device.updateAllPrices(processedPrices);
            await device.setAvailable();
            await device.setCapabilityValue('spot_price_update_status', true);
            await this.emitPriceUpdate(device);
    
            return true;
        } catch (error) {
            this.logger.error('Chyba při aktualizaci cen', error, {
                deviceId: device.getData().id,
                operationId,
            });
            return false;
        } finally {
            await this.getLockManager().releaseLock(device.getData().id, operationId);
        }
    }
    
    async emitPriceUpdate(device) {
        await this.homey.emit('spot_prices_updated', {
            deviceId: device.getData().id,
            currentPrice: await device.getCapabilityValue('measure_current_spot_price_CZK'),
            currentIndex: await device.getCapabilityValue('measure_current_spot_price_index'),
            averagePrice: await device.getCapabilityValue('daily_average_price'),
        });
    }

    // Pomocné metody
    async fetchWithCache(cacheKey, fetchFunction, cacheManager) {
        const cachedData = cacheManager.get(cacheKey);
        if (cachedData) {
            this.logger.debug('Načtena data z cache', { cacheKey });
            return cachedData;
        }
    
        const data = await fetchFunction();
        cacheManager.set(cacheKey, data, 'PRICE');
        return data;
    }
    
    async fetchAPI(url, timeoutMs = 10000) {
        let timeout;
        try {
            const source = axios.CancelToken.source();
            timeout = setTimeout(() => source.cancel(`Timeout po ${timeoutMs}ms`), timeoutMs);
    
            const { data } = await axios.get(url, {
                cancelToken: source.token,
                validateStatus: status => status === 200,
            });
    
            this.logger.debug('Úspěšná odpověď z API', { url, sample: data });
            return data;
        } catch (error) {
            const errorMessage = axios.isCancel(error)
                ? 'Timeout při volání API'
                : error.response
                    ? `HTTP error: ${error.response.status}`
                    : 'Neočekávaná chyba API';
    
            this.logger.error(errorMessage, { url, error });
            throw new Error(errorMessage);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }
    
    validatePriceData(data) {
        if (!this.getDataValidator().validatePriceData(data)) {
            throw new Error('Neplatný formát dat');
        }
    }

    async fetchPrimaryData() {
        const response = await this.fetchAPI(`${this.baseUrl}/get-prices-json`);
        
        if (!response?.hoursToday || response.hoursToday.length !== 24) {
            throw new Error('Neplatná struktura dat z primárního API');
        }
    
        this.logger.debug('Data získána z primárního API', {
            sample: response.hoursToday[0],
        });
    
        return response.hoursToday.map(hourData => {
            if (typeof hourData.hour !== 'number' || typeof hourData.priceCZK !== 'number') {
                throw new Error('Neplatný formát dat v primárním API');
            }
            return {
                hour: hourData.hour,
                priceCZK: hourData.priceCZK,
            };
        });
    }       
    
    async fetchBackupData() {
        const response = await this.fetchAPI(this.backupUrl, 10000);
    
        if (!response?.data?.dataLine) {
            throw new Error('Neplatná odpověď záložního API');
        }
    
        const dataLine = response.data.dataLine.find(line => line.title === "Cena (EUR/MWh)");
        if (!dataLine || !Array.isArray(dataLine.point)) {
            throw new Error('Chybí očekávaná data v odpovědi záložního API');
        }
    
        const exchangeRate = await this.updateExchangeRate();
        this.logger.debug('Kurz pro záložní API', { exchangeRate });
    
        return this.convertPrices(dataLine.point, exchangeRate);
    }       
    
    convertPrices(points, exchangeRate) {
        const hourMap = new Map([...Array(24)].map((_, i) => [i + 1, i === 24 ? 0 : i]));
    
        return points.slice(0, 24).map(point => {
            const inputHour = parseInt(point.x, 10);
            if (!hourMap.has(inputHour)) {
                this.logger.error(`Neplatná vstupní hodina: ${inputHour}`, { point });
                throw new Error(`Neplatná vstupní hodina: ${inputHour}`);
            }
    
            const hour = hourMap.get(inputHour);
            const priceEUR = parseFloat(point.y);
            if (isNaN(priceEUR)) {
                this.logger.error(`Neplatná cena pro hodinu ${inputHour}: ${point.y}`, { point });
                throw new Error(`Neplatná cena pro hodinu ${inputHour}: ${point.y}`);
            }
    
            const priceCZK = priceEUR * exchangeRate;
    
            return {
                hour,
                priceCZK: parseFloat(priceCZK.toFixed(2)),
                priceEur: priceEUR,
            };
        }).sort((a, b) => a.hour - b.hour);
    }
}

module.exports = SpotPriceAPI;    

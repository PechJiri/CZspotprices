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

    async updateExchangeRate() {
        if (!this.lastRateUpdate || Date.now() - this.lastRateUpdate > 24 * 60 * 60 * 1000) {
            try {
                const { data } = await axios.get(this.exchangeRateUrl);
                if (data?.kurzy?.EUR?.dev_stred) {
                    this.exchangeRate = data.kurzy.EUR.dev_stred;
                    this.lastRateUpdate = Date.now();
                    this.logger?.debug('Kurz aktualizován', { rate: this.exchangeRate });
                }
            } catch (error) {
                this.logger?.warn('Použit výchozí kurz', { default: this.exchangeRate });
            }
        }
        return this.exchangeRate;
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

    async handleApiError(error, device, context = 'API') {
        const errorMessage = error instanceof Error ? 
            `${error.name}: ${error.message}` : 
            typeof error === 'string' ? error : 
            typeof error === 'object' && error !== null ? JSON.stringify(error) : 
            'Unknown error';

        this.logger?.error(`${context}: Chyba`, error, {
            errorMessage,
            deviceId: device?.id || 'N/A',
            deviceName: device?.name || 'N/A',
            stack: error?.stack
        });

        if (device?.triggerAPIFailure) {
            await device.triggerAPIFailure({
                primaryAPI: errorMessage,
                backupAPI: '',
                willRetry: false,
                maxRetriesReached: true
            });
        }

        return errorMessage;
    }

    async getDailyPrices(device) {
        if (!device || typeof device.triggerAPIFailure !== 'function') {
            const errorMessage = 'Neplatná device instance pro getDailyPrices';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage));
            }
            throw new Error(errorMessage);
        }
    
        const cacheManager = this.getCacheManager();
        const timeoutMs = 10000;
    
        try {
            await device.setCapabilityValue('primary_api_fail', false);
    
            // Generování cache klíče pro primární API
            const currentDate = new Date().toISOString().split('T')[0];
            const primaryCacheKey = `primary_dailyPrices_${currentDate}`;
    
            // Pokus načíst z cache (primární API)
            const cachedPrimaryData = cacheManager.get(primaryCacheKey);
            if (cachedPrimaryData) {
                this.logger?.debug('Načtena data z cache (primární API)', { cacheKey: primaryCacheKey });
                return cachedPrimaryData;
            }
    
            // Získání dat z primárního API
            const rawData = await this._fetchFromPrimaryAPI(timeoutMs);
            if (!rawData) {
                this.logger.error('Chyba: data jsou undefined po volání _fetchFromPrimaryAPI');
                throw new Error('Data z primárního API jsou undefined');
            }
    
            const data = rawData.map(hourData => ({
                hour: hourData.hour,
                priceCZK: hourData.priceCZK
            }));
    
            if (!this.getDataValidator().validatePriceData(data)) {
                throw new Error('Neplatný formát dat z primárního API');
            }
    
            // Uložení do cache (primární API)
            cacheManager.set(primaryCacheKey, data, 'PRICE');
    
            this.logger?.log('Data úspěšně získána z primárního API', {
                source: 'Primary API',
                sampleData: data[0]
            });
    
            return data;
    
        } catch (primaryError) {
            // Pokud selže primární API, zkusíme záložní
            await device.setCapabilityValue('primary_api_fail', true);
    
            try {
                this.logger?.log('Primární API selhalo, přepínám na záložní API', {
                    primaryError: primaryError.message
                });
    
                // Generování cache klíče pro záložní API
                const currentDate = new Date().toISOString().split('T')[0];
                const backupCacheKey = `backup_dailyPrices_${currentDate}`;
    
                // Pokus načíst z cache (záložní API)
                const cachedBackupData = cacheManager.get(backupCacheKey);
                if (cachedBackupData) {
                    this.logger?.debug('Načtena data z cache (záložní API)', { cacheKey: backupCacheKey });
                    return cachedBackupData;
                }
    
                // Získání dat ze záložního API
                const rawBackupData = await this.getBackupDailyPrices(device);
    
                this.logger?.debug('Data získána ze záložního API', {
                    dataLength: rawBackupData?.length,
                    sample: rawBackupData?.[0]
                });
    
                const backupData = rawBackupData.map(({ hour, priceCZK }) => ({ hour, priceCZK }));
    
                if (!this.getDataValidator().validatePriceData(backupData)) {
                    throw new Error('Neplatný formát dat ze záložního API');
                }
    
                // Uložení do cache (záložní API)
                cacheManager.set(backupCacheKey, backupData, 'PRICE');
    
                await device.triggerAPIFailure({
                    primaryAPI: await this.handleApiError(primaryError, device, 'Primary API'),
                    backupAPI: 'Záložní API úspěšné',
                    willRetry: true,
                    retryCount: 0,
                    nextRetryIn: '60'
                });
    
                this.logger?.log('Úspěšně přepnuto na záložní API');
                return backupData;
    
            } catch (backupError) {
                this.logger?.error('Selhalo i záložní API', {
                    primaryError: primaryError.message,
                    backupError: backupError.message
                });
    
                const errorMessage = await this.handleApiError(backupError, device, 'Backup API');
    
                await device.triggerAPIFailure({
                    primaryAPI: await this.handleApiError(primaryError, device, 'Primary API'),
                    backupAPI: errorMessage,
                    willRetry: false,
                    maxRetriesReached: true
                });
    
                throw new Error(`Selhání obou API: ${errorMessage}`);
            }
        }
    }    

    async _fetchFromPrimaryAPI(timeoutMs) {
        const url = `${this.baseUrl}/get-prices-json`;
        let timeout;
    
        try {
            const source = axios.CancelToken.source();
            timeout = setTimeout(() => source.cancel(`Timeout po ${timeoutMs}ms`), timeoutMs);
    
            const { data } = await axios.get(url, { 
                cancelToken: source.token,
                validateStatus: status => status === 200
            });
    
            this.logger?.debug('Kompletní odpověď z API', { data });
    
            if (data?.hoursToday?.length !== 24) {
                throw new Error('Neplatná struktura dat z API');
            }
    
            this.logger?.debug('Data získána z primárního API', {
                url,
                sampleData: data.hoursToday[0]
            });
    
            return data.hoursToday;
        } catch (error) {
            const errorMessage = axios.isCancel(error) ? 
                'Timeout při volání API' : 
                error.response ? 
                    `HTTP error: ${error.response.status}` : 
                    'Neočekávaná chyba API';
    
            this.logger?.error(errorMessage, error, { url });
            throw new Error(errorMessage);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }    

    async updateCurrentValues(device) {
        const operationId = `update-${Date.now()}`;
    
        try {
            const lockAcquired = await this.getLockManager().acquireLock(device.getData().id, operationId);
                if (!lockAcquired) {
                    this.logger?.warn('Nelze získat zámek pro aktualizaci', {
                        operationId,
                        deviceId: device.getData().id
                    });
                    return false;
                }
    
            try {
                await device.setCapabilityValue('spot_price_update_status', false);
                const dailyPrices = await this.getDailyPrices(device);
                
                const processedPrices = dailyPrices.map(priceData => ({
                    ...priceData,
                    priceCZK: this.priceCalculationEngine.addDistributionPrice(
                        priceData.priceCZK, 
                        device.getSettings(),
                        priceData.hour
                    )
                }));
    
                await device.updateAllPrices(processedPrices);
                await device.setAvailable();
                await device.setCapabilityValue('spot_price_update_status', true);
    
                await this.emitPriceUpdate(device);
                
                return true;
    
            } finally {
                await this.lockManager.releaseLock(device.getData().id, operationId);
            }
    
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při aktualizaci cen', error, {
                    deviceId: device.getData().id,
                    operationId
                });
            }
            return false;
        }
    }
    
    async emitPriceUpdate(device) {
        await this.homey.emit('spot_prices_updated', {
            deviceId: device.getData().id,
            currentPrice: await device.getCapabilityValue('measure_current_spot_price_CZK'),
            currentIndex: await device.getCapabilityValue('measure_current_spot_index'),
            averagePrice: await device.getCapabilityValue('daily_average_price')
        });
    }
    
    async isUpdateInProgress(device) {
        const updatingLock = await device.getStoreValue('updatingLock');
        return updatingLock === true;
    }
    
    async acquireUpdateLock() {
        await this.setStoreValue('updatingLock', true);
        return true;
    }
    
    async releaseUpdateLock() {
        await this.setStoreValue('updatingLock', false);
    }
    
    async initializeUpdate(device) {
        await device.setCapabilityValue('spot_price_update_status', false);
        this.logger?.log('=== ZAČÁTEK AKTUALIZACE SOUČASNÝCH HODNOT ===', {
            deviceId: device.getData().id,
            timestamp: new Date().toISOString()
        });
    }
    
    async fetchAndValidateData(device) {
        const dailyPrices = await this.getDailyPrices(device);
        if (!Array.isArray(dailyPrices) || dailyPrices.length !== 24) {
            throw new Error(`Neplatná data z API: Očekáváno 24 záznamů, získáno ${dailyPrices?.length}`);
        }
        return dailyPrices;
    }
    
    async processAndUpdatePrices(device, dailyPrices) {
        try {
            const processedPrices = await this.processPrices(dailyPrices, device);
            await device.setAvailable();
            await device.setCapabilityValue('spot_price_update_status', true);
            await this.emitUpdateEvent(device);
        } catch (error) {
            throw new Error('Chyba při zpracování cen: ' + error.message);
        }
    }
    
    async processPrices(dailyPrices, device) {
        const settings = device.getSettings();
        return dailyPrices.map(priceData => ({
            ...priceData,
            priceCZK: this.getPriceCalculationEngine().addDistributionPrice(priceData.priceCZK, settings, priceData.hour)
        }));
    }
    
    async emitUpdateEvent(device) {
        await this.homey.emit('spot_prices_updated', {
            deviceId: device.getData().id,
            currentPrice: await device.getCapabilityValue('measure_current_spot_price_CZK'),
            currentIndex: await device.getCapabilityValue('measure_current_spot_index'),
            averagePrice: await device.getCapabilityValue('daily_average_price')
        });
    }
    
    async handleUpdateError(device, error) {
        this.logger?.error('Kritická chyba v updateCurrentValues', {
            error: {
                message: error.message,
                stack: error.stack
            },
            deviceId: device.getData().id
        });
        
        await device.triggerAPIFailure({
            primaryAPI: error.message,
            backupAPI: '',
            willRetry: true,
            retryCount: 0,
            nextRetryIn: '5',
            maxRetriesReached: false
        });
    }
    
    async getBackupDailyPrices(device) {
        const cacheManager = this.getCacheManager(); // Použití getteru pro práci s cache
    
        try {
            this.logger?.debug('Začínám získávat data ze záložního API');
    
            // Získání aktuálního času a validace výstupu
            const timeInfo = this.getCurrentTimeInfo();
            if (!timeInfo || !timeInfo.date || typeof timeInfo.hour !== 'number') {
                throw new Error('Chyba při získávání aktuálního času: neplatné časové informace');
            }
    
            const cacheKey = `backupDailyPrices_${timeInfo.date}`;
            
            // Pokus o načtení dat ze záložní cache
            const cachedData = cacheManager.get(cacheKey);
            if (cachedData) {
                this.logger?.debug('Načtena data ze záložního API z cache', { cacheKey });
                return cachedData;
            }
    
            // Inicializace záložního API
            await this.initializeBackupFetch();
            const exchangeRate = await this.updateExchangeRate();
            this.logger?.debug('Exchange rate aktualizován', { exchangeRate: this.exchangeRate });
    
            this.logger?.debug('Získané parametry pro záložní API', {
                exchangeRate,
                timeInfo,
            });
    
            // Načtení dat ze záložního API
            const rawData = await this.fetchBackupData(timeInfo);
    
            this.logger?.debug('Získána raw data ze záložního API', {
                hasData: !!rawData,
                dataStructure: rawData?.data ? Object.keys(rawData.data) : null,
            });
    
            // Validace základní struktury dat
            if (!this.getDataValidator().validateBackupApiResponse(rawData)) {
                throw new Error('Neplatná základní struktura dat ze záložního API');
            }
    
            // Zpracování dat
            const prices = await this.processBackupData(rawData, exchangeRate);
    
            this.logger?.debug('Zpracovaná data ze záložního API', {
                pricesCount: prices?.length,
                samplePrice: prices?.[0],
            });
    
            // Validace zpracovaných dat
            if (!this.getDataValidator().validatePriceData(prices)) {
                throw new Error('Neplatná cenová data po zpracování záložního API');
            }
    
            // Uložení zpracovaných dat do cache
            cacheManager.set(cacheKey, prices, 'PRICE');
    
            this.logger?.log('Data úspěšně uložena do cache pro záložní API', {
                cacheKey,
                sampleData: prices[0],
            });
    
            return prices;
        } catch (error) {
            this.logger?.error('Chyba při získávání dat ze záložního API', error, {
                stack: error.stack,
            });
            throw error;
        }
    }            
    
    async initializeBackupFetch() {
        this.logger?.debug('Začátek získávání cen ze záložního API', { 
            url: this.backupUrl 
        });
    }
    
    async fetchBackupData(timeInfo) {
        this.logger?.debug('Volání záložního API', { url: this.backupUrl, date: timeInfo.date });
        const response = await axios.get(this.backupUrl, {
            params: { report_date: timeInfo.date }
        });
        return response.data;
    }
    
    async processBackupData(data, exchangeRate) {
        const dataLine = data?.data?.dataLine.find(line => 
            line.title === "Cena (EUR/MWh)");
    
        if (!this.getDataValidator().validateBackupDataStructure(data)) {
            throw new Error('Neplatná struktura dat ze záložního API');
        }
    
        // Validace jednotlivých bodů v datech
        if (!this.getDataValidator().validatePriceLine(dataLine)) {
            throw new Error('Neplatná dataLine struktura nebo data neobsahují platné hodnoty');
        }
    
        return this.convertPrices(dataLine.point, exchangeRate);
    }
    
    convertPrices(points, exchangeRate) {
        const hourMap = new Map([...Array(24)].map((_, i) => [i + 1, i === 24 ? 0 : i]));
    
        return points.slice(0, 24).map(point => {
            const inputHour = parseInt(point.x, 10);
            if (!hourMap.has(inputHour)) {
                throw new Error(`Neplatná vstupní hodina: ${inputHour}`);
            }
    
            const hour = hourMap.get(inputHour);
            const priceEUR = parseFloat(point.y);
            if (isNaN(priceEUR)) {
                throw new Error(`Neplatná cena pro hodinu ${inputHour}: ${point.y}`);
            }
    
            const priceCZK = priceEUR * exchangeRate;
    
            return {
                hour,
                priceCZK: parseFloat(priceCZK.toFixed(2)),
                priceEur: priceEUR
            };
        }).sort((a, b) => a.hour - b.hour);
    }
    
    handleBackupError(error) {
        this.logger?.error('Chyba při získávání cen ze záložního API', error, {
            url: this.backupUrl,
            exchangeRate: this.exchangeRate
        });
    }
}

module.exports = SpotPriceAPI;
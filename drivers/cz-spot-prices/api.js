'use strict';

const axios = require('axios');
const PriceCalculator = require('../../helpers/pricecalculation/PriceCalculator');
const TariffCalculator = require('../../helpers/pricecalculation/TariffCalculator');
const PriceCalculationEngine = require('../../helpers/pricecalculation/PriceCalculationEngine');
const DataValidator = require('../../helpers/DataValidator');
const CacheManager = require('../../helpers/CacheManager');
const Logger = require('../../helpers/Logger');

class SpotPriceAPI {
    // Statická proměnná pro uložení jediné instance
    static instance = null;
    static CONTEXT = 'SpotPriceAPI';

    // Statická metoda pro získání nebo vytvoření instance
    static getInstance(homey) {
        if (!SpotPriceAPI.instance) {
            SpotPriceAPI.instance = new SpotPriceAPI(homey);
        }
        return SpotPriceAPI.instance;
    }

    constructor(homeyInstance, deviceContext = SpotPriceAPI.CONTEXT) {
        if (SpotPriceAPI.instance) {
            throw new Error('Použijte SpotPriceAPI.getInstance() místo volání new SpotPriceAPI().');
        }
        
        this.homey = homeyInstance;
        
        if (!this.homey) {
            throw new Error('Homey instance není dostupná');
        }
    
        // Inicializace loggeru
        this.logger = Logger.getInstance()
        
        if (!this.logger) {
            throw new Error('Logger inicializace selhala');
        }
    
        this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
        const today = new Date().toISOString().slice(0, 10);
        this.backupUrl = `https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data?date=${today}`;
        this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
        this.exchangeRate = 25.25;
        this.homeyTimezone = this.homey.clock.getTimezone();
    
        // Inicializace ostatních pomocných tříd
        try {
            this.priceCalculator = PriceCalculator.getInstance(this.homey, 'PriceCalculator');
            this.tariffCalculator = TariffCalculator.getInstance(this.homey, 'TariffCalculator');
            this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey, 'PriceCalculatorEngine');
            this.dataValidator = DataValidator.getInstance(this.homey, 'DataValidator');
            this.cacheManager = CacheManager.getInstance(this.homey, 'CacheManager');
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při inicializaci pomocných tříd', error);
            }
            throw error;
        }
        
        this.logger.debug('SpotPriceAPI inicializován');
    }
    
    static getInstance(homey) {
        if (!SpotPriceAPI.instance) {
            SpotPriceAPI.instance = new SpotPriceAPI(homey);
        }
        return SpotPriceAPI.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro SpotPriceAPI');
        }
        SpotPriceAPI.homeyInstance = homey;
    }

  async updateExchangeRate() {
    try {
        if (this.logger) this.logger.debug('Aktualizace směnného kurzu');
        const response = await axios.get(this.exchangeRateUrl);
        const data = response.data;
        if (data && data.kurzy && data.kurzy.EUR) {
            this.exchangeRate = data.kurzy.EUR.dev_stred;
            if (this.logger) this.logger.log('Směnný kurz aktualizován', { 
                newRate: this.exchangeRate 
            });
        }
    } catch (error) {
        if (this.logger) this.logger.error('Chyba při aktualizaci směnného kurzu', error);
    }
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

  getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (typeof error === 'object' && error !== null) return JSON.stringify(error);
    return 'Unknown error';
  }

  handleApiError(context, error, device) {
    let errorMessage = this.getErrorMessage(error);
    
    // Logování chyby
    if (this.logger) {
        this.logger.error(`${context}: API chyba`, error, { 
            errorMessage, 
            deviceId: device ? device.id : 'N/A', 
            deviceName: device ? device.name : 'N/A' 
        });
    } else {
        this.homey.error(`${context}:`, errorMessage);
    }

    // Použití nové metody z device
    if (device && typeof device.triggerAPIFailure === 'function') {
        device.triggerAPIFailure({
            primaryAPI: errorMessage,
            backupAPI: '',
            willRetry: false,
            maxRetriesReached: true
        });
    }
  }

  // Nové metody využívající PriceCalculator
  async getDailyPrices(device) {
    if (!device || typeof device.triggerAPIFailure !== 'function') {
        const errorMessage = 'Neplatná device instance pro getDailyPrices';
        if (this.logger) {
            this.logger.error(errorMessage, new Error(errorMessage));
        }
        throw new Error(errorMessage);
    }

    const timeoutMs = 10000;
    let spotElektrinaError = null;
    let oteError = null;

    try {
        // Výchozí stav - normálně získáváme data z primárního API
        await device.setCapabilityValue('primary_api_fail', false);

        if (this.logger) {
            this.logger.debug('Pokus o získání dat z primárního API (spotovaelektrina.cz)');
        }

        const rawData = await this._fetchFromPrimaryAPI(timeoutMs);

        if (!rawData) {
            this.logger.error('Chyba: data jsou undefined po volání _fetchFromPrimaryAPI');
            throw new Error('Data z primárního API jsou undefined');
        }

        // Transformace dat - pouze hour a priceCZK
        const data = rawData.map(hourData => ({
            hour: hourData.hour,
            priceCZK: hourData.priceCZK
            // Úmyslně vynecháváme level z API
        }));

        if (!this.dataValidator.validatePriceData(data)) {
            throw new Error('Neplatný formát dat z primárního API');
        }

        if (this.logger) {
            this.logger.log('Data úspěšně získána z primárního API', { 
                source: 'Primary API',
                sampleData: data[0] // Log prvního záznamu pro kontrolu
            });
        }

        return data;

    } catch (error) {
        spotElektrinaError = error;
        
        if (this.logger) {
            this.logger.error('Chyba primárního API', error, { 
                context: 'getDailyPrices', 
                deviceId: device.id 
            });
        }

        // Primární API selhalo - přepneme na záložní API
        await device.setCapabilityValue('primary_api_fail', true);

        try {
            if (this.logger) {
                this.logger.debug('Pokus o získání dat ze záložního API (ote.cr)');
            }

            const rawBackupData = await this.getBackupDailyPrices(device);

            // Transformace záložních dat - opět pouze hour a priceCZK
            const backupData = rawBackupData.map(hourData => ({
                hour: hourData.hour,
                priceCZK: hourData.priceCZK
                // Opět vynecháváme jakékoliv levely
            }));

            if (!this.dataValidator.validatePriceData(backupData)) {
                throw new Error('Neplatný formát dat ze záložního API');
            }

            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: 'Záložní API úspěšné',
                willRetry: true,
                retryCount: 0,
                nextRetryIn: '60'
            });

            if (this.logger) {
                this.logger.log('Data úspěšně získána ze záložního API', { 
                    source: 'Backup API',
                    sampleData: backupData[0] // Log prvního záznamu pro kontrolu
                });
            }

            // Ponecháme primary_api_fail na true, protože stále používáme záložní API
            return backupData;

        } catch (backupError) {
            oteError = backupError;

            if (this.logger) {
                this.logger.error('Selhání záložního API', backupError, { 
                    context: 'getDailyPrices', 
                    deviceId: device.id 
                });
            }

            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: this.getErrorMessage(oteError),
                willRetry: false,
                maxRetriesReached: true
            });

            // Ponecháme primary_api_fail na true, protože primární API stále nefunguje
            throw new Error(`Selhání obou API: spotovaelektrina.cz: ${this.getErrorMessage(spotElektrinaError)}, ote.cr: ${this.getErrorMessage(oteError)}`);
        }
    }
}

// Pomocná metoda pro volání primárního API
async _fetchFromPrimaryAPI(timeoutMs) {
    const url = `${this.baseUrl}/get-prices-json`;
    let timeout;

    if (this.logger) {
        this.logger.debug('Volání primárního API pro získání cen', { url, timeoutMs });
    }

    try {
        const source = axios.CancelToken.source();
        timeout = setTimeout(() => {
            source.cancel(`Timeout při volání primárního API po ${timeoutMs}ms`);
        }, timeoutMs);

        const response = await axios.get(url, { cancelToken: source.token });
        clearTimeout(timeout);

        if (response.status !== 200) {
            const errorMessage = `HTTP error! status: ${response.status}`;
            if (this.logger) {
                this.logger.error('Chyba při volání primárního API', new Error(errorMessage), { url, status: response.status });
            }
            throw new Error(errorMessage);
        }

        const data = response.data;

        // Ověření struktury dat
        if (!data.hoursToday || !Array.isArray(data.hoursToday) || data.hoursToday.length !== 24) {
            const invalidDataError = new Error('Neplatná struktura dat z API');
            if (this.logger) {
                this.logger.error('Neplatná struktura dat z primárního API', invalidDataError, { 
                    url,
                    receivedData: data // Log celého objektu bez ořezání při chybě
                });
            }
            throw invalidDataError;
        }

        // Vrátíme pouze pole `hoursToday`
        return data.hoursToday;

    } catch (error) {
        if (axios.isCancel(error)) {
            const timeoutError = new Error('Timeout při volání API');
            if (this.logger) {
                this.logger.error('Timeout při volání primárního API', timeoutError, { url, timeoutMs });
            }
            throw timeoutError;
        }

        if (this.logger) {
            this.logger.error('Neočekávaná chyba při volání primárního API', error, { url });
        }
        throw error;

    } finally {
        if (timeout) clearTimeout(timeout);
    }
    }

    async updateCurrentValues(device) {
        const operationId = `update-${Date.now()}`;
        
        if (!this.initialized) {
            this.priceCalculator = PriceCalculator.getInstance(this.homey, 'PriceCalculator');
            this.initialized = true;
        }
    
        try {
            const lockAcquired = await this.lockManager.acquireLock(device.getData().id, operationId);
            if (!lockAcquired) {
                if (this.logger) {
                    this.logger.warn('Nelze získat zámek pro aktualizaci - jiná operace probíhá', {
                        operationId,
                        lockInfo: this.lockManager.getLockInfo(device.getData().id)
                    });
                }
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
            await this.updateDeviceValues(device, processedPrices);
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
            priceCZK: this.priceCalculationEngine.addDistributionPrice(priceData.priceCZK, settings, priceData.hour)
        }));
    }
    
    async updateDeviceValues() {
        // Implementace aktualizace hodnot zařízení
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
    
    async getBackupDailyPrices() {
        try {
            await this.initializeBackupFetch();
            const exchangeRate = await this.updateExchangeRate();
            const timeInfo = this.getCurrentTimeInfo();
            const rawData = await this.fetchBackupData(timeInfo);
            const prices = await this.processBackupData(rawData, exchangeRate);
            return this.validateAndFormatPrices(prices);
        } catch (error) {
            this.handleBackupError(error);
            throw error;
        }
    }
    
    async initializeBackupFetch() {
        this.logger?.debug('Začátek získávání cen ze záložního API', { 
            url: this.backupUrl 
        });
    }
    
    async fetchBackupData(timeInfo) {
        const response = await axios.get(this.backupUrl, {
            params: { report_date: timeInfo.date }
        });
        return response.data;
    }
    
    async processBackupData(data, exchangeRate) {
        const dataLine = data?.data?.dataLine.find(line => 
            line.title === "Cena (EUR/MWh)");
            
        if (!this.isValidDataLine(dataLine)) {
            throw new Error('Invalid data structure from backup API');
        }
        
        return this.convertPrices(dataLine.point, exchangeRate);
    }
    
    isValidDataLine(dataLine) {
        return dataLine && Array.isArray(dataLine.point) && dataLine.point.length >= 24;
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
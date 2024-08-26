'use strict';

const { Driver } = require('homey');
const SpotPriceAPI = require('./api'); // Import API třídy

class CZSpotPricesDriver extends Driver {

    async onInit() {
        this.log('CZSpotPricesDriver has been initialized');
        this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];

        // Registrace Flow karet
        this.registerFlowCards();
    }

    registerFlowCards() {
        this._registerTriggerFlowCards();
        this._registerConditionFlowCards();
    }

    _registerTriggerFlowCards() {
        this.log('Registering trigger Flow cards...');
        try {
            this.homey.flow.getTriggerCard('current_price_lower_than_trigger');
            this.homey.flow.getTriggerCard('current_price_higher_than_trigger');
            this.homey.flow.getTriggerCard('current_price_index_trigger');
            this.log('Trigger Flow cards registered successfully.');
        } catch (error) {
            this.log('Error registering trigger Flow cards:', error);
        }
    }

    _registerConditionFlowCards() {
        this.log('Registering condition Flow cards...');
        try {
            this._registerConditionCard('price_lower_than_condition', 'current_spot_price_CZK');
            this._registerConditionCard('price_higher_than_condition', 'current_spot_price_CZK');
            this._registerConditionCard('price_index_is_condition', 'current_spot_index');
            this.log('Condition Flow cards registered successfully.');
        } catch (error) {
            this.log('Error registering condition Flow cards:', error);
        }
    }

    _registerConditionCard(cardId, capability) {
        this.log(`Registering condition card ${cardId}...`);
        this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
            const device = state.device;
            const currentValue = await device.getCapabilityValue(capability);
            this.log(`Running condition card ${cardId} with capability ${capability}. Current value: ${currentValue}, Args value: ${args.value}`);
            return currentValue === args.value;
        });
    }

    async saveTariffInterval(args) {
        const { tariff_from, tariff_to } = args;

        this.tariffIntervals.push({
            interval_from: tariff_from,
            interval_to: tariff_to
        });

        await this.homey.settings.set('tariff_intervals', this.tariffIntervals);
        return true;
    }

    async deleteTariffInterval(args, intervalIndex) {
        this.tariffIntervals.splice(intervalIndex, 1);
        await this.homey.settings.set('tariff_intervals', this.tariffIntervals);
        return true;
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.log('CZSpotPricesDriver settings were changed');

        if (changedKeys.includes('update_interval')) {
            const updateInterval = newSettings.update_interval || 1;
            this.startDataFetchInterval(updateInterval);
        }

        if (changedKeys.includes('tariff_intervals')) {
            this.tariffIntervals = newSettings.tariff_intervals || [];
        }

        this.updateCapabilities();
    }

    startDataFetchInterval(interval) {
        if (this.dataFetchInterval) {
            this.homey.clearInterval(this.dataFetchInterval);
        }

        this.dataFetchInterval = this.homey.setInterval(async () => {
            await this.updateCurrentValues();
        }, interval * 60 * 60 * 1000);
    }

    async updateCapabilities() {
        const lowTariffPrice = this.homey.settings.get('low_tariff_price');
        const highTariffPrice = this.homey.settings.get('high_tariff_price');
        const tariffHours = this.tariffIntervals;

        const api = new SpotPriceAPI(this.homey);
        await api.updateCapabilities(this.getDevice(), lowTariffPrice, highTariffPrice, tariffHours);
    }

    async updateCurrentValues() {
        const api = new SpotPriceAPI(this.homey);
        await api.updateCurrentValues(this.getDevice());
    }

    onPair(session) {
        this.log("onPair() called");

        session.setHandler("list_devices", async () => {
            this.log("list_devices handler called");
            return await this.onPairListDevices();
        });

        session.setHandler("check", async (data) => {
            this.log("check handler called with data:", data);
            return await this.onCheck(data);
        });

        session.setHandler("settingsChanged", async (data) => {
            this.log("settingsChanged handler called with data:", data);
            this.tariffIntervals = data.tariff_intervals || [];
            this.log("Updated tariffIntervals:", this.tariffIntervals);
        });
    }

    async onPairListDevices() {
        this.log("onPairListDevices called");
        try {
            return [{ name: 'CZ Spot Prices Device', data: { id: 'cz_spot_prices_device' } }];
        } catch (error) {
            this.log("Error during pairing:", error);
            throw error;
        }
    }

    async onCheck(data) {
        this.log("onCheck called with data:", data);
        return this.homey.__("pair.connection_ok");
    }
}

module.exports = CZSpotPricesDriver;
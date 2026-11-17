'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Logger = require('../helpers/Logger');
const DataValidator = require('../helpers/DataValidator');
const CacheManager = require('../helpers/CacheManager');
const PriceCalculator = require('../helpers/pricecalculation/PriceCalculator');
const PriceCalculationEngine = require('../helpers/pricecalculation/PriceCalculationEngine');
const CapabilityManager = require('../helpers/CapabilityManager');

const homey = { log() {}, error() {}, clock: { getTimezone: () => 'Europe/Prague' } };
Logger.getInstance(homey);
Logger.setEnabled(false);
const validator = DataValidator.getInstance(homey);

function prices() {
    return Array.from({ length: 96 }, (_, i) => ({
        hour: Math.floor(i / 4), minute: i % 4 * 15, priceCZK: i - 10, level: 'medium'
    }));
}

function calculator() {
    const instance = new PriceCalculator(homey);
    const cache = Object.create(CacheManager.prototype);
    cache.caches = new Map();
    cache.logger = Logger.getInstance();
    instance._cacheManager = cache;
    return instance;
}

for (const input of [null, undefined, {}]) {
    test(`index validation retains useful errors for ${String(input)}`, () => {
        const result = validator.validateIndexData(input, 8, 8);
        assert.equal(result.isValid, false);
        assert.ok(result.errors.includes('Data nejsou pole'));
    });

    test(`index calculation safely rejects ${String(input)}`, () => {
        assert.deepEqual(calculator().setIndexes(input, 8, 8), []);
    });
}

test('malformed slots retain batch validation errors', () => {
    const result = validator.validateIndexData([null], 8, 8);
    assert.equal(result.isValid, false);
    assert.match(result.errors.join(' '), /počet slotů/);
    assert.doesNotMatch(result.errors.join(' '), /Cannot read/);
});

test('duplicate slots are rejected and valid negative prices retain indexes and ordering', () => {
    const duplicate = prices();
    duplicate[1] = { ...duplicate[0] };
    assert.equal(validator.validateIndexData(duplicate, 8, 8).isValid, false);
    const input = prices();
    const snapshot = JSON.stringify(input);
    const result = calculator().setIndexes(input, 8, 8);
    assert.equal(result.length, 96);
    assert.deepEqual(result[0], { hour: 0, minute: 0, priceCZK: -10, level: 'low' });
    assert.deepEqual(result[95], { hour: 23, minute: 45, priceCZK: 85, level: 'high' });
    assert.equal(result.filter(slot => slot.level === 'low').length, 8);
    assert.equal(result.filter(slot => slot.level === 'high').length, 8);
    assert.equal(JSON.stringify(input), snapshot);
});

test('invalid arrays retain the unknown-index fallback without mutation', () => {
    const input = [{ hour: 0, minute: 0, priceCZK: 12 }];
    assert.deepEqual(calculator().setIndexes(input, 8, 8), [
        { hour: 0, minute: 0, priceCZK: 12, level: 'unknown' }
    ]);
    assert.equal(input[0].level, undefined);
});

function device(options = {}) {
    const values = new Map([['low_tariff', options.previousTariff ?? false]]);
    const triggers = [];
    const engine = Object.create(PriceCalculationEngine.prototype);
    engine.validator = validator;
    engine.logger = Logger.getInstance();
    const instance = {
        spotPriceApi: { getCurrentTimeInfo: () => options.time ?? { hour: 0, minute: 0 } },
        priceCalculationEngine: engine,
        getSetting: () => true,
        getSettings: () => ({}),
        getCapabilityValue: name => values.get(name),
        async setCapabilityValue(name, value) {
            await new Promise(resolve => setImmediate(resolve));
            if (options.failWrite === name) throw new Error('capability write failed');
            values.set(name, value);
        },
        tariffCalculator: { isLowTariff: () => true },
        triggersManager: {
            getTrigger: () => options.missingTrigger ? null : {
                async trigger(tokens, state) {
                    assert.equal(values.get('low_tariff'), true);
                    assert.ok(values.has('measure_current_price'));
                    triggers.push(state);
                    if (options.failTrigger) throw new Error('trigger failed');
                }
            }
        }
    };
    if (options.noTariff) delete instance.tariffCalculator;
    return { instance, values, triggers };
}

function capabilities() {
    return CapabilityManager.getInstance(homey);
}

test('zero next price is published and tariff trigger follows successful capability writes', async () => {
    const input = prices();
    input[0].priceCZK = -125;
    input[1].priceCZK = 0;
    const { instance, values, triggers } = device();
    const result = await capabilities().updateCurrentAndNextSlotPrices(instance, input, false);
    assert.equal(result.currentPrice, -125);
    assert.equal(result.nextPrice, 0);
    assert.equal(values.get('next_price'), 0);
    assert.deepEqual(triggers, [{ low_tariff: true }]);
});

test('last slot and missing tariff calculator preserve current updates without next writes', async () => {
    const { instance, values, triggers } = device({ time: { hour: 23, minute: 45 }, noTariff: true });
    const result = await capabilities().updateCurrentAndNextSlotPrices(instance, prices(), false);
    assert.equal(result.currentPrice, 85);
    assert.equal(result.nextPrice, null);
    assert.equal(result.nextIndex, 'unknown');
    assert.equal(values.has('next_price'), false);
    assert.deepEqual(triggers, []);
});

test('unchanged tariff does not trigger a change', async () => {
    const { instance, triggers } = device({ previousTariff: true });
    await capabilities().updateCurrentAndNextSlotPrices(instance, prices(), false);
    assert.deepEqual(triggers, []);
});

test('failed capability write prevents tariff trigger', async () => {
    const { instance, triggers } = device({ failWrite: 'measure_current_price' });
    await assert.rejects(capabilities().updateCurrentAndNextSlotPrices(instance, prices(), false), /write failed/);
    assert.deepEqual(triggers, []);
});

test('missing or failing tariff trigger preserves successful price updates', async () => {
    for (const options of [{ missingTrigger: true }, { failTrigger: true }]) {
        const { instance, values } = device(options);
        const result = await capabilities().updateCurrentAndNextSlotPrices(instance, prices(), false);
        assert.equal(result.currentPrice, -10);
        assert.equal(values.get('measure_current_price'), -10);
    }
});

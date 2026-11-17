'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const SpotPriceAPI = require('../helpers/api');
const CacheManager = require('../helpers/CacheManager');
const Logger = require('../helpers/Logger');
const homey = { clock: { getTimezone: () => 'Europe/Prague' }, log() {}, error() {} };
Logger.getInstance(homey);
Logger.setEnabled(false);
const slots = Array.from({ length: 96 }, (_, i) => ({
  hour: Math.floor(i / 4), minute: (i % 4) * 15, priceCZK: i === 0 ? -125 : 2500, priceEur: 100
}));
function client(baseUrl) {
  const api = new SpotPriceAPI(homey);
  api.baseUrl = baseUrl;
  const cache = Object.create(CacheManager.prototype);
  cache.caches = new Map();
  cache.logger = Logger.getInstance();
  api._cacheManager = cache;
  return api;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}
test('96 quarter-hour prices, negative values, shared fetch and real cache remain intact', async t => {
  let hits = 0;
  const url = await serve(t, (request, response) => {
    hits++;
    assert.equal(request.url, '/get-prices-json-qh');
    assert.equal(request.headers.accept, 'application/json');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ hoursToday: slots, hoursTomorrow: slots }));
  });
  const api = client(url);
  const [first, second] = await Promise.all([api.getPrices(), api.getPrices()]);
  assert.equal(first.today.length, 96);
  assert.equal(first.tomorrow.length, 96);
  assert.deepEqual(first.today[0], { hour: 0, minute: 0, priceCZK: -125, priceEur: 100 });
  assert.deepEqual(first.today[95], { hour: 23, minute: 45, priceCZK: 2500, priceEur: 100 });
  assert.strictEqual(second, first);
  assert.strictEqual(await api.getPrices(), first);
  assert.equal(hits, 1);
  assert.equal(api._fetchLocks.size, 0);
});
test('incomplete day is rejected, lock released and next valid response recovers', async t => {
  let valid = false;
  const url = await serve(t, (_, response) => response.end(JSON.stringify({
    hoursToday: valid ? slots : slots.slice(0, 95)
  })));
  const api = client(url);
  await assert.rejects(api.getPrices(), /95\/96/);
  assert.equal(api._fetchLocks.size, 0);
  valid = true;
  const result = await api.getPrices();
  assert.equal(result.today.length, 96);
  assert.deepEqual(result.tomorrow, []);
});
test('missing price array cannot populate the cache', async t => {
  const url = await serve(t, (_, response) => response.end('{}'));
  const api = client(url);
  await assert.rejects(api.getPrices(), /hoursToday/);
  assert.equal(api._cacheManager.caches.size, 0);
  assert.equal(api._fetchLocks.size, 0);
});
test('HTTP failures and malformed JSON remain errors', async t => {
  const url = await serve(t, (request, response) => {
    if (request.url === '/failure') { response.writeHead(503); response.end('unavailable'); }
    else response.end('{');
  });
  const api = client(url);
  await assert.rejects(api.fetchAPI(url + '/failure'), /HTTP 503/);
  await assert.rejects(api.fetchAPI(url + '/json'), /API error:/);
});
test('native fetch timeout aborts a stalled request and later calls still work', async t => {
  const url = await serve(t, (request, response) => {
    if (request.url === '/ok') response.end('{"value":42}');
  });
  const api = client(url);
  await assert.rejects(api.fetchAPI(url + '/slow', 30), /Timeout \(30ms\)/);
  assert.deepEqual(await api.fetchAPI(url + '/ok'), { value: 42 });
});

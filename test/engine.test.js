'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const GUILD = '1340570565676761121';
const USER = '123456789012345678';
const config = { guildId: GUILD, checkMs: 300000, pollMs: 60000 };
const base = { url: 'https://lilabeauty.com.au/products/blush?variant=123', variant: 'Rose', variantId: '123', name: 'Rose blush', retailer: 'Lila Beauty', category: 'makeup', price: 20, currency: 'AUD', availability: 'out_of_stock' };
function fixture(t, { path, inspectProduct } = {}) {
  const store = new Store(path);
  t.after(() => { try { store.close(); } catch {} });
  store.setConfig(GUILD, { channels: { makeup: 'makeup-channel', sales: 'sales-channel' } });
  const channelMessages = [], dmMessages = [], members = [];
  const client = { isReady: () => true,
    channels: { fetch: async id => ({ send: async payload => { channelMessages.push({ id, payload }); return { id: 'channel-message' }; } }) },
    users: { fetch: async id => ({ send: async payload => { dmMessages.push({ id, payload }); return { id: 'dm-message' }; } }) },
    guilds: { fetch: async () => ({ members: { fetch: async id => { members.push(id); return { id }; } } }) },
  };
  const logger = { warn() {}, error() {} };
  const engine = new Engine({ store, client, config, inspectProduct: inspectProduct || (async () => ({ ...base, availability: 'in_stock' })), logger });
  return { store, client, engine, channelMessages, dmMessages, members };
}
function confirmRestock(store, product) {
  store.recordObservation(product, { ...base, availability: 'in_stock' });
  store.recordObservation(product, { ...base, availability: 'in_stock' });
  return store.pendingEvents()[0];
}

test('engine requires confirmed restock, queues unique channel and opted-in DM deliveries, and sends once', async t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, base);
  f.store.watch(GUILD, USER, p.id);
  f.store.setCategories(GUILD, USER, ['makeup']);
  assert.deepEqual(f.store.pendingEvents(), []);
  await f.engine.check(p);
  assert.equal(f.store.pendingEvents().length, 0);
  // Skip host pacing time in this offline test; production still spaces requests.
  f.engine.lastHostRequest.clear();
  await f.engine.check(p);
  assert.equal(f.store.pendingEvents().length, 1);
  f.engine.queueEvents();
  f.engine.queueEvents();
  assert.equal(f.store.pendingDeliveries().length, 2);
  await f.engine.deliver();
  await f.engine.deliver();
  assert.equal(f.channelMessages.length, 1);
  assert.equal(f.dmMessages.length, 1);
  assert.equal(f.store.pendingDeliveries().length, 0);
  assert.deepEqual(f.channelMessages[0].payload.allowedMentions, { parse: [] });
  assert.equal(f.channelMessages[0].payload.enforceNonce, true);
  assert.equal(f.channelMessages[0].payload.nonce.length, 24);
});

test('blocked retailer checks preserve last known stock and back off without creating alerts', async t => {
  const f = fixture(t, { inspectProduct: async () => { throw Object.assign(new Error('blocked'), { code: 'RETAILER_BLOCKED' }); } });
  const p = f.store.addProduct(GUILD, { ...base, availability: 'in_stock' });
  await f.engine.check(p);
  const current = f.store.getProduct(GUILD, p.id);
  assert.equal(current.availability, 'in_stock');
  assert.equal(current.error, 'RETAILER_BLOCKED');
  assert.ok(current.next_check > Date.now());
  assert.equal(f.store.pendingEvents().length, 0);
});

test('queued DM is cancelled immediately after member opts out', async t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, base);
  f.store.setCategories(GUILD, USER, ['makeup']);
  confirmRestock(f.store, p);
  f.engine.queueEvents();
  f.store.setCategories(GUILD, USER, []);
  await f.engine.deliver();
  assert.equal(f.dmMessages.length, 0);
  assert.equal(f.channelMessages.length, 1);
  assert.equal(f.store.pendingDeliveries().length, 0);
});

test('queued DM is discarded when member has left the server', async t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, base);
  f.store.watch(GUILD, USER, p.id);
  confirmRestock(f.store, p);
  f.engine.queueEvents();
  f.client.guilds.fetch = async () => ({ members: { fetch: async () => { throw Object.assign(new Error('Unknown member'), { code: 10007 }); } } });
  await f.engine.deliver();
  assert.equal(f.dmMessages.length, 0);
  assert.deepEqual(f.store.userWatches(GUILD, USER), []);
  assert.equal(f.store.pendingDeliveries().length, 0);
});

test('failed delivery retries survive a database restart and preserve the same deduplication nonce', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'glow-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'bot.sqlite');
  const f = fixture(t, { path: db });
  const p = f.store.addProduct(GUILD, base);
  confirmRestock(f.store, p);
  f.engine.queueEvents();
  let originalNonce;
  f.client.channels.fetch = async () => ({ send: async payload => { originalNonce = payload.nonce; throw Object.assign(new Error('temporarily unavailable'), { code: 503 }); } });
  await f.engine.deliver();
  const waiting = f.store.db.prepare('SELECT * FROM deliveries').get();
  assert.equal(waiting.attempts, 1);
  assert.equal(waiting.status, 'pending');
  assert.ok(waiting.next_attempt > Date.now());
  f.store.close();
  const reopened = new Store(db);
  t.after(() => reopened.close());
  reopened.db.prepare('UPDATE deliveries SET next_attempt=0').run();
  const sent = [];
  const client = { isReady: () => true, channels: { fetch: async () => ({ send: async payload => { sent.push(payload); return { id: 'success' }; } }) } };
  const engine = new Engine({ store: reopened, client, config, inspectProduct: async () => base });
  await engine.deliver();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].nonce, originalNonce);
  assert.equal(reopened.pendingDeliveries().length, 0);
});

test('overlapping ticks and checks do not fetch a product twice', async t => {
  let release;
  let count = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { inspectProduct: async () => { count++; await blocked; return base; } });
  const p = f.store.addProduct(GUILD, base);
  f.store.scheduleNext(p.id, 0);
  const first = f.engine.tick();
  // Let the first tick pass its delivery phase and start the check.
  await new Promise(resolve => setImmediate(resolve));
  await f.engine.tick();
  assert.equal(await f.engine.check(p), null);
  release();
  await first;
  assert.equal(count, 1);
  assert.equal(f.engine.running, false);
});

test('events remain pending while a destination channel has not been configured', t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, base);
  confirmRestock(f.store, p);
  f.store.setConfig(GUILD, { channels: { makeup: null } });
  f.engine.queueEvents();
  assert.equal(f.store.pendingEvents().length, 1);
  assert.equal(f.store.pendingDeliveries().length, 0);
});

test('collection discovery imports baseline silently, announces later new products once, then delivers', async t => {
  const f = fixture(t);
  const url = 'https://lilabeauty.com.au/collections/new-arrivals';
  const source = f.store.addSource(GUILD, { url, category: 'makeup', retailer: 'Lila Beauty' });
  let products = [{ ...base, availability: 'in_stock' }];
  f.engine.inspectCollection = async requested => {
    assert.equal(requested, url);
    return { url, retailer: 'Lila Beauty', products };
  };
  const baseline = await f.engine.discover(source);
  assert.equal(baseline.added, 1);
  assert.deepEqual(baseline.events, []);
  assert.equal(f.store.pendingEvents().length, 0);
  f.store.setCategories(GUILD, USER, ['makeup']);
  products = [...products, { ...base, url: 'https://lilabeauty.com.au/products/lip-colour?variant=456', variantId: '456', name: 'New lip colour', availability: 'in_stock' }];
  f.engine.lastHostRequest.clear();
  const discovered = await f.engine.discover(source);
  assert.equal(discovered.added, 1);
  assert.equal(discovered.events.length, 1);
  assert.equal(discovered.events[0].kind, 'new_product');
  assert.equal(f.store.pendingEvents().length, 1);
  f.engine.queueEvents();
  assert.equal(f.store.pendingDeliveries().length, 2);
  await f.engine.deliver();
  assert.equal(f.channelMessages.length, 1);
  assert.equal(f.dmMessages.length, 1);
  assert.match(f.channelMessages[0].payload.embeds[0].title, /New arrival/i);
  f.engine.lastHostRequest.clear();
  const repeated = await f.engine.discover(source);
  assert.equal(repeated.added, 0);
  assert.deepEqual(repeated.events, []);
  f.engine.queueEvents();
  await f.engine.deliver();
  assert.equal(f.channelMessages.length, 1);
  assert.equal(f.dmMessages.length, 1);
});

test('overlapping discovery requests inspect a source only once', async t => {
  const f = fixture(t);
  const url = 'https://lilabeauty.com.au/collections/new-arrivals';
  const source = f.store.addSource(GUILD, { url, category: 'makeup' });
  let release;
  let calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  f.engine.inspectCollection = async () => { calls++; await blocked; return { url, products: [base] }; };
  const pending = f.engine.discover(source);
  assert.equal(await f.engine.discover(source), null);
  release();
  await pending;
  assert.equal(calls, 1);
  assert.equal(f.store.stats(GUILD).products, 1);
});

test('a slow product check finishing after shutdown cannot write to the closed store', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { inspectProduct: async () => { await blocked; return { ...base, availability: 'in_stock' }; } });
  const p = f.store.addProduct(GUILD, base);
  const pending = f.engine.check(p);
  f.engine.stopping = true;
  f.store.close();
  release();
  assert.equal(await pending, null);
  assert.equal(f.engine.checking.size, 0);
});

test('a slow discovery finishing after shutdown cannot write to the closed store', async t => {
  const f = fixture(t);
  const url = 'https://lilabeauty.com.au/collections/new-arrivals';
  const source = f.store.addSource(GUILD, { url, category: 'makeup' });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.engine.inspectCollection = async () => { await blocked; return { url, products: [base] }; };
  const pending = f.engine.discover(source);
  f.engine.stopping = true;
  f.store.close();
  release();
  assert.equal(await pending, null);
  assert.equal(f.engine.discovering.size, 0);
});

test('unknown availability returns failure and keeps exponential source backoff', async t => {
  const f = fixture(t, { inspectProduct: async () => ({ ...base, availability: 'unknown' }) });
  const p = f.store.addProduct(GUILD, { ...base, availability: 'in_stock' });
  const success = p.last_success;
  for (let n = 0; n < 3; n++) f.store.recordError(p, 'EXISTING_ERROR');
  const before = f.store.getProduct(GUILD, p.id);
  assert.equal(before.error_count, 3);
  assert.equal(await f.engine.check(p), null);
  const after = f.store.getProduct(GUILD, p.id);
  assert.equal(after.availability, 'in_stock');
  assert.equal(after.last_success, success);
  assert.equal(after.error_count, 4);
  assert.equal(after.error, 'UNKNOWN_AVAILABILITY');
  assert.ok(after.next_check > Date.now() + 7 * 60000, 'fourth failure retains eight minute backoff instead of success interval');
  assert.equal(f.store.pendingEvents().length, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../src/store');
const { DatabaseSync } = require('node:sqlite');

const observation = {
  url: 'https://www.adorebeauty.com.au/example.html', name: 'Liquid blush',
  retailer: 'Adore Beauty', variant: 'Peach', category: 'makeup',
  price: 40, currency: 'AUD', availability: 'out_of_stock',
};

function withStore(action) {
  const store = new Store();
  try { action(store); } finally { store.close(); }
}

test('initial stock baseline is silent; changed stock needs two agreeing checks and sends once', () => withStore(store => {
  const product = store.addProduct('guild', observation);
  assert.deepEqual(store.pendingEvents(), []);
  assert.deepEqual(store.recordObservation(product, { ...observation, availability: 'in_stock' }, 1000), []);
  assert.equal(store.getProduct('guild', product.id).availability, 'out_of_stock');
  const events = store.recordObservation(product, { ...observation, availability: 'in_stock' }, 2000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'restock');
  assert.equal(events[0].product.variant, 'Peach');
  assert.equal(store.getProduct('guild', product.id).availability, 'in_stock');
  assert.deepEqual(store.recordObservation(product, { ...observation, availability: 'in_stock' }, 3000), []);
  assert.equal(store.pendingEvents().length, 1);
}));

test('a later first successful check establishes baseline without alerting', () => withStore(store => {
  const product = store.addProduct('guild', { ...observation, availability: 'unknown' });
  const result = store.recordObservation(product, { ...observation, availability: 'in_stock' }, 1000);
  assert.deepEqual(result, []);
  assert.equal(store.getProduct('guild', product.id).availability, 'in_stock');
}));

test('errors and unknown preserve state and break restock confirmation sequence', () => withStore(store => {
  const product = store.addProduct('guild', observation);
  store.recordObservation(product, { ...observation, availability: 'in_stock' }, 1000);
  store.recordError(product, new Error('403 from retailer'), 2000);
  const failed = store.getProduct('guild', product.id);
  assert.equal(failed.availability, 'out_of_stock');
  assert.equal(failed.candidate_count, 0);
  assert.equal(failed.error_count, 1);
  assert.equal(failed.next_check, 62_000);
  assert.deepEqual(store.recordObservation(product, { ...observation, availability: 'in_stock' }, 3000), []);
  store.recordObservation(product, { ...observation, availability: 'unknown', price: 1 }, 4000);
  const unknown = store.getProduct('guild', product.id);
  assert.equal(unknown.availability, 'out_of_stock');
  assert.equal(unknown.price, 40);
  assert.equal(unknown.last_success, 3000);
  assert.equal(unknown.candidate_count, 0);
  assert.deepEqual(store.pendingEvents(), []);
}));

test('same currency genuine lower price alerts once, while null and foreign currency do not', () => withStore(store => {
  const product = store.addProduct('guild', { ...observation, availability: 'in_stock' });
  const lower = { ...observation, availability: 'in_stock', price: 35 };
  const events = store.recordObservation(product, lower, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].previousPrice, 40);
  assert.equal(events[0].product.price, 35);
  assert.deepEqual(store.recordObservation(product, lower, 2000), []);
  assert.deepEqual(store.recordObservation(product, { ...lower, price: null }, 3000), []);
  assert.equal(store.getProduct('guild', product.id).price, 35);
  assert.deepEqual(store.recordObservation(product, { ...lower, price: 5, currency: 'USD' }, 4000), []);
}));

test('variant identity and guild scope isolate watches and observations', () => withStore(store => {
  const peach = store.addProduct('guild', observation);
  const rose = store.addProduct('guild', { ...observation, variant: 'Rose' });
  assert.notEqual(peach.id, rose.id);
  assert.equal(store.addProduct('guild', observation).id, peach.id);
  assert.equal(store.getProduct('other', peach.id), null);
  assert.throws(() => store.watch('other', 'user', peach.id), /not on this server/);
  store.watch('guild', 'user', rose.id);
  assert.deepEqual(store.subscribers(peach), []);
  assert.deepEqual(store.subscribers(rose), ['user']);
}));

test('stable variant ID permits label rename while rejecting another shade and replacement URL', () => withStore(store => {
  const selected = { ...observation, url: 'https://www.adorebeauty.com.au/example.html?variant=123', variantId: '123' };
  const product = store.addProduct('guild', selected);
  assert.equal(product.variant_id, '123');
  store.recordObservation(product, { ...selected, variant: 'Peach Glow' }, 1000);
  assert.equal(store.getProduct('guild', product.id).variant, 'Peach Glow');
  assert.equal(store.addProduct('guild', { ...selected, variant: 'Peach Glow' }).id, product.id);
  assert.throws(() => store.recordObservation(product, { ...selected, variantId: '456', availability: 'in_stock' }, 2000), /different or unconfirmed shade/);
  assert.throws(() => store.recordObservation(product, { ...selected, variantId: undefined, availability: 'in_stock' }, 2000), /different or unconfirmed shade/);
  assert.throws(() => store.recordObservation(product, { ...selected, url: 'https://www.adorebeauty.com.au/replacement.html', availability: 'in_stock' }, 2000), /different product URL/);
  const unchanged = store.getProduct('guild', product.id);
  assert.equal(unchanged.availability, 'out_of_stock');
  assert.equal(unchanged.last_success, 1000);
  assert.deepEqual(store.pendingEvents(), []);
}));

test('existing database migrates missing stable variant column without losing products', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glow-migrate-'));
  const path = join(dir, 'db.sqlite');
  let store;
  try {
    store = new Store(path);
    const product = store.addProduct('guild', observation);
    store.close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE products DROP COLUMN variant_id');
    old.close();
    store = new Store(path);
    assert.equal(store.getProduct('guild', product.id).name, observation.name);
    assert.equal(store.getProduct('guild', product.id).variant_id, null);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('category and product subscribers merge without duplicate DMs; sales opts into price drops only', () => withStore(store => {
  const product = store.addProduct('guild', observation);
  store.setCategories('guild', 'one', ['makeup']);
  store.watch('guild', 'one', product.id);
  store.setCategories('guild', 'two', ['sales']);
  store.setCategories('other', 'three', ['makeup']);
  assert.deepEqual(store.subscribers(product), ['one']);
  assert.deepEqual(store.subscribers(product, 'price_drop'), ['one', 'two']);
  store.setCategories('guild', 'one', []);
  assert.deepEqual(store.categories('guild', 'one'), []);
  assert.deepEqual(store.subscribers(product), ['one']);
  store.unwatch('guild', 'one', product.id);
  assert.deepEqual(store.subscribers(product), []);
  assert.throws(() => store.setCategories('guild', 'one', ['invalid']), /valid alert/);
}));

test('outbox delivery survives restart, deduplicates targets and retries before failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glow-store-'));
  const path = join(dir, 'db.sqlite');
  let store;
  try {
    store = new Store(path);
    const product = store.addProduct('guild', { ...observation, availability: 'in_stock' });
    store.watch('guild', 'user', product.id);
    store.setCategories('guild', 'user', ['makeup']);
    const event = store.recordObservation(product, { ...observation, availability: 'in_stock', price: 30 }, 1000)[0];
    const queued = store.queueDelivery(event, 'dm', 'user', { content: 'Price reduced' });
    store.queueDelivery(event, 'dm', 'user', { content: 'Duplicate' });
    assert.equal(store.pendingDeliveries().length, 1);
    store.eventsQueued(event.id);
    store.deliveryFailed(queued.id, 'DM blocked', 2000);
    assert.equal(store.pendingDeliveries(2000).length, 0);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.categories('guild', 'user'), ['makeup']);
    assert.equal(store.userWatches('guild', 'user').length, 1);
    assert.equal(store.pendingEvents().length, 0);
    const retry = store.pendingDeliveries(62_000)[0];
    assert.equal(retry.attempts, 1);
    assert.equal(retry.payload.content, 'Price reduced');
    store.deliverySent(retry.id, 'message-id');
    assert.equal(store.pendingDeliveries().length, 0);
    const channel = store.queueDelivery(event, 'channel', 'channel-id', {});
    for (let i = 0; i < 8; i++) store.deliveryFailed(channel.id, 'Channel not writable', i * 100_000);
    assert.equal(store.stats('guild').failed_deliveries, 1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forget removes member preferences, watches, requests and private queued deliveries', () => withStore(store => {
  const product = store.addProduct('guild', { ...observation, availability: 'in_stock' });
  store.setCategories('guild', 'user', ['makeup']);
  store.watch('guild', 'user', product.id);
  store.addRequest('guild', 'user', observation.url, 'Please track Rose');
  const event = store.recordObservation(product, { ...observation, availability: 'in_stock', price: 30 }, 1000)[0];
  store.queueDelivery(event, 'dm', 'user', {});
  store.queueDelivery(event, 'channel', 'channel', {});
  store.forgetUser('guild', 'user');
  assert.deepEqual(store.categories('guild', 'user'), []);
  assert.deepEqual(store.userWatches('guild', 'user'), []);
  assert.equal(store.stats('guild').pending_requests, 0);
  assert.deepEqual(store.pendingDeliveries().map(row => row.target_type), ['channel']);
}));

test('a queued DM can be cancelled immediately after member opts out', () => withStore(store => {
  const product = store.addProduct('guild', { ...observation, availability: 'in_stock' });
  store.setCategories('guild', 'user', ['makeup']);
  const event = store.recordObservation(product, { ...observation, availability: 'in_stock', price: 30 }, 1000)[0];
  store.queueDelivery(event, 'dm', 'user', { content: 'Price reduced' });
  store.setCategories('guild', 'user', []);
  const delivery = store.pendingDeliveries()[0];
  const savedEvent = store.getEvent(delivery.event_id);
  assert.equal(savedEvent.kind, 'price_drop');
  assert.equal(savedEvent.product.id, product.id);
  assert.equal(store.getEvent(-1), null);
  assert.equal(store.subscribers(savedEvent.product, savedEvent.kind).includes(delivery.target_id), false);
  store.cancelDelivery(delivery.id);
  assert.deepEqual(store.pendingDeliveries(), []);
  store.deliveryFailed(delivery.id, 'Should not retry', 2000);
  assert.deepEqual(store.pendingDeliveries(), []);
}));

test('requests stay in durable guild scoped admin queue until resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glow-requests-'));
  const path = join(dir, 'db.sqlite');
  let store;
  try {
    store = new Store(path);
    const id = store.addRequest('guild', 'user', observation.url, 'Please track this blush');
    store.addRequest('other', 'user', observation.url, 'Other server');
    store.close();
    store = new Store(path);
    const rows = store.listRequests('guild');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].note, 'Please track this blush');
    assert.equal(store.resolveRequest('other', id), false);
    assert.equal(store.listRequests('guild').length, 1);
    assert.equal(store.resolveRequest('guild', id), true);
    assert.equal(store.resolveRequest('guild', id), false);
    assert.deepEqual(store.listRequests('guild'), []);
    assert.equal(store.listRequests('guild', { status: 'resolved' }).length, 1);
    assert.throws(() => store.listRequests('guild', { status: 'anything' }), /Invalid request status/);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configuration merge preserves existing channels and panels; search is literal', () => withStore(store => {
  store.setConfig('guild', { channels: { makeup: 'one' }, panels: { home: 'home' } });
  store.setConfig('guild', { channels: { skincare: 'two' } });
  assert.deepEqual(store.getConfig('guild'), { channels: { makeup: 'one', skincare: 'two' }, panels: { home: 'home' } });
  const product = store.addProduct('guild', observation);
  assert.equal(store.listProducts('guild', { search: 'blush' }).length, 1);
  assert.equal(store.listProducts('guild', { search: '%' }).length, 0);
  store.pauseProduct('guild', product.id, true);
  assert.equal(store.getProduct('guild', product.id).paused, 1);
  store.scheduleNext(product.id, 1234);
  assert.equal(store.getProduct('guild', product.id).next_check, 1234);
}));

test('catalogue first success is silent, later new stock announces once and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glow-catalogue-'));
  const path = join(dir, 'db.sqlite');
  let store;
  const sourceUrl = 'https://www.adorebeauty.com.au/products.json';
  const item = (slug, availability = 'in_stock') => ({ ...observation,
    name: slug, url: `https://www.adorebeauty.com.au/products/${slug}?variant=123`, variantId: '123', availability,
  });
  try {
    store = new Store(path);
    let source = store.addSource('guild', { url: sourceUrl, retailer: 'Adore Beauty', category: 'makeup' });
    assert.equal(store.addSource('guild', { url: sourceUrl, category: 'skincare' }).id, source.id);
    const first = store.recordDiscovery(source, { url: sourceUrl, products: [item('baseline'), item('sold-out', 'out_of_stock')] }, 1000);
    assert.equal(first.added, 2);
    assert.deepEqual(first.events, []);
    assert.deepEqual(store.pendingEvents(), []);
    assert.equal(store.listSources('guild')[0].initialized, 1);
    assert.equal(store.listSources('guild')[0].next_check, 601_000);
    // A manually tracked item appearing in the catalogue is not a new-product announcement.
    store.addProduct('guild', item('already-tracked'));
    const feed = { url: sourceUrl, products: [item('baseline'), item('already-tracked'), item('new'), item('new-sold-out', 'out_of_stock')] };
    const second = store.recordDiscovery(source, feed, 2000);
    assert.equal(second.added, 2);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].kind, 'new_product');
    assert.equal(second.events[0].product.name, 'new');
    assert.deepEqual(store.recordDiscovery(source, feed, 3000), { added: 0, events: [], capacity: 0 });
    store.close();
    store = new Store(path);
    source = store.listSources('guild')[0];
    assert.deepEqual(store.recordDiscovery(source, feed, 4000), { added: 0, events: [], capacity: 0 });
    assert.equal(store.pendingEvents().length, 1);
    assert.equal(store.pendingEvents()[0].product.name, 'new');
    assert.equal(store.listProducts('guild').find(product => product.name === 'new-sold-out').availability, 'out_of_stock');
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalogue errors preserve known identities and back off; paused and other-guild sources stay isolated', () => withStore(store => {
  const url = 'https://www.adorebeauty.com.au/products.json';
  const source = store.addSource('guild', { url, category: 'makeup' });
  store.recordDiscovery(source, { url, products: [observation] }, 1000);
  store.recordSourceError(source, '403 challenge', 2000);
  const failed = store.listSources('guild')[0];
  assert.equal(failed.last_success, 1000);
  assert.equal(failed.last_checked, 2000);
  assert.equal(failed.error_count, 1);
  assert.equal(failed.next_check, 602_000);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM source_items WHERE source_id=?').get(source.id).count, 1);
  assert.deepEqual(store.recordDiscovery(source, { url, products: [observation] }, 3000), { added: 0, events: [], capacity: 0 });
  assert.equal(store.listSources('guild')[0].error, null);
  assert.equal(store.listSources('other').length, 0);
  assert.equal(store.pauseSource('other', source.id), false);
  assert.equal(store.pauseSource('guild', source.id), true);
  assert.deepEqual(store.recordDiscovery(source, { url, products: [{ ...observation, url: observation.url + '?new=1' }] }, 4000), { added: 0, events: [], capacity: 0 });
  assert.equal(store.listProducts('guild').length, 1);
}));

test('catalogue capacity leaves skipped identities unseen for later retry', () => withStore(store => {
  const url = 'https://www.adorebeauty.com.au/products.json';
  const source = store.addSource('guild', { url, category: 'makeup' });
  store.recordDiscovery(source, { url, products: [] }, 1000);
  for (let i = 0; i < 1000; i++) store.addProduct('guild', { ...observation, url: observation.url + '?existing=' + i });
  const nextItem = { ...observation, url: observation.url + '?new=1', availability: 'in_stock' };
  const result = store.recordDiscovery(source, { url, products: [nextItem] }, 2000);
  assert.deepEqual(result, { added: 0, events: [], capacity: 1 });
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM source_items WHERE source_id=?').get(source.id).count, 0);
  store.db.prepare('DELETE FROM products WHERE id=?').run(store.listProducts('guild')[0].id);
  const retried = store.recordDiscovery(source, { url, products: [nextItem] }, 3000);
  assert.equal(retried.added, 1);
  assert.equal(retried.events.length, 1);
}));

test('catalogue discovery is atomic and bounds input to 100 product pages', () => withStore(store => {
  const url = 'https://www.adorebeauty.com.au/products.json';
  const source = store.addSource('guild', { url, category: 'makeup' });
  assert.throws(() => store.recordDiscovery(source, { url, products: [observation, { name: 'Bad product' }] }), /incomplete product/);
  assert.equal(store.listProducts('guild').length, 0);
  assert.equal(store.listSources('guild')[0].initialized, 0);
  const products = Array.from({ length: 101 }, (_, i) => ({ ...observation, url: `https://www.adorebeauty.com.au/products/item-${i}` }));
  const result = store.recordDiscovery(source, { url, products }, 1000);
  assert.equal(result.added, 100);
  assert.equal(store.listProducts('guild', { limit: 1000 }).length, 100);
}));

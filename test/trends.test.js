'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { TrendsService, SOURCES, parseRetailerList, parseRss, upcomingDate, fetchSource } = require('../src/trends');

const HOUR = 3600000, DAY = 24 * HOUR, now = Date.UTC(2026, 10, 3, 2);
const retailer = SOURCES[0], publisher = SOURCES[2], google = SOURCES[3];
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rss = (items = [], extra = '') => `<rss xmlns:ht="https://trends.google.com/trending/rss"><channel>${extra}${items.map(item => `<item><title>${xml(item.title)}</title><link>${xml(item.url || 'https://www.allure.com/story/new-lipstick')}</link><pubDate>${new Date(item.date ?? now - HOUR).toUTCString()}</pubDate><description>${xml(item.description || '')}</description>${item.traffic ? `<ht:approx_traffic>${xml(item.traffic)}</ht:approx_traffic>` : ''}</item>`).join('')}</channel></rss>`;
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rows = count => Array.from({ length: count }, (_, i) => ({ key: String(i + 1), name: `Product ${i + 1}`, url: `https://wcosmetics.com.au/products/item-${i + 1}`, kind: 'bestsellers', position: i + 1, observedAt: now, publishedAt: null, evidence: 'Displayed retailer list, not sales rank.' }));
function fixture(t, options = {}) {
  const store = options.store || new Store(':memory:');
  let clock = now;
  const sent = [];
  const client = { channels: { async fetch() { return { async send(payload) { sent.push(payload); return { id: String(sent.length) }; } }; } } };
  const service = new TrendsService({ store, client, config: { guildId: '1340570565676761121' }, sources: [], clock: () => clock, logger: { warn() {} }, ...options });
  if (!options.store) t.after(() => store.close());
  return { store, service, sent, setTime(value) { clock = value; } };
}

test('retailer observations preserve displayed order and do not treat generic vendor as a brand or listing date as a launch', () => {
  const data = { products: [{ id: 1, title: 'Fino Hair Mask 230g', vendor: 'wcosmeticshq', handle: 'fino-hair-mask', created_at: '2021-01-01', published_at: '2026-01-01' }] };
  const result = parseRetailerList(JSON.stringify(data), retailer, now);
  assert.equal(result[0].name, 'Fino Hair Mask 230g');
  assert.equal(result[0].position, 1);
  assert.equal(result[0].publishedAt, null);
  assert.match(result[0].evidence, /manually featured/);
  assert.match(result[0].evidence, /not a sales count/);
  assert.throws(() => parseRetailerList(JSON.stringify({ products: [{ ...data.products[0], handle: '../account' }] }), retailer, now));
  assert.throws(() => parseRetailerList(JSON.stringify({ products: [data.products[0], data.products[0]] }), retailer, now));
});

test('publisher RSS keeps dated relevant public metadata and rejects unrelated, duplicate and future items', () => {
  const result = parseRss(rss([
    { title: '7 Best New Beauty Products for 2026', description: 'New lipstick and skincare launches.' },
    { title: '7 Best New Beauty Products for 2026', description: 'Same URL and story.' },
    { title: 'Sephora shares rise after Q3 acquisition', url: 'https://www.allure.com/story/finance' },
    { title: 'Celebrity hair on a red carpet', url: 'https://www.allure.com/story/celebrity' },
    { title: 'New skincare launch', url: 'https://www.allure.com/story/future', date: now + 2 * DAY },
    { title: 'New lipstick launch', url: 'https://other.example/story/article' },
  ]), publisher, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'new');
  assert.match(result[0].evidence, /not proof of popularity/);
});

test('cached topic queries include public RSS metadata without displaying full article text', t => {
  const f = fixture(t, { sources: [publisher] });
  const items = parseRss(rss([{ title: 'Best New Beauty Products for 2026', description: 'New Laneige skin care products were announced in this public feed summary.' }]), publisher, now);
  f.service.record(publisher, items, now);
  const found = f.service.list({ query: 'Laneige skincare', filter: 'new' });
  assert.equal(found.length, 1);
  assert.equal(f.service.summary({ query: 'Laneige skin care' }).editorialArticles, 1);
  assert.ok(!found[0].evidence.includes('public feed summary'));
});

test('upcoming requires an explicit future release date with year, not publication or listing metadata', () => {
  assert.equal(upcomingDate('New lipstick launches on 10 November 2026', now - HOUR, now), Date.UTC(2026, 10, 10));
  for (const text of ['New lipstick launches this month', 'Posted 10 November 2026', 'Lipstick launches on 3 November 2026', 'Available on 10 November']) {
    assert.equal(upcomingDate(text, now - HOUR, now), null);
  }
  const parsed = parseRss(rss([{ title: 'New lipstick launches on 10 November 2026' }]), publisher, now);
  assert.equal(parsed[0].kind, 'upcoming');
  assert.equal(parsed[0].launchAt, Date.UTC(2026, 10, 10));
});

test('Google AU filters exact beauty topics, keeps reported traffic literal, and accepts an empty beauty result', () => {
  const sourceUrl = google.url;
  const data = rss([{ title: 'stock', url: sourceUrl, traffic: '10000+' }, { title: 'the block auctions', url: sourceUrl },
    { title: 'Sephora', url: sourceUrl, traffic: '500+' }]);
  const result = parseRss(data, google, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Sephora');
  assert.match(result[0].evidence, /500\+/);
  assert.match(result[0].evidence, /not product sales/);
  assert.deepEqual(parseRss(rss([{ title: 'brisbane weather forecast', url: sourceUrl }]), google, now), []);
});

test('RSS ttl is interpreted as minutes and never mistaken for seconds', t => {
  const f = fixture(t);
  const items = parseRss(rss([], '<ttl>1800</ttl>'), SOURCES[1], now);
  f.service.record(SOURCES[1], items, now);
  const state = f.store.db.prepare('SELECT next_check FROM trend_sources WHERE source_id=?').get(SOURCES[1].id);
  assert.equal(state.next_check, now + 30 * HOUR);
});

test('source fetch rejects cross-host and changed-path redirects, access blocks and excessive responses', async () => {
  for (const location of ['https://other.example/rss', '/account/login']) {
    await assert.rejects(fetchSource(publisher, async () => reply('', 302, { location })));
  }
  await assert.rejects(fetchSource(publisher, async () => reply('', 403)), error => error.code === 'SOURCE_HTTP_403');
  await assert.rejects(fetchSource(publisher, async () => reply('small', 200, { 'content-length': String(3 * 1024 * 1024) })));
});

test('first source snapshot is silent; rising needs a comparable sample at least 24 hours earlier', t => {
  const f = fixture(t);
  const baseline = rows(15);
  f.service.record(retailer, baseline, now);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 0);
  const changed = baseline.map(item => ({ ...item, position: item.key === '12' ? 3 : item.position, observedAt: now + 12 * HOUR }));
  f.service.record(retailer, changed, now + 12 * HOUR);
  assert.equal(f.service.list({ filter: 'rising' }).length, 0);
  f.setTime(now + DAY);
  f.service.record(retailer, changed, now + DAY);
  const result = f.service.list({ filter: 'rising' });
  assert.equal(result.length, 1);
  assert.equal(result[0].previousPosition, 12);
  assert.equal(result[0].position, 3);
  assert.equal(result[0].previousObservedAt, now);
  assert.match(result[0].evidence, /not a sales or popularity measurement/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 1);
});

test('a successful retailer snapshot removes products no longer in the displayed favourites list', t => {
  const f = fixture(t);
  f.service.record(retailer, rows(2), now);
  assert.equal(f.service.list({ filter: 'bestsellers' }).length, 2);
  f.service.record(retailer, rows(1), now + HOUR);
  assert.deepEqual(f.service.list({ filter: 'bestsellers' }).map(item => item.key), ['1']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM trend_snapshots').get().n, 2);
});

test('reader voted 2026 picks persist separately and year search never invents a retailer sales history', t => {
  const f = fixture(t);
  f.service.record(retailer, rows(2), now);
  assert.equal(f.service.list({ query: '2026', filter: 'bestsellers' }).length, 0);
  const seeds = f.service.list({ query: '2026 Laneige', filter: 'hits' });
  assert.equal(seeds.length, 1);
  assert.match(seeds[0].evidence, /Reader voted, not a sales count/);
  assert.equal(new Date(seeds[0].publishedAt).getUTCFullYear(), 2026);
  assert.equal(f.service.list({ query: '2025', filter: 'hits' }).length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 0);
});

test('query evidence counts deduplicated cached headlines and independent publisher domains without counting reader picks', t => {
  const f = fixture(t, { sources: [publisher, SOURCES[1]] });
  const article = { key: 'laneige-review', name: 'New Laneige skincare review', url: 'https://www.allure.com/story/laneige-review', kind: 'new', publishedAt: now - HOUR, observedAt: now, evidence: 'Dated public coverage.' };
  f.service.record(publisher, [article, { ...article, kind: 'upcoming', launchAt: now + DAY }], now);
  f.service.record(SOURCES[1], [{ ...article, key: 'laneige-launch', url: 'https://www.cosmeticsbusiness.com/laneige-launch', publishedAt: now - 8 * DAY }], now);
  const summary = f.service.summary({ query: 'Laneige' });
  assert.equal(summary.editorialArticles, 2);
  assert.equal(summary.independentPublishers, 2);
  assert.equal(summary.recentArticles, 1);
  assert.equal(summary.previousArticles, 1);
  assert.match(summary.message, /not demand or complete media coverage/);
  assert.equal(f.service.summary({ query: 'unknownbrand' }).sourceCount, 0);
  assert.equal(f.service.list({ query: 'lauder', filter: 'hits' }).length, 0);
  assert.equal(f.service.list({ query: 'elf', filter: 'hits' }).length, 1);
});

test('automatic posts have a daily budget, a seven day item cooldown and stable restart persistence', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'glow-trends-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path.join(directory, 'state.sqlite'));
  let f = fixture(t, { store });
  f.service.record(publisher, [], now);
  const items = Array.from({ length: 6 }, (_, index) => ({ key: `news-${index}`, name: `New lipstick ${index}`, url: `https://www.allure.com/story/new-${index}`, kind: 'new', observedAt: now + HOUR, publishedAt: now + HOUR, evidence: 'Dated public headline.' }));
  f.service.record(publisher, items, now + HOUR);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 3);
  store.close();
  store = new Store(path.join(directory, 'state.sqlite'));
  t.after(() => store.close());
  f = fixture(t, { store });
  f.service.record(publisher, [], now + DAY);
  f.service.record(publisher, items.slice(0, 3), now + DAY + HOUR);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 3);
  assert.equal(f.service.list({ filter: 'new', limit: 20 }).length, 6);
});

test('late retries cannot exceed three actual sends on a Melbourne day', async t => {
  const f = fixture(t);
  f.store.setConfig(f.service.config.guildId, { channels: { trends: '123456789012345678' } });
  f.service.record(publisher, [], now);
  const news = day => Array.from({ length: 3 }, (_, i) => ({ key: `day-${day}-${i}`, name: `New lipstick ${day} ${i}`, url: `https://www.allure.com/story/day-${day}-${i}`, kind: 'new', publishedAt: now + day * DAY, observedAt: now + day * DAY, evidence: 'Public feed metadata.' }));
  f.service.record(publisher, news(0), now + HOUR);
  f.service.record(publisher, news(1), now + DAY + HOUR);
  await f.service.deliver(now + DAY + HOUR);
  assert.equal(f.sent.length, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM trend_posts WHERE status='pending'").get().n, 3);
  await f.service.deliver(now + DAY + 2 * HOUR);
  assert.equal(f.sent.length, 3);
  await f.service.deliver(now + 2 * DAY + HOUR);
  assert.equal(f.sent.length, 6);
});

test('a blocked source preserves earlier observations, backs off, and creates no fresh claims', async t => {
  const f = fixture(t, { sources: [retailer], fetcher: async () => reply('', 429) });
  f.service.record(retailer, rows(2), now - 2 * HOUR);
  await f.service.tick();
  const state = f.store.db.prepare('SELECT * FROM trend_sources WHERE source_id=?').get(retailer.id);
  assert.equal(state.error, 'SOURCE_HTTP_429');
  assert.equal(state.next_check, now + HOUR);
  const saved = f.service.list({ filter: 'bestsellers' });
  assert.equal(saved.length, 2);
  assert.ok(saved.every(item => item.sourceUnavailable));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM trend_posts').get().n, 0);
});

test('no destination keeps posts pending; retries use the same nonce and do not duplicate successful deliveries', async t => {
  const f = fixture(t);
  f.service.record(publisher, [], now);
  f.service.record(publisher, [{ key: 'new', name: 'New lipstick', url: 'https://www.allure.com/story/new', kind: 'new', observedAt: now, publishedAt: now, evidence: 'Public feed.' }], now + HOUR);
  await f.service.deliver(now + HOUR);
  assert.equal(f.sent.length, 0);
  f.store.setConfig(f.service.config.guildId, { channels: { trends: '123456789012345678' } });
  let failed = false;
  const attempts = [];
  f.service.client.channels.fetch = async () => ({ async send(payload) { attempts.push(payload); if (!failed) { failed = true; throw Object.assign(new Error('No private details'), { code: 50013 }); } return { id: '456' }; } });
  await f.service.deliver(now + HOUR);
  await f.service.deliver(now + 2 * HOUR);
  await f.service.deliver(now + 3 * HOUR);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].nonce, attempts[1].nonce);
  assert.deepEqual(attempts[0].allowedMentions, { parse: [] });
  assert.equal(f.store.db.prepare('SELECT status FROM trend_posts').get().status, 'sent');
});

test('a reached release date leaves upcoming results and cannot be sent as a late upcoming announcement', async t => {
  const f = fixture(t);
  f.store.setConfig(f.service.config.guildId, { channels: { trends: '123456789012345678' } });
  f.service.record(publisher, [], now);
  f.service.record(publisher, [{ key: 'dated', name: 'New lipstick launch', url: 'https://www.allure.com/story/dated', kind: 'upcoming', publishedAt: now, observedAt: now, launchAt: Date.UTC(2026, 10, 4), evidence: 'Explicit future launch date.' }], now + HOUR);
  assert.equal(f.service.list({ filter: 'upcoming' }).length, 1);
  f.setTime(now + DAY);
  assert.equal(f.service.list({ filter: 'upcoming' }).length, 0);
  await f.service.deliver(now + DAY);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.db.prepare('SELECT status FROM trend_posts').get().status, 'cancelled');
});

test('shutdown prevents an in-flight source response writing to a closed database', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const store = new Store(':memory:');
  const f = fixture(t, { store, sources: [retailer], fetcher: async () => pending });
  const work = f.service.tick();
  f.service.stop();
  store.close();
  finish(reply({ products: [] }));
  await assert.doesNotReject(work);
});

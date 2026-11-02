'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { Store } = require('../src/store');
const { createHandler } = require('../src/app');
const GUILD = '1340570565676761121';
const USER = '123456789012345678';
const config = { guildId: GUILD, checkMs: 300000, pollMs: 60000 };
const product = (n = 1) => ({ url: `https://lilabeauty.com.au/products/blush-${n}?variant=${n}`, variant: 'Rose', variantId: String(n), name: `Rose blush ${n}`, category: 'makeup', retailer: 'Lila Beauty', price: 20, currency: 'AUD', availability: 'in_stock' });
let serial = 0;
function interaction({ kind = 'button', customId, commandName, options = {}, fields = {}, values = [], userId = USER, guildId = GUILD, manager = false, messageId, ephemeralMessage = true } = {}) {
  const calls = [];
  const i = {
    customId, commandName, values, guildId, guild: { id: guildId }, user: { id: userId },
    message: messageId ? { id: messageId, flags: { has: () => ephemeralMessage } } : undefined,
    memberPermissions: { has: () => manager },
    inGuild: () => Boolean(guildId),
    isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isModalSubmit: () => kind === 'modal',
    options: { getString: name => options[name] ?? null, getBoolean: name => options[name] ?? null, getInteger: name => options[name] ?? null, getSubcommand: () => options.subcommand },
    fields: { getTextInputValue: name => fields[name] || '' },
    calls, deferred: false, replied: false, replyId: `response-${++serial}`,
    async reply(payload) { if (this.deferred || this.replied) throw new Error('Interaction already acknowledged'); this.replied = true; calls.push(['reply', payload]); },
    async deferReply(payload) { if (this.deferred || this.replied) throw new Error('Interaction already acknowledged'); this.deferred = true; calls.push(['deferReply', payload]); },
    async editReply(payload) { calls.push(['editReply', payload]); },
    async followUp(payload) { calls.push(['followUp', payload]); },
    async update(payload) { this.replied = true; calls.push(['update', payload]); },
    async showModal(payload) { this.replied = true; calls.push(['showModal', payload]); },
    async fetchReply() { return { id: this.replyId }; },
  };
  return i;
}
function fixture(t, overrides = {}) {
  const store = new Store();
  t.after(() => store.close());
  const logs = [];
  const memberships = [];
  const client = { isReady: () => true,
    guilds: { fetch: async id => ({ id, members: { fetch: async userId => { memberships.push(userId); return { id: userId }; } } }) },
    channels: { fetch: async () => ({ send: async payload => { logs.push(payload); return { id: 'log' }; } }) },
  };
  const engine = { queueEvents() {}, check: async () => ({ observation: {} }) };
  let inspections = 0;
  let setups = 0;
  const handler = createHandler({ store, client, config, engine, inspect: async () => { inspections++; return product(); }, setup: async () => { setups++; return { plan: ['Create start'], config: { channels: { start: 'start' } } }; }, ...overrides });
  return { store, client, handler, logs, memberships, get inspections() { return inspections; }, get setups() { return setups; } };
}
function last(i) { return i.calls.at(-1)?.[1]; }
function ids(payload) { return (payload.components || []).flatMap(row => row.components || []).map(c => c.custom_id); }

test('new member can choose categories, find and watch a product, then stop alerts using buttons', async t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, product());
  const home = interaction({ kind: 'command', commandName: 'glow' });
  await f.handler(home);
  assert.equal(last(home).flags, MessageFlags.Ephemeral);
  assert.ok(ids(last(home)).includes('glow:preferences'));
  const preferences = interaction({ customId: 'glow:preferences' });
  await f.handler(preferences);
  assert.equal(last(preferences).flags, MessageFlags.Ephemeral);
  const categories = interaction({ kind: 'select', customId: 'glow:categories', values: ['makeup', 'sales'] });
  await f.handler(categories);
  assert.deepEqual(f.store.categories(GUILD, USER), ['makeup', 'sales']);
  const search = interaction({ customId: 'glow:search' });
  await f.handler(search);
  assert.equal(search.calls[0][0], 'showModal');
  const query = interaction({ kind: 'modal', customId: 'glow:search-submit', fields: { query: 'Rose' } });
  await f.handler(query);
  assert.ok(ids(last(query)).includes(`glow:watch:${p.id}`));
  const watch = interaction({ customId: `glow:watch:${p.id}` });
  await f.handler(watch);
  assert.equal(f.store.userWatches(GUILD, USER).length, 1);
  const mine = interaction({ customId: 'glow:mine' });
  await f.handler(mine);
  assert.match(last(mine).content, /Rose blush/);
  const clear = interaction({ customId: 'glow:clear' });
  await f.handler(clear);
  assert.deepEqual(f.store.categories(GUILD, USER), []);
  assert.deepEqual(f.store.userWatches(GUILD, USER), []);
});

test('runtime checks deny forged admin commands and setup button to ordinary members', async t => {
  const f = fixture(t);
  for (const params of [{ kind: 'command', commandName: 'product', options: { subcommand: 'add' } }, { kind: 'command', commandName: 'setup', options: { apply: true } }, { customId: 'glow:setup-apply' }]) {
    const i = interaction(params);
    await f.handler(i);
    assert.match(last(i).content, /Only a server manager/);
    assert.equal(last(i).flags, MessageFlags.Ephemeral);
  }
  assert.equal(f.inspections, 0);
  assert.equal(f.setups, 0);
});

test('wrong guild cannot alter member subscriptions or run setup', async t => {
  const f = fixture(t);
  const i = interaction({ kind: 'select', customId: 'glow:categories', values: ['makeup'], guildId: '999999999999999999' });
  await f.handler(i);
  assert.match(last(i).content, /another server/);
  assert.deepEqual(f.store.categories(GUILD, USER), []);
});

test('setup shows only a verified hardcoded permission preflight message', async t => {
  const publicMessage = 'Glowbot needs these server permissions to set up channels: ManageChannels, ManageRoles. Administrator is not required.';
  const error = Object.assign(new Error('private host detail do not reveal'), {
    code: 'SETUP_PERMISSIONS', missingPermissions: ['ManageChannels', 'ManageRoles'], publicMessage,
  });
  const f = fixture(t, { setup: async () => { throw error; } });
  const request = interaction({ kind: 'command', commandName: 'setup', manager: true, options: { apply: true } });
  await f.handler(request);
  assert.equal(last(request).content, publicMessage);
  assert.doesNotMatch(JSON.stringify(request.calls), /private host detail/);
});

test('setup keeps arbitrary or forged error details out of member replies', async t => {
  for (const properties of [
    { code: 'SETUP_PERMISSIONS', missingPermissions: ['ManageChannels'], publicMessage: 'secret credential detail' },
    { code: 'SETUP_PERMISSIONS', missingPermissions: ['secret credential detail'], publicMessage: 'secret credential detail' },
    { code: 'OTHER', missingPermissions: ['ManageChannels'], publicMessage: 'secret credential detail' },
  ]) {
    const f = fixture(t, { setup: async () => { throw Object.assign(new Error('secret credential detail'), properties); } });
    const request = interaction({ customId: 'glow:setup-apply', manager: true });
    await f.handler(request);
    assert.match(last(request).content, /could not finish/);
    assert.doesNotMatch(JSON.stringify(request.calls), /secret credential detail/);
  }
});

test('search pagination retains its product query and is scoped to the requesting user', async t => {
  const f = fixture(t);
  for (let n = 1; n <= 6; n++) f.store.addProduct(GUILD, product(n));
  f.store.addProduct(GUILD, { ...product(7), name: 'Unrelated cleanser', variant: 'Clear' });
  const query = interaction({ kind: 'command', commandName: 'find', options: { query: 'Rose' } });
  await f.handler(query);
  const page = interaction({ customId: 'glow:products:1', messageId: query.replyId });
  await f.handler(page);
  assert.equal(page.calls[0][0], 'update');
  assert.equal(last(page).embeds.length, 2);
  assert.ok(last(page).embeds.every(e => /Rose/.test(e.title)));
  const other = interaction({ customId: 'glow:products:1', messageId: query.replyId, userId: 'other-user' });
  await f.handler(other);
  assert.match(last(other).content, /search expired/);
});

test('valid product requests are saved and notify the private team channel', async t => {
  const f = fixture(t);
  f.store.setConfig(GUILD, { channels: { logs: 'private-logs' } });
  const i = interaction({ kind: 'modal', customId: 'glow:request-submit', fields: { url: product().url, note: 'Rose shade' } });
  await f.handler(i);
  assert.equal(f.store.stats(GUILD).pending_requests, 1);
  assert.equal(f.logs.length, 1);
  assert.match(last(i).content, /Request #1 is saved/);
  assert.deepEqual(f.logs[0].allowedMentions, { parse: [] });
});

test('saved request remains acknowledged when the private notification cannot be delivered', async t => {
  const f = fixture(t);
  f.store.setConfig(GUILD, { channels: { logs: 'private-logs' } });
  f.client.channels.fetch = async () => { throw Object.assign(new Error('Missing access'), { code: 50001 }); };
  const i = interaction({ kind: 'modal', customId: 'glow:request-submit', fields: { url: product().url, note: 'Rose shade' } });
  await f.handler(i);
  assert.equal(f.store.stats(GUILD).pending_requests, 1);
  assert.match(last(i).content, /saved/i);
});

test('DM controls verify current server membership and deny departed members', async t => {
  const f = fixture(t);
  const p = f.store.addProduct(GUILD, product());
  const i = interaction({ customId: `glow:watch:${p.id}`, guildId: null });
  await f.handler(i);
  assert.deepEqual(f.memberships, [USER]);
  assert.equal(f.store.userWatches(GUILD, USER).length, 1);
  f.client.guilds.fetch = async () => ({ members: { fetch: async () => { throw Object.assign(new Error('Unknown member'), { code: 10007 }); } } });
  const denied = interaction({ customId: 'glow:preferences', guildId: null });
  await f.handler(denied);
  assert.match(last(denied).content, /Join the Glowbot server/);
});

test('large personal watch lists fit Discord message limits', async t => {
  const f = fixture(t);
  for (let n = 1; n <= 25; n++) {
    const p = f.store.addProduct(GUILD, { ...product(n), name: 'Long beauty product name '.repeat(10), variant: 'Very long shade and size description '.repeat(3) });
    f.store.watch(GUILD, USER, p.id);
  }
  const i = interaction({ customId: 'glow:mine' });
  await f.handler(i);
  assert.ok(last(i).content.length <= 2000, `message length ${last(i).content.length}`);
});


test('a shared selector does not expose personal categories by editing the public message', async t => {
  const f = fixture(t);
  const i = interaction({ kind: 'select', customId: 'glow:categories', values: ['skincare'], messageId: 'public-panel', ephemeralMessage: false });
  await f.handler(i);
  assert.equal(i.calls[0][0], 'reply');
  assert.equal(last(i).flags, MessageFlags.Ephemeral);
  assert.deepEqual(f.store.categories(GUILD, USER), ['skincare']);
});

test('all guild commands serialize with unique names and restricted admin defaults', () => {
  const { commands } = require('../src/commands');
  const all = commands();
  assert.equal(new Set(all.map(c => c.name)).size, all.length);
  for (const c of all) {
    assert.match(c.name, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 100);
    assert.deepEqual(c.contexts, [0]);
    for (const o of c.options || []) assert.ok(o.name.length <= 32);
  }
  for (const name of ['setup', 'product', 'publish', 'requests', 'source']) {
    assert.equal(all.find(c => c.name === name).default_member_permissions, '32');
  }
  assert.ok(all.some(c => c.name === 'retailers'));
  const trends = all.find(c => c.name === 'trends');
  assert.ok(trends);
  assert.equal(trends.options.find(o => o.name === 'query').max_length, 100);
  assert.deepEqual(trends.options.find(o => o.name === 'filter').choices.map(c => c.value), ['all', 'bestsellers', 'hits', 'rising', 'new', 'upcoming']);
});

test('ordinary members can privately search cached trends using a command or welcome button', async t => {
  const calls = [];
  const trends = { list(options) { calls.push(options); return [{ name: 'Rose tint', url: 'https://wcosmetics.com.au/products/rose-tint', kind: 'bestsellers', source: 'W cosmetics', position: 3, observedAt: Date.now(), evidence: 'Observed in the retailer bestseller collection.' }]; } };
  const f = fixture(t, { trends });
  const command = interaction({ kind: 'command', commandName: 'trends', options: { query: '  Rose  ', filter: 'bestsellers' } });
  await f.handler(command);
  assert.deepEqual(calls[0], { query: 'Rose', filter: 'bestsellers', limit: 200 });
  assert.equal(last(command).flags, MessageFlags.Ephemeral);
  assert.equal(last(command).embeds[0].title, 'Rose tint');
  const button = interaction({ customId: 'glow:trends' });
  await f.handler(button);
  assert.deepEqual(calls[1], { query: '', filter: 'all', limit: 200 });
  assert.equal(last(button).flags, MessageFlags.Ephemeral);
  assert.equal(f.inspections, 0);
  assert.equal(f.logs.length, 0);
  const wrongGuild = interaction({ kind: 'command', commandName: 'trends', guildId: 'another-server' });
  await f.handler(wrongGuild);
  assert.equal(calls.length, 2);
  assert.match(last(wrongGuild).content, /another server/);
});

test('trends reject forged filters and show an honest empty upcoming state', async t => {
  const f = fixture(t);
  const forged = interaction({ kind: 'command', commandName: 'trends', options: { filter: 'invented' } });
  await f.handler(forged);
  assert.match(last(forged).content, /listed discovery filters/);
  const upcoming = interaction({ kind: 'command', commandName: 'trends', options: { filter: 'upcoming' } });
  await f.handler(upcoming);
  assert.match(last(upcoming).embeds[0].description, /No matching explicit dated upcoming announcement/);
});

test('private trend pages and filters retain the query and show the full cached result set', async t => {
  const calls = [];
  const records = Array.from({ length: 9 }, (_, n) => ({ name: `Rose discovery ${n + 1}`, kind: n < 5 ? 'hits' : 'new', source: 'A publisher', observedAt: Date.now(), evidence: 'Dated public evidence.' }));
  const trends = {
    list(options) { calls.push(options); return records.filter(record => options.filter === 'all' || record.kind === options.filter); },
    summary({ query }) { assert.equal(query, 'Rose'); return { editorialArticles: 4, independentPublishers: 2, sourceCount: 3, latestObservedAt: Date.now(), message: 'Observed coverage, not measured demand.' }; },
  };
  const f = fixture(t, { trends });
  const initial = interaction({ kind: 'command', commandName: 'trends', options: { query: 'Rose' } });
  await f.handler(initial);
  assert.equal(last(initial).embeds.length, 4);
  assert.match(last(initial).embeds[0].footer.text, /Page 1 of 3/);
  assert.match(last(initial).content, /4 editorial articles from 2 publisher domains; 3 sources/);
  assert.ok(ids(last(initial)).includes('glow:trends-page:1'));
  const second = interaction({ customId: 'glow:trends-page:1', messageId: initial.replyId });
  await f.handler(second);
  assert.equal(second.calls[0][0], 'update');
  assert.equal(last(second).embeds[0].title, 'Rose discovery 5');
  assert.ok(ids(last(second)).includes('glow:trends-page:0'));
  const third = interaction({ customId: 'glow:trends-page:2', messageId: initial.replyId });
  await f.handler(third);
  assert.equal(last(third).embeds.length, 1);
  assert.equal(last(third).embeds[0].title, 'Rose discovery 9');
  const filtered = interaction({ kind: 'select', customId: 'glow:trends-filter', values: ['hits'], messageId: initial.replyId });
  await f.handler(filtered);
  assert.equal(filtered.calls[0][0], 'update');
  assert.match(last(filtered).embeds[0].footer.text, /Page 1 of 2/);
  assert.ok(last(filtered).components[0].components[0].options.find(option => option.value === 'hits').default);
  const filteredNext = interaction({ customId: 'glow:trends-page:1', messageId: initial.replyId });
  await f.handler(filteredNext);
  assert.equal(last(filteredNext).embeds.length, 1);
  assert.equal(last(filteredNext).embeds[0].title, 'Rose discovery 5');
  assert.ok(calls.every(options => options.query === 'Rose' && options.limit === 200));
  assert.equal(calls.at(-1).filter, 'hits');
});

test('trend sessions reject another user, public message updates and expired controls', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  const f = fixture(t, { trends: { list() { reads++; return []; } } });
  const initial = interaction({ kind: 'command', commandName: 'trends', options: { query: 'private query' } });
  await f.handler(initial);
  const other = interaction({ customId: 'glow:trends-page:1', messageId: initial.replyId, userId: 'other-user' });
  await f.handler(other);
  assert.equal(other.calls[0][0], 'reply');
  assert.equal(last(other).flags, MessageFlags.Ephemeral);
  assert.doesNotMatch(JSON.stringify(other.calls), /private query/);
  const publicControl = interaction({ customId: 'glow:trends-page:1', messageId: initial.replyId, ephemeralMessage: false });
  await f.handler(publicControl);
  assert.equal(publicControl.calls[0][0], 'reply');
  assert.match(last(publicControl).content, /own private discoveries/);
  assert.equal(reads, 1);
  now += 15 * 60_000;
  const expired = interaction({ kind: 'select', customId: 'glow:trends-filter', values: ['hits'], messageId: initial.replyId });
  await f.handler(expired);
  assert.match(last(expired).content, /search expired/);
  assert.equal(reads, 1);
});

test('trend session storage evicts the oldest search after one thousand private searches', async t => {
  const f = fixture(t, { trends: { list() { return []; } } });
  let first;
  for (let n = 0; n < 1001; n++) {
    const request = interaction({ kind: 'command', commandName: 'trends' });
    await f.handler(request);
    first ||= request;
  }
  const old = interaction({ customId: 'glow:trends-page:0', messageId: first.replyId });
  await f.handler(old);
  assert.match(last(old).content, /search expired/);
});

test('deferred DM trend pages carry their user scoped session into the new reply after membership checks', async t => {
  let reads = 0;
  const records = Array.from({ length: 6 }, (_, n) => ({ name: `Saved discovery ${n + 1}`, kind: 'hits', observedAt: Date.now() }));
  const f = fixture(t, { trends: { list() { reads++; return records; } } });
  const initial = interaction({ customId: 'glow:trends', guildId: null });
  await f.handler(initial);
  const next = interaction({ customId: 'glow:trends-page:1', guildId: null, messageId: initial.replyId });
  await f.handler(next);
  assert.equal(next.calls[0][0], 'deferReply');
  assert.equal(last(next).embeds[0].title, 'Saved discovery 5');
  const filtered = interaction({ kind: 'select', customId: 'glow:trends-filter', values: ['hits'], guildId: null, messageId: next.replyId });
  await f.handler(filtered);
  assert.equal(last(filtered).embeds[0].title, 'Saved discovery 1');
  assert.deepEqual(f.memberships, [USER, USER, USER]);
  assert.equal(reads, 3);
  const other = interaction({ customId: 'glow:trends-page:1', guildId: null, messageId: filtered.replyId, userId: 'other-user' });
  await f.handler(other);
  assert.match(last(other).content, /search expired/);
  assert.equal(reads, 3);
  assert.equal(f.memberships.at(-1), 'other-user');
});

test('startup configuration handles legacy token alias, rejects conflict and validates limits', () => {
  const { loadConfig } = require('../src/config');
  const env = { BOT_TOKEN: 'test-token-do-not-use', GUILD_ID: GUILD, DATABASE_PATH: './data/test.sqlite' };
  const current = loadConfig(env);
  assert.equal(current.guildId, GUILD);
  assert.equal(current.checkMs, 300000);
  assert.equal(current.pollMs, 60000);
  assert.equal(loadConfig({ ...env, BOT_TOKEN: undefined, TOKEN: env.BOT_TOKEN }).token, env.BOT_TOKEN);
  assert.throws(() => loadConfig({ ...env, TOKEN: 'different-token' }), /disagree/);
  assert.throws(() => loadConfig({ ...env, BOT_TOKEN: '' }), /Set BOT_TOKEN/);
  assert.throws(() => loadConfig({ ...env, GUILD_ID: 'invalid' }), /GUILD_ID/);
  assert.throws(() => loadConfig({ ...env, PRODUCT_CHECK_SECONDS: '5' }), /PRODUCT_CHECK_SECONDS/);
});

test('source add, list and pause are denied to ordinary members', async t => {
  const f = fixture(t);
  for (const subcommand of ['add', 'list', 'pause']) {
    const i = interaction({ kind: 'command', commandName: 'source', options: { subcommand, url: 'https://lilabeauty.com.au/collections/new-arrivals', category: 'makeup' } });
    await f.handler(i);
    assert.match(last(i).content, /Only a server manager/);
  }
  assert.deepEqual(f.store.listSources(GUILD), []);
});

test('manager can add, review and pause a real-shaped collection source without network access', async t => {
  const discoveries = [];
  const engine = { queueEvents() {}, discover: async source => { discoveries.push(source); return { added: 2, events: [], capacity: 0 }; } };
  const f = fixture(t, { engine });
  const add = interaction({ kind: 'command', commandName: 'source', manager: true, options: { subcommand: 'add', url: 'https://lilabeauty.com.au/collections/new-arrivals', category: 'makeup' } });
  await f.handler(add);
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].url, 'https://lilabeauty.com.au/collections/new-arrivals');
  assert.equal(discoveries[0].category, 'makeup');
  assert.match(last(add).content, /Source #1 is active/);
  assert.match(last(add).content, /first collection import is silent/);
  const list = interaction({ kind: 'command', commandName: 'source', manager: true, options: { subcommand: 'list' } });
  await f.handler(list);
  assert.match(last(list).content, /Lila Beauty/);
  const pause = interaction({ kind: 'command', commandName: 'source', manager: true, options: { subcommand: 'pause', id: 1, paused: true } });
  await f.handler(pause);
  assert.equal(f.store.listSources(GUILD)[0].paused, 1);
  assert.match(last(pause).content, /monitoring updated/);
});

test('unverified collection source is retained with an honest retry message', async t => {
  const f = fixture(t, { engine: { queueEvents() {}, discover: async () => null } });
  const i = interaction({ kind: 'command', commandName: 'source', manager: true, options: { subcommand: 'add', url: 'https://lilabeauty.com.au/collections/new-arrivals', category: 'makeup' } });
  await f.handler(i);
  assert.equal(f.store.listSources(GUILD).length, 1);
  assert.match(last(i).content, /saved, but its feed could not be verified/);
});

test('source setup rejects product URLs, filters and retailers without a collection adapter', async t => {
  const f = fixture(t, { engine: { discover: async () => { assert.fail('Invalid source must not be inspected'); } } });
  for (const url of [product().url, 'https://lilabeauty.com.au/collections/new-arrivals?filter=lipstick', 'https://www.mecca.com/collections/new-arrivals']) {
    const i = interaction({ kind: 'command', commandName: 'source', manager: true, options: { subcommand: 'add', url, category: 'makeup' } });
    await f.handler(i);
    assert.match(last(i).content, /collection page URL|Collection discovery currently supports/);
  }
  assert.deepEqual(f.store.listSources(GUILD), []);
});

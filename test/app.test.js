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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupGuild, CHANNELS } = require('../src/setup');
const { homePanel, publicPreferencesPanel, preferencesPanel, productCards, alertPayload, trendsPanel } = require('../src/ui');

function fixture() {
  const channels = new Map();
  const configs = new Map();
  const created = [];
  const editedMessages = [];
  let serial = 100;
  let writes = 0;
  let sent = 0;
  let permissionsAllowed = true;
  const makeChannel = ({ id = String(++serial), name, type = 0, parent = null, permissionOverwrites = [] }) => {
    const messages = new Map();
    const overwrites = new Map(permissionOverwrites.map(o => [o.id, o]));
    const channel = {
      id, name, type, parentId: parent,
      permissionOverwrites: {
        cache: overwrites,
        async edit(id, values) { overwrites.set(id, { ...(overwrites.get(id) || {}), ...values }); },
      },
      async setParent(id, options) { assert.equal(options.lockPermissions, false); this.parentId = id; return this; },
      messages: {
        async fetch(query) {
          if (typeof query !== 'string') return messages;
          if (!messages.has(query)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          return messages.get(query);
        },
      },
      async send(payload) {
        sent++;
        const message = { id: String(++serial), author: { id: 'bot' }, embeds: payload.embeds,
          async edit(next) { editedMessages.push(this.id); this.embeds = next.embeds; return this; } };
        messages.set(message.id, message);
        return message;
      },
    };
    channels.set(id, channel);
    return channel;
  };
  const guild = {
    id: 'glow-guild',
    channels: { cache: channels, async fetch() { return channels; }, async create(options) { created.push(options); return makeChannel(options); } },
    members: { me: { id: 'bot', permissions: { has() { return permissionsAllowed; } } } },
    roles: { everyone: { id: 'everyone' }, cache: new Map([
      ['moderator', { id: 'moderator', managed: false, permissions: { has(p) { return p === 8192n; } } }],
    ]) },
  };
  const store = {
    getConfig(id) { return configs.get(id) || {}; },
    setConfig(id, config) { writes++; configs.set(id, JSON.parse(JSON.stringify(config))); },
  };
  return { guild, store, makeChannel, created, channels, editedMessages, configs,
    get sent() { return sent; }, get writes() { return writes; }, denyPermissions() { permissionsAllowed = false; } };
}

test('setup dry run previews additions without writing Discord or local configuration', async () => {
  const f = fixture();
  f.makeChannel({ name: '💄makeup-drops', id: 'existing-makeup' });
  const result = await setupGuild(f.guild, f.store, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.plan.some(p => p.startsWith('Reuse channel: 💄makeup-drops')));
  assert.equal(f.created.length, 0);
  assert.equal(f.writes, 0);
  assert.equal(f.sent, 0);
});

test('setup adopts old channels, preserves unrelated content and reruns without duplication', async () => {
  const f = fixture();
  const makeup = f.makeChannel({ name: '💄makeup-drops', id: 'existing-makeup' });
  const general = f.makeChannel({ name: '📱general', id: 'existing-general' });
  const logs = f.makeChannel({ name: '🔒admin-logs', id: 'existing-logs' });
  logs.permissionOverwrites.cache.set('staff', { ViewChannel: true });
  const legacy = f.makeChannel({ name: '🧸labubu-drops', id: 'existing-labubu' });
  const result = await setupGuild(f.guild, f.store);
  assert.equal(result.config.channels.makeup, makeup.id);
  assert.equal(result.config.channels.general, general.id);
  assert.equal(result.config.channels.logs, logs.id);
  assert.equal(logs.permissionOverwrites.cache.get('everyone').ViewChannel, false);
  assert.equal(logs.permissionOverwrites.cache.get('staff').ViewChannel, true);
  assert.equal(makeup.permissionOverwrites.cache.get('everyone').SendMessages, false);
  assert.equal(makeup.permissionOverwrites.cache.get('bot').SendMessages, true);
  assert.equal(makeup.permissionOverwrites.cache.get('moderator').SendMessages, true);
  assert.equal(legacy.parentId, null);
  assert.equal(f.sent, 4);
  const count = f.channels.size;
  const createCount = f.created.length;
  await setupGuild(f.guild, f.store);
  assert.equal(f.channels.size, count);
  assert.equal(f.created.length, createCount);
  assert.equal(f.sent, 4);
  assert.equal(f.editedMessages.length, 4);
  assert.equal(Object.keys(result.config.channels).length, CHANNELS.length);
});

test('setup does not partially apply when required permissions are absent', async () => {
  const f = fixture();
  f.denyPermissions();
  await assert.rejects(setupGuild(f.guild, f.store), error => {
    assert.equal(error.code, 'SETUP_PERMISSIONS');
    assert.deepEqual(error.missingPermissions, ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']);
    assert.equal(error.publicMessage, 'Glowbot needs these server permissions to set up channels: ManageChannels, ManageRoles, ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory. Administrator is not required.');
    return true;
  });
  assert.equal(f.created.length, 0);
  assert.equal(f.writes, 0);
});

test('setup permission preflight reports every missing permission and only the missing names', async () => {
  const f = fixture();
  f.guild.members.me.permissions.has = permission => ![16n, 268435456n].includes(permission);
  await assert.rejects(setupGuild(f.guild, f.store), error => {
    assert.deepEqual(error.missingPermissions, ['ManageChannels', 'ManageRoles']);
    assert.equal(error.publicMessage, 'Glowbot needs these server permissions to set up channels: ManageChannels, ManageRoles. Administrator is not required.');
    return error.code === 'SETUP_PERMISSIONS';
  });
  assert.equal(f.created.length, 0);
  assert.equal(f.writes, 0);
  assert.equal(f.sent, 0);
});

test('new private Team and logs allow non-administrator staff without exposing them to everyone', async () => {
  const f = fixture();
  const result = await setupGuild(f.guild, f.store);
  const teamOptions = f.created.find(c => c.type === 4 && c.name === 'Team');
  const staffCategoryOverwrite = teamOptions.permissionOverwrites.find(o => o.id === 'moderator');
  assert.ok(staffCategoryOverwrite);
  const staffAllow = staffCategoryOverwrite.allow.reduce((mask, permission) => mask | permission, 0n);
  for (const required of [1024n, 2048n, 16384n, 65536n]) assert.equal(staffAllow & required, required);
  const logs = f.channels.get(result.config.channels.logs);
  const staffLogsOverwrite = logs.permissionOverwrites.cache.get('moderator');
  assert.equal(staffLogsOverwrite.ViewChannel, true);
  assert.equal(staffLogsOverwrite.SendMessages, true);
  assert.equal(staffLogsOverwrite.EmbedLinks, true);
  assert.equal(staffLogsOverwrite.ReadMessageHistory, true);
  assert.equal(logs.permissionOverwrites.cache.get('everyone').ViewChannel, false);
  const everyoneCategoryOverwrite = teamOptions.permissionOverwrites.find(o => o.id === 'everyone');
  assert.ok(everyoneCategoryOverwrite.deny.includes(1024n));
});

test('setup recovers panel IDs from bot-authored panel markers after configuration loss', async () => {
  const f = fixture();
  await setupGuild(f.guild, f.store);
  f.configs.clear();
  await setupGuild(f.guild, f.store);
  assert.equal(f.sent, 4);
});

test('setup refuses to edit another account message if stored panel ID is wrong', async () => {
  const f = fixture();
  const result = await setupGuild(f.guild, f.store);
  const start = f.channels.get(result.config.channels.start);
  const original = await start.messages.fetch(result.config.panels.home);
  original.author.id = 'human';
  await assert.rejects(setupGuild(f.guild, f.store), /not a Glowbot message/);
  assert.equal(f.editedMessages.length, 0);
});

test('member panels provide a no-command path and suppress mentions', () => {
  const welcome = homePanel({ channels: { rules: 'rules-id' } });
  assert.match(welcome.embeds[0].description, /<#rules-id>/);
  assert.deepEqual(welcome.allowedMentions, { parse: [] });
  assert.deepEqual(welcome.components[0].components.map(b => b.custom_id), ['glow:preferences', 'glow:search', 'glow:request', 'glow:mine', 'glow:help']);
  assert.equal(welcome.components[1].components[0].custom_id, 'glow:trends');
  const choices = preferencesPanel(['makeup']);
  assert.equal(choices.components[0].components[0].min_values, 0);
  assert.equal(choices.components[0].components[0].options.find(o => o.value === 'makeup').default, true);
});

test('trend cards show literal list movement and dates without claiming measured sales', () => {
  const now = Date.now();
  const card = trendsPanel([{ name: 'A retailer favourite', url: 'https://wcosmetics.com.au/products/item', sourceUrl: 'https://wcosmetics.com.au/collections/best-seller', source: '@everyone Shop', kind: 'rising', position: 3, previousPosition: 12, previousObservedAt: now - 86400000, observedAt: now, evidence: 'Moved higher in the displayed retailer list.' }]);
  assert.match(card.embeds[0].description, /Retailer list position: 12 at <t:\d+:f> → 3 at <t:\d+:f>/);
  assert.match(card.content, /not measured sales/);
  assert.match(card.content, /New means newly observed/);
  assert.ok(!card.embeds[0].description.includes('@everyone'));
  assert.deepEqual(card.allowedMentions, { parse: [] });
});

test('trend cards remain within Discord embed limits and reject unsafe links', () => {
  const records = Array.from({ length: 10 }, () => ({ name: 'N'.repeat(500), source: 'S'.repeat(500), evidence: 'E'.repeat(5000), kind: 'new', observedAt: Date.now(), url: 'javascript:alert(1)', sourceUrl: 'https://user:secret@example.com/' }));
  const cards = trendsPanel(records, { query: '@everyone _query_' });
  assert.equal(cards.embeds.length, 4);
  assert.ok(cards.embeds.every(e => e.title.length <= 200 && e.description.length <= 1100 && !e.url));
  const combined = cards.content.length + cards.embeds.reduce((n, e) => n + e.title.length + e.description.length, 0);
  assert.ok(combined <= 6000);
  assert.ok(!JSON.stringify(cards).includes('secret'));
});

test('trend results sharing a source keep all four cards without duplicate embed URLs', () => {
  const source = 'https://www.allure.com/story/2026-readers-choice-winner-product-reviews';
  const names = ['Amika dry shampoo', 'CeraVe cleanser', 'e.l.f. skin tint', 'Haus Labs foundation'];
  const cards = trendsPanel(names.map(name => ({ name, kind: 'hits', source: 'Allure', sourceUrl: source, url: source, observedAt: Date.now() })));
  assert.deepEqual(cards.embeds.map(card => card.title), names);
  assert.ok(cards.embeds.every(card => !Object.hasOwn(card, 'url')));
  assert.ok(cards.embeds.every(card => card.description.includes(`[View source](${source})`)));
  assert.ok(cards.embeds.every(card => !card.description.includes('#')));
  const distinct = trendsPanel([{ name: 'Retailer product', kind: 'bestsellers', position: 1, sourceUrl: 'https://wcosmetics.com.au/collections/best-seller', url: 'https://wcosmetics.com.au/products/item', observedAt: Date.now() }]);
  assert.match(distinct.embeds[0].description, /\[View source\]\(https:\/\/wcosmetics.com.au\/collections\/best-seller\)/);
  assert.match(distinct.embeds[0].description, /\[View product\]\(https:\/\/wcosmetics.com.au\/products\/item\)/);
  assert.ok(!Object.hasOwn(distinct.embeds[0], 'url'));
});

test('reader picks and search interest signals use their own evidence labels', () => {
  const now = Date.now();
  const cards = trendsPanel([
    { name: 'Reader picked mascara', kind: 'hits', source: 'Allure', observedAt: now, evidence: 'Listed in the 2026 reader voted awards.' },
    { name: 'Beauty search topic', kind: 'rising', source: 'Google Trends AU', observedAt: now, evidence: 'Reported by the public search interest feed.' },
  ]);
  assert.match(cards.embeds[0].description, /2026 reader voted winner/);
  assert.match(cards.embeds[1].description, /Observed interest signal/);
  assert.doesNotMatch(cards.embeds[1].description, /Moved higher|Retailer list position/);
  assert.match(cards.content, /cached source snapshot/);
  assert.match(trendsPanel([], { filter: 'hits' }).embeds[0].description, /No matching verified 2026 reader voted winner/);
});

test('trend browsing paginates four records and renders bounded literal coverage counts', () => {
  const records = Array.from({ length: 9 }, (_, n) => ({ name: `Saved result ${n + 1}`, kind: 'new', observedAt: Date.now(), evidence: 'A public headline.' }));
  const summary = { editorialArticles: 7, independentPublishers: 2, sourceCount: 4, latestObservedAt: Date.now(), message: '@everyone ' + 'M'.repeat(5000) };
  const first = trendsPanel(records, { query: 'Rose', filter: 'new', summary, interactive: true });
  assert.equal(first.embeds.length, 4);
  assert.match(first.embeds[0].footer.text, /Page 1 of 3/);
  assert.equal(first.components[0].components[0].custom_id, 'glow:trends-filter');
  assert.equal(first.components[1].components[0].custom_id, 'glow:trends-page:1');
  assert.match(first.content, /7 editorial articles from 2 publisher domains; 4 sources/);
  assert.ok(first.content.length <= 1000);
  assert.ok(!first.content.includes('@everyone'));
  const last = trendsPanel(records, { page: 2, interactive: true });
  assert.equal(last.embeds.length, 1);
  assert.equal(last.embeds[0].title, 'Saved result 9');
  assert.equal(last.components[1].components[0].custom_id, 'glow:trends-page:1');
  const invalid = trendsPanel([], { summary: { editorialArticles: -1, independentPublishers: Infinity, sourceCount: '999', message: '' } });
  assert.match(invalid.content, /0 editorial articles from 0 publisher domains; 0 sources/);
  const automatic = trendsPanel([records[0]]);
  assert.deepEqual(automatic.components, []);
});

test('unavailable trend sources display only a fixed saved observation notice', () => {
  const cards = trendsPanel([{ name: 'Saved find', kind: 'new', observedAt: Date.now(), sourceUnavailable: true, sourceError: 'private error detail', evidence: 'Saved public evidence.' }]);
  assert.match(cards.embeds[0].description, /Source temporarily unavailable\. Showing the last saved observation\./);
  assert.doesNotMatch(JSON.stringify(cards), /private error detail/);
});

test('public preferences panel opens private controls without exposing member choices', () => {
  const panel = publicPreferencesPanel();
  assert.ok(panel.components.every(r => r.components.every(c => c.type === 2)));
  assert.equal(panel.components[0].components[0].custom_id, 'glow:preferences');
  assert.match(panel.embeds[0].description, /choices are private/);
});

test('product cards paginate within Discord component limits and preserve exact variant and price', () => {
  const products = Array.from({ length: 7 }, (_, n) => ({ id: n + 1, name: `Product ${n}`, url: 'https://www.mecca.com/en-au/product/', variant: 'Rose 02', price: 49.95, currency: 'AUD', availability: 'in_stock' }));
  const first = productCards(products);
  assert.equal(first.embeds.length, 4);
  assert.equal(first.components.length, 5);
  assert.match(first.embeds[0].description, /Rose 02/);
  assert.match(first.embeds[0].description, /49\.95 AUD/);
  assert.equal(first.components[4].components[0].custom_id, 'glow:products:1');
  const last = productCards(products, 1);
  assert.equal(last.embeds.length, 3);
  assert.equal(last.components[3].components[0].custom_id, 'glow:products:0');
});

test('alerts include source, exact variant, timestamp and safe outbound shop link', () => {
  const result = alertPayload({ kind: 'price_drop', previousPrice: 60, checkedAt: '2026-10-30T00:00:00Z', product: {
    id: 42, name: 'Blush', retailer: '@everyone Shop', variant: 'Pink 03', price: 45, currency: 'AUD', url: 'https://www.adorebeauty.com.au/blush.html',
  } });
  assert.match(result.embeds[0].title, /Price drop/);
  assert.match(result.embeds[0].description, /Pink 03/);
  assert.match(result.embeds[0].description, /<t:\d+:f>/);
  assert.ok(!result.embeds[0].description.includes('@everyone'));
  assert.equal(result.components[0].components[0].url, 'https://www.adorebeauty.com.au/blush.html');
  assert.deepEqual(result.allowedMentions, { parse: [] });
});

test('product cards distinguish paused, failed and stale checks from current availability', () => {
  const product = { id: 42, name: 'Blush', url: 'https://www.mecca.com/blush/', price: 45, currency: 'AUD', availability: 'in_stock', last_success: Date.now() };
  assert.match(productCards([product]).embeds[0].description, /Available to order/);
  assert.doesNotMatch(productCards([product]).embeds[0].description, /unconfirmed/);
  assert.match(productCards([{ ...product, error: 'HTTP_403' }]).embeds[0].description, /Source needs attention.*Current availability is unconfirmed/s);
  assert.match(productCards([{ ...product, paused: 1 }]).embeds[0].description, /Monitoring paused/);
  assert.match(productCards([{ ...product, last_success: Date.now() - 16 * 60_000 }]).embeds[0].description, /Check is stale/);
  assert.match(productCards([{ ...product, candidate_stock: 'out_of_stock' }]).embeds[0].description, /pending confirmation/);
});

test('restock alert describes ordering availability without claiming physical store stock', () => {
  const alert = alertPayload({ kind: 'restock', product: { id: 1, name: 'Serum', url: 'https://www.mecca.com/serum/' } });
  assert.match(alert.embeds[0].title, /Available to order again/);
});

test('new collection products use a new arrival label rather than a restock claim', () => {
  const alert = alertPayload({ kind: 'new_drop', product: { id: 1, name: 'Serum', url: 'https://lilabeauty.com.au/products/serum' } });
  assert.match(alert.embeds[0].title, /New arrival available to order/);
});

'use strict';
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const http = require('node:http');
const { Store } = require('./store');
const { loadConfig, CATEGORIES } = require('./config');
const { commands } = require('./commands');
const { setupGuild, SETUP_PERMISSION_NAMES } = require('./setup');
const ui = require('./ui');
const { inspectProduct, inspectCollection, validateProductUrl, RETAILERS } = require('./retailers');
const { Engine } = require('./engine');
const { TrendsService } = require('./trends');
const safe = value => String(value ?? '').replace(/@/g, '@\u200b').replace(/[\[\]_*`~|<>]/g, '\\$&');
const text = content => ({ content, allowedMentions: { parse: [] } });
const privateReply = (interaction, payload) => interaction.deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
const privateUpdate = (interaction, payload) => interaction.deferred ? interaction.editReply(payload) :
  interaction.message?.flags?.has(MessageFlags.Ephemeral) ? interaction.update(payload) : privateReply(interaction, payload);
const isManager = interaction => interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

function modal(id, title, fields) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields.map(field =>
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(field.id).setLabel(field.label)
      .setStyle(field.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(field.required !== false)
      .setMaxLength(field.max || 200).setPlaceholder(field.placeholder || ''))));
}

function createHandler({ store, client, config, engine, trends, inspect = inspectProduct, setup = setupGuild }) {
  let settingUp = false;
  // Bounded short lived search state preserves pagination without exposing user searches.
  const searches = new Map();
  const trendSearches = new Map();
  const trendFilters = ['all', 'hits', 'bestsellers', 'rising', 'new', 'upcoming'];
  const searchKey = i => `${i.user.id}:${i.message?.id || 'command'}`;
  const matches = query => store.listProducts(config.guildId, { search: query, limit: 1000 }).filter(p => !p.paused);
  const remember = (key, query) => {
    for (const [id, entry] of searches) if (entry.expires < Date.now()) searches.delete(id);
    if (searches.size > 1000) searches.delete(searches.keys().next().value);
    searches.set(key, { query, expires: Date.now() + 15 * 60_000 });
  };
  const rememberTrends = (key, query, filter) => {
    for (const [id, entry] of trendSearches) if (entry.expires <= Date.now()) trendSearches.delete(id);
    if (trendSearches.size >= 1000 && !trendSearches.has(key)) trendSearches.delete(trendSearches.keys().next().value);
    trendSearches.set(key, { query, filter, expires: Date.now() + 15 * 60_000 });
  };
  const trendPayload = (query, filter, page = 0) => ui.trendsPanel(
    trends?.list({ query, filter, limit: 200 }) || [],
    { query, filter, page, summary: trends?.summary?.({ query }), interactive: true },
  );
  const myAlerts = (interaction, requestedPage = 0) => {
    const categories = store.categories(config.guildId, interaction.user.id);
    const watched = store.userWatches(config.guildId, interaction.user.id);
    const count = watched.length;
    const pages = Math.max(1, Math.ceil(count / 10));
    const page = Math.max(0, Math.min(pages - 1, Number(requestedPage) || 0));
    const shown = watched.slice(page * 10, (page + 1) * 10);
    const payload = text(`**Your alerts**\nCategories: ${categories.length ? categories.join(', ') : 'None'}\n\n` +
      (count ? shown.map(p => `#${p.id}: ${safe(p.name.slice(0, 65))}${p.variant ? ` (${safe(p.variant.slice(0, 30))})` : ''}`).join('\n') + `\nPage ${page + 1} of ${pages}.` : 'No individual product watches.') +
      '\n\nCategory and product alerts arrive as optional direct messages. Clear categories or remove product watches to stop them.');
    payload.components = [];
    if (count) payload.components.push({ type: 1, components: [{ type: 3, custom_id: `glow:remove-watches:${page}`, placeholder: 'Remove selected product watches', min_values: 1, max_values: shown.length,
      options: shown.map(p => ({ label: `#${p.id} ${p.name}`.slice(0, 100), description: (p.variant || p.retailer || 'Individual watch').slice(0, 100), value: String(p.id) })) }] });
    const navigation = [];
    if (page > 0) navigation.push({ type: 2, style: 2, custom_id: `glow:mine:${page - 1}`, label: 'Previous' });
    if (page + 1 < pages) navigation.push({ type: 2, style: 2, custom_id: `glow:mine:${page + 1}`, label: 'Next' });
    if (navigation.length) payload.components.push({ type: 1, components: navigation });
    payload.components.push({ type: 1, components: [
      { type: 2, style: 1, custom_id: 'glow:preferences', label: 'Choose categories' },
      { type: 2, style: 2, custom_id: 'glow:search', label: 'Find a product' },
      { type: 2, style: 4, custom_id: 'glow:clear', label: 'Stop all my alerts' },
    ] });
    return payload;
  };
  const status = () => {
    const stats = store.stats(config.guildId);
    const sourcesNeedingAttention = store.listProducts(config.guildId, { limit: 1000 })
      .filter(p => !p.paused && (p.error || !p.last_success || p.last_success < Date.now() - 2 * config.checkMs)).length;
    const discoveryErrors = store.listSources(config.guildId)
      .filter(s => !s.paused && (s.error || !s.last_success || s.last_success < Date.now() - 20 * 60_000)).length;
    return ui.statusPanel({ connected: client.isReady(), products: stats.products, lastSuccess: stats.last_success,
      errors: sourcesNeedingAttention, pending: stats.pending_deliveries,
      message: `${stats.products ? '' : 'No live products have been added yet. '}${discoveryErrors} collection sources need attention. ${stats.failed_deliveries || 0} failed deliveries. Product check target: ${config.checkMs / 1000} seconds, plus queue, confirmation and delivery time.` });
  };
  async function applySetup(i) {
    if (settingUp) return i.editReply(text('Server setup is already running. Check again shortly.'));
    settingUp = true;
    try {
      const result = await setup(i.guild, store, { dryRun: false });
      await i.editReply(text(`Glowbot is set up. Start in <#${result.config.channels.start}>. Existing messages and unrelated channels were kept.`));
      engine.queueEvents();
    } finally { settingUp = false; }
  }
  async function handle(interaction) {
    if (!(interaction.isChatInputCommand() || interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return;
    if (interaction.guildId && interaction.guildId !== config.guildId) return privateReply(interaction, text('Glowbot is configured for another server.'));
    const id = interaction.customId;
    // Modal opening must be the first response. Membership is checked on submission.
    if (id === 'glow:search') return interaction.showModal(modal('glow:search-submit', 'Find a beauty product', [{ id: 'query', label: 'Product or brand', max: 100 }]));
    if (id === 'glow:request') return interaction.showModal(modal('glow:request-submit', 'Request a product', [
      { id: 'url', label: 'Supported retailer product link', max: 1000 },
      { id: 'note', label: 'Exact shade, size or details', long: true, max: 500, required: false },
    ]));
    // Acknowledge before REST membership checks, which can exceed Discord's deadline.
    if (!interaction.guildId) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = await client.guilds.fetch(config.guildId);
      try { await guild.members.fetch(interaction.user.id); }
      catch { return privateReply(interaction, text('Join the Glowbot server to manage its product alerts.')); }
    }
    const cfg = store.getConfig(config.guildId);
    const command = interaction.commandName;
    if (command === 'glow') return privateReply(interaction, ui.homePanel(cfg));
    if (id?.startsWith('glow:trends-page:') || id === 'glow:trends-filter') {
      const key = searchKey(interaction);
      const session = trendSearches.get(key);
      if (!session || session.expires <= Date.now()) {
        trendSearches.delete(key);
        return privateReply(interaction, text('This discovery search expired. Select Discover beauty trends or use /trends to start again.'));
      }
      if (!interaction.message?.flags?.has(MessageFlags.Ephemeral)) return privateReply(interaction, text('Open your own private discoveries using Discover beauty trends or /trends.'));
      const filter = id === 'glow:trends-filter' ? interaction.values?.[0] : session.filter;
      if (!trendFilters.includes(filter) || (id === 'glow:trends-filter' && interaction.values.length !== 1)) return privateReply(interaction, text('Choose one of the listed discovery filters.'));
      const page = id === 'glow:trends-filter' ? 0 : Number(id.split(':')[2]);
      if (!Number.isSafeInteger(page) || page < 0 || page > 49) return privateReply(interaction, text('This discovery page is unavailable. Start again using /trends.'));
      const result = await privateUpdate(interaction, trendPayload(session.query, filter, page));
      rememberTrends(key, session.query, filter);
      if (interaction.deferred) {
        // DM membership checks defer a new private reply rather than editing
        // the originating message. Its new controls need the same user scope.
        const message = await interaction.fetchReply();
        rememberTrends(`${interaction.user.id}:${message.id}`, session.query, filter);
      }
      return result;
    }
    if (command === 'trends' || id === 'glow:trends') {
      const query = command === 'trends' ? (interaction.options.getString('query') || '').trim().slice(0, 100) : '';
      const filter = command === 'trends' ? interaction.options.getString('filter') || 'all' : 'all';
      if (!trendFilters.includes(filter)) return privateReply(interaction, text('Choose one of the listed discovery filters.'));
      await privateReply(interaction, trendPayload(query, filter));
      const message = await interaction.fetchReply();
      rememberTrends(`${interaction.user.id}:${message.id}`, query, filter);
      return;
    }
    if (command === 'help' || id === 'glow:help') {
      const payload = ui.helpPanel(cfg);
      payload.components.push({ type: 1, components: [{ type: 2, style: 2, custom_id: 'glow:request', label: 'Request a product' }] });
      return privateReply(interaction, payload);
    }
    if (command === 'alerts' || id === 'glow:preferences') return privateReply(interaction, ui.preferencesPanel(store.categories(config.guildId, interaction.user.id)));
    if (id === 'glow:categories') {
      if (!interaction.values.every(c => CATEGORIES.includes(c))) return privateReply(interaction, text('Choose one of the listed categories.'));
      store.setCategories(config.guildId, interaction.user.id, interaction.values);
      return privateUpdate(interaction, ui.preferencesPanel(interaction.values));
    }
    if (command === 'myalerts' || id === 'glow:mine' || id?.startsWith('glow:mine:')) return privateReply(interaction, myAlerts(interaction, id?.split(':')[2]));
    if (id?.startsWith('glow:remove-watches')) {
      for (const productId of interaction.values) store.unwatch(config.guildId, interaction.user.id, Number(productId));
      return privateUpdate(interaction, myAlerts(interaction, id.split(':')[2]));
    }
    if (id === 'glow:clear') {
      store.setCategories(config.guildId, interaction.user.id, []);
      for (const p of store.userWatches(config.guildId, interaction.user.id)) store.unwatch(config.guildId, interaction.user.id, p.id);
      return privateUpdate(interaction, myAlerts(interaction));
    }
    if (id?.startsWith('glow:watch:') || id?.startsWith('glow:unwatch:')) {
      const productId = Number(id.split(':')[2]);
      const product = store.getProduct(config.guildId, productId);
      if (!product || product.paused) return privateReply(interaction, text('This product is no longer active. Use Find a product for current watches.'));
      if (id.startsWith('glow:unwatch:')) store.unwatch(config.guildId, interaction.user.id, productId);
      else store.watch(config.guildId, interaction.user.id, productId);
      return privateReply(interaction, text(`${id.startsWith('glow:unwatch:') ? 'Stopped watching' : 'You are watching'} ${safe(product.name)}${product.variant ? ` (${safe(product.variant)})` : ''}. Use My alerts to manage optional direct messages.`));
    }
    if (command === 'find' || id === 'glow:search-submit' || id?.startsWith('glow:products:')) {
      let query = command === 'find' ? (interaction.options.getString('query') || '') : id === 'glow:search-submit' ? interaction.fields.getTextInputValue('query').trim() : searches.get(searchKey(interaction))?.query;
      if (query === undefined) return privateReply(interaction, text('This search expired. Select Find a product to search again.'));
      const page = id?.startsWith('glow:products:') ? Number(id.split(':')[2]) : 0;
      const payload = ui.productCards(matches(query), page);
      if (id?.startsWith('glow:products:')) {
        remember(searchKey(interaction), query);
        return privateUpdate(interaction, payload);
      }
      await privateReply(interaction, payload);
      const message = await interaction.fetchReply();
      remember(`${interaction.user.id}:${message.id}`, query);
      return;
    }
    if (id === 'glow:request-submit') {
      const url = validateProductUrl(interaction.fields.getTextInputValue('url')).href;
      const note = interaction.fields.getTextInputValue('note').trim();
      if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const requestId = store.addRequest(config.guildId, interaction.user.id, url, note);
      if (cfg.channels.logs) {
        try {
          const log = await client.channels.fetch(cfg.channels.logs);
          await log.send(text(`**Product request #${requestId}**\n${url}\n${safe(note || 'No variant notes supplied.')}\nUse /requests to see the queue or /product add to begin monitoring.`));
        } catch { console.warn(`Request ${requestId} saved; staff notification failed. Review /requests.`); }
      }
      return interaction.editReply(text(`Request #${requestId} is saved for the team. Monitoring begins after they verify this exact product.`));
    }
    if (command === 'privacy') {
      if (interaction.options.getBoolean('delete')) {
        store.forgetUser(config.guildId, interaction.user.id);
        return privateReply(interaction, text('Your saved categories, product watches, requests and private alert delivery records have been deleted. Existing Discord messages remain under your Discord controls.'));
      }
      return privateReply(interaction, text('Glowbot stores your Discord user ID, optional categories, product watches, product requests and delivery records. It does not read your general chat messages. Use /privacy delete:true to remove your saved records and stop alerts.'));
    }
    if (command === 'status') return privateReply(interaction, status());
    if (command === 'retailers') return privateReply(interaction, text('**Supported retailer adapters**\n' + RETAILERS.map(r => `${safe(r.name)}: ${r.domains.join(', ')}`).join('\n') + '\n\nA store adapter can only track pages with readable, exact product data. Blocked pages and ambiguous shades are rejected.'));
    if (command === 'setup' || command === 'product' || command === 'publish' || command === 'requests' || command === 'source' || id === 'glow:setup-apply') {
      if (!isManager(interaction)) return privateReply(interaction, text('Only a server manager can use this control.'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (command === 'source') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
          const sources = store.listSources(config.guildId);
          return interaction.editReply(text(sources.length ? sources.map(s => `#${s.id} ${safe(s.retailer)} · ${s.paused ? 'paused' : s.error || 'active'}\n${s.url}`).join('\n\n').slice(0, 1950) : 'No collection sources yet. Use /source add with a supported retailer collection URL.'));
        }
        if (sub === 'pause') {
          const ok = store.pauseSource(config.guildId, interaction.options.getInteger('id'), interaction.options.getBoolean('paused'));
          return interaction.editReply(text(ok ? 'Source monitoring updated.' : 'Source not found in this server.'));
        }
        if (store.listSources(config.guildId).length >= 5) return interaction.editReply(text('The current limit is five collection sources. Review service capacity before adding more.'));
        const url = validateProductUrl(interaction.options.getString('url'));
        if (!/^\/collections\/[^/]+\/?$/.test(url.pathname) || url.search) return interaction.editReply(text('Use the retailer collection page URL, such as /collections/new-arrivals, without filters.'));
        const retailer = RETAILERS.find(r => r.domains.includes(url.hostname.replace(/^www\./, '')));
        if (retailer?.adapter !== 'shopify') return interaction.editReply(text('Collection discovery currently supports Lila Beauty, W cosmetics and Glam Raider. Other retailer adapters track exact products only.'));
        const source = store.addSource(config.guildId, { url: url.href.replace(/\/$/, ''), category: interaction.options.getString('category'), retailer: retailer.name });
        const result = await engine.discover(source);
        return interaction.editReply(text(result ? `Source #${source.id} is active. ${result.added} product variants added. The first collection import is silent. Later newly seen products that are available to order are announced. This feed covers up to 100 recent products, with a 1000 tracked product capacity.${result.capacity ? ` ${result.capacity} variants deferred at capacity.` : ''}` : `Source #${source.id} was saved, but its feed could not be verified. Check /source list; it will retry with backoff.`));
      }
      if (command === 'requests') {
        const resolvedId = interaction.options.getInteger('resolve');
        if (resolvedId) {
          const result = store.resolveRequest(config.guildId, resolvedId);
          return interaction.editReply(text(result ? `Request #${resolvedId} resolved.` : 'Pending request not found.'));
        }
        const pending = store.listRequests(config.guildId, { limit: 5 });
        return interaction.editReply(text(pending.length ? pending.map(r => `**Request #${r.id}**\n${r.url.slice(0, 200)}\n${safe(r.note.slice(0, 120))}`).join('\n\n') + '\n\nUse /product add to verify, then /requests resolve:ID.' : 'No pending product requests.'));
      }
      if (command === 'setup' || id === 'glow:setup-apply') {
        if (id === 'glow:setup-apply' || interaction.options.getBoolean('apply')) return applySetup(interaction);
        const result = await setup(interaction.guild, store, { dryRun: true });
        return interaction.editReply({ ...text('**Glowbot server setup preview**\n' + result.plan.join('\n') + '\n\nCreates channel groups and welcome panels. Existing channels are reused. Alert and guide channels become read only for members; staff logs stay private.'),
          components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'glow:setup-apply', label: 'Apply this layout' }] }] });
      }
      if (command === 'product') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
          const products = store.listProducts(config.guildId, { limit: 1000 });
          return interaction.editReply(text(products.length ? products.slice(0, 35).map(p => `#${p.id} ${safe(p.name)} (${safe(p.variant || 'default')}) · ${p.paused ? 'paused' : p.error || p.availability}`).join('\n').slice(0, 1950) : 'No products yet. Use /product add with a real product URL.'));
        }
        if (sub === 'add') {
          if (store.stats(config.guildId).products >= 1000) return interaction.editReply(text('The monitored product limit is 1000. Pause unused products and review capacity before increasing this limit.'));
          const observation = await inspect(interaction.options.getString('url'), { variant: interaction.options.getString('variant') || undefined });
          const product = store.addProduct(config.guildId, { ...observation, category: interaction.options.getString('category') });
          store.scheduleNext(product.id, Date.now() + config.checkMs);
          return interaction.editReply({ ...ui.productCards([product]), content: `Verified product #${product.id}. Monitoring is active. The initial check is a silent baseline.` });
        }
        const product = store.getProduct(config.guildId, interaction.options.getInteger('id'));
        if (!product) return interaction.editReply(text('Product ID not found in this server.'));
        if (sub === 'pause') {
          const paused = interaction.options.getBoolean('paused');
          store.pauseProduct(config.guildId, product.id, paused);
          return interaction.editReply(text(`Product #${product.id} ${paused ? 'paused' : 'resumed'}. Previously queued alerts retain their original checked time.`));
        }
        const checked = await engine.check(product);
        engine.queueEvents();
        if (!checked) return interaction.editReply(text('The source could not be verified. Its last known stock is preserved. Check /product list for the source error.'));
        return interaction.editReply(ui.productCards([store.getProduct(config.guildId, product.id)]));
      }
      if (command === 'publish') {
        if (!cfg.channels.trends) return interaction.editReply(text('Run /setup before publishing.'));
        const source = new URL(interaction.options.getString('source'));
        if (source.protocol !== 'https:' || source.username || source.password) return interaction.editReply(text('Use a public HTTPS source without credentials.'));
        const destination = await client.channels.fetch(cfg.channels.trends);
        const message = await destination.send({ embeds: [{ title: interaction.options.getString('title'), description: safe(interaction.options.getString('note')), url: source.href, color: 0xce688b,
          footer: { text: 'Team sourced beauty update' }, timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
        return interaction.editReply(text(`Published: ${message.url}`));
      }
    }
    return privateReply(interaction, text('This control is no longer supported. Open /glow for current controls.'));
  }
  return async interaction => {
    try { await handle(interaction); }
    catch (error) {
      console.warn(`Interaction ${interaction.commandName || 'component'}: ${error.code || error.name || 'error'}`);
      const isSetupAction = interaction.commandName === 'setup' || interaction.customId === 'glow:setup-apply';
      const knownMissingPermissions = isSetupAction && error.code === 'SETUP_PERMISSIONS' &&
        Array.isArray(error.missingPermissions) && error.missingPermissions.length > 0 &&
        error.missingPermissions.length <= SETUP_PERMISSION_NAMES.length &&
        new Set(error.missingPermissions).size === error.missingPermissions.length &&
        error.missingPermissions.every(name => SETUP_PERMISSION_NAMES.includes(name));
      const expectedSetupMessage = knownMissingPermissions ?
        `Glowbot needs these server permissions to set up channels: ${error.missingPermissions.join(', ')}. Administrator is not required.` : null;
      // Only this exact, hardcoded preflight message may cross the private-log boundary.
      const safeSetupMessage = expectedSetupMessage && error.publicMessage === expectedSetupMessage ? expectedSetupMessage : null;
      const message = text(safeSetupMessage || (error.name === 'RetailerError' ? `${error.message}\nUse /retailers for supported shops.` : 'This action could not finish. Try again, or ask the team to check the private host logs.'));
      try {
        if (interaction.deferred) await interaction.editReply(message);
        else if (interaction.replied) await interaction.followUp({ ...message, flags: MessageFlags.Ephemeral });
        else await privateReply(interaction, message);
      } catch { /* Discord may have expired the interaction. No public fallback. */ }
    }
  };
}

async function start() {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const trends = new TrendsService({ store, client, config });
  const engine = new Engine({ store, client, inspectProduct, inspectCollection, config, trends });
  let server;
  client.on(Events.InteractionCreate, createHandler({ store, client, config, engine, trends }));
  client.on(Events.Error, error => console.error(`Discord error: ${error.code || error.name}`));
  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      await guild.commands.set(commands());
      engine.start();
      console.info('Glowbot connected. Guild commands registered. Use /setup to review the layout.');
    } catch (error) {
      console.error(`Startup checks failed: ${error.code || error.name}`);
      await shutdown(1);
    }
  });
  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    await engine.stop();
    client.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    store.close();
    process.exitCode = code;
  }
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  try {
    await client.login(config.token);
    server = http.createServer((req, res) => {
      if (req.url !== '/healthz') { res.writeHead(404); return res.end(); }
      res.writeHead(client.isReady() ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ connected: client.isReady(), monitorRunning: engine.running, lastCycle: engine.lastCycle }));
    });
    server.on('error', error => { console.error(`Health server: ${error.code || error.name}`); void shutdown(1); });
    server.listen(config.port, '0.0.0.0');
    return { client, store, engine, shutdown };
  } catch (error) { await shutdown(1); throw error; }
}
module.exports = { start, createHandler, isManager };

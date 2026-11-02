'use strict';

const { homePanel, publicPreferencesPanel, rulesPanel, helpPanel } = require('./ui');

const PERM = Object.freeze({
  Administrator: 8n, ManageChannels: 16n, ManageGuild: 32n, AddReactions: 64n,
  ViewChannel: 1024n, SendMessages: 2048n, ManageMessages: 8192n, EmbedLinks: 16384n,
  ReadMessageHistory: 65536n, ManageRoles: 268435456n, CreatePublicThreads: 34359738368n,
  CreatePrivateThreads: 68719476736n, SendMessagesInThreads: 274877906944n,
});
const SETUP_PERMISSION_NAMES = Object.freeze([
  'ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory',
]);
const CATEGORIES = [
  { key: 'welcome', name: 'Welcome & Rules' },
  { key: 'alerts', name: 'Beauty Alerts' },
  { key: 'community', name: 'Community' },
  { key: 'support', name: 'Guides & Support' },
  { key: 'team', name: 'Team', private: true },
];
const CHANNELS = [
  { key: 'start', name: '👋│start-here', category: 'welcome', readonly: true, aliases: ['start-here', 'welcome'] },
  { key: 'rules', name: '📜│rules', category: 'welcome', readonly: true, aliases: ['rules'] },
  { key: 'preferences', name: '🔔│choose-alerts', category: 'welcome', readonly: true, aliases: ['choose-alerts', 'notification-roles'] },
  { key: 'makeup', name: '💄│makeup-drops', category: 'alerts', readonly: true, aliases: ['makeup-drops', 'beauty-drops'] },
  { key: 'skincare', name: '🧴│skincare-drops', category: 'alerts', readonly: true, aliases: ['skincare-drops'] },
  { key: 'haircare', name: '💇│haircare-drops', category: 'alerts', readonly: true, aliases: ['haircare-drops'] },
  { key: 'fragrance', name: '🌸│fragrance-drops', category: 'alerts', readonly: true, aliases: ['fragrance-drops'] },
  { key: 'sales', name: '🏷️│sales-and-deals', category: 'alerts', readonly: true, aliases: ['sales-and-deals', 'sales', 'deals'] },
  { key: 'trends', name: '🔥│trending-beauty', category: 'alerts', readonly: true, aliases: ['trending-beauty'] },
  { key: 'general', name: '💬│general', category: 'community', aliases: ['general', 'general-chat'] },
  { key: 'requests', name: '🔎│product-requests', category: 'community', aliases: ['product-requests', 'requests'] },
  { key: 'feedback', name: '🗣│feedback', category: 'community', aliases: ['feedback', 'requests-feedback'] },
  { key: 'wins', name: '✨│beauty-wins', category: 'community', aliases: ['beauty-wins'] },
  { key: 'help', name: '📖│how-it-works', category: 'support', readonly: true, aliases: ['how-it-works', 'guides'] },
  { key: 'commands', name: '🤖│bot-commands', category: 'support', aliases: ['bot-commands'] },
  { key: 'logs', name: '🔒│admin-logs', category: 'team', private: true, aliases: ['admin-logs'] },
];

function normalise(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function values(collection) { return Array.from(collection?.values?.() || []); }
function hasPermission(role, permission) {
  try { return Boolean(role?.permissions?.has(permission)); } catch { return false; }
}

/**
 * Reuses known channel IDs and aliases; never deletes, renames or empties channels.
 * Dry run returns the intended layout without touching Discord or the store.
 * The caller is responsible for restricting this function to the configured guild
 * and a server manager. Every post is a bot-authored setup panel, never a user DM.
 */
async function setupGuild(guild, store, { dryRun = false } = {}) {
  const config = { ...store.getConfig(guild.id) };
  config.channels = { ...(config.channels || {}) };
  config.panels = { ...(config.panels || {}) };
  const fetched = await guild.channels.fetch();
  const all = values(fetched || guild.channels.cache);
  const plan = [];
  const categories = {};

  const findChannel = definition => all.find(c => c.id === config.channels[definition.key] && c.type === 0) ||
    all.find(c => c.type === 0 && definition.aliases.includes(normalise(c.name)));
  for (const definition of CATEGORIES) {
    const existing = all.find(c => c.type === 4 && normalise(c.name) === normalise(definition.name));
    categories[definition.key] = existing;
    if (!existing) plan.push(`Create category: ${definition.name}${definition.private ? ' (private)' : ''}`);
  }
  for (const definition of CHANNELS) {
    const existing = findChannel(definition);
    plan.push(`${existing ? 'Reuse' : 'Create'} channel: ${existing?.name || definition.name} → ${CATEGORIES.find(c => c.key === definition.category).name}`);
    if (definition.private) plan.push(`Keep ${existing?.name || definition.name} private to staff and the bot`);
  }
  if (dryRun) return { dryRun: true, plan, config };

  const me = guild.members.me || await guild.members.fetchMe();
  const missingPermissions = SETUP_PERMISSION_NAMES.filter(name => !hasPermission(me, PERM[name]));
  if (missingPermissions.length) {
    const publicMessage = `Glowbot needs these server permissions to set up channels: ${missingPermissions.join(', ')}. Administrator is not required.`;
    throw Object.assign(new Error('Glowbot setup is missing required bot permissions.'), {
      code: 'SETUP_PERMISSIONS', missingPermissions, publicMessage,
    });
  }
  const everyoneId = guild.roles.everyone.id;
  const botId = me.id;
  const staff = values(guild.roles.cache).filter(r => r.id !== everyoneId && !r.managed &&
    (hasPermission(r, PERM.ManageGuild) || hasPermission(r, PERM.ManageMessages)));
  const botAllow = { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true };
  const botAllowBits = PERM.ViewChannel | PERM.SendMessages | PERM.EmbedLinks | PERM.ReadMessageHistory;
  for (const definition of CATEGORIES) {
    if (categories[definition.key]) continue;
    const options = { name: definition.name, type: 4, reason: 'Glowbot community setup' };
    if (definition.private) options.permissionOverwrites = [
      { id: everyoneId, deny: [PERM.ViewChannel] },
      { id: botId, allow: [botAllowBits] },
      ...staff.map(role => ({ id: role.id, allow: [botAllowBits] })),
    ];
    const created = await guild.channels.create(options);
    all.push(created);
    categories[definition.key] = created;
  }
  for (const definition of CHANNELS) {
    let target = findChannel(definition);
    const parent = categories[definition.category].id;
    if (!target) {
      const options = { name: definition.name, type: 0, parent, reason: 'Glowbot community setup' };
      if (definition.private) options.permissionOverwrites = [
        { id: everyoneId, deny: [PERM.ViewChannel] },
        { id: botId, allow: [botAllowBits] },
        ...staff.map(role => ({ id: role.id, allow: [botAllowBits] })),
      ];
      target = await guild.channels.create(options);
      all.push(target);
    } else if (target.parentId !== parent) {
      await target.setParent(parent, { lockPermissions: false, reason: 'Organise Glowbot channels' });
    }
    config.channels[definition.key] = target.id;
    // Persist progress so a network failure halfway through can resume cleanly.
    store.setConfig(guild.id, config);
    if (definition.private) {
      await target.permissionOverwrites.edit(everyoneId, { ViewChannel: false }, { reason: 'Keep Glowbot logs private' });
      await target.permissionOverwrites.edit(botId, botAllow, { reason: 'Allow Glowbot to write its private logs' });
      for (const role of staff) await target.permissionOverwrites.edit(role.id, botAllow, { reason: 'Allow server staff to read and use Glowbot logs' });
    } else if (definition.readonly) {
      await target.permissionOverwrites.edit(everyoneId, {
        SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false, SendMessagesInThreads: false,
      }, { reason: 'Keep information and product alert channels readable' });
      await target.permissionOverwrites.edit(botId, botAllow, { reason: 'Allow Glowbot to publish alerts' });
      for (const role of staff) await target.permissionOverwrites.edit(role.id, { SendMessages: true }, { reason: 'Preserve staff access to information channels' });
    }
  }

  const panelDefinitions = [
    ['start', 'home', () => homePanel(config)],
    ['rules', 'rules', () => rulesPanel()],
    ['preferences', 'preferences', () => publicPreferencesPanel()],
    ['help', 'help', () => helpPanel(config)],
  ];
  for (const [channelKey, panelKey, build] of panelDefinitions) {
    const target = all.find(c => c.id === config.channels[channelKey]);
    const marker = `Glowbot setup panel · ${panelKey}`;
    let existing;
    if (config.panels[panelKey]) {
      try { existing = await target.messages.fetch(config.panels[panelKey]); }
      catch (error) { if (error.code !== 10008) throw error; }
    }
    if (!existing) {
      const recent = await target.messages.fetch({ limit: 50 });
      existing = values(recent).find(m => m.author?.id === botId && m.embeds?.some(e => e.footer?.text === marker));
    }
    if (existing && existing.author?.id !== botId) throw new Error(`Saved ${panelKey} panel is not a Glowbot message; no message was changed.`);
    const message = existing ? await existing.edit(build()) : await target.send(build());
    config.panels[panelKey] = message.id;
    store.setConfig(guild.id, config);
  }
  return { dryRun: false, plan, config };
}

module.exports = { setupGuild, CHANNELS, CATEGORIES, normalise, SETUP_PERMISSION_NAMES };

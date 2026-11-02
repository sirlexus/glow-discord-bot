'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const { CATEGORIES } = require('./config');
const categoryOption = option => option.setName('category').setDescription('Beauty category').setRequired(true)
  .addChoices(...CATEGORIES.filter(c => c !== 'sales').map(c => ({ name: c, value: c })));
const base = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
const admin = builder => builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
function commands() {
  return [
    base('glow', 'Open your Glowbot home and alert controls'),
    base('help', 'How to use Glowbot'),
    base('alerts', 'Choose your beauty alert categories'),
    base('find', 'Find monitored beauty products').addStringOption(o => o.setName('query').setDescription('Product or brand').setMaxLength(100)),
    base('trends', 'Browse sourced beauty discoveries and observed retailer favourites')
      .addStringOption(o => o.setName('query').setDescription('Product, brand or headline').setMaxLength(100))
      .addStringOption(o => o.setName('filter').setDescription('Type of sourced discovery').addChoices(
        { name: 'All discoveries', value: 'all' }, { name: 'Retailer favourites', value: 'bestsellers' },
        { name: '2026 reader picks', value: 'hits' },
        { name: 'Observed interest signals', value: 'rising' }, { name: 'Newly observed coverage', value: 'new' },
        { name: 'Verified upcoming announcements', value: 'upcoming' })),
    base('myalerts', 'See the products and categories you follow'),
    base('privacy', 'See stored data or delete your alert preferences').addBooleanOption(o => o.setName('delete').setDescription('Delete my preferences, product watches and requests')),
    base('status', 'See whether Glowbot and its product sources are working'),
    base('retailers', 'See the supported retailer adapters and their limits'),
    admin(base('setup', 'Preview or apply the Glowbot server layout')).addBooleanOption(o => o.setName('apply').setDescription('Apply the reviewed server layout and welcome panels')),
    admin(base('requests', 'Review or resolve member product requests')).addIntegerOption(o => o.setName('resolve').setDescription('Mark this request ID resolved after review').setMinValue(1)),
    admin(base('source', 'Monitor a recent retailer collection for new arrivals'))
      .addSubcommand(s => s.setName('add').setDescription('Add a supported Shopify retailer collection')
        .addStringOption(o => o.setName('url').setDescription('Retailer /collections/name URL').setMaxLength(1000).setRequired(true))
        .addStringOption(categoryOption))
      .addSubcommand(s => s.setName('list').setDescription('Show collection source health'))
      .addSubcommand(s => s.setName('pause').setDescription('Pause or resume discovery')
        .addIntegerOption(o => o.setName('id').setDescription('Source ID').setMinValue(1).setRequired(true))
        .addBooleanOption(o => o.setName('paused').setDescription('Pause discovery').setRequired(true))),
    admin(base('product', 'Manage monitored products'))
      .addSubcommand(s => s.setName('add').setDescription('Verify a retailer product and begin monitoring')
        .addStringOption(o => o.setName('url').setDescription('Exact product URL from a supported retailer').setRequired(true).setMaxLength(1000))
        .addStringOption(categoryOption)
        .addStringOption(o => o.setName('variant').setDescription('Exact shade, size or variant ID').setMaxLength(120)))
      .addSubcommand(s => s.setName('check').setDescription('Check one product now').addIntegerOption(o => o.setName('id').setDescription('Product ID').setMinValue(1).setRequired(true)))
      .addSubcommand(s => s.setName('pause').setDescription('Pause or resume a product').addIntegerOption(o => o.setName('id').setDescription('Product ID').setMinValue(1).setRequired(true)).addBooleanOption(o => o.setName('paused').setDescription('Pause monitoring').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List products and source errors')),
    admin(base('publish', 'Publish a sourced beauty trend or release'))
      .addStringOption(o => o.setName('title').setDescription('Headline').setMaxLength(180).setRequired(true))
      .addStringOption(o => o.setName('source').setDescription('Public HTTPS source').setMaxLength(1000).setRequired(true))
      .addStringOption(o => o.setName('note').setDescription('Explain the trend or release and its source').setMaxLength(1500).setRequired(true)),
  ].map(c => c.toJSON());
}
module.exports = { commands };

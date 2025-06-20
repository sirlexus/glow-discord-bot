// glowbot/index.js
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`GlowBot is online as ${client.user.tag}`);

  try {
    const trendChannel = client.channels.cache.find(c => c.name === '🔥trending-beauty' && c.isTextBased());
    if (trendChannel) {
      trendChannel.send('✅ GlowBot is now online and watching for makeup trends!');
    }
  } catch (err) {
    console.error('Trend channel send failed:', err.message);
  }

  try {
    const dropChannel = client.channels.cache.find(c => c.name === '💄makeup-drops' && c.isTextBased());
    if (dropChannel) {
      dropChannel.send('✅ GlowBot is now online and tracking real-time makeup drops!');
    }
  } catch (err) {
    console.error('Drop channel send failed:', err.message);
  }
});

client.on('messageCreate', message => {
  if (message.author.bot) return;
  const content = message.content.toLowerCase();

  if (content.includes('makeup') || content.includes('

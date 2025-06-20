// glowbot/index.js
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const axios = require('axios');
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

  const startupChannels = ['💄makeup-drops', '🧸labubu-drops', '👜handbag-drops', '🔥trending-beauty'];
  startupChannels.forEach(name => {
    try {
      const ch = client.channels.cache.find(c => c.name === name && c.isTextBased());
      if (ch) ch.send(`✅ GlowBot is now live and monitoring ${name}!`);
    } catch (err) {
      console.error(`Channel ${name} failed to send startup message:`, err.message);
    }
  });
});

client.on('messageCreate', message => {
  if (message.author.bot) return;
  const content = message.content.toLowerCase();

  if (content.includes('makeup') || content.includes('drop')) {
    message.channel.send('💄 Heads up! A makeup drop might be happening soon. Stay tuned!');
  }

  if (content === '!glow') {
    message.channel.send('✨ GlowBot at your service! Type `makeup`, `drop`, or `!glow` for updates.');
  }
});

const productLinks = [
  // AU bestsellers — Mecca (patched)
  { name: 'Rare Beauty Blush', url: 'https://www.mecca.com.au/rare-beauty-soft-pinch-liquid-blush/V-052855.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Charlotte Tilbury Flawless Filter', url: 'https://www.mecca.com.au/charlotte-tilbury-hollywood-flawless-filter/V-051554.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Glow Recipe Dew Drops', url: 'https://www.mecca.com.au/glow-recipe-watermelon-glow-niacinamide-dew-drops/V-049893.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Hourglass Ambient Blush', url: 'https://www.mecca.com.au/hourglass-ambient-lighting

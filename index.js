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
      dropChannel.send('✅ GlowBot is now online and watching for makeup drops!');
    }
  } catch (err) {
    console.error('Drop channel send failed:', err.message);
  }
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

// Simulated trend alert
async function checkTrends() {
  const trendingTags = [
    '#glowup',
    '#rarebeauty',
    '#softpinch',
    '#makeuphaul',
    '#tiktokmadebuyit'
  ];

  const randomTrend = trendingTags[Math.floor(Math.random() * trendingTags.length)];
  try {
    const trendChannel = client.channels.cache.find(c => c.name === '🔥trending-beauty' && c.isTextBased());
    if (trendChannel) {
      trendChannel.send(`🔥 Trend Alert! The tag **${randomTrend}** is gaining attention on social media.`);
    }
  } catch (err) {
    console.error('Trend alert send failed:', err.message);
  }
}

// Schedule job every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('Running trend check...');
  checkTrends();
});

client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err.message);
});

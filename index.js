// glowbot/index.js
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const puppeteer = require('puppeteer');
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
  // Online status messages removed as requested
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
  {
    name: 'Rare Beauty Blush',
    url: 'https://www.mecca.com.au/rare-beauty-soft-pinch-liquid-blush/I-051524.html',
    keyword: 'add-to-cart',
    channel: '💄makeup-drops'
  },
  {

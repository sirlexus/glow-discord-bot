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
  // ✅ Updated AU bestsellers — Mecca
  { name: 'Rare Beauty Blush', url: 'https://www.mecca.com.au/rare-beauty-soft-pinch-liquid-blush/V-052855.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Charlotte Tilbury Flawless Filter', url: 'https://www.mecca.com.au/charlotte-tilbury-hollywood-flawless-filter/V-051554.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Glow Recipe Dew Drops', url: 'https://www.mecca.com.au/glow-recipe-watermelon-glow-niacinamide-dew-drops/V-049893.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },
  { name: 'Hourglass Ambient Blush', url: 'https://www.mecca.com.au/hourglass-ambient-lighting-blush/V-018059.html', keyword: 'add-to-cart', channel: '💄makeup-drops' },

  // ✅ Labubu drops
  { name: 'Labubu Plush 30cm', url: 'https://popmart.com/products/labubu-30cm-plush-toy', keyword: 'add to cart', channel: '🧸labubu-drops' },
  { name: 'Labubu Explorer Series', url: 'https://popmart.com/products/labubu-the-explorer-series', keyword: 'add to cart', channel: '🧸labubu-drops' },

  // ✅ Handbag drops
  { name: 'Gucci GG Marmont Bag', url: 'https://www.gucci.com/us/en/pr/women/handbags/shoulder-bags/gg-marmont-shoulder-bag-p-443497DTDIT1000', keyword: 'add to bag', channel: '👜handbag-drops' },
  { name: 'Louis Vuitton Speedy 25', url: 'https://au.louisvuitton.com/eng-au/products/speedy-bandouliere-25-monogram-005656', keyword: 'add to cart', channel: '👜handbag-drops' },
  { name: 'Coach Tabby Shoulder Bag', url: 'https://www.coach.com/shop-handbags-tabby', keyword: 'add to bag', channel: '👜handbag-drops' },
  { name: 'Telfar Medium Shopping Bag', url: 'https://shop.telfar.net/collections/shop/products/medium-shopping-bag-black', keyword: 'add to cart', channel: '👜handbag-drops' },
  { name: 'Prada Re-Edition 2005', url: 'https://www.prada.com/au/en/women/bags/re-edition/products.re-edition_2005_nylon_bag.1BH204_R064_F0002_V_OOO.html', keyword: 'add to cart', channel: '👜handbag-drops' },
];

async function checkRealDrops() {
  for (const product of productLinks) {
    try {
      const res = await axios.get(product.url);
      const html = res.data;
      const inStock = html.toLowerCase().includes(product.keyword);

      if (inStock) {
        const dropChannel = client.channels.cache.find(c => c.name === product.channel && c.isTextBased());
        if (dropChannel) {
          dropChannel.send(`🔔 **${product.name}** is now available!\n🔗 ${product.url}`);
        }
      }
    } catch (err) {
      console.error(`Drop check failed for ${product.name}:`, err.message);
    }
  }
}

// Run every minute
cron.schedule('* * * * *', () => {
  console.log('Checking all tracked product drops...');
  checkRealDrops();
});

client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err.message);
});

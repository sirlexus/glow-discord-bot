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
    const trendChannel = client.channels.cache.find(
      c => c.name === '🔥trending-beauty' && c.isTextBased()
    );
    if (trendChannel) {
      trendChannel.send('✅ GlowBot is now online and watching for makeup trends!');
    }
  } catch (err) {
    console.error('Trend channel send failed:', err.message);
  }

  try {
    const dropChannel = client.channels.cache.find(
      c => c.name === '💄makeup-drops' && c.isTextBased()
    );
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
    name: 'Charlotte Tilbury Flawless Filter',
    url: 'https://www.mecca.com.au/charlotte-tilbury-hollywood-flawless-filter/V-040882.html',
    keyword: 'add-to-cart',
    channel: '💄makeup-drops'
  },
  {
    name: 'Glow Recipe Dew Drops',
    url: 'https://www.mecca.com.au/glow-recipe-watermelon-glow-niacinamide-dew-drops/V-049893.html',
    keyword: 'add-to-cart',
    channel: '💄makeup-drops'
  },
  {
    name: 'Hourglass Ambient Blush',
    url: 'https://www.mecca.com.au/hourglass-ambient-lighting-blush/V-018059.html',
    keyword: 'add-to-cart',
    channel: '💄makeup-drops'
  },
  {
    name: 'NARS Radiant Creamy Concealer',
    url: 'https://www.mecca.com.au/nars-radiant-creamy-concealer/V-018737.html',
    keyword: 'add-to-cart',
    channel: '💄makeup-drops'
  }
];

async function checkRealDrops() {
  for (const product of productLinks) {
    try {
      const res = await axios.get(product.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });

      const html = res.data;
      const inStock = html.toLowerCase().includes(product.keyword);

      if (inStock) {
        const dropChannel = client.channels.cache.find(
          c => c.name === product.channel && c.isTextBased()
        );
        if (dropChannel) {
          dropChannel.send(`🔔 **${product.name}** is now available!\n🔗 ${product.url}`);
        }
      }
    } catch (err) {
      console.error(`Drop check failed for ${product.name}:`, err.message);
    }
  }
}

cron.schedule('* * * * *', () => {
  console.log('Checking all tracked product drops...');
  checkRealDrops();
});

client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err.message);
});

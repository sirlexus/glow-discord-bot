// glowbot/index.js
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`GlowBot is online as ${client.user.tag}`);

  const notifyChannel = (name, message) => {
    try {
      const channel = client.channels.cache.find(
        c => c.name === name && c.isTextBased()
      );
      if (channel) channel.send(message);
    } catch (err) {
      console.error(`${name} channel send failed:`, err.message);
    }
  };

  notifyChannel('🔥trending-beauty', '✅ GlowBot is now online and watching for makeup trends!');
  notifyChannel('💄makeup-drops', '✅ GlowBot is now online and tracking real-time makeup drops!');
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
  },
  {
    name: 'Labubu Figurine',
    url: 'https://www.popmart.com/en/products/labubu',
    keyword: 'buy now',
    channel: '💄makeup-drops'
  },
  {
    name: 'Mini Designer Handbag',
    url: 'https://www.farfetch.com/au/shopping/women/mini-bags-1/items.aspx',
    keyword: 'add to bag',
    channel: '💄makeup-drops'
  }
];

async function checkRealDrops() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  for (const product of productLinks) {
    try {
      await page.goto(product.url, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      const body = await page.content();
      const inStock = body.toLowerCase().includes(product.keyword);

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

  await browser.close();
}

cron.schedule('* * * * *', () => {
  console.log('Checking all tracked product drops...');
  checkRealDrops();
});

client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err.message);
});

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

// Example product URLs to track (expand this list with actual product/category links)
const productLinks = [
  {
    name: 'Rare Beauty Soft Pinch Blush - Mecca',
    url: 'https://www.mecca.com.au/rare-beauty-soft-pinch-liquid-blush/I-051524.html',
    selector: '.product-add-to-cart .add-to-cart-button'
  }
  // Add more links with appropriate selectors
];

async function checkStock() {
  for (const item of productLinks) {
    try {
      const response = await axios.get(item.url);
      const $ = cheerio.load(response.data);
      const isAvailable = $(item.selector).text().toLowerCase().includes('add to bag') || $(item.selector).length > 0;

      if (isAvailable) {
        const channel = client.channels.cache.find(c => c.name === '💄makeup-drops' && c.isTextBased());
        if (channel) {
          channel.send(`💄 **${item.name}** is back in stock!
🔗 ${item.url}`);
        }
      }
    } catch (error) {
      console.error(`Error checking stock for ${item.name}:`, error.message);
    }
  }
}

// Schedule job every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('Running stock check...');
  checkStock();
});

client.login(process.env.BOT_TOKEN);

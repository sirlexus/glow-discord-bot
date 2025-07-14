const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const products = require('./products.json');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function checkRealDrops() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();

  for (const product of products) {
    try {
      await page.goto(product.url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      const content = await page.content();
      const inStock = !content.includes('Sold Out') && !content.includes('Out of stock');

      if (inStock && !product.notified) {
        const channel = client.channels.cache.find(c => c.name === product.channel);
        if (channel) {
          await channel.send({
            content: `🛍️ **${product.name}** is now available!\n${product.url}`,
          });
        }
        product.notified = true;
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

client.login(process.env.TOKEN);

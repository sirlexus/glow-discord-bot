const { Client, GatewayIntentBits, Partials } = require('discord.js');
const puppeteer = require('puppeteer');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Disable online status message
client.once('ready', () => {
  console.log(`GlowBot is running silently...`);
});

// Command to manually test bot is online (optional)
client.on('messageCreate', async message => {
  if (message.content === '!ping') {
    message.reply('GlowBot is active.');
  }
});

// Example Puppeteer product checker (replace URL logic later)
async function checkProductAvailability(url) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // You can modify this selector or logic to suit the actual product page
  const availability = await page.evaluate(() => {
    const stock = document.querySelector('.product-stock, .stock-status, .in-stock');
    return stock ? stock.textContent.trim() : 'Status unknown';
  });

  await browser.close();
  return availability;
}

// Example scheduled check (for one product)
const exampleProductUrl = 'https://www.mecca.com.au/example-product-page';
const channelIdToNotify = 'YOUR_DISCORD_CHANNEL_ID'; // Replace with your real channel ID

async function notifyProductStatus() {
  const status = await checkProductAvailability(exampleProductUrl);
  const channel = await client.channels.fetch(channelIdToNotify);
  if (channel) {
    channel.send(`Stock update for Mecca product: ${status}`);
  }
}

// Runs check every 10 minutes (adjust as needed)
setInterval(notifyProductStatus, 10 * 60 * 1000);

// ==== HARDCODED TOKEN (SECURITY WARNING) ====
client.login('MTM2MDEzOTIxNzEwNzE1NzE0NQ.GzVsYf.-B6KMoqXMFxds3WGlmhfpMpZAJv0uHKHvwHs5k');

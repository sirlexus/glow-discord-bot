'use strict';
const path = require('node:path');

const CATEGORIES = ['makeup', 'skincare', 'haircare', 'fragrance', 'sales'];
function loadConfig(env = process.env) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'CONFIGURATION' }); };
  if (env.BOT_TOKEN && env.TOKEN && env.BOT_TOKEN !== env.TOKEN) {
    fail('BOT_TOKEN and legacy TOKEN disagree. Keep only BOT_TOKEN.');
  }
  const token = (env.BOT_TOKEN || env.TOKEN || '').trim();
  if (!token || /YOUR_|REPLACE_|^example/i.test(token)) fail('Set BOT_TOKEN in the host environment.');
  const guildId = (env.GUILD_ID || '').trim();
  if (!/^\d{17,22}$/.test(guildId)) fail('Set GUILD_ID to the Glowbot server ID.');
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] || fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${key} must be between ${min} and ${max}.`);
    return n;
  };
  return {
    token, guildId,
    databasePath: path.resolve(env.DATABASE_PATH || './data/glowbot.sqlite'),
    pollMs: integer('POLL_INTERVAL_SECONDS', 60, 30, 3600) * 1000,
    checkMs: integer('PRODUCT_CHECK_SECONDS', 300, 60, 86400) * 1000,
    port: integer('PORT', 10000, 1024, 65535),
  };
}
module.exports = { loadConfig, CATEGORIES };

'use strict';

const { createHash } = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { load } = require('cheerio');

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SOURCES = Object.freeze([
  { id: 'w-favourites', name: 'W cosmetics', type: 'retailer', url: 'https://wcosmetics.com.au/collections/best-seller/products.json?limit=30', page: 'https://wcosmetics.com.au/collections/best-seller' },
  { id: 'cosmetics-business', name: 'Cosmetics Business', type: 'editorial', url: 'https://www.cosmeticsbusiness.com/rss' },
  { id: 'allure', name: 'Allure', type: 'editorial', url: 'https://www.allure.com/feed/rss' },
  { id: 'google-au', name: 'Google Trends Australia', type: 'search', url: 'https://trends.google.com/trending/rss?geo=AU' },
]);
const BEAUTY = /\b(?:makeup|skin\s?care|cosmetics|lipstick|lip\s+gloss|mascara|eyeshadow|blush|perfume|fragrance|sunscreen|hair\s?care|hair\s+colou?r|nail\s+polish|body\s+acne|beauty\s+(?:products?|box)|razors?|sephora|rare beauty|fenty beauty|huda beauty|charlotte tilbury|rhode skincare|rhode beauty|medicube|cosrx|tirtir|beauty of joseon)\b/i;
const PRODUCT_COVERAGE = /\b(?:launch(?:es|ing)?|unveil(?:s|ed)?|debut(?:s)?|introduc(?:es|ing)|releas(?:es|ing)|new|best|viral|trending|collection|review|savings|sale|gloss|treatments?)\b/i;
const CORPORATE = /\b(?:quarter|q[1-4]|shares?|stock market|acquisition|ingredient suppliers?|packaging|grant|partnership|consulting|ai capabilities|women.s health|diagnostics|skin.?alyze)\b/i;
const normalise = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  .replace(/\bskin care\b/g, 'skincare').replace(/\bhair care\b/g, 'haircare').replace(/\bmake up\b/g, 'makeup').replace(/\be l f\b/g, 'elf');
const clean = (value, max = 500) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex');
const dayKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function publicUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || net.isIP(url.hostname)) return null;
    if (allowedHosts && !allowedHosts.includes(url.hostname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  const lower = address.toLowerCase();
  return net.isIP(address) === 6 && /^[23][0-9a-f]{0,3}:/.test(lower) &&
    !/^(?:2001:db8:|2001:0:|2001::|2002:)/.test(lower);
}

/** Fixed public sources only. User searches never become network requests. */
async function fetchSource(source, fetcher) {
  const host = new URL(source.url).hostname;
  const allowed = [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`];
  let url = source.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!publicUrl(url, allowed)) throw Object.assign(new Error('Unapproved source'), { code: 'UNSAFE_SOURCE' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    timer.unref?.();
    let dispatcher;
    try {
      if (!fetcher) {
        const hostname = new URL(url).hostname;
        const addresses = await Promise.race([
          dns.lookup(hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true })),
        ]);
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Unsafe source address');
        const { Agent } = require('undici');
        dispatcher = new Agent({ connect: { timeout: 12_000, lookup: (requested, options, callback) => {
          if (requested !== hostname) return callback(new Error('Unexpected source host'));
          const choices = options.family ? addresses.filter(item => item.family === options.family) : addresses;
          if (!choices.length) return callback(new Error('No source address'));
          if (options.all) callback(null, choices);
          else callback(null, choices[0].address, choices[0].family);
        } } });
      }
      const response = await (fetcher || require('undici').fetch)(url, { redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'GlowBot/2.1 (public beauty source monitor)', accept: 'application/rss+xml, application/xml, application/json, text/xml;q=0.9' },
        ...(dispatcher ? { dispatcher } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel?.();
        if (!location) throw new Error('Incomplete redirect');
        const next = new URL(location, url);
        // Redirects must preserve the feed path, not lead to login or an article.
        if (!publicUrl(next.href, allowed) || next.pathname !== new URL(source.url).pathname || next.search !== new URL(source.url).search) throw new Error('Source redirect changed identity');
        url = next.href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel?.(); throw Object.assign(new Error('Source unavailable'), { code: `SOURCE_HTTP_${response.status}` }); }
      const limit = 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel?.(); throw new Error('Source too large'); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error('Source too large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { clearTimeout(timer); if (dispatcher) await dispatcher.close(); }
  }
  throw new Error('Too many source redirects');
}

function parseRetailerList(body, source, now) {
  const data = JSON.parse(body);
  if (!Array.isArray(data.products) || data.products.length > 30) throw new Error('Invalid retailer list');
  const seen = new Set();
  return data.products.map((product, index) => {
    if (!product || !/^\d+$/.test(String(product.id)) || !product.title || typeof product.handle !== 'string' ||
      !product.handle || product.handle.length > 500 || /[\p{C}\p{Z}/\\?#%]/u.test(product.handle) || ['.', '..'].includes(product.handle) || seen.has(String(product.id))) throw new Error('Invalid retailer list identity');
    seen.add(String(product.id));
    const url = new URL(`/products/${encodeURIComponent(product.handle)}`, source.page).href;
    return { key: String(product.id), name: clean(product.title, 200),
      url, kind: 'bestsellers', position: index + 1, observedAt: now, publishedAt: null,
      evidence: `Position ${index + 1} in the retailer's displayed bestseller collection. This list is manually featured; position is not a sales count or a 2026 sales ranking.` };
  });
}

function upcomingDate(text, publishedAt, now) {
  const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
  const pattern = new RegExp(`\\b(?:launch(?:es|ing)?|release(?:s)?|available|debut(?:s)?)\\s+(?:on\\s+|from\\s+)?(\\d{1,2}\\s+${month}\\s+20\\d{2}|${month}\\s+\\d{1,2},?\\s+20\\d{2})\\b`, 'i');
  const matched = text.match(pattern);
  if (!matched) return null;
  const date = Date.parse(`${matched[1]} 00:00:00 GMT`);
  // A date already reached in Australia is not advertised as upcoming.
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) > dayKey(now) &&
    date <= now + 366 * DAY && date >= publishedAt ? date : null;
}

function parseRss(body, source, now) {
  const $ = load(body, { xmlMode: true });
  if (!$('rss > channel').length) throw new Error('Invalid RSS source');
  const items = $('channel > item').toArray();
  if (items.length > 200) throw new Error('Oversized RSS source');
  const allowed = [new URL(source.url).hostname, new URL(source.url).hostname.replace(/^www\./, '')];
  const results = [];
  const ttl = Number($('channel > ttl').text());
  if (Number.isSafeInteger(ttl) && ttl > 0) Object.defineProperty(results, 'refreshMs', { value: Math.min(7 * DAY, Math.max(HOUR, ttl * 60_000)) });
  const seen = new Set();
  for (const item of items) {
    const node = $(item);
    const title = clean(node.children('title').text(), 200);
    const description = clean(load(node.children('description').text()).text(), 1500);
    const publishedAt = Date.parse(node.children('pubDate').text());
    if (!title || !Number.isFinite(publishedAt) || publishedAt > now + HOUR || publishedAt < now - 120 * DAY) continue;
    const combined = `${title} ${description}`;
    if (source.type === 'search' ? !BEAUTY.test(title) : (!BEAUTY.test(combined) || !PRODUCT_COVERAGE.test(title) || CORPORATE.test(title))) continue;
    const url = publicUrl(node.children('link').text().trim(), allowed);
    if (!url) continue;
    const key = source.type === 'search' ? normalise(title) : url;
    if (seen.has(key)) continue;
    seen.add(key);
    const launchAt = source.type === 'editorial' ? upcomingDate(combined, publishedAt, now) : null;
    const traffic = clean(node.children().filter((_, element) => element.name === 'ht:approx_traffic').text(), 40);
    results.push({ key, name: title, url, searchText: normalise(source.type === 'search' ? title : combined), kind: source.type === 'search' ? 'rising' : launchAt ? 'upcoming' : 'new',
      observedAt: now, publishedAt, launchAt, position: null,
      evidence: source.type === 'search' ? `A beauty topic in Google's Australia search-trend RSS${traffic ? `; reported approximate traffic: ${traffic}` : ''}. Search interest is not product sales or a recommendation.` :
        `Dated public publisher headline${launchAt ? '; the feed explicitly states a future release or availability date' : '; this is editorial coverage, not proof of popularity or an upcoming release'}. Only public RSS metadata is used.`,
    });
  }
  return results;
}

class TrendsService {
  constructor({ store, client, config, sources = SOURCES, fetcher, logger = console, clock = Date.now }) {
    Object.assign(this, { store, client, config, sources, fetcher, logger, clock });
    this.stopping = false; this.running = false;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS trend_sources (guild_id TEXT NOT NULL,source_id TEXT NOT NULL,last_success INTEGER,next_check INTEGER NOT NULL DEFAULT 0,error TEXT,error_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guild_id,source_id));
      CREATE TABLE IF NOT EXISTS trend_snapshots (id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,source_id TEXT NOT NULL,captured_at INTEGER NOT NULL,items TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trend_snapshot_time ON trend_snapshots(guild_id,source_id,captured_at);
      CREATE TABLE IF NOT EXISTS trend_entries (guild_id TEXT NOT NULL,source_id TEXT NOT NULL,item_key TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,record TEXT NOT NULL,observed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(guild_id,source_id,item_key,kind));
      CREATE TABLE IF NOT EXISTS trend_posts (id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,source_id TEXT NOT NULL,item_key TEXT NOT NULL,record TEXT NOT NULL,queued_at INTEGER NOT NULL,day_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,sent_day TEXT,message_id TEXT,error TEXT);
    `);
    const seeds = require('./trend-seeds.json');
    const observedAt = Date.parse(`${seeds.verifiedAt}T00:00:00+11:00`);
    const publishedAt = Date.parse(seeds.publishedAt);
    for (const product of seeds.products) {
      const record = { key: normalise(product.name), name: product.name, category: product.category, kind: 'hits',
        url: seeds.sourceUrl, sourceUrl: seeds.sourceUrl, source: seeds.source, sourceId: 'allure-2026-readers', observedAt, publishedAt,
        evidence: `Allure Readers' Choice 2026 winner: ${product.awardCategory}. Reader voted, not a sales count or Australia-wide ranking. Published 19 May 2026.` };
      store.db.prepare('INSERT INTO trend_entries(guild_id,source_id,item_key,kind,name,record,observed_at,expires_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,source_id,item_key,kind) DO UPDATE SET name=excluded.name,record=excluded.record')
        .run(config.guildId, record.sourceId, record.key, record.kind, record.name, JSON.stringify(record), observedAt, Number.MAX_SAFE_INTEGER);
    }
  }

  matching({ query = '', filter = 'all' } = {}) {
    const now = this.clock();
    const terms = normalise(query).split(' ').filter(Boolean).slice(0, 15);
    const year = terms.find(term => /^20\d{2}$/.test(term));
    const failed = new Set(this.store.db.prepare('SELECT source_id FROM trend_sources WHERE guild_id=? AND error IS NOT NULL').all(this.config.guildId).map(row => row.source_id));
    return this.store.db.prepare('SELECT record FROM trend_entries WHERE guild_id=? AND expires_at>? ORDER BY observed_at DESC')
      .all(this.config.guildId, now).map(row => JSON.parse(row.record))
      .filter(item => (filter === 'all' || item.kind === filter) &&
        (item.kind !== 'upcoming' || (item.launchAt && new Date(item.launchAt).toISOString().slice(0, 10) > dayKey(now))) &&
        (!year || (item.publishedAt && String(new Date(item.publishedAt).getUTCFullYear()) === year)))
      .filter(item => {
        const words = new Set(normalise(`${item.name} ${item.searchText || ''} ${item.category || ''} ${item.source} ${item.evidence}`).split(' '));
        return terms.filter(term => term !== year).every(term => words.has(term));
      })
      .sort((a, b) => {
        const priorities = { upcoming: 0, rising: 1, hits: 2, new: 3, bestsellers: 4 };
        return priorities[a.kind] - priorities[b.kind] || (a.position || 999) - (b.position || 999) || (b.publishedAt || b.observedAt) - (a.publishedAt || a.observedAt);
      }).map(item => ({ ...item, sourceUnavailable: failed.has(item.sourceId) }));
  }

  list({ query = '', filter = 'all', limit = 4 } = {}) {
    return this.matching({ query, filter }).slice(0, Math.min(200, Math.max(1, Number(limit) || 4)));
  }

  summary({ query = '' } = {}) {
    const now = this.clock();
    const items = this.matching({ query });
    const editorialIds = new Set(this.sources.filter(source => source.type === 'editorial').map(source => source.id));
    const articles = [...new Map(items.filter(item => editorialIds.has(item.sourceId)).map(item => [item.url, item])).values()];
    const states = this.store.db.prepare('SELECT last_success,error FROM trend_sources WHERE guild_id=?').all(this.config.guildId);
    return {
      editorialArticles: articles.length,
      independentPublishers: new Set(articles.map(item => new URL(item.url).hostname.replace(/^www\./, ''))).size,
      recentArticles: articles.filter(item => item.publishedAt >= now - 7 * DAY).length,
      previousArticles: articles.filter(item => item.publishedAt < now - 7 * DAY && item.publishedAt >= now - 14 * DAY).length,
      latestObservedAt: Math.max(0, ...states.map(state => state.last_success || 0)) || null,
      sourceCount: new Set(items.map(item => item.sourceId)).size,
      monitoredFeeds: this.sources.length,
      message: `Counts are matching cached headlines, not demand or complete media coverage. ${states.filter(state => state.error).length} sources are temporarily unavailable. New source history starts silently; retailer list comparisons need at least 24 hours and measure featured placement, not sales.`,
    };
  }

  record(source, items, now) {
    const db = this.store.db, guild = this.config.guildId;
    return this.store.transaction(() => {
      const state = db.prepare('SELECT * FROM trend_sources WHERE guild_id=? AND source_id=?').get(guild, source.id);
      const previous = db.prepare('SELECT items,captured_at FROM trend_snapshots WHERE guild_id=? AND source_id=? AND captured_at<=? AND captured_at>=? ORDER BY captured_at DESC LIMIT 1').get(guild, source.id, now - DAY, now - 3 * DAY);
      const older = new Map((previous ? JSON.parse(previous.items) : []).map(item => [item.key, item]));
      const immediate = db.prepare('SELECT items FROM trend_snapshots WHERE guild_id=? AND source_id=? ORDER BY captured_at DESC LIMIT 1').get(guild, source.id);
      const known = new Set((immediate ? JSON.parse(immediate.items) : []).map(item => item.key));
      const candidates = [];
      // A successful current snapshot replaces membership of the displayed
      // list. Historical snapshots and dated movement observations remain.
      if (source.type === 'retailer') db.prepare("DELETE FROM trend_entries WHERE guild_id=? AND source_id=? AND kind='bestsellers'").run(guild, source.id);
      const save = item => {
        const record = { ...item, source: source.name, sourceUrl: source.page || source.url, sourceId: source.id };
        const expires = source.type === 'retailer' ? now + 2 * DAY : (item.publishedAt || now) + 120 * DAY;
        db.prepare('INSERT INTO trend_entries(guild_id,source_id,item_key,kind,name,record,observed_at,expires_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,source_id,item_key,kind) DO UPDATE SET name=excluded.name,record=excluded.record,observed_at=excluded.observed_at,expires_at=excluded.expires_at')
          .run(guild, source.id, item.key, item.kind, item.name, JSON.stringify(record), now, expires);
        return record;
      };
      for (const item of items) {
        const record = save(item);
        if (source.type === 'retailer') {
          const prior = older.get(item.key);
          if (prior && prior.position - item.position >= 5 && item.position <= 20) {
            const rising = save({ ...item, kind: 'rising', previousPosition: prior.position, previousObservedAt: previous.captured_at,
              evidence: `Moved from displayed position ${prior.position} to ${item.position} in the retailer's manually featured bestseller list over at least 24 hours. This is observed merchandising movement, not a sales or popularity measurement.` });
            if (state?.last_success) candidates.push(rising);
          }
        } else if (state?.last_success && !known.has(item.key) && item.publishedAt >= now - 2 * DAY) candidates.push(record);
      }
      db.prepare('INSERT INTO trend_snapshots(guild_id,source_id,captured_at,items) VALUES (?,?,?,?)').run(guild, source.id, now, JSON.stringify(items));
      db.prepare('DELETE FROM trend_snapshots WHERE guild_id=? AND source_id=? AND captured_at<?').run(guild, source.id, now - 7 * DAY);
      db.prepare('DELETE FROM trend_entries WHERE guild_id=? AND expires_at<=?').run(guild, now);
      db.prepare('INSERT INTO trend_sources(guild_id,source_id,last_success,next_check,error,error_count) VALUES (?,?,?,?,NULL,0) ON CONFLICT(guild_id,source_id) DO UPDATE SET last_success=excluded.last_success,next_check=excluded.next_check,error=NULL,error_count=0').run(guild, source.id, now, now + (items.refreshMs || HOUR));
      for (const record of candidates) {
        const recent = db.prepare("SELECT 1 FROM trend_posts WHERE guild_id=? AND source_id=? AND item_key=? AND queued_at>? AND status!='cancelled'").get(guild, source.id, record.key, now - 7 * DAY);
        const total = db.prepare('SELECT COUNT(*) count FROM trend_posts WHERE guild_id=? AND day_key=?').get(guild, dayKey(now)).count;
        if (recent || total >= 3) continue;
        db.prepare('INSERT INTO trend_posts(guild_id,source_id,item_key,record,queued_at,day_key) VALUES (?,?,?,?,?,?)').run(guild, source.id, record.key, JSON.stringify(record), now, dayKey(now));
      }
      return { items: items.length, candidates: candidates.length };
    });
  }

  async deliver(now) {
    const db = this.store.db, guild = this.config.guildId;
    const channelId = this.store.getConfig(guild).channels?.trends;
    if (!channelId) return;
    for (const post of db.prepare("SELECT * FROM trend_posts WHERE guild_id=? AND status='pending' AND next_attempt<=? ORDER BY id LIMIT 10").all(guild, now)) {
      if (this.stopping) return;
      if (now - post.queued_at > 2 * DAY) { db.prepare("UPDATE trend_posts SET status='cancelled' WHERE id=?").run(post.id); continue; }
      if (db.prepare("SELECT COUNT(*) count FROM trend_posts WHERE guild_id=? AND status='sent' AND sent_day=?").get(guild, dayKey(now)).count >= 3) break;
      const source = db.prepare('SELECT error FROM trend_sources WHERE guild_id=? AND source_id=?').get(guild, post.source_id);
      if (source?.error) continue;
      try {
        const record = JSON.parse(post.record);
        if (record.kind === 'upcoming' && (!record.launchAt || new Date(record.launchAt).toISOString().slice(0, 10) <= dayKey(now))) {
          db.prepare("UPDATE trend_posts SET status='cancelled' WHERE id=?").run(post.id);
          continue;
        }
        const target = await this.client.channels.fetch(channelId);
        if (this.stopping) return;
        const payload = require('./ui').trendsPanel([record]);
        const message = await target.send({ ...payload, allowedMentions: { parse: [] }, nonce: hash(`trend:${guild}:${post.id}`).slice(0, 24), enforceNonce: true });
        if (this.stopping) return;
        db.prepare("UPDATE trend_posts SET status='sent',sent_day=?,message_id=?,error=NULL WHERE id=?").run(dayKey(now), String(message.id), post.id);
      } catch (error) {
        if (this.stopping) return;
        const attempts = post.attempts + 1;
        db.prepare('UPDATE trend_posts SET attempts=?,status=?,next_attempt=?,error=? WHERE id=?').run(attempts, attempts >= 8 ? 'failed' : 'pending', now + Math.min(HOUR, 60_000 * 2 ** (attempts - 1)), String(error.code || 'TREND_DELIVERY_FAILED').slice(0, 80), post.id);
      }
    }
  }

  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    const now = this.clock();
    try {
      for (const source of this.sources) {
        if (this.stopping) return;
        const state = this.store.db.prepare('SELECT * FROM trend_sources WHERE guild_id=? AND source_id=?').get(this.config.guildId, source.id);
        if (state?.next_check > now) continue;
        try {
          const body = await fetchSource(source, this.fetcher);
          if (this.stopping) return;
          const items = source.type === 'retailer' ? parseRetailerList(body, source, now) : parseRss(body, source, now);
          this.record(source, items, now);
        } catch (error) {
          if (this.stopping) return;
          const count = (state?.error_count || 0) + 1;
          const code = String(error.code || 'TREND_SOURCE_UNAVAILABLE').slice(0, 80);
          this.store.db.prepare('INSERT INTO trend_sources(guild_id,source_id,next_check,error,error_count) VALUES (?,?,?,?,?) ON CONFLICT(guild_id,source_id) DO UPDATE SET next_check=excluded.next_check,error=excluded.error,error_count=excluded.error_count')
            .run(this.config.guildId, source.id, now + Math.min(12 * HOUR, HOUR * 2 ** Math.min(count - 1, 4)), code, count);
          this.logger.warn(`Trend source ${source.id}: ${code}`);
        }
      }
      if (!this.stopping) await this.deliver(now);
    } finally { this.running = false; }
  }

  stop() { this.stopping = true; }
}

module.exports = { TrendsService, SOURCES, parseRetailerList, parseRss, upcomingDate, fetchSource };

'use strict';

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const CATEGORIES = new Set(['makeup', 'skincare', 'haircare', 'fragrance', 'sales']);
const STOCK_STATES = new Set(['in_stock', 'out_of_stock', 'preorder', 'unknown']);
const MINUTE = 60_000;

function json(value) { return JSON.stringify(value); }
function parse(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }
function cleanError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .slice(0, 500);
}
function validPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}
function normaliseObservation(observation) {
  return {
    ...observation,
    availability: STOCK_STATES.has(observation.availability) ? observation.availability : 'unknown',
    price: validPrice(observation.price),
    currency: String(observation.currency || '').toUpperCase().slice(0, 3),
  };
}

class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY, config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        url TEXT NOT NULL,
        variant TEXT NOT NULL DEFAULT '',
        variant_id TEXT,
        name TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT '',
        retailer TEXT NOT NULL DEFAULT '',
        sku TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        price REAL,
        currency TEXT NOT NULL DEFAULT '',
        availability TEXT NOT NULL DEFAULT 'unknown',
        image TEXT,
        source TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER,
        last_checked INTEGER,
        next_check INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        candidate_stock TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(guild_id, url, variant)
      );
      CREATE INDEX IF NOT EXISTS products_guild ON products(guild_id, paused, next_check);
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        checked_at INTEGER NOT NULL, availability TEXT NOT NULL, price REAL, currency TEXT
      );
      CREATE INDEX IF NOT EXISTS observations_product ON observations(product_id, id);
      CREATE TABLE IF NOT EXISTS preferences (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT NOT NULL,
        PRIMARY KEY(guild_id, user_id, category)
      );
      CREATE TABLE IF NOT EXISTS watches (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        PRIMARY KEY(guild_id, user_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
        generation INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        queued INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(product_id, generation)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id),
        target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, message_id TEXT,
        UNIQUE(event_id, target_type, target_id)
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status, next_attempt);
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, url TEXT NOT NULL, note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL, retailer TEXT NOT NULL DEFAULT '',
        initialized INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER, last_checked INTEGER, next_check INTEGER NOT NULL DEFAULT 0,
        error TEXT, error_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(guild_id, url)
      );
      CREATE TABLE IF NOT EXISTS source_items (
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        url TEXT NOT NULL, variant_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(source_id, url, variant_id)
      );
    `);
    // Preserve existing databases made before stable retailer variant IDs were stored.
    const columns = this.db.prepare('PRAGMA table_info(products)').all();
    if (!columns.some(column => column.name === 'variant_id')) this.db.exec('ALTER TABLE products ADD COLUMN variant_id TEXT');
  }

  close() { this.db.close(); }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getConfig(guildId) {
    const row = this.db.prepare('SELECT config FROM guild_config WHERE guild_id = ?').get(String(guildId));
    return row ? parse(row.config) : {};
  }

  setConfig(guildId, update) {
    const current = this.getConfig(guildId);
    const merged = { ...current, ...update };
    for (const key of ['channels', 'panels', 'roles']) {
      if (current[key] || update[key]) merged[key] = { ...(current[key] || {}), ...(update[key] || {}) };
    }
    this.db.prepare('INSERT INTO guild_config(guild_id, config) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET config = excluded.config')
      .run(String(guildId), json(merged));
    return merged;
  }

  addProduct(guildId, input, now = Date.now()) {
    const observation = normaliseObservation(input);
    if (!CATEGORIES.has(input.category)) throw new Error('Choose a valid beauty category.');
    if (!input.url || !input.name) throw new Error('A product needs a URL and name.');
    const success = observation.availability !== 'unknown';
    const variant = String(input.variant || '');
    const variantId = input.variantId == null ? null : String(input.variantId);
    const existing = variantId === null
      ? this.db.prepare('SELECT * FROM products WHERE guild_id = ? AND url = ? AND variant = ?')
        .get(String(guildId), input.url, variant)
      : this.db.prepare('SELECT * FROM products WHERE guild_id = ? AND url = ? AND (variant_id = ? OR (variant_id IS NULL AND variant = ?))')
        .get(String(guildId), input.url, variantId, variant);
    if (existing) return existing;
    const result = this.db.prepare(`INSERT INTO products
      (guild_id,url,variant,variant_id,name,brand,retailer,sku,category,price,currency,availability,image,source,last_success,last_checked,next_check,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      String(guildId), input.url, variant, variantId, String(input.name).slice(0, 256), String(input.brand || '').slice(0, 100),
      String(input.retailer || '').slice(0, 100), String(input.sku || '').slice(0, 100), input.category,
      observation.price, observation.currency, observation.availability, input.image || null, input.source || null,
      success ? now : null, success ? now : null, success ? now + MINUTE : 0, now,
    );
    return this.getProduct(guildId, Number(result.lastInsertRowid));
  }

  listProducts(guildId, { search = '', category, limit = 100, offset = 0 } = {}) {
    const conditions = ['guild_id = ?'];
    const values = [String(guildId)];
    if (search) {
      conditions.push("(name LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\' OR retailer LIKE ? ESCAPE '\\' OR variant LIKE ? ESCAPE '\\')");
      const term = '%' + String(search).slice(0, 200).replace(/[\\%_]/g, '\\$&') + '%';
      values.push(term, term, term, term);
    }
    if (category) { conditions.push('category = ?'); values.push(category); }
    values.push(Math.min(1000, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
    return this.db.prepare(`SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`).all(...values);
  }

  getProduct(guildId, id) {
    return this.db.prepare('SELECT * FROM products WHERE guild_id = ? AND id = ?').get(String(guildId), Number(id)) || null;
  }

  pauseProduct(guildId, id, paused = true) {
    const result = this.db.prepare('UPDATE products SET paused = ? WHERE guild_id = ? AND id = ?')
      .run(paused ? 1 : 0, String(guildId), Number(id));
    return Number(result.changes) > 0;
  }

  scheduleNext(productId, when) {
    if (!Number.isFinite(when)) throw new Error('Invalid check time.');
    this.db.prepare('UPDATE products SET next_check = ? WHERE id = ?').run(when, Number(productId));
  }

  categories(guildId, userId) {
    return this.db.prepare('SELECT category FROM preferences WHERE guild_id = ? AND user_id = ? ORDER BY category')
      .all(String(guildId), String(userId)).map(row => row.category);
  }

  setCategories(guildId, userId, categories) {
    const selected = [...new Set(categories)];
    if (selected.some(category => !CATEGORIES.has(category))) throw new Error('Choose a valid alert category.');
    this.transaction(() => {
      this.db.prepare('DELETE FROM preferences WHERE guild_id = ? AND user_id = ?').run(String(guildId), String(userId));
      const insert = this.db.prepare('INSERT INTO preferences VALUES (?,?,?)');
      for (const category of selected) insert.run(String(guildId), String(userId), category);
    });
    return this.categories(guildId, userId);
  }

  watch(guildId, userId, productId) {
    const product = this.getProduct(guildId, productId);
    if (!product) throw new Error('That product is not on this server.');
    this.db.prepare('INSERT OR IGNORE INTO watches VALUES (?,?,?)').run(String(guildId), String(userId), Number(productId));
    return product;
  }

  unwatch(guildId, userId, productId) {
    return Number(this.db.prepare('DELETE FROM watches WHERE guild_id = ? AND user_id = ? AND product_id = ?')
      .run(String(guildId), String(userId), Number(productId)).changes) > 0;
  }

  userWatches(guildId, userId) {
    return this.db.prepare(`SELECT p.* FROM products p JOIN watches w ON p.id = w.product_id
      WHERE w.guild_id = ? AND w.user_id = ? ORDER BY p.id`).all(String(guildId), String(userId));
  }

  forgetUser(guildId, userId) {
    this.transaction(() => {
      for (const table of ['preferences', 'watches', 'requests']) {
        this.db.prepare(`DELETE FROM ${table} WHERE guild_id = ? AND user_id = ?`).run(String(guildId), String(userId));
      }
      this.db.prepare(`DELETE FROM deliveries WHERE target_type = 'dm' AND target_id = ?
        AND event_id IN (SELECT id FROM events WHERE guild_id = ?)`).run(String(userId), String(guildId));
    });
  }

  subscribers(product, kind = 'restock') {
    const categories = kind === 'price_drop' ? [product.category, 'sales'] : [product.category, product.category];
    return this.db.prepare(`SELECT user_id FROM preferences WHERE guild_id = ? AND category IN (?,?)
      UNION SELECT user_id FROM watches WHERE guild_id = ? AND product_id = ?`)
      .all(String(product.guild_id), ...categories, String(product.guild_id), product.id).map(row => row.user_id);
  }

  recordObservation(productInput, input, now = Date.now()) {
    const product = this.getProduct(productInput.guild_id, productInput.id);
    if (!product) throw new Error('Product not found.');
    const observation = normaliseObservation(input);
    if (input.url && input.url !== product.url) throw new Error('The retailer now points to a different product URL. Review this product before checking again.');
    if (product.variant_id && String(input.variantId ?? '') !== product.variant_id) {
      throw new Error('The retailer returned a different or unconfirmed shade. Review this product before checking again.');
    }
    if (!product.variant_id && product.variant && input.variant && String(input.variant) !== product.variant) {
      throw new Error('The retailer returned a different shade. Review this product before checking again.');
    }
    if (observation.availability === 'unknown') {
      this.recordError(product, 'Stock could not be confirmed from the retailer.', now);
      return [];
    }
    return this.transaction(() => {
      let availability = product.availability;
      let candidate = null;
      let count = 0;
      const events = [];
      const baseline = product.last_success === null;
      if (baseline) availability = observation.availability;
      else if (observation.availability !== product.availability) {
        candidate = observation.availability;
        count = product.candidate_stock === candidate ? product.candidate_count + 1 : 1;
        if (count >= 2) {
          availability = candidate;
          candidate = null;
          count = 0;
          if (availability === 'in_stock' && ['out_of_stock', 'preorder'].includes(product.availability)) events.push({ kind: 'restock' });
        }
      }
      if (!baseline && availability === 'in_stock' && observation.availability === 'in_stock' &&
        observation.price !== null && product.price !== null && observation.currency &&
        observation.currency === product.currency && observation.price < product.price) {
        events.push({ kind: 'price_drop', previousPrice: product.price });
      }
      this.db.prepare(`UPDATE products SET availability=?, price=?, currency=?, last_checked=?, last_success=?,
        next_check=?, error=NULL, error_count=0, candidate_stock=?, candidate_count=?,
        name=?, retailer=?, image=?, source=?, variant=? WHERE id=?`).run(
        availability, observation.price ?? product.price, observation.currency || product.currency, now, now, now + MINUTE,
        candidate, count, String(input.name || product.name).slice(0, 256), String(input.retailer || product.retailer).slice(0, 100),
        input.image || product.image, input.source || product.source,
        product.variant_id && input.variant ? String(input.variant) : product.variant, product.id,
      );
      this.db.prepare('INSERT INTO observations(product_id,checked_at,availability,price,currency) VALUES (?,?,?,?,?)')
        .run(product.id, now, observation.availability, observation.price, observation.currency);
      this.db.prepare('DELETE FROM observations WHERE product_id = ? AND id NOT IN (SELECT id FROM observations WHERE product_id = ? ORDER BY id DESC LIMIT 200)')
        .run(product.id, product.id);
      const latest = this.getProduct(product.guild_id, product.id);
      for (let index = 0; index < events.length; index++) {
        const event = events[index];
        const generation = product.generation + index + 1;
        Object.assign(event, { guild_id: product.guild_id, product_id: product.id, product: latest, checkedAt: now });
        const result = this.db.prepare('INSERT INTO events(guild_id,product_id,generation,kind,payload,created_at) VALUES (?,?,?,?,?,?)')
          .run(product.guild_id, product.id, generation, event.kind, json(event), now);
        event.id = Number(result.lastInsertRowid);
      }
      if (events.length) this.db.prepare('UPDATE products SET generation = ? WHERE id = ?').run(product.generation + events.length, product.id);
      return events;
    });
  }

  recordError(productInput, error, now = Date.now()) {
    const product = this.getProduct(productInput.guild_id, productInput.id);
    if (!product) throw new Error('Product not found.');
    const count = product.error_count + 1;
    this.db.prepare(`UPDATE products SET last_checked=?,error=?,error_count=?,next_check=?,candidate_stock=NULL,candidate_count=0 WHERE id=?`)
      .run(now, cleanError(error), count, now + Math.min(60 * MINUTE, MINUTE * 2 ** Math.min(count - 1, 6)), product.id);
  }

  pendingEvents() {
    return this.db.prepare('SELECT * FROM events WHERE queued = 0 ORDER BY id').all()
      .map(row => ({ ...parse(row.payload), id: row.id }));
  }

  getEvent(id) {
    const row = this.db.prepare('SELECT id,payload FROM events WHERE id = ?').get(Number(id));
    return row ? { ...parse(row.payload), id: row.id } : null;
  }

  eventsQueued(id) { this.db.prepare('UPDATE events SET queued = 1 WHERE id = ?').run(Number(id)); }

  queueDelivery(event, targetType, targetId, payload) {
    if (!['channel', 'dm'].includes(targetType)) throw new Error('Invalid delivery target.');
    this.db.prepare('INSERT OR IGNORE INTO deliveries(event_id,target_type,target_id,payload) VALUES (?,?,?,?)')
      .run(Number(event.id), targetType, String(targetId), json(payload));
    return this.db.prepare('SELECT * FROM deliveries WHERE event_id = ? AND target_type = ? AND target_id = ?')
      .get(Number(event.id), targetType, String(targetId));
  }

  pendingDeliveries(now = Date.now()) {
    return this.db.prepare("SELECT d.*, e.guild_id FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.status='pending' AND d.next_attempt <= ? ORDER BY d.id LIMIT 100")
      .all(now).map(row => ({ ...row, payload: parse(row.payload) }));
  }

  deliverySent(id, messageId) {
    this.db.prepare("UPDATE deliveries SET status='sent', message_id=?, error=NULL WHERE id=?").run(String(messageId), Number(id));
  }

  cancelDelivery(id) {
    this.db.prepare("UPDATE deliveries SET status='cancelled', error=NULL WHERE id=? AND status='pending'").run(Number(id));
  }

  deliveryFailed(id, error, now = Date.now()) {
    const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(Number(id));
    if (!delivery || delivery.status !== 'pending') return;
    const attempts = delivery.attempts + 1;
    this.db.prepare('UPDATE deliveries SET attempts=?,status=?,error=?,next_attempt=? WHERE id=?')
      .run(attempts, attempts >= 8 ? 'failed' : 'pending', cleanError(error), now + Math.min(60 * MINUTE, MINUTE * 2 ** (attempts - 1)), Number(id));
  }

  addRequest(guildId, userId, url, note = '') {
    const result = this.db.prepare('INSERT INTO requests(guild_id,user_id,url,note,created_at) VALUES (?,?,?,?,?)')
      .run(String(guildId), String(userId), String(url).slice(0, 2048), String(note).slice(0, 1000), Date.now());
    return Number(result.lastInsertRowid);
  }

  listRequests(guildId, { status = 'pending', limit = 20 } = {}) {
    if (!['pending', 'resolved'].includes(status)) throw new Error('Invalid request status.');
    return this.db.prepare('SELECT * FROM requests WHERE guild_id = ? AND status = ? ORDER BY id LIMIT ?')
      .all(String(guildId), status, Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  resolveRequest(guildId, id) {
    return Number(this.db.prepare("UPDATE requests SET status = 'resolved' WHERE guild_id = ? AND id = ? AND status = 'pending'")
      .run(String(guildId), Number(id)).changes) > 0;
  }

  addSource(guildId, { url, category, retailer = '' }) {
    if (!CATEGORIES.has(category) || category === 'sales') throw new Error('Choose a valid product category for this source.');
    if (!url) throw new Error('A catalogue source needs a URL.');
    this.db.prepare('INSERT OR IGNORE INTO sources(guild_id,url,category,retailer) VALUES (?,?,?,?)')
      .run(String(guildId), String(url), category, String(retailer).slice(0, 100));
    return this.db.prepare('SELECT * FROM sources WHERE guild_id = ? AND url = ?').get(String(guildId), String(url));
  }

  listSources(guildId) {
    return this.db.prepare('SELECT * FROM sources WHERE guild_id = ? ORDER BY id').all(String(guildId));
  }

  pauseSource(guildId, id, paused = true) {
    return Number(this.db.prepare('UPDATE sources SET paused = ? WHERE guild_id = ? AND id = ?')
      .run(paused ? 1 : 0, String(guildId), Number(id)).changes) > 0;
  }

  recordSourceError(sourceInput, error, now = Date.now()) {
    const source = this.db.prepare('SELECT * FROM sources WHERE guild_id = ? AND id = ?')
      .get(String(sourceInput.guild_id), Number(sourceInput.id));
    if (!source) throw new Error('Catalogue source not found.');
    const count = source.error_count + 1;
    this.db.prepare('UPDATE sources SET last_checked=?,error=?,error_count=?,next_check=? WHERE id=?')
      .run(now, cleanError(error), count, now + Math.min(60 * MINUTE, 10 * MINUTE * 2 ** Math.min(count - 1, 3)), source.id);
  }

  recordDiscovery(sourceInput, feed, now = Date.now()) {
    const source = this.db.prepare('SELECT * FROM sources WHERE guild_id = ? AND id = ?')
      .get(String(sourceInput.guild_id), Number(sourceInput.id));
    if (!source) throw new Error('Catalogue source not found.');
    if (source.paused) return { added: 0, events: [], capacity: 0 };
    if (!Array.isArray(feed.products)) throw new Error('The catalogue feed did not contain products.');
    if (feed.url && feed.url !== source.url) throw new Error('The retailer catalogue URL changed. Review this source.');
    return this.transaction(() => {
      const result = { added: 0, events: [], capacity: 0 };
      let tracked = this.db.prepare('SELECT COUNT(*) count FROM products WHERE guild_id=?').get(source.guild_id).count;
      const productPages = new Set();
      const feedIdentities = new Set();
      for (const input of feed.products.slice(0, 1000)) {
        if (!input.url || !input.name) throw new Error('The catalogue contained an incomplete product.');
        // Variants share a page but have exact canonical URLs with a variant query.
        const pageUrl = new URL(input.url);
        pageUrl.search = '';
        pageUrl.hash = '';
        const pageIdentity = pageUrl.href;
        if (!productPages.has(pageIdentity) && productPages.size >= 100) continue;
        productPages.add(pageIdentity);
        const variantId = String(input.variantId ?? input.variant ?? '');
        const identity = json([input.url, variantId]);
        if (feedIdentities.has(identity)) continue;
        feedIdentities.add(identity);
        const seen = this.db.prepare('SELECT 1 FROM source_items WHERE source_id=? AND url=? AND variant_id=?')
          .get(source.id, input.url, variantId);
        if (seen) continue;
        const variant = String(input.variant || '');
        const existing = input.variantId == null
          ? this.db.prepare('SELECT id FROM products WHERE guild_id=? AND url=? AND variant=?').get(source.guild_id, input.url, variant)
          : this.db.prepare('SELECT id FROM products WHERE guild_id=? AND url=? AND (variant_id=? OR (variant_id IS NULL AND variant=?))')
            .get(source.guild_id, input.url, String(input.variantId), variant);
        if (!existing && tracked >= 1000) {
          result.capacity++;
          continue;
        }
        const product = existing ? this.getProduct(source.guild_id, existing.id) : this.addProduct(source.guild_id, {
          ...input, category: source.category, retailer: input.retailer || feed.retailer || source.retailer,
        }, now);
        this.db.prepare('INSERT INTO source_items(source_id,url,variant_id) VALUES (?,?,?)').run(source.id, input.url, variantId);
        if (existing) continue;
        result.added++;
        tracked++;
        if (source.initialized && product.availability === 'in_stock') {
          const generation = product.generation + 1;
          const event = { guild_id: source.guild_id, product_id: product.id, kind: 'new_product', product, checkedAt: now };
          const inserted = this.db.prepare('INSERT INTO events(guild_id,product_id,generation,kind,payload,created_at) VALUES (?,?,?,?,?,?)')
            .run(source.guild_id, product.id, generation, event.kind, json(event), now);
          event.id = Number(inserted.lastInsertRowid);
          this.db.prepare('UPDATE products SET generation=? WHERE id=?').run(generation, product.id);
          result.events.push(event);
        }
      }
      this.db.prepare('UPDATE sources SET initialized=1,last_success=?,last_checked=?,next_check=?,error=NULL,error_count=0,retailer=? WHERE id=?')
        .run(now, now, now + 10 * MINUTE, String(feed.retailer || source.retailer).slice(0, 100), source.id);
      return result;
    });
  }

  stats(guildId) {
    const id = String(guildId);
    const product = this.db.prepare(`SELECT COUNT(*) products, SUM(paused=0) active, SUM(paused=1) paused,
      SUM(paused=0 AND (last_success IS NULL OR last_success < ?)) stale, MAX(last_checked) last_checked,
      MAX(last_success) last_success, SUM(error IS NOT NULL AND paused=0) source_errors FROM products WHERE guild_id=?`)
      .get(Date.now() - 15 * MINUTE, id);
    const deliveries = this.db.prepare(`SELECT SUM(d.status='pending') pending_deliveries, SUM(d.status='failed') failed_deliveries
      FROM deliveries d JOIN events e ON d.event_id=e.id WHERE e.guild_id=?`).get(id);
    const pendingRequests = this.db.prepare("SELECT COUNT(*) count FROM requests WHERE guild_id=? AND status='pending'").get(id).count;
    return { ...product, ...deliveries, pending_requests: pendingRequests };
  }
}

module.exports = { Store, CATEGORIES };

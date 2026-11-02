'use strict';
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { alertPayload } = require('./ui');

class Engine {
  constructor({ store, client, inspectProduct, inspectCollection, config, trends, logger = console }) {
    Object.assign(this, { store, client, inspectProduct, inspectCollection, config, trends, logger });
    this.running = false;
    this.stopping = false;
    this.lastCycle = null;
    this.lastHostRequest = new Map();
    this.checking = new Set();
    this.discovering = new Set();
  }
  async discover(source) {
    if (!this.inspectCollection || this.discovering.has(source.id)) return null;
    this.discovering.add(source.id);
    try {
      const host = new URL(source.url).hostname;
      const wait = 1500 - (Date.now() - (this.lastHostRequest.get(host) || 0));
      if (wait > 0) await delay(wait);
      this.lastHostRequest.set(host, Date.now());
      const feed = await this.inspectCollection(source.url);
      if (this.stopping) return null;
      const result = this.store.recordDiscovery(source, feed);
      if (result.capacity) this.logger.warn(`Source ${source.id}: capacity reached; ${result.capacity} variants deferred.`);
      return result;
    } catch (error) {
      if (this.stopping) return null;
      this.store.recordSourceError(source, String(error.code || 'SOURCE_UNAVAILABLE'));
      return null;
    } finally { this.discovering.delete(source.id); }
  }
  async check(product) {
    if (this.checking.has(product.id)) return null;
    this.checking.add(product.id);
    try {
      const host = new URL(product.url).hostname;
      const wait = 1500 - (Date.now() - (this.lastHostRequest.get(host) || 0));
      if (wait > 0) await delay(wait);
      this.lastHostRequest.set(host, Date.now());
      const observation = await this.inspectProduct(product.url, { variant: product.variant_id || product.variant || undefined });
      if (!['in_stock', 'out_of_stock', 'preorder'].includes(observation.availability)) {
        throw Object.assign(new Error('No reliable availability'), { code: 'UNKNOWN_AVAILABILITY' });
      }
      if (this.stopping) return null;
      const events = this.store.recordObservation(product, observation);
      this.store.scheduleNext(product.id, Date.now() + this.config.checkMs);
      return { observation, events };
    } catch (error) {
      if (this.stopping) return null;
      this.store.recordError(product, String(error.code || 'SOURCE_UNAVAILABLE'));
      // Avoid logging page bodies, interaction payloads or credentials.
      this.logger.warn(`Product ${product.id}: ${error.code || 'SOURCE_UNAVAILABLE'}`);
      return null;
    } finally { this.checking.delete(product.id); }
  }
  queueEvents() {
    for (const event of this.store.pendingEvents()) {
      if (event.guild_id !== this.config.guildId) continue;
      const config = this.store.getConfig(event.guild_id);
      const channelId = config.channels?.[event.kind === 'price_drop' ? 'sales' : event.product.category];
      // Keep the event pending until an admin completes setup.
      if (!channelId) continue;
      const payload = alertPayload(event);
      this.store.queueDelivery(event, 'channel', channelId, payload);
      for (const userId of this.store.subscribers(event.product, event.kind)) {
        this.store.queueDelivery(event, 'dm', userId, payload);
      }
      this.store.eventsQueued(event.id);
    }
  }
  async deliver() {
    for (const delivery of this.store.pendingDeliveries()) {
      if (delivery.guild_id !== this.config.guildId) continue;
      if (this.stopping) break;
      try {
        if (delivery.target_type === 'dm') {
          const event = this.store.getEvent(delivery.event_id);
          if (!event || !this.store.subscribers(event.product, event.kind).includes(delivery.target_id)) {
            this.store.cancelDelivery(delivery.id);
            continue;
          }
          const guild = await this.client.guilds.fetch(event.guild_id);
          if (this.stopping) break;
          try { await guild.members.fetch(delivery.target_id); }
          catch (error) {
            if (this.stopping) break;
            if (error.code === 10007) { this.store.forgetUser(event.guild_id, delivery.target_id); continue; }
            throw error;
          }
        }
        const target = delivery.target_type === 'channel'
          ? await this.client.channels.fetch(delivery.target_id)
          : await this.client.users.fetch(delivery.target_id);
        if (this.stopping) break;
        if (!target?.send) throw Object.assign(new Error('Destination is unavailable'), { code: 'DESTINATION_UNAVAILABLE' });
        const nonce = createHash('sha256').update(String(delivery.id)).digest('hex').slice(0, 24);
        const message = await target.send({ ...delivery.payload, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
        if (this.stopping) break;
        this.store.deliverySent(delivery.id, message.id);
      } catch (error) {
        if (this.stopping) break;
        this.store.deliveryFailed(delivery.id, String(error.code || 'DELIVERY_FAILED'));
      }
    }
  }
  async tick() {
    if (this.running || this.stopping || !this.client.isReady()) return;
    this.running = true;
    try {
      if (this.trends) await this.trends.tick();
      if (this.stopping) return;
      await this.deliver();
      if (this.inspectCollection) for (const source of this.store.listSources(this.config.guildId)) {
        if (this.stopping) break;
        if (!source.paused && (!source.next_check || source.next_check <= Date.now())) await this.discover(source);
      }
      if (this.stopping) return;
      for (const product of this.store.listProducts(this.config.guildId, { limit: 1000 })) {
        if (this.stopping) break;
        if (!product.paused && (!product.next_check || product.next_check <= Date.now())) await this.check(product);
      }
      if (this.stopping) return;
      this.queueEvents();
      await this.deliver();
      this.lastCycle = Date.now();
    } catch (error) {
      this.logger.error(`Monitor cycle: ${error.code || error.name || 'error'}`);
    } finally { this.running = false; }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    this.trends?.stop();
    clearInterval(this.timer);
    const deadline = Date.now() + 20000;
    while (this.running && Date.now() < deadline) await delay(100);
  }
}
module.exports = { Engine };

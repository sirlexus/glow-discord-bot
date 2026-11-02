'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 4;
const RETAILERS = Object.freeze([
  { id: 'adore', name: 'Adore Beauty', domains: ['adorebeauty.com.au'], adapter: 'jsonld' },
  { id: 'sephora', name: 'Sephora Australia', domains: ['sephora.com.au'], adapter: 'jsonld' },
  { id: 'mecca', name: 'MECCA', domains: ['mecca.com', 'mecca.com.au'], adapter: 'jsonld' },
  { id: 'lila', name: 'Lila Beauty', domains: ['lilabeauty.com.au'], adapter: 'shopify' },
  { id: 'wcosmetics', name: 'W cosmetics', domains: ['wcosmetics.com.au'], adapter: 'shopify' },
  { id: 'glamraider', name: 'Glam Raider', domains: ['glamraiderbeauty.com.au'], adapter: 'shopify' },
]);

class RetailerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RetailerError';
    this.code = code;
    this.details = details;
  }
}

function retailerFor(hostname) {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  return RETAILERS.find(retailer => retailer.domains.includes(host));
}

/** Returns a normalised URL. Only explicitly supported retail hosts are accepted. */
function validateProductUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch {
    throw new RetailerError('INVALID_URL', 'Enter a complete HTTPS product link.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new RetailerError('UNSAFE_URL', 'Product links must use HTTPS without credentials or custom ports.');
  }
  if (!retailerFor(url.hostname)) {
    throw new RetailerError('UNSUPPORTED_RETAILER', 'This retailer is not supported. Use /retailers to see supported stores.');
  }
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:account|cart|checkouts?)(?:\/|$)/i.test(url.pathname)) {
    throw new RetailerError('PRODUCT_LINK_REQUIRED', 'Use a public product or collection link, not an account, cart or checkout link.');
  }
  for (const key of url.searchParams.keys()) {
    if (/^(?:token|access[_-]?token|auth(?:orization)?|session(?:[_-]?id)?|password|email|api[_-]?key)$/i.test(key)) {
      throw new RetailerError('SENSITIVE_URL', 'This link contains private account or session information. Copy a clean public product or collection link.');
    }
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|srsltid$|_pos$|_sid$|_ss$)/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (family === 6) {
    // Deliberately conservative: only ordinary global unicast IPv6 addresses.
    // This excludes loopback, mapped IPv4, ULA, link-local and transition ranges.
    const lower = address.toLowerCase();
    return /^[23][0-9a-f]{0,3}:/.test(lower) && !lower.startsWith('2001:db8:') &&
      !lower.startsWith('2001:0:') && !lower.startsWith('2001::') && !lower.startsWith('2002:');
  }
  return false;
}

async function pinnedDispatcher(hostname, signal) {
  const addresses = await Promise.race([
    dns.lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  ]);
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) {
    throw new RetailerError('UNSAFE_ADDRESS', 'The retailer resolved to an address that is not safe to request.');
  }
  const { Agent } = require('undici');
  return new Agent({ connect: {
    lookup: (host, options, callback) => {
      if (host !== hostname) return callback(new Error('Unexpected request hostname.'));
      const choices = options.family ? addresses.filter(item => item.family === options.family) : addresses;
      if (!choices.length) return callback(new Error('No address for requested network family.'));
      if (options.all) callback(null, choices);
      else callback(null, choices[0].address, choices[0].family);
    },
    timeout: TIMEOUT_MS,
  } });
}

async function readLimited(response) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) {
    await response.body?.cancel?.();
    throw new RetailerError('RESPONSE_TOO_LARGE', 'The retailer response was too large to inspect safely.');
  }
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BYTES) throw new RetailerError('RESPONSE_TOO_LARGE', 'The retailer response was too large to inspect safely.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** fetcher is an injectable, trusted fetch implementation used by offline tests. */
async function requestText(input, fetcher) {
  let url = validateProductUrl(input);
  const retailer = retailerFor(url.hostname);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Retailer request timed out.')), TIMEOUT_MS);
    timer.unref?.();
    let dispatcher;
    try {
      dispatcher = fetcher ? undefined : await pinnedDispatcher(url.hostname, controller.signal);
      const execute = fetcher || require('undici').fetch;
      const response = await execute(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'GlowBot/2.0 (beauty product availability monitor)', accept: 'application/json, text/html;q=0.9' },
        ...(dispatcher ? { dispatcher } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel?.();
        if (!location) throw new RetailerError('INVALID_REDIRECT', 'The retailer returned an incomplete redirect.');
        const next = validateProductUrl(new URL(location, url).href);
        if (retailerFor(next.hostname).id !== retailer.id) {
          throw new RetailerError('UNSAFE_REDIRECT', 'The retailer redirected to a different store.');
        }
        url = next;
        continue;
      }
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        await response.body?.cancel?.();
        throw new RetailerError('RETAILER_BLOCKED', 'The retailer blocked or limited this check. Availability is unknown.', { status: response.status });
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        throw new RetailerError('HTTP_ERROR', 'The retailer could not return this product. Availability is unknown.', { status: response.status });
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/(?:json|html|javascript|text\/plain)/i.test(contentType)) {
        await response.body?.cancel?.();
        throw new RetailerError('UNSUPPORTED_RESPONSE', 'The retailer did not return product data.');
      }
      return { text: await readLimited(response), url, contentType };
    } catch (error) {
      if (error instanceof RetailerError) throw error;
      if (controller.signal.aborted) throw new RetailerError('TIMEOUT', 'The retailer check timed out. Availability is unknown.');
      throw new RetailerError('NETWORK_ERROR', 'The retailer could not be reached. Availability is unknown.');
    } finally {
      clearTimeout(timer);
      if (dispatcher) await dispatcher.close();
    }
  }
  throw new RetailerError('TOO_MANY_REDIRECTS', 'The retailer redirected too many times.');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    throw new RetailerError('INVALID_PRODUCT_DATA', 'The retailer did not return readable product data. Availability is unknown.');
  }
}

function clean(value, limit = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function currency(value) {
  const result = clean(value).toUpperCase();
  return /^[A-Z]{3}$/.test(result) ? result : null;
}

function money(value, cents = false) {
  if (typeof value !== 'number' && !/^\d+(?:\.\d+)?$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * (cents ? 1 : 100)) / 100 : null;
}

function asset(value, base) {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === 'object') value = value.url || value.contentUrl || value.src;
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && !net.isIP(url.hostname) && url.hostname.includes('.') && !url.port ? url.href : null;
  } catch { return null; }
}

function selectionValue(url, variant) {
  const chosen = variant == null || variant === '' ? url.searchParams.get('variant') || url.searchParams.get('sku') : variant;
  return chosen == null ? null : clean(chosen, 200);
}

function exactValue(value, selected) {
  return value != null && String(value).trim().toLowerCase() === String(selected).trim().toLowerCase();
}

function validShopifyHandle(value) {
  // Retailer handles can contain Unicode and underscores. Keep each handle to
  // one path segment, then encode it before constructing any request URL.
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    value !== '.' && value !== '..' && !/[\p{C}\p{Z}/\\?#%]/u.test(value);
}

async function inspectShopify(url, options, retailer) {
  const match = url.pathname.match(/^(?:(\/[a-z]{2}(?:-[a-z]{2})?))?(?:\/collections\/[^/]+)?\/products\/([^/]+?)(?:\.js)?\/?$/i);
  if (!match) throw new RetailerError('PRODUCT_LINK_REQUIRED', 'Use a product page link, not a collection or store homepage.');
  const prefix = match[1] || '';
  let handle;
  try { handle = decodeURIComponent(match[2]); } catch { /* Refuse malformed encoding below. */ }
  if (!validShopifyHandle(handle)) throw new RetailerError('PRODUCT_LINK_REQUIRED', 'Use a valid public product page link.');
  const encodedHandle = encodeURIComponent(handle);
  const endpoint = new URL(`${prefix}/products/${encodedHandle}.js`, url.origin);
  const response = await requestText(endpoint, options.fetcher);
  const product = parseJson(response.text);
  if (!product || !product.title || !Array.isArray(product.variants) || !product.variants.length) {
    throw new RetailerError('NO_PRODUCT_DATA', 'The retailer did not provide an identifiable product and its variants.');
  }
  if (!validShopifyHandle(product.handle) || product.handle !== handle) {
    throw new RetailerError('PRODUCT_MISMATCH', 'The retailer returned a different product. Availability is unknown.');
  }
  const selected = selectionValue(url, options.variant);
  const variants = selected ? product.variants.filter(item =>
    [item.id, item.sku, item.title].some(value => exactValue(value, selected))) : product.variants;
  if (variants.length !== 1) {
    throw new RetailerError(selected ? 'VARIANT_NOT_FOUND' : 'VARIANT_REQUIRED', selected ?
      'That shade or size could not be matched exactly. Use the variant ID from the product link.' :
      'This product has several shades or sizes. Select one on the retailer site and copy its variant link.', {
      variants: product.variants.slice(0, 25).map(item => ({ id: String(item.id), name: clean(item.title) })),
    });
  }
  const variant = variants[0];
  if (!/^\d+$/.test(String(variant.id))) throw new RetailerError('NO_PRODUCT_DATA', 'The retailer did not provide a reliable variant ID.');
  if (typeof variant.available !== 'boolean') throw new RetailerError('NO_RELIABLE_AVAILABILITY', 'This product does not have reliable availability data.');
  let priceCurrency = currency(product.currency);
  if (!priceCurrency) {
    // Shopify prices use the customer's presentment currency. Never assume AUD
    // just because a domain is Australian. cart.js is a read-only currency check.
    const cart = await requestText(new URL(`${prefix}/cart.js`, response.url.origin), options.fetcher);
    priceCurrency = currency(parseJson(cart.text).currency);
  }
  if (!priceCurrency) throw new RetailerError('NO_RELIABLE_CURRENCY', 'The retailer did not identify the product currency.');
  const price = Number.isSafeInteger(variant.price) ? money(variant.price, true) : null;
  if (price === null) throw new RetailerError('NO_RELIABLE_PRICE', 'The retailer did not provide a reliable variant price.');
  const canonical = new URL(`${prefix}/products/${encodedHandle}`, response.url.origin);
  canonical.searchParams.set('variant', String(variant.id));
  return {
    url: canonical.href, retailer: retailer.name, name: clean(product.title), brand: clean(product.vendor) || null,
    variant: clean(variant.title) || String(variant.id), variantId: String(variant.id), sku: clean(variant.sku) || null,
    price, currency: priceCurrency, availability: variant.available ? 'in_stock' : 'out_of_stock',
    image: asset(variant.featured_image || product.featured_image || product.images, canonical), source: 'shopify',
    checkedAt: new Date().toISOString(),
  };
}

function typeIs(object, type) {
  return [object?.['@type']].flat().some(value => String(value).split('/').pop() === type);
}

function comparableUrl(value, base, includeQuery = false) {
  try {
    const url = new URL(value, base);
    return url.origin.replace('://www.', '://') + url.pathname.replace(/\/$/, '') + (includeQuery ? url.search : '');
  } catch { return null; }
}

function productIdentifiers(product) {
  return [product.sku, product.mpn, product.productID, product.name, product.color, product.size].filter(value => value != null && typeof value !== 'object');
}

function schemaAvailability(value) {
  const name = String(value || '').split(/[\/#]/).pop();
  if (name === 'InStock' || name === 'LimitedAvailability') return 'in_stock';
  if (['OutOfStock', 'SoldOut', 'Discontinued'].includes(name)) return 'out_of_stock';
  if (['PreOrder', 'PreSale', 'BackOrder'].includes(name)) return 'preorder';
  return 'unknown';
}

async function inspectJsonLd(url, options, retailer) {
  if (url.pathname === '/') throw new RetailerError('PRODUCT_LINK_REQUIRED', 'Use a product page link, not a store homepage.');
  const response = await requestText(url, options.fetcher);
  const $ = require('cheerio').load(response.text);
  const nodes = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const value = JSON.parse($(script).text());
      const collect = item => {
        if (Array.isArray(item)) return item.forEach(collect);
        if (!item || typeof item !== 'object') return;
        nodes.push(item);
        if (item['@graph']) collect(item['@graph']);
        if (item.mainEntity) collect(item.mainEntity);
        if (typeIs(item, 'ProductGroup') && item.hasVariant) collect(item.hasVariant);
      };
      collect(value);
    } catch { /* Invalid JSON-LD is not evidence of stock. Other valid blocks may exist. */ }
  }
  const resolve = value => value && typeof value === 'object' && value['@id'] && Object.keys(value).length === 1 ?
    nodes.find(item => item['@id'] === value['@id']) || value : value;
  let products = nodes.filter(item => typeIs(item, 'Product'));
  const selected = selectionValue(url, options.variant);
  const pageIdentity = comparableUrl(response.url.href, response.url);
  const canonical = $('link[rel="canonical"]').attr('href');
  const pageMatches = product => [product.url || product['@id']].filter(Boolean).some(value => comparableUrl(value, response.url) === pageIdentity);
  const matchingPage = products.filter(pageMatches);
  if (matchingPage.length) products = matchingPage;
  else if (!(products.length === 1 && canonical && comparableUrl(canonical, response.url) === pageIdentity)) {
    throw new RetailerError('NO_RELIABLE_SCHEMA', 'The page did not identify an unambiguous product. Availability is unknown.');
  }
  if (selected && products.length > 1) products = products.filter(item => productIdentifiers(item).some(value => exactValue(value, selected)));
  if (products.length !== 1) throw new RetailerError('AMBIGUOUS_PRODUCT', 'Several products or variants were found. This page cannot be monitored reliably.');
  const product = products[0];
  if (!product.name) throw new RetailerError('NO_PRODUCT_DATA', 'The product schema did not provide a product name.');
  let offers = [product.offers].flat().filter(Boolean).map(resolve);
  offers = offers.flatMap(offer => typeIs(offer, 'AggregateOffer') ? [offer.offers].flat().filter(Boolean).map(resolve) : [offer]);
  const requestedMatchesProduct = selected && productIdentifiers(product).some(value => exactValue(value, selected));
  if (selected && !requestedMatchesProduct) {
    offers = offers.filter(offer => [offer.sku, offer.mpn, offer.name].some(value => exactValue(value, selected)) ||
      (offer.url && comparableUrl(offer.url, response.url, true) === comparableUrl(url.href, url, true) &&
        ['variant', 'sku'].some(key => new URL(offer.url, response.url).searchParams.get(key) === selected)));
  }
  if (offers.length !== 1 || !typeIs(offers[0], 'Offer')) {
    throw new RetailerError(selected ? 'VARIANT_NOT_FOUND' : 'AMBIGUOUS_OFFER', 'A single exact product offer could not be identified. Availability is unknown.');
  }
  const offer = offers[0];
  // An unrequested variant query must not be silently ignored by a retailer schema.
  const availability = schemaAvailability(offer.availability);
  if (availability === 'unknown') throw new RetailerError('NO_RELIABLE_AVAILABILITY', 'The product schema did not provide a recognised availability state.');
  let price = money(offer.price);
  let priceCurrency = currency(offer.priceCurrency);
  if (price === null || !priceCurrency) {
    const specifications = [offer.priceSpecification].flat().filter(Boolean).map(resolve);
    if (specifications.length === 1) {
      const specPrice = money(specifications[0].price);
      const specCurrency = currency(specifications[0].priceCurrency);
      if (specPrice !== null && specCurrency && (price === null || price === specPrice) && (!priceCurrency || priceCurrency === specCurrency)) {
        price = specPrice;
        priceCurrency = specCurrency;
      }
    }
  }
  if (price === null || !priceCurrency) throw new RetailerError('NO_RELIABLE_PRICE', 'The exact product offer did not provide a reliable price and currency.');
  return {
    url: response.url.href, retailer: retailer.name, name: clean(product.name),
    brand: clean(typeof product.brand === 'object' ? product.brand?.name : product.brand) || null,
    variant: selected || clean(product.sku) || null, variantId: selected || null, sku: clean(offer.sku || product.sku) || null,
    price, currency: priceCurrency, availability, image: asset(product.image, response.url), source: 'jsonld', checkedAt: new Date().toISOString(),
  };
}

async function inspectProduct(value, options = {}) {
  const url = validateProductUrl(value);
  const retailer = retailerFor(url.hostname);
  return retailer.adapter === 'shopify' ? inspectShopify(url, options, retailer) : inspectJsonLd(url, options, retailer);
}

/**
 * A bounded catalogue snapshot for discovery, not a complete catalogue crawl.
 * Only the collection's current first 100 products (up to 1,000 variants) are
 * inspected. The caller establishes a silent baseline and detects later IDs.
 * Shopify collection feeds use decimal currency prices, unlike product.js.
 */
async function inspectCollection(value, options = {}) {
  const input = validateProductUrl(value);
  const retailer = retailerFor(input.hostname);
  if (retailer.adapter !== 'shopify') {
    throw new RetailerError('UNSUPPORTED_COLLECTION', 'Automatic collection discovery is available for Lila Beauty, W cosmetics and Glam Raider only.');
  }
  const match = input.pathname.match(/^(\/[a-z]{2}(?:-[a-z]{2})?)?\/collections\/([a-z0-9][a-z0-9-]*)(?:\/products(?:\.json)?|\.json)?\/?$/i);
  if (!match) {
    throw new RetailerError('COLLECTION_LINK_REQUIRED', 'Use a collection link such as /collections/new-arrivals.');
  }
  const prefix = match[1] || '';
  const path = `${prefix}/collections/${match[2]}`;
  const endpoint = new URL(`${path}/products.json?limit=100`, input.origin);
  const response = await requestText(endpoint, options.fetcher);
  if (response.url.pathname !== endpoint.pathname) {
    throw new RetailerError('COLLECTION_MISMATCH', 'The retailer returned a different collection. Catalogue availability is unknown.');
  }
  const data = parseJson(response.text);
  if (!data || !Array.isArray(data.products)) {
    throw new RetailerError('NO_COLLECTION_DATA', 'The retailer did not return a readable product collection.');
  }
  if (data.products.length > 100) {
    throw new RetailerError('COLLECTION_LIMIT', 'The retailer returned more than the allowed 100 product snapshot.');
  }
  const url = new URL(path, response.url.origin);
  const checkedAt = new Date().toISOString();
  const products = [];
  const seen = new Set();
  for (const product of data.products) {
    if (!product || !/^\d+$/.test(String(product.id)) || !product.title ||
      !validShopifyHandle(product.handle) ||
      !Array.isArray(product.variants) || !product.variants.length) {
      throw new RetailerError('INVALID_COLLECTION_PRODUCT', 'A collection product has incomplete identity or variant data. No catalogue changes were accepted.');
    }
    for (const variant of product.variants) {
      if (!variant || !/^\d+$/.test(String(variant.id)) || typeof variant.available !== 'boolean') {
        throw new RetailerError('INVALID_COLLECTION_VARIANT', 'A collection variant has no exact identity or reliable availability. No catalogue changes were accepted.');
      }
      const price = money(variant.price);
      if (price === null) {
        throw new RetailerError('NO_RELIABLE_PRICE', 'A collection variant has no reliable price. No catalogue changes were accepted.');
      }
      const productUrl = new URL(`${prefix}/products/${encodeURIComponent(product.handle)}`, response.url.origin);
      productUrl.searchParams.set('variant', String(variant.id));
      if (seen.has(productUrl.href)) {
        throw new RetailerError('DUPLICATE_COLLECTION_VARIANT', 'The collection returned duplicate variant identities. No catalogue changes were accepted.');
      }
      seen.add(productUrl.href);
      products.push({
        url: productUrl.href, retailer: retailer.name, name: clean(product.title), brand: clean(product.vendor) || null,
        variant: clean(variant.title) || String(variant.id), variantId: String(variant.id), sku: clean(variant.sku) || null,
        price, currency: null, availability: variant.available ? 'in_stock' : 'out_of_stock',
        image: asset(variant.featured_image || product.image || product.images, productUrl),
        source: 'shopify_collection', checkedAt,
      });
      if (products.length > 1000) {
        throw new RetailerError('COLLECTION_LIMIT', 'The collection exceeds the allowed 1,000 variant snapshot. No catalogue changes were accepted.');
      }
    }
  }
  // Currency is presentment dependent, so verify it even on Australian domains.
  // An explicitly empty snapshot is valid and does not need a price currency.
  if (products.length) {
    const cart = await requestText(new URL(`${prefix}/cart.js`, response.url.origin), options.fetcher);
    const priceCurrency = currency(parseJson(cart.text).currency);
    if (!priceCurrency) throw new RetailerError('NO_RELIABLE_CURRENCY', 'The retailer did not identify the collection price currency.');
    for (const product of products) product.currency = priceCurrency;
  }
  return { url: url.href, retailer: retailer.name, products, checkedAt, source: 'shopify_collection' };
}

module.exports = { inspectProduct, inspectCollection, validateProductUrl, RetailerError, RETAILERS };

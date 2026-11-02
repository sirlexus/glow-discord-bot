'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectProduct, inspectCollection, validateProductUrl, RetailerError } = require('../src/retailers');

const shopUrl = 'https://lilabeauty.com.au/products/test-lip-tint';
const schemaUrl = 'https://www.adorebeauty.com.au/p/example/lip-tint.html';

function shopProduct(overrides = {}) {
  return { title: 'Lip Tint', handle: 'test-lip-tint', vendor: 'Test Beauty', currency: 'AUD',
    featured_image: '//cdn.shopify.com/test.jpg',
    variants: [
      { id: 123, title: 'Rose', sku: 'ROSE', price: 2599, available: false },
      { id: 456, title: 'Berry', sku: 'BERRY', price: 2799, available: true },
    ], ...overrides };
}

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'object' ? JSON.stringify(body) : body, {
    status, headers: { 'content-type': typeof body === 'object' ? 'application/json' : 'text/html', ...headers },
  });
}

function schemaProduct(overrides = {}) {
  return { '@context': 'https://schema.org', '@type': 'Product', name: 'Rose Lip Tint',
    url: schemaUrl, sku: 'ROSE', brand: { '@type': 'Brand', name: 'Test Beauty' },
    offers: { '@type': 'Offer', price: '29.95', priceCurrency: 'AUD', availability: 'https://schema.org/InStock' },
    ...overrides };
}

function html(schema, extra = '') {
  return `<html><head><link rel="canonical" href="${schemaUrl}"><script type="application/ld+json">${JSON.stringify(schema)}</script></head><body>${extra}</body></html>`;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof RetailerError && error.code === code);
}

test('approved URLs are normalised and tracking is removed', () => {
  const parsed = validateProductUrl(`${shopUrl}?variant=123&utm_source=test#details`);
  assert.equal(parsed.href, `${shopUrl}?variant=123`);
});

test('unsafe protocols, credentials, ports, hosts and deceptive subdomains are rejected', () => {
  for (const value of ['http://lilabeauty.com.au/products/a', 'https://u:p@lilabeauty.com.au/products/a',
    'https://lilabeauty.com.au:444/products/a', 'https://127.0.0.1/products/a',
    'https://lilabeauty.com.au.attacker.test/products/a', 'https://internal.lilabeauty.com.au/products/a']) {
    assert.throws(() => validateProductUrl(value), RetailerError);
  }
});

test('private query keys are refused without exposing their values', () => {
  for (const key of ['token', 'auth', 'session', 'session_id', 'password', 'email', 'api_key', 'API-Key', 'access_token']) {
    assert.throws(() => validateProductUrl(`${shopUrl}?variant=123&${key}=private-value-do-not-log`), error =>
      error instanceof RetailerError && error.code === 'SENSITIVE_URL' &&
      !error.message.includes('private-value-do-not-log') && !JSON.stringify(error).includes('private-value-do-not-log'));
  }
});

test('private account, cart and checkout routes are refused while internal currency endpoint remains safe', () => {
  for (const path of ['/account', '/account/login', '/cart', '/cart/add', '/checkout', '/checkouts/private-session', '/en-au/cart']) {
    assert.throws(() => validateProductUrl(`https://lilabeauty.com.au${path}`), error =>
      error instanceof RetailerError && error.code === 'PRODUCT_LINK_REQUIRED');
  }
  assert.equal(validateProductUrl('https://lilabeauty.com.au/cart.js').pathname, '/cart.js');
});

test('Shopify uses selected variant, not overall product availability or minimum price', async () => {
  const calls = [];
  const result = await inspectProduct(`${shopUrl}?variant=123`, { fetcher: async url => {
    calls.push(url);
    return response(shopProduct({ available: true, price: 1 }));
  } });
  assert.equal(result.availability, 'out_of_stock');
  assert.equal(result.price, 25.99);
  assert.equal(result.currency, 'AUD');
  assert.equal(result.variant, 'Rose');
  assert.equal(result.variantId, '123');
  assert.equal(result.url, `${shopUrl}?variant=123`);
  assert.equal(result.image, 'https://cdn.shopify.com/test.jpg');
  assert.deepEqual(calls, [`${shopUrl}.js`]);
});

test('Shopify matches a decoded Unicode handle exactly and preserves its encoded product URL', async () => {
  const handle = 'vital-hydra-solution™-hydrating-lip-mask';
  const encodedUrl = `https://lilabeauty.com.au/products/${encodeURIComponent(handle)}`;
  const calls = [];
  const product = shopProduct({ handle });
  const result = await inspectProduct(`${encodedUrl}?variant=456`, { fetcher: async url => {
    calls.push(url);
    return response(product);
  } });
  assert.deepEqual(calls, [`${encodedUrl}.js`]);
  assert.equal(result.url, `${encodedUrl}?variant=456`);
  assert.equal(result.variantId, '456');
  await rejectsCode(inspectProduct(`${encodedUrl}?variant=456`, {
    fetcher: async () => response({ ...product, handle: `${handle}-different` }),
  }), 'PRODUCT_MISMATCH');
});

test('Shopify refuses encoded path separators and malformed handles before making a request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response(shopProduct()); };
  for (const handle of ['item%2Fother', 'item%5Cother', 'item%3Fprivate', 'item%23private', 'item%25encoded', 'item%00', 'item%ZZ']) {
    await rejectsCode(inspectProduct(`https://lilabeauty.com.au/products/${handle}`, { fetcher }), 'PRODUCT_LINK_REQUIRED');
  }
  assert.equal(calls, 0);
});

test('Shopify refuses unselected multiple variants and reports available options', async () => {
  await assert.rejects(inspectProduct(shopUrl, { fetcher: async () => response(shopProduct()) }), error =>
    error.code === 'VARIANT_REQUIRED' && error.details.variants.length === 2);
});

test('Shopify exact SKU or title selection works; unknown variant is never silently substituted', async () => {
  const result = await inspectProduct(shopUrl, { variant: 'BERRY', fetcher: async () => response(shopProduct()) });
  assert.equal(result.variantId, '456');
  assert.equal(result.availability, 'in_stock');
  await rejectsCode(inspectProduct(shopUrl, { variant: 'missing', fetcher: async () => response(shopProduct()) }), 'VARIANT_NOT_FOUND');
});

test('Shopify single variant establishes currency with read-only cart data', async () => {
  const calls = [];
  const product = shopProduct({ currency: undefined, variants: [shopProduct().variants[0]] });
  const result = await inspectProduct(shopUrl, { fetcher: async url => {
    calls.push(url);
    return response(url.endsWith('/cart.js') ? { currency: 'NZD' } : product);
  } });
  assert.equal(result.currency, 'NZD');
  assert.equal(calls[1], 'https://lilabeauty.com.au/cart.js');
});

test('Shopify rejects returned product mismatch, unreliable availability, malformed prices and currency', async () => {
  await rejectsCode(inspectProduct(`${shopUrl}?variant=123`, { fetcher: async () => response(shopProduct({ handle: 'other' })) }), 'PRODUCT_MISMATCH');
  await rejectsCode(inspectProduct(shopUrl, { fetcher: async () => response(shopProduct({ variants: [{ id: 123, title: 'Rose', price: 2599 }] })) }), 'NO_RELIABLE_AVAILABILITY');
  await rejectsCode(inspectProduct(shopUrl, { fetcher: async () => response(shopProduct({ variants: [{ id: 123, title: 'Rose', price: 25.99, available: true }] })) }), 'NO_RELIABLE_PRICE');
  await rejectsCode(inspectProduct(shopUrl, { fetcher: async url => response(url.endsWith('/cart.js') ? { currency: 'AUD bad' } : shopProduct({ currency: undefined, variants: [shopProduct().variants[0]] })) }), 'NO_RELIABLE_CURRENCY');
});

test('JSON-LD extracts only exact product offer and structured availability', async () => {
  const result = await inspectProduct(schemaUrl, { fetcher: async () => response(html(schemaProduct(), 'Sold out Add to cart')) });
  assert.equal(result.price, 29.95);
  assert.equal(result.availability, 'in_stock');
  assert.equal(result.brand, 'Test Beauty');
  assert.equal(result.source, 'jsonld');
});

test('body text is never used to infer stock when schema is absent or damaged', async () => {
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('<button>Add to cart</button> In stock') }), 'NO_RELIABLE_SCHEMA');
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('<script type="application/ld+json">{broken</script><p>sold out</p>') }), 'NO_RELIABLE_SCHEMA');
});

test('a product schema unrelated to requested page is rejected', async () => {
  const body = `<script type="application/ld+json">${JSON.stringify(schemaProduct({ url: 'https://www.adorebeauty.com.au/p/recommendation.html' }))}</script>`;
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response(body) }), 'NO_RELIABLE_SCHEMA');
});

test('JSON-LD multiple products and aggregate offers are rejected rather than guessing', async () => {
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response(html([schemaProduct(), schemaProduct({ sku: 'BERRY' })])) }), 'AMBIGUOUS_PRODUCT');
  const product = schemaProduct({ offers: { '@type': 'AggregateOffer', lowPrice: '19.00', highPrice: '39.00', priceCurrency: 'AUD', availability: 'https://schema.org/InStock' } });
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response(html(product)) }), 'AMBIGUOUS_OFFER');
});

test('JSON-LD does not silently ignore selected variant', async () => {
  await rejectsCode(inspectProduct(`${schemaUrl}?variant=BERRY`, { fetcher: async () => response(html(schemaProduct())) }), 'VARIANT_NOT_FOUND');
  const result = await inspectProduct(schemaUrl, { variant: 'ROSE', fetcher: async () => response(html(schemaProduct())) });
  assert.equal(result.variant, 'ROSE');
});

test('JSON-LD no recognised availability never becomes out of stock', async () => {
  const product = schemaProduct({ offers: { '@type': 'Offer', price: '29.95', priceCurrency: 'AUD' } });
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response(html(product)) }), 'NO_RELIABLE_AVAILABILITY');
});

test('JSON-LD graph resolves a referenced offer', async () => {
  const graph = { '@graph': [schemaProduct({ offers: { '@id': '#offer' } }),
    { '@type': 'Offer', '@id': '#offer', price: '22.00', priceCurrency: 'AUD', availability: 'https://schema.org/OutOfStock' }] };
  const result = await inspectProduct(schemaUrl, { fetcher: async () => response(html(graph)) });
  assert.equal(result.availability, 'out_of_stock');
  assert.equal(result.price, 22);
});

test('rate limits and access blocks are clean errors, not stock observations', async () => {
  for (const status of [403, 429, 503]) {
    await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('blocked', status) }), 'RETAILER_BLOCKED');
  }
});

test('redirects cannot escape allowlist or switch retailer', async () => {
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('', 302, { location: 'https://127.0.0.1/internal' }) }), 'UNSUPPORTED_RETAILER');
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('', 302, { location: shopUrl }) }), 'UNSAFE_REDIRECT');
});

test('same retailer redirects are bounded and product schema uses final page identity', async () => {
  const target = schemaUrl.replace('lip-tint.html', 'rose-tint.html');
  const result = await inspectProduct(schemaUrl, { fetcher: async url => url === schemaUrl ?
    response('', 301, { location: target }) : response(html(schemaProduct({ url: target }))) });
  assert.equal(result.price, 29.95);
  assert.equal(result.url, target);
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('', 302, { location: schemaUrl }) }), 'TOO_MANY_REDIRECTS');
});

test('production fetch refuses private DNS answers before making a request', async () => {
  const dns = require('node:dns').promises;
  const original = dns.lookup;
  try {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
      dns.lookup = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
      await rejectsCode(inspectProduct(schemaUrl), 'UNSAFE_ADDRESS');
    }
    // A mix of public and private answers is unsafe too; never try the private one.
    dns.lookup = async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await rejectsCode(inspectProduct(schemaUrl), 'UNSAFE_ADDRESS');
  } finally { dns.lookup = original; }
});

test('JSON-LD does not combine conflicting price specification fields', async () => {
  const product = schemaProduct({ offers: { '@type': 'Offer', price: '29.95',
    priceSpecification: { '@type': 'UnitPriceSpecification', price: '19.95', priceCurrency: 'AUD' },
    availability: 'https://schema.org/InStock' } });
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response(html(product)) }), 'NO_RELIABLE_PRICE');
});

test('oversized responses and network errors are reported safely', async () => {
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('small', 200, { 'content-length': '3000000' }) }), 'RESPONSE_TOO_LARGE');
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => response('x'.repeat(2 * 1024 * 1024 + 1)) }), 'RESPONSE_TOO_LARGE');
  await rejectsCode(inspectProduct(schemaUrl, { fetcher: async () => { throw new Error('sensitive upstream detail'); } }), 'NETWORK_ERROR');
});

const collectionUrl = 'https://lilabeauty.com.au/collections/new-arrivals';
function collectionProduct(overrides = {}) {
  return { id: 111, handle: 'new-lip-tint', title: 'New Lip Tint', vendor: 'Beauty Brand',
    images: [{ src: 'https://cdn.shopify.com/new-lip-tint.jpg' }], variants: [
      { id: 112, title: 'Rose', sku: 'NEW-ROSE', price: '25.99', available: true },
      { id: 113, title: 'Berry', sku: 'NEW-BERRY', price: '27.99', available: false },
    ], ...overrides };
}
function collectionFetch(products, calls = []) {
  return async url => {
    calls.push(url);
    return response(url.endsWith('/cart.js') ? { currency: 'AUD' } : { products });
  };
}

test('collection discovery reads bounded feed and returns exact variant observations at decimal prices', async () => {
  const calls = [];
  const result = await inspectCollection(`${collectionUrl}/products.json?sort_by=created-descending&utm_source=discord`, {
    fetcher: collectionFetch([collectionProduct()], calls),
  });
  assert.equal(result.url, collectionUrl);
  assert.equal(result.source, 'shopify_collection');
  assert.equal(result.products.length, 2);
  assert.deepEqual(calls, [`${collectionUrl}/products.json?limit=100`, 'https://lilabeauty.com.au/cart.js']);
  assert.deepEqual(result.products.map(item => [item.variantId, item.price, item.availability, item.currency]), [
    ['112', 25.99, 'in_stock', 'AUD'], ['113', 27.99, 'out_of_stock', 'AUD'],
  ]);
  assert.equal(result.products[0].url, 'https://lilabeauty.com.au/products/new-lip-tint?variant=112');
  assert.equal(result.products[0].image, 'https://cdn.shopify.com/new-lip-tint.jpg');
});

test('a full collection snapshot accepts real retailer Unicode and underscore handle shapes', async () => {
  // These two handle shapes were observed in Lila's 100-product makeup and
  // skincare feeds on 3 November 2026. One valid item must not reject a feed.
  const products = Array.from({ length: 98 }, (_, index) => collectionProduct({
    id: index + 1, handle: `product-${index + 1}`,
    variants: [{ id: index + 1000, title: 'Default Title', price: '1.00', available: true }],
  }));
  products.push(collectionProduct({ id: 8200640069694, handle: 'vital-hydra-solution™-hydrating-lip-mask',
    title: 'Vital Hydra Solution Hydrating Lip Mask', variants: [
      { id: 43157081423934, title: 'Bubble Gum', sku: 'DRJ198', price: '29.50', available: true },
      { id: 43157080244286, title: 'Original', sku: 'DRJ197', price: '29.50', available: true },
    ] }));
  products.push(collectionProduct({ id: 15433027420222, handle: 'fermentation-eye-cream-mini-10g-sca_clone_freegift',
    title: 'Fermentation Eye Cream Mini 10g', variants: [
      { id: 67917063716926, title: 'Default Title', sku: 'BTN130', price: '0.00', available: true },
    ] }));
  const result = await inspectCollection(collectionUrl, { fetcher: collectionFetch(products) });
  assert.equal(result.products.length, 101);
  const unicode = result.products.find(product => product.variantId === '43157081423934');
  assert.equal(unicode.url, 'https://lilabeauty.com.au/products/vital-hydra-solution%E2%84%A2-hydrating-lip-mask?variant=43157081423934');
  assert.equal(unicode.price, 29.5);
  assert.equal(unicode.currency, 'AUD');
  const underscore = result.products.find(product => product.variantId === '67917063716926');
  assert.equal(underscore.url, 'https://lilabeauty.com.au/products/fermentation-eye-cream-mini-10g-sca_clone_freegift?variant=67917063716926');
});

test('collection handles cannot inject another URL, path, query or fragment', async () => {
  for (const handle of ['//other.example/item', '../account', '.', '..', 'item/other', 'item\\other', 'item?token=secret', 'item#part', 'item%2fother', 'item\u0000', 'item with space']) {
    await rejectsCode(inspectCollection(collectionUrl, {
      fetcher: collectionFetch([collectionProduct({ handle })]),
    }), 'INVALID_COLLECTION_PRODUCT');
  }
});

test('collection parser discovers later product identities independently of initial snapshot', async () => {
  const initial = await inspectCollection(collectionUrl, { fetcher: collectionFetch([collectionProduct()]) });
  const newcomer = collectionProduct({ id: 222, handle: 'new-eye-shadow', title: 'New Eye Shadow',
    variants: [{ id: 223, title: 'Copper', price: '39.00', available: true }] });
  const later = await inspectCollection(collectionUrl, { fetcher: collectionFetch([newcomer, collectionProduct()]) });
  const knownIds = new Set(initial.products.map(item => item.variantId));
  assert.deepEqual(later.products.filter(item => !knownIds.has(item.variantId)).map(item => item.name), ['New Eye Shadow']);
});

test('collection snapshots accept explicit empty data without creating invented products', async () => {
  const calls = [];
  const result = await inspectCollection(collectionUrl, { fetcher: collectionFetch([], calls) });
  assert.deepEqual(result.products, []);
  assert.equal(calls.length, 1);
});

test('collection discovery only accepts supported Shopify collection links', async () => {
  await rejectsCode(inspectCollection('https://www.adorebeauty.com.au/collections/new-arrivals'), 'UNSUPPORTED_COLLECTION');
  await rejectsCode(inspectCollection(shopUrl), 'COLLECTION_LINK_REQUIRED');
  await rejectsCode(inspectCollection('https://lilabeauty.com.au/collections/new-arrivals/products/fake'), 'COLLECTION_LINK_REQUIRED');
});

test('collection discovery keeps locale and refuses a redirect to another collection', async () => {
  const calls = [];
  const result = await inspectCollection('https://lilabeauty.com.au/en-au/collections/new-arrivals.json?tracking=x', {
    fetcher: collectionFetch([collectionProduct()], calls),
  });
  assert.equal(result.url, 'https://lilabeauty.com.au/en-au/collections/new-arrivals');
  assert.equal(calls[1], 'https://lilabeauty.com.au/en-au/cart.js');
  assert.equal(result.products[0].url, 'https://lilabeauty.com.au/en-au/products/new-lip-tint?variant=112');
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: async url => url.includes('new-arrivals') ?
    response('', 302, { location: '/collections/all/products.json?limit=100' }) : response({ products: [] }) }), 'COLLECTION_MISMATCH');
});

test('collection malformed items fail the complete check instead of returning partial discoveries', async () => {
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: async () => response({ message: 'blocked' }) }), 'NO_COLLECTION_DATA');
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch([collectionProduct(), { id: 2 }]) }), 'INVALID_COLLECTION_PRODUCT');
  const missingStock = collectionProduct({ variants: [{ id: 112, title: 'Rose', price: '25.99' }] });
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch([missingStock]) }), 'INVALID_COLLECTION_VARIANT');
  const missingPrice = collectionProduct({ variants: [{ id: 112, available: true, price: 'AUD 25.99' }] });
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch([missingPrice]) }), 'NO_RELIABLE_PRICE');
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch([collectionProduct(), collectionProduct()]) }), 'DUPLICATE_COLLECTION_VARIANT');
});

test('collection discovery enforces product and variant bounds', async () => {
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch(Array(101).fill(collectionProduct())) }), 'COLLECTION_LIMIT');
  const variants = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, title: `Shade ${i + 1}`, available: true, price: '1.00' }));
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: collectionFetch([collectionProduct({ variants })]) }), 'COLLECTION_LIMIT');
});

test('collection discovery rejects unconfirmed currency and blocked feeds', async () => {
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: async url => response(url.endsWith('/cart.js') ? {} : { products: [collectionProduct()] }) }), 'NO_RELIABLE_CURRENCY');
  await rejectsCode(inspectCollection(collectionUrl, { fetcher: async () => response('limited', 429) }), 'RETAILER_BLOCKED');
});

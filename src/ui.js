'use strict';

// Component IDs are permanent. Their handlers live in the main interaction router.
const COLOUR = 0xce688b;
const CATEGORIES = Object.freeze([
  { label: 'Makeup', value: 'makeup', emoji: { name: '💄' } },
  { label: 'Skincare', value: 'skincare', emoji: { name: '🧴' } },
  { label: 'Haircare', value: 'haircare', emoji: { name: '💇' } },
  { label: 'Fragrance', value: 'fragrance', emoji: { name: '🌸' } },
  { label: 'Sales and price drops', value: 'sales', emoji: { name: '🏷️' } },
]);
const safe = value => String(value ?? '').replace(/@/g, '@\u200b').replace(/[\[\]_*`~|<>]/g, '\\$&');
const cut = (value, length) => String(value ?? '').slice(0, length);
const row = (...components) => ({ type: 1, components });
const button = (id, label, style = 2) => ({ type: 2, custom_id: id, label, style });
const payload = (embeds, components = []) => ({ embeds, components, allowedMentions: { parse: [] } });
const embed = (title, description, extra = {}) => ({ title, description, color: COLOUR, ...extra });
const channel = (config, key, fallback) => config?.channels?.[key] ? `<#${config.channels[key]}>` : fallback;

function homePanel(config = {}) {
  return payload([embed('Welcome to Glowbot',
    `Beauty finds, stock updates and price drops, in one place.\n\n` +
    `**1. Read the basics** in ${channel(config, 'rules', 'rules')}.\n` +
    `**2. Choose your alerts** using the button below. Notifications are optional.\n` +
    `**3. Find a product** or ask for one in ${channel(config, 'requests', 'product requests')}.\n\n` +
    `You can browse the public alert channels without signing up for direct messages. ` +
    `Stock can change after a check. Always confirm the exact shade, size and price at the shop.`,
    { footer: { text: 'Glowbot setup panel · home' } })], [
    row(button('glow:preferences', 'Choose alerts', 1), button('glow:search', 'Find a product'), button('glow:request', 'Request a product'), button('glow:mine', 'My alerts'), button('glow:help', 'Help')),
  ]);
}

function publicPreferencesPanel() {
  return payload([embed('Make Glowbot your own',
    'Choose only the beauty categories you want to hear about. Your choices are private. ' +
    'Select Choose alerts below to open your personal preferences. You can stop them whenever you like.',
    { footer: { text: 'Glowbot setup panel · preferences' } })],
    [row(button('glow:preferences', 'Choose alerts', 1), button('glow:mine', 'My alerts'), button('glow:help', 'Help'))]);
}

function preferencesPanel(selected = []) {
  const active = new Set(selected);
  return payload([embed('Choose your beauty alerts',
    'Choose categories for direct messages about confirmed restocks and price drops. ' +
    'These messages are optional. Clear every category to stop category alerts. ' +
    'Individual product watches are managed in My alerts.\n\n' +
    'Discord must allow direct messages from this server. If delivery fails, your subscriptions stay saved and Glowbot reports the problem.')], [
    row({ type: 3, custom_id: 'glow:categories', placeholder: 'Choose categories or clear them all', min_values: 0, max_values: CATEGORIES.length,
      options: CATEGORIES.map(c => ({ ...c, default: active.has(c.value) })) }),
    row(button('glow:mine', 'My alerts'), button('glow:search', 'Find a product'), button('glow:help', 'Help')),
  ]);
}

function priceFor(product) {
  const cents = product.priceCents ?? product.price_cents;
  const amount = cents != null ? Number(cents) / 100 : Number(product.price);
  if (!Number.isFinite(amount) || (product.price == null && cents == null)) return 'Price unavailable';
  const currency = product.currency || 'AUD';
  try { return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(amount) + ` ${currency}`; }
  catch { return `${amount.toFixed(2)} ${safe(currency)}`; }
}

function timestamp(value) {
  if (value == null) return 'Not checked yet';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `<t:${Math.floor(date.valueOf() / 1000)}:f>` : 'Not checked yet';
}

function stockLabel(product) {
  const state = product.availability ?? product.stock ?? product.status;
  return ({ in_stock: 'Available to order', out_of_stock: 'Unavailable to order', available: 'Available to order', unavailable: 'Unavailable to order', preorder: 'Preorder', unknown: 'Unconfirmed' })[state] || 'Unconfirmed';
}

function sourceNotice(product) {
  if (product.paused) return '**Monitoring paused.** The status below is from the last successful check.';
  if (product.error) return '**Source needs attention.** Current availability is unconfirmed; the status below is the last successfully observed state.';
  const last = product.checkedAt ?? product.checked_at ?? product.last_success;
  if (!last) return '**Not verified yet.** Current availability is unconfirmed.';
  const age = Date.now() - new Date(last).valueOf();
  if (!Number.isFinite(age) || age > 15 * 60_000) return '**Check is stale.** Current availability is unconfirmed; the status below may have changed.';
  if (product.candidate_stock) return '**Availability change pending confirmation.** The status below is the last confirmed state.';
  return '';
}

function productCards(products = [], page = 0) {
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(products.length / perPage));
  page = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const shown = products.slice(page * perPage, (page + 1) * perPage);
  if (!shown.length) return payload([embed('No matching products yet',
    'Try a different name or ask the team to track the product in product requests. Glowbot only lists products that the team has added.')],
    [row(button('glow:search', 'Search again'), button('glow:mine', 'My alerts'))]);
  const embeds = shown.map(p => embed(cut(p.name, 200),
    `${sourceNotice(p) ? `${sourceNotice(p)}\n\n` : ''}` +
    `**${safe(p.retailer || new URL(p.url).hostname)}**\n` +
    `${p.variant ? `Shade or size: ${safe(p.variant)}\n` : ''}` +
    `${priceFor(p)} · ${stockLabel(p)}\n` +
    `Last successful check: ${timestamp(p.checkedAt ?? p.checked_at ?? p.last_success)}\n` +
    'Availability is for this exact listed product. Confirm at checkout.',
    { url: p.url }));
  const components = shown.map(p => row(button(`glow:watch:${p.id}`, cut(`Watch ${p.name}`, 70), 1), { type: 2, style: 5, label: 'Visit shop', url: p.url }));
  const navigation = [];
  if (page > 0) navigation.push(button(`glow:products:${page - 1}`, 'Previous'));
  if (page + 1 < pages) navigation.push(button(`glow:products:${page + 1}`, 'Next'));
  navigation.push(button('glow:mine', 'My alerts'));
  components.push(row(...navigation));
  embeds[0].footer = { text: `Page ${page + 1} of ${pages}` };
  return payload(embeds, components);
}

function helpPanel(config = {}) {
  return payload([embed('How Glowbot works',
    '**Browse:** Read the beauty alert channels. No commands are needed.\n\n' +
    '**Choose alerts:** Pick categories for optional direct messages. You can also watch individual products. My alerts lets you stop them.\n\n' +
    '**Find a product:** Search the tracked list by product name. Exact shades and sizes are separate watches. ' +
    `Ask for a missing product in ${channel(config, 'requests', 'product requests')}.\n\n` +
    '**What gets checked:** Selected public retailer product pages. The first successful check sets a baseline. ' +
    'An alert follows a confirmed restock or price drop. A blocked or unreadable page is marked unconfirmed.\n\n' +
    '**New arrivals:** Selected recent retailer collection feeds. The first import is silent; later newly available products are announced.\n\n' +
    '**Trends:** The trending channel is for sourced picks shared by the team. Glowbot does not invent popularity scores.\n\n' +
    '**Need help?** Use /status to check the service, or contact the team in feedback. ' +
    'Allow server direct messages if you want private alerts.',
    { footer: { text: 'Glowbot setup panel · help' } })], [row(button('glow:preferences', 'Choose alerts', 1), button('glow:search', 'Find a product'), button('glow:mine', 'My alerts'))]);
}

function rulesPanel() {
  return payload([embed('A few simple rules',
    '1. Be respectful. Beginners and experienced beauty shoppers are equally welcome.\n\n' +
    '2. Keep product requests clear. Include the shop link and exact shade or size.\n\n' +
    '3. Share genuine finds. Disclose affiliate links, sponsorships and personal connections.\n\n' +
    '4. Do not spam, impersonate retailers or share another person’s private information.\n\n' +
    '5. Check the retailer before buying. Alerts are observations at the stated time. Prices, stock and shipping can change.\n\n' +
    '6. Product discussion is personal experience, not medical advice. Ask a qualified professional about health concerns.\n\n' +
    'Report problems to the team in feedback.', { footer: { text: 'Glowbot setup panel · rules' } })]);
}

function alertPayload(event) {
  const p = event.product || event;
  const kind = event.kind ?? event.type;
    const title = kind === 'price_drop' ? 'Price drop' : ['new_product', 'new_drop'].includes(kind) ? 'New arrival available to order' : 'Available to order again';
  const old = event.previousPrice ?? event.previous_price;
  return payload([embed(`${title}: ${cut(p.name, 180)}`,
    `**${safe(p.retailer || new URL(p.url).hostname)}**\n` +
    `${p.variant ? `Shade or size: ${safe(p.variant)}\n` : ''}` +
    `${priceFor(p)}${old != null ? ` (previously ${priceFor({ price: old, currency: p.currency })})` : ''}\n` +
    `Checked: ${timestamp(event.checkedAt ?? event.checked_at ?? p.checkedAt ?? p.checked_at ?? Date.now())}\n\n` +
    'Stock and prices can change. Confirm the exact product and final price at checkout.', { url: p.url })],
    [row({ type: 2, style: 5, label: 'Visit shop', url: p.url }, button(`glow:watch:${p.id}`, 'Watch this product'), button('glow:mine', 'My alerts'))]);
}

function statusPanel(status = {}) {
  return payload([embed('Glowbot status',
    `Discord: **${status.connected === false ? 'Disconnected' : 'Connected'}**\n` +
    `Tracked products: **${status.products ?? status.productCount ?? 0}**\n` +
    `Last successful check: ${timestamp(status.lastSuccess ?? status.last_success)}\n` +
    `Sources needing attention: **${status.errors ?? status.sourceErrors ?? 0}**\n` +
    `Pending deliveries: **${status.pending ?? status.pendingDeliveries ?? 0}**\n` +
    `${status.message ? `\n${safe(status.message)}` : ''}`)]);
}

module.exports = { CATEGORIES, homePanel, publicPreferencesPanel, preferencesPanel, productCards, helpPanel, rulesPanel, alertPayload, statusPanel, priceFor, timestamp };

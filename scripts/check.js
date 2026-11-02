'use strict';
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { commands } = require('../src/commands');
const { RETAILERS } = require('../src/retailers');
const root = mkdtempSync(path.join(tmpdir(), 'glowbot-check-'));
try {
  const store = new Store(path.join(root, 'check.sqlite'));
  store.setConfig('check', { channels: {} });
  store.close();
  const definitions = commands();
  if (new Set(definitions.map(c => c.name)).size !== definitions.length) throw new Error('Duplicate slash command names');
  require('../src/app');
  console.info(`Checks passed: ${definitions.length} commands, ${RETAILERS.length} retailer adapters, writable SQLite. This does not test a live Discord connection or retailer access.`);
} finally { rmSync(root, { recursive: true, force: true }); }

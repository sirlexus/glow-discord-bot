'use strict';
require('dotenv').config({ quiet: true });
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const source = path.resolve(process.env.DATABASE_PATH || './data/glowbot.sqlite');
if (!existsSync(source)) { console.error('Database does not exist.'); process.exitCode = 1; }
else {
  const targetDir = path.resolve(process.argv[2] || path.join(path.dirname(source), 'backups'));
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const target = path.join(targetDir, `glowbot-${new Date().toISOString().replace(/[:.]/g, '')}.sqlite`);
  const db = new DatabaseSync(source);
  try { db.prepare('VACUUM INTO ?').run(target); console.info(`Backup created: ${target}`); }
  finally { db.close(); }
}

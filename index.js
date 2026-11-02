"use strict";
require('dotenv').config({ quiet: true });
require('./src/app').start().catch(error => {
  console.error(error.code === 'CONFIGURATION' ? `Glowbot configuration: ${error.message}` :
    `Glowbot could not start: ${error.code || error.name || 'startup error'}. Check the private host logs and setup guide.`);
  process.exitCode = 1;
});

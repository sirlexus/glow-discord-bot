'use strict';
const { inspectProduct } = require('../src/retailers');
const [url, variant] = process.argv.slice(2);
if (!url) { console.error('Usage: npm run inspect -- https://retailer/product [exact-variant-id-or-name]'); process.exitCode = 1; }
else inspectProduct(url, { variant }).then(p => console.info(JSON.stringify(p, null, 2))).catch(error => {
  console.error(`${error.code || 'INSPECTION_FAILED'}: ${error.name === 'RetailerError' ? error.message : 'Product inspection failed.'}`);
  process.exitCode = 1;
});

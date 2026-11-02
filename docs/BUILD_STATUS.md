# Build status, 3 November 2026

## Source and verification

Glowbot 2.0.0 was recovered from the previous workspace and published to the existing sirlexus/glow-discord-bot repository through GitHub. The deployment keeps Discord application 1360139217107157145 and server 1340570565676761121.

The live retailer check found that valid Shopify handles containing Unicode or underscores caused collection imports to fail. The parser now accepts a bounded single safe path segment, encodes it in request URLs and compares the exact decoded product identity. Path, query, fragment and malformed-encoding checks remain enforced.

Current verification: npm run check, all 91 automated tests and git diff --check passed. Fresh public Lila Beauty responses confirmed AUD currency, the full new-makeup and new-skincare collection shapes, and two exact product variants. These checks do not establish access from Render or promise full retailer coverage.

## Live activation in progress

The existing free Render web service was manually suspended before this work and remains suspended. The replacement form is configured for one Node background worker, Singapore region, a 1 GB disk mounted at /var/data and manual deployments. The owner approved US$7.25 per month for this worker and storage, subject to any applicable tax, and entered the bot token directly into the BOT_TOKEN field.

Deployment, Discord connection, server setup, a live host retailer check, private delivery and restart persistence are still pending at this checkpoint. Do not describe the bot as live until those checks pass.

## Additional work authorised

The owner requested beauty bestseller discovery and early interest tracking using only free public sources and the approved hosting budget. That extension is being developed separately from the base deployment. Retailer bestseller-list position is not a unit sales count. An item being newly observed is not evidence of a future release or a year-wide hit.

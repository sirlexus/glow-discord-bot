# Build status, 3 November 2026

## Source and verification

Glowbot 2.0.0 was recovered from the previous workspace and published to the existing sirlexus/glow-discord-bot repository through GitHub. The deployment keeps Discord application 1360139217107157145 and server 1340570565676761121.

The live retailer check found that valid Shopify handles containing Unicode or underscores caused collection imports to fail. The parser now accepts a bounded single safe path segment, encodes it in request URLs and compares the exact decoded product identity. Path, query, fragment and malformed-encoding checks remain enforced.

Current source checks include 14 commands and tests for exact Shopify identities, bounded public storefront currency metadata, persistent trend snapshots, dated reader picks, cached article evidence counts, source failures, list comparison, publication dates, delivery caps, cooldowns, retries and safe permission diagnostics. Fresh public Lila Beauty responses confirmed AUD currency, the full new-makeup and new-skincare collection shapes, and two exact product variants. These checks do not establish access from Render or promise full retailer coverage.

Final verification for this feature update: all 124 automated tests, `npm run check` and `git diff --check` passed. A separate read-only review checked source semantics, cached membership, evidence counts, private browsing and date expiry.

## Base activation verified

The existing free Render web service was manually suspended before this work and remains suspended. One replacement Node background worker in Singapore is connected to Discord, with a 1 GB disk mounted at /var/data and manual deployments. The owner approved US$7.25 per month for this worker and storage, subject to any applicable tax, and entered the replacement bot token directly into the BOT_TOKEN field.

The `/setup` preview works. Applying the layout is blocked because the bot lacks Manage Channels and Manage Roles. The preflight now reports every missing permission with a validated hardcoded message before any mutation. No permissions were granted. Existing makeup, trending beauty, general, feedback and bot command channels were mapped separately in the persistent configuration. Private message transport to the owner was verified. Product source access, ordinary member delivery and restart persistence still need their live checks. Do not treat a connected bot as proof of complete retailer coverage.

## Additional work authorised

The owner requested beauty bestseller discovery and early interest tracking using only free public sources and the approved hosting budget. The feature update adds searchable 2026 Allure reader picks, four public metadata feeds, observed retailer list movement over at least 24 hours, literal query evidence counts and private browsing controls. Initial source snapshots are silent; later automatic posts are capped at three per Melbourne calendar day with a seven day per-source-item cooldown.

W cosmetics' displayed bestseller ordering is manually featured, not a unit sales ranking. Google Trends can have no beauty topic and does not establish slow product demand. Dated publisher metadata is editorial coverage, not proof of popularity. An upcoming label requires an explicit future release or availability date with its year. There are no extra API keys, paid models or subscriptions for this update.

The feature source commit must be published and deployed before live feature checks are claimed. The launch guide describes source access, member controls, existing channel mapping, delivery and restart validation.

# Live activation record, 3 November 2026

## Deployed and verified

The rebuilt Glowbot is running as one paid Node background worker on Render in Singapore. The existing free web service remains suspended. Production has a 1 GB persistent disk mounted at /var/data and manual deployments. The owner approved US$7.25 per month for the worker and storage, subject to applicable tax. No extra paid APIs, model calls, subscriptions or credentials were added.

Deployed application source: GitHub commit 8440d58d38806b468fa4f1548001150ad561dec3. Its source tree matched the locally verified implementation before deployment. All 125 automated tests, source checks and diff checks passed. Render's production build also passed all 125 tests and registered the guild commands.

The implementation includes 14 commands, exact product and shade watches, optional private preferences, product requests, stock and price checks, selected collection discovery, durable delivery, and searchable beauty discovery.

## Server setup

The owner interface completed Welcome & Rules, Beauty Alerts, Community, Guides & Support and private Team groups. Fifteen public channel destinations are configured. Welcome, rules, preferences, help and discovery panels are installed. Alert channels and information channels deny member posting while allowing Glowbot to post. Community and command channels remain writable.

Existing channels and messages were retained. The old Labubu channel remains separate. The existing private admin log channel was moved with its original restrictions. No access to its history was added. Manager-only /requests provides the durable product request queue.

The bot still has no global Manage Channels or Manage Roles permission. Its automatic /setup apply control therefore remains unavailable; the manually completed layout and normal member controls work with its existing server permissions and limited public-channel posting exceptions.

## Discovery checks on the production host

All four configured public sources returned successful observations without source errors: W cosmetics, Cosmetics Business, Allure and Google Trends Australia. The initial cache contains 30 retailer favourites, 10 verified 2026 Allure reader picks and 12 dated editorial items. No relevant Google beauty topic was present; this is an honest empty result, not a source failure.

The first snapshots are silent. Subsequent automatic posts are capped at three per Melbourne calendar day with a seven day source-item cooldown. Retailer placement comparisons require observations at least 24 hours apart. Publisher cache hints are respected.

Live Discord checks passed for private discovery browsing, category filters, pagination and a Rare Beauty query. A live display issue where Discord hid cards sharing the same embed URL was fixed. Four reader-pick cards with the same primary source are now visibly rendered using explicit source links.

A retailer's featured list is not a sales count. Reader votes are not Australia-wide sales. Editorial coverage and Google search spikes do not establish future product demand. Upcoming labels require an explicit future announcement date. Search covers the saved public source observations, not the whole internet.

## Stock and member controls

The production host verified exact AUD observations for Missha M Perfect Cover BB Cream 50ml, No.21 Light Beige, and Dr. Jart+ Vital Hydra Solution Hydrating Lip Mask, Bubble Gum, at Lila Beauty. W cosmetics' Shiseido Fino Hair Mask 230g has two retailer variants labelled O and N. Both were individually verified and added after ambiguity was correctly rejected. The initial checks were silent baselines. Four exact variants are active.

Product search, an individual watch, My alerts, category choices and Stop all my alerts were exercised using the owner's account. A private transport test was delivered silently to the owner. Temporary preference and watch choices were cleared afterwards. No retailer event was fabricated to demonstrate delivery.

Restart checks preserved the configured channels, panel references, discovery history, existing product rows and saved preference state. The two W variants were added to the same durable store after that verification. Ordinary member desktop and mobile testing using a separate non-manager account has not been performed. Automated tests cover the manager permission boundary and private preference isolation.

Other retailer adapters and full collection imports must pass their own production checks before broader coverage is advertised. The service is a selected monitor with source timestamps and failure states, not an exhaustive market or instant stock service.

# Glowbot

A Discord beauty community with product requests, optional private alerts, exact product watches and selected new arrival feeds.

The server layout follows the useful parts of Shiny Cardboard Society: a clear welcome area, personal notification choices, separate product channels, community discussion and private team controls.

## Current delivery status

The rebuilt code includes automated tests, persistent storage, server setup and deployment configuration. **A passing test run does not establish a live Discord connection or live retailer coverage.** Production launch still requires the owner to replace the previously exposed bot token, deploy an always running service, and complete the live checks in [the launch guide](docs/LAUNCH.md).

All six adapters are tested using controlled product data. Lila Beauty's public collection feed structure was also checked in the browser on 30 October 2026 and a factual sample is included under test fixtures. Currency verification and live access from the bot host remain unverified. Retailer pages that block access or omit exact product information are rejected or marked unconfirmed.

## For a new member

1. Open `start-here` and read the basic rules.
2. Select **Choose alerts**. Pick the beauty categories you want to receive as optional direct messages.
3. Select **Find a product** to search the monitored list. Use **Watch** for an exact shade or size.
4. Use **Request a product** if your item is missing. The team verifies it before monitoring begins.
5. Open **My alerts** whenever you want to change your choices or stop all alerts.

You do not need to type a command. Public alert channels remain available to browse without subscribing to direct messages. Discord must allow direct messages from the server if you want private alerts.

## What is included

| Area | Behaviour |
| --- | --- |
| Welcome | Start guide, rules and private preference controls |
| Beauty alerts | Makeup, skincare, haircare, fragrance, sales and team sourced trends |
| Product watches | Exact product and variant, retailer, price, last successful check and shop link |
| Restock alerts | Two agreeing checks confirm a change from unavailable or preorder to available to order |
| Price alerts | A lower observed price in the same currency can produce an alert |
| New arrivals | Selected recent Shopify collection feeds, with a silent first import |
| Requests | A member submits a product link and exact shade or size for team review |
| Preferences | Saved categories and product watches; optional direct messages |
| Administration | Repeatable setup preview, product and source controls, sourced trend publishing and status |
| Reliability | SQLite persistence, delivery retries, source error backoff and checks for duplicate events |
| Privacy | No general chat message reading; `/privacy` explains stored records and can remove them |

“Available to order” describes the retailer data observed at the stated time. It does not guarantee physical shelf stock, checkout availability or delivery to your location.

## Retailer coverage

| Retailer | Individual products | Selected new arrival feeds |
| --- | --- | --- |
| Adore Beauty | Exact, unambiguous product and offer data from the page | No |
| Sephora Australia | Exact, unambiguous product and offer data from the page | No |
| MECCA | Exact, unambiguous product and offer data from the page | No |
| Lila Beauty | Exact Shopify variant | Yes |
| W cosmetics | Exact Shopify variant | Yes |
| Glam Raider | Exact Shopify variant | Yes |

These are implemented adapters, not a claim that every product at each store is currently readable. A product with several shades must resolve to one exact variant. Unreadable pages do not become false “out of stock” observations.

Collection feeds inspect up to 100 recent products per selected source. They do not cover an entire retailer catalogue. A new product must be available to order to qualify for a new arrival alert. Initial source data establishes a silent baseline, so adding a source does not announce its existing catalogue.

Trend posts use a team supplied source and explanation. Glowbot does not automatically scan TikTok, invent popularity scores or promise complete beauty market coverage.

## Team controls

The setup and catalogue controls require **Manage Server**. Ordinary members cannot add products, configure sources, apply server setup or publish team posts.

| Control | Purpose |
| --- | --- |
| `/setup` | Review the proposed channel layout without changing the server |
| `/setup apply:true` | Apply that layout and its welcome panels |
| `/product add` | Verify a real supported product link, exact variant and beauty category |
| `/product list` | Inspect monitored products, paused items and source errors |
| `/product check` | Check a product now |
| `/product pause` | Pause or resume a product |
| `/source add` | Verify and add a supported recent collection feed and category |
| `/source list` | Review source configuration and failures |
| `/source pause` | Pause or resume a source |
| `/publish` | Publish a sourced beauty trend or release |
| `/status` | Check the connection, product checks and delivery queue |
| `/retailers` | See the supported retailer adapters and their limits |

The service supports up to five configured collection sources and 1,000 monitored products. Review polling load before raising those limits. Default product checks run about every five minutes, with a scheduler cycle every minute. Restock confirmation requires two agreeing observations; confirmation, network and queue time add delay. This is not an instant notification service.

## Run and deploy

Use Node **24.22.1**, or a supported Node 24 release meeting `package.json` requirements.

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Set `BOT_TOKEN`, `GUILD_ID` and a writable persistent `DATABASE_PATH` in the deployment environment. Do not put the token into code, a commit, a Discord message or a chat.

```bash
npm start
```

The included `render.yaml` describes **one paid background worker with a persistent disk**. Review the current service and disk charge in Render before creating it. Update or replace the existing deployment carefully so two copies of the bot do not run together.

Render free web services sleep after idle periods and cannot attach persistent disks. They are not a reliable production host for this bot. See the [full launch and recovery guide](docs/LAUNCH.md) for credential replacement, installation permissions, live checks, persistence and backups.

## Limits to keep in mind

1. A retailer can block requests or change its data format. Source errors and stale observations are shown rather than guessed.
2. No purchase, checkout or stock reservation is performed. Members buy directly from the retailer.
3. Prices can change between checking and checkout. Only same currency price reductions are compared.
4. Discord retries reduce missed delivery and short term duplicate sends. Absolute exactly once delivery is not guaranteed.
5. A persistent disk is not an independent backup. Create a SQLite backup and copy it off the service regularly.
6. No backup schedule, external monitoring subscription or recurring automation has been created by this repository.

## Official references

1. [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
2. [Discord permissions](https://docs.discord.com/developers/topics/permissions)
3. [Discord OAuth2 installation](https://docs.discord.com/developers/topics/oauth2)
4. [Render background workers](https://render.com/docs/background-workers)
5. [Render persistent disks](https://render.com/docs/disks)
6. [Render free service limitations](https://render.com/docs/free)

# Glowbot launch and recovery guide

This guide separates the tested implementation from the live checks required before inviting new members.

## Existing project

| Item | Existing value |
| --- | --- |
| Repository | https://github.com/sirlexus/glow-discord-bot |
| Discord application | `1360139217107157145` |
| Glowbot server | `1340570565676761121` |
| Runtime | Node `24.22.1` |
| Production storage | `/var/data/glowbot.sqlite` on a persistent disk |
| Main secret | `BOT_TOKEN`, stored in Render environment settings |

Keep the existing application and server identity. Do not create a second bot simply to repair the old one.

## 1. Replace the exposed token

The previous repository contained a hardcoded bot token. Removing it from the current code does not revoke it or remove old commits.

The owner must complete these steps personally:

1. Open the [existing application’s Bot page](https://discord.com/developers/applications/1360139217107157145/bot) in Discord Developer Portal.
2. Use **Reset Token** and complete Discord’s authentication prompts. This revokes the old token.
3. Enter the new value directly into **BOT_TOKEN** in the intended Render service’s environment settings.
4. Remove the obsolete `TOKEN` variable after updating the deployment. If both variables exist and disagree, the rebuilt app intentionally refuses to start.
5. Never paste the replacement into GitHub, Discord, a screenshot, support logs or this chat.

Do not use the public historical token for a connectivity test. No token belongs in `index.js`, `products.json` or `render.yaml`.

## 2. Check installation permissions

Use the existing application’s installation settings with the scopes `bot` and `applications.commands`. Install to the existing Glowbot server.

The bot needs these permissions to set up channels and publish its own panels:

1. Manage Channels
2. Manage Roles, to edit channel permission overwrites during setup
3. View Channels
4. Send Messages
5. Embed Links
6. Read Message History

**Administrator is not required.** Only the Guilds gateway intent is used. Message Content Intent and Server Members Intent are not needed for this design.

Role based notification assignments are not used. Members opt into private alerts through saved preferences. Manage Roles may be removed after setup if you want to reduce ongoing permissions, but it must be restored before rerunning setup.

Check that channel specific overwrites allow the bot to send alerts and read its own welcome panels. The Team area and admin logs must remain hidden from an ordinary member.

## 3. Deploy one always running service

Review the existing Render deployment before creating anything new. If its current service type supports the required always running process and disk, update it. If moving from an old web service to the included worker configuration, stop the old bot service before starting the replacement. Two live copies can duplicate checks and sends.

The included `render.yaml` is a deployment template, not evidence that a worker has been created. It specifies a paid starter background worker, a 1 GB persistent disk at `/var/data`, one instance and manual deployments. Review the current recurring cost in Render before provisioning it.

Use:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Node version | `24.22.1` |
| Build command | `npm ci --ignore-scripts && npm run check && npm test` |
| Start command | `npm start` |
| Instances | `1` |
| `BOT_TOKEN` | Replacement token entered directly in Render |
| `GUILD_ID` | `1340570565676761121` |
| `DATABASE_PATH` | `/var/data/glowbot.sqlite` |
| `POLL_INTERVAL_SECONDS` | `60` |
| `PRODUCT_CHECK_SECONDS` | `300` |

The database path must be on the mounted disk. A local `.env` file and a file under an ephemeral deployment directory do not provide production persistence.

Render free web services spin down after idle periods and do not support persistent disks. A free database that expires is not a substitute for durable bot storage. Do not describe the bot as continuously available on that arrangement.

Keep one instance because this implementation uses a single SQLite database and one monitor loop. Do not scale it horizontally without changing the storage and work coordination design.

## 4. Review and apply the server layout

Once the new process is connected and the commands appear:

1. Run `/setup` as a server manager. Read the preview.
2. Apply the layout using its **Apply this layout** button or `/setup apply:true`.
3. Check the welcome, rules, choose alerts and how it works panels.
4. Rerun `/setup` and apply it once more. Existing channels and panels should be reused.

Setup adopts matching existing channels, including makeup drops, trending beauty, feedback, general, bot commands and private admin logs. It creates missing channels and organises them into Welcome & Rules, Beauty Alerts, Community, Guides & Support and Team.

It does not delete unrelated channels or messages. Member posting is restricted in information and alert channels. Existing staff access is preserved. Public preference panels open a personal control panel so one member’s choices do not overwrite another member’s choices.

## 5. Verify real product and feed coverage

There are six retailer adapters: Adore Beauty, Sephora Australia, MECCA, Lila Beauty, W cosmetics and Glam Raider. They have controlled fixture tests. **Live retailer access still needs to be verified on the deployed host.**

For each retailer you intend to advertise:

1. Choose a real product page and a specific shade or size.
2. Run `/product add` with its URL, category and exact variant where required.
3. Check that the returned name, retailer, variant, currency, price and ordering availability match the retailer page.
4. Run `/product check` and inspect the result.
5. Confirm a deliberate unsupported or ambiguous link is rejected rather than silently monitoring a different item.

Only claim coverage for products that pass. Do not infer that one working product means every page at that retailer is supported. A blocked page stays unconfirmed. No anti bot challenge bypass is included.

For new arrivals, `/source add` accepts a supported recent collection feed and category from Lila Beauty, W cosmetics or Glam Raider. Use `/source list` to review results and `/source pause` to stop or resume checks.

The first successful import records a silent baseline. Later newly discovered products can generate a new arrival alert when available to order. A source reads up to 100 recent products. This is not a full catalogue crawler. Up to five configured sources and 1,000 monitored products are supported by the current capacity limits.

## 6. Complete the member and delivery smoke test

Use the owner account and a second ordinary member account. The ordinary member account must not have Administrator or Manage Server.

| Check | Expected result |
| --- | --- |
| Ordinary member opens `start-here` | Clear welcome, rules, choices, product search, requests and help |
| Choose alerts | Opens private choices; another member cannot see or overwrite them |
| Find a product | Shows the exact shade or size, retailer, price and checked time |
| Watch a product | Saves that member’s watch; no other member’s preferences change |
| Request a product | Saves the request for team review; it does not immediately create a monitored product |
| My alerts | Lists saved choices and provides removal and stop controls |
| Block direct messages | Public browsing continues; failed private delivery is recorded without crashing |
| Team area | Hidden from the ordinary member |
| Setup, product, source and publish controls | Denied to the ordinary member |
| Source failure | Marks the source unconfirmed and preserves its last successful observation |
| Pause a product | Stops scheduled checks for that product; cards clearly show it is paused |
| Privacy deletion | Removes saved preferences, watches, requests and private delivery records for that member |

Test delivery mechanics in a private test channel or a separate test server with controlled data and the automated tests. **Do not fabricate a public retailer restock or price drop to demonstrate that an alert sends.**

Before calling notifications live, verify a genuine retailer response from the deployed host and an end to end test delivery. Before inviting members, verify the ordinary member experience on both desktop and mobile.

## 7. Verify restart persistence

1. Add one verified real product and save test account preferences.
2. Record the product ID and the test account’s choices.
3. Restart the production worker.
4. Confirm `/product list`, `/source list` if used, and **My alerts** retain their records.
5. Confirm the bot reconnects without sending the entire existing catalogue again.
6. Check `/status` and private deployment logs for source or delivery failures.

A rebuild or restart that loses preferences is a failed launch check. Correct the disk and database path before continuing.

## 8. Back up and restore

Run the supplied SQLite backup helper in the service environment:

```bash
node scripts/backup.js
```

By default this creates a dated snapshot in the database directory’s `backups` folder. You may supply a destination directory:

```bash
node scripts/backup.js /var/data/backups
```

The helper uses SQLite’s `VACUUM INTO` to produce a consistent snapshot. Check its success result. **Copy the resulting backup off the Render service** to a protected location you control. Another folder on the same disk is not protection from loss of that disk or service.

No recurring backup automation has been created. Choose a backup frequency based on how much preference and product history you are willing to lose, and test restoration before relying on it.

To restore:

1. Stop every process using the database.
2. Keep a copy of the current database and any `-wal` or `-shm` files for recovery.
3. Restore the selected snapshot at the configured database path. Do not leave old journal sidecar files beside a restored database.
4. Start only one worker.
5. Verify configured channels, products, sources and test preferences before resuming normal use.

Older backups can contain delivery states that differ from Discord’s actual message history. Review pending deliveries after restoration. Exactly once delivery across arbitrary restore and retry scenarios is not guaranteed.

## Operating checks and common problems

| Symptom | Check |
| --- | --- |
| Bot will not start | Correct replacement token, matching application, `GUILD_ID`, conflicting legacy `TOKEN`, runtime version and writable disk |
| Bot connects but slash commands are missing | Correct server, `applications.commands` installation scope and startup command registration result |
| Setup fails | Manage Server on the owner’s account; required bot permissions and channel overwrites |
| Product rejected | Supported HTTPS retailer, exact variant and readable structured product data |
| Old “available” state remains | Look for source failure, pause, pending confirmation or stale check notices |
| Private alerts do not arrive | Member’s categories or watches, server membership, Discord direct message setting and failed delivery count |
| Bot stops after idle time | Confirm a paid always running service rather than a free sleeping web service |
| Data disappears after restart | `DATABASE_PATH` must point to the mounted persistent disk |
| Duplicate alerts or checks | Confirm the old service is stopped and only one rebuilt process is running |

Default checks are about every five minutes per product, with a scheduler cycle every minute. Confirmed restocks require two agreeing checks. Collection scans, network delay, retailer errors and delivery retries add time. Neither instant alerts nor complete retailer coverage are promised.

## Launch decision

The bot is ready for member invitations only when the replacement credential is in place, one persistent production service is running, real advertised retailer products have passed live checks, a private end to end delivery has passed, the ordinary member experience works, and restart persistence has been verified.

Until then, describe it as a tested implementation awaiting live activation.

## Official documentation

1. [Discord interaction responses and deadlines](https://docs.discord.com/developers/interactions/receiving-and-responding)
2. [Discord bot permissions](https://docs.discord.com/developers/topics/permissions)
3. [Discord installation scopes](https://docs.discord.com/developers/topics/oauth2)
4. [Render background workers](https://render.com/docs/background-workers)
5. [Render persistent disk behaviour](https://render.com/docs/disks)
6. [Render free service limitations](https://render.com/docs/free)

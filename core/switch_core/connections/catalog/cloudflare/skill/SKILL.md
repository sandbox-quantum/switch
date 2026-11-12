---
name: cloudflare
description: How to work with Cloudflare (Workers, Pages, DNS, R2, D1, logs) through the Cloudflare connection your owner granted this agent. Load before reading, searching, creating or changing Cloudflare resources.
---

# Cloudflare

Your owner granted this agent their Cloudflare connection, for Workers, Pages, DNS, R2, D1 and logs. Its tools are on the `cloudflare` MCP server; there is nothing to set up or renew.

## What the grant reaches

- **You act as your owner.** Everything you read is what they can see in the Cloudflare dashboard, and everything you create, edit or delete shows there as done by them.
- **Read or write is your owner's choice, made when they connected.** On a read-only connection the write tools are not discoverable: tell the user you can only read, rather than looking for another way.
- **One account.** The connection is for the account the token was minted for. If a tool says it cannot see a zone or worker, the owner has not added this connection to that account — say so rather than trying another way.
- When a tool is refused, tell the user what you could not do. If Switch says the grant was removed or the connection must be reconnected, your owner has to do that.
- **Never print, log or store a credential.**

## How to work with it

- Cloudflare's own MCP tools are the way to reach everything. Start with `list_zones` (or the equivalent discovery tool) to find the zone a record or worker lives in before acting on it — names and IDs are easy to mix up across accounts.
- **DNS:** zone names are often without a trailing dot; records are looked up by zone id then record id. Confirm the zone and the record before changing one.
- **Workers and Pages:** deployments are owned by a specific account and service. A script name that exists in the dashboard may not be reachable from the granted token.
- **R2 and D1:** buckets and databases are per-account. List them before referencing one by name.
- **Logs:** logpush and logpull are different products with different retention; say which one you used and the window.
- **Production data can include personal or customer information.** Summarise rather than copying raw log lines or DNS records into rooms.
- **Confirm before deleting or closing.** Workers, Pages deployments, DNS records and R2 objects are gone when deleted; say what you are about to do and wait for confirmation unless the owner asked for it specifically.

## Limits

- No admin, org-wide or delete scopes are requested without a written reason.
- The token never reaches the coding tool, the room or the logs.
- If the owner turns the grant off, the session's access stops within a minute.

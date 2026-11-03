---
name: cloudflare
description: Inspect and manage Cloudflare resources including Workers, DNS records, KV namespaces, and zone configurations with Cloudflare MCP tools, acting with the owner's Cloudflare access.
---

# Cloudflare

The `cloudflare` MCP server gives you Cloudflare's platform tools. Use them
to inspect DNS records, check zone settings, analyze deployment telemetry,
view Worker scripts and routes, and read KV storage namespaces.

How to work with it:

- Start narrow. Specify zone IDs, record names, worker names, or specific account
  scopes rather than asking for unbounded platform listings.
- Read before modifying: inspect current DNS records or Worker deployments
  first to verify state and avoid breaking live services.
- You act as the owner of this connection, with whatever their Cloudflare permissions
  permit.
- Confirm with the user before creating, updating, or deleting DNS records,
  modifying routing rules, deploying worker scripts, or purging caches.
- Cloudflare configurations, domain routes, and DNS targets may reveal internal
  network topology or origin server IPs. Summarize information clearly, avoid
  exposing sensitive origin addresses in rooms, and never share secrets.

If a tool answers that an action is not permitted, the connection's permissions
do not cover it: inform the user rather than searching for alternative paths.

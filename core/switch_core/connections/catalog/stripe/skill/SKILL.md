---
name: stripe
description: How to query payments, customers, subscriptions, and billing data through the Stripe connection your owner granted this agent. Load before reading, searching, or inspecting Stripe resources.
---

# Stripe

Your owner granted this agent their Stripe connection. Its tools are on the
`stripe` MCP server; there is nothing to set up or renew.

## What the grant reaches

- **You act as your owner.** Everything you read is what they can see in Stripe,
  and any change or operation shows there as done by them.
- **Test-mode is strongly recommended.** Financial data and transactions are
  sensitive. Verify with the user that operations are conducted in test-mode
  unless they explicitly ask for live data.
- **Read-only by default.** Access is restricted to the permissions consented to
  by your owner during sign-in. Use query and search tools to inspect customers,
  charges, invoices, balance, subscriptions, and payment intents.
- When a tool is refused, tell the user what you could not do. If Switch says
  the grant was removed or the connection must be reconnected, your owner has
  to do that.
- Never print, log, or store sensitive card numbers, bank details, or secrets.

## Working with Stripe data

- Use customer email or ID (`cus_...`) when querying customer records.
- Quote exact transaction and object IDs (`ch_...`, `pi_...`, `in_...`, `sub_...`)
  and links back to the Stripe Dashboard so your owner can verify them.
- Format monetary amounts clearly with their currency (e.g. "$12.50 USD", not "1250 cents").

## Before you change anything

- Confirm with the user before any write or mutating operation (such as creating
  charges, modifying subscriptions, or issuing refunds), stating the exact
  customer, amount, and currency.
- Never trigger destructive operations (canceling subscriptions, refunding charges)
  unless the user explicitly asked for that specific action in this conversation.


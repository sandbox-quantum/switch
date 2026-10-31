---
name: new-relic
description: Investigate systems, incidents, and performance with New Relic through its MCP tools — NRQL queries, metrics, alerts, APM services, and entities.
---

# New Relic

The `new-relic` MCP server provides tools to query and inspect telemetry from
your connected New Relic organization. Use them to answer questions about system
behavior, performance bottlenecks, and incident root causes.

## What the grant reaches

- **You act as the owner of this connection.** The server runs queries and
  retrieves data according to your owner's user permissions in New Relic.
- **NRQL and entity exploration:** Query time-series telemetry using NRQL,
  inspect APM application states, view Golden Signals (throughput, latency, error rate),
  and check open alerts or violation incidents.
- **Never print, log, or store credentials.** Authentication is handled
  transparently by the session host.

## Tasks and tools

- **Investigate alerts & violations:** List active incident alerts, impacted
  entities, and triggered policy conditions.
- **Run NRQL queries:** Execute targeted queries against transaction events,
  errors, and metrics.
- **Entity inspection:** Retrieve health metrics and deployment markers for
  monitored services.

## Query etiquette and safety

- **Start narrow:** Specify a concrete `WHERE` clause (filtering by `appName`,
  `entityGuid`, or `transactionName`) and a bounded time range (such as `SINCE 1 hour ago`).
  Unbounded queries consume quota and return unwieldy result sets.
- **Summarize logs and traces:** Production telemetry may contain sensitive or
  customer data. Extract error messages, HTTP status codes, and latency percentiles
  rather than pasting large dumps into the room.
- **Cite evidence:** When answering incident or debugging questions, quote the
  NRQL query executed and the observed metrics (such as p95 latency or error rates)
  so team members can independently verify the findings.
- **Mutations require confirmation:** Only create, acknowledge, or resolve alerts
  or mute rules if explicitly directed by the user.

If a tool reports that MCP access is disabled, an organization administrator
must enable it under New Relic's Feature Control Manager.

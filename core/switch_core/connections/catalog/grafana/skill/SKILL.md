---
name: grafana
description: Query Grafana Cloud dashboards, panels, metrics, Prometheus data, and Loki log streams through the Grafana connection your owner granted this agent.
---

# Grafana

The `grafana` MCP server provides tools to inspect Grafana Cloud dashboards, query Prometheus
and Loki data sources, analyze telemetry metrics, and check active alerts.

## What the grant reaches

- **You act as the owner of this connection.** You can view dashboards, metrics,
  and log streams that your owner has access to in Grafana Cloud.
- **Billing notice:** Grafana Cloud MCP users count toward Grafana Assistant user
  allocations under your organization's plan.
- **Never print, log, or store credentials.** Authentication and token renewal
  are handled transparently by the session host.

## Tasks and tools

- **Dashboard inspection:** List dashboards, search by tag, and inspect panel configurations
  and PromQL/LogQL queries.
- **Metrics querying:** Execute instant and range queries against configured Prometheus
  or Mimir datasources to analyze performance and error rates.
- **Log streams:** Query Loki logs for recent incident triage and root cause investigation.
- **Alert rules:** Inspect firing alerts, alert rules, and notification policies.

## Safety and etiquette

- **Read before modifying:** Always query and review existing panel configurations
  before proposing dashboard edits.
- **Explicit confirmation for changes:** Saving dashboard changes or mutating alert rules
  affects team monitoring. Always present diffs and confirm with the user before saving.
- **No unprompted deletions:** Never delete dashboards or silence alerts without explicit
  user instruction.
- **Narrow queries by default:** Use bounded time ranges (`[5m]`, `[1h]`) and appropriate step
  intervals to avoid overloading datasources or hitting query limits.

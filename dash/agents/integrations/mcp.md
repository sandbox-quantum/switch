# MCP

Switchdash no longer ships a dedicated MCP management service or UI. MCP server
configuration is now passed through to agents as part of the agent payload, using a
small set of shared types and a static catalog.

## Main Files

- `src/shared/core/mcp/types.ts` — canonical MCP server entry types (e.g. `RawServerEntry`)
- `src/shared/core/mcp/catalog.ts` — static catalog of known MCP servers and their
  credential keys (`catalogData`)
- `src/main/core/providers/agent-payload-builder.ts` — includes MCP capability data in the
  payload handed to an agent based on provider capabilities

## Current Behavior

- MCP data is described once in `src/shared/core/mcp/` and consumed where agents are launched.
- Whether a provider receives MCP configuration is driven by that provider's capabilities
  in the agent provider registry.

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in the shared types and catalog, and adapt at the edges
- if you add provider-specific MCP behavior, gate it on provider capabilities rather than
  hardcoding provider names

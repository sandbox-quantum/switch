---
name: snowflake
description: Query data in Snowflake using Cortex Agents and SQL tools exposed on the administrator-configured MCP server.
---

# Snowflake

The `snowflake` connector defines integration with a Snowflake account through
a Snowflake-managed Model Context Protocol (MCP) server.

## Connection Availability

Under Switch's security architecture, credentials that do not expire or that
remain valid for long durations are never handed to an agent process. Because
Snowflake programmatic credentials (PATs) can live for up to a year and cannot
be narrowed or revoked per agent by Switch, this connector remains cataloged but
deliberately unavailable (`key_never_expires`) in Switch Console. Agents
cannot currently receive grants or make direct calls through this connector
in v1. A future Core-mediated service execution architecture will allow Switch
to query Snowflake tools on behalf of agents without exposing credentials to
the session host.

## Working with Snowflake MCP Tools

When Snowflake tools are exposed by an administrator-created MCP server:

- **Prefer Cortex Agents**: If the MCP server provides Cortex Agent tools, use
  them to orchestrate structured and unstructured data queries across Cortex
  Analyst (semantic models) and Cortex Search.
- **Discover Schema First**: Before constructing queries, discover available
  databases, schemas, tables, and views to ensure queries target valid
  objects and avoid unnecessary errors.
- **Read-Before-Write**: Always read and verify existing records before proposing
  or applying any updates.
- **Safe Defaults**:
  - Request confirmation from the user before executing any data manipulation
    (DML) or schema definition (DDL) statements.
  - Never execute destructive statements (such as `DROP`, `TRUNCATE`, or
    unfiltered `DELETE`) unless explicitly instructed by the user in the
    current conversation.
  - Limit `SELECT` queries to relevant columns and rows using appropriate
    `WHERE` and `LIMIT` clauses to avoid excessive compute consumption.

## Access Boundaries and Permissions

Tools pass through directly from the administrator-configured MCP server.
What can be queried or modified is governed entirely by the role assigned to
the underlying credential in Snowflake and the tools configured on the MCP
server object. If the role or tool set permits writes or DDL, the connector
is write-capable; the skill itself cannot enforce read-only restrictions.
Never use `ACCOUNTADMIN` or excessive privileges; administrators should assign
a least-privileged custom role scoped strictly to the required database objects.

---
name: supabase
description: How to query databases, read schemas, and manage table records in Supabase projects through the Supabase connection.
---

# Supabase

Your owner granted this agent access to their Supabase connection. Its tools are
provided on the `supabase` MCP server. Use them to inspect database schemas, run
queries, and view or manage table records.

## Read-before-write practices

- **Inspect schemas first**: Always inspect table schemas, column data types, and
  foreign key constraints before executing queries. Understanding table structure
  prevents errors and ensures query accuracy.
- **Read-only by default**: Default access is read-only. Always start by inspecting
  schema definitions and reading existing rows before planning any modifications.

## User confirmation for mutations

- **Require explicit user confirmation**: You must obtain explicit user confirmation
  before executing any insert, update, or delete operations. Clearly describe the
  target table, the affected columns, and the exact records to be added, modified,
  or removed.
- **Constrain updates and deletes**: Always include precise filter conditions (such
  as primary key IDs) to avoid modifying unintended records. Never run unconstrained
  mutations.

## Credential and data hygiene

- **Never expose credentials**: Maintain strict hygiene for all sensitive information.
  Never print, output, quote, or display connection strings, secrets, or authentication
  credentials in chat messages, responses, or logs.
- **Protect sensitive data**: Production database tables may contain customer or
  private information. Summarize query results rather than outputting large dumps of
  raw data into chat threads.
- **Graceful refusal**: If an operation is refused or fails, explain the failure
  clearly to the user without attempting unsanctioned workarounds.

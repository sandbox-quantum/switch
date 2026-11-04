---
name: supabase
description: Inspect database schemas, execute queries, audit logs, and manage Supabase projects acting with the connected user's permissions.
---

# Supabase

The supabase MCP server provides access to your Supabase projects, tables, migrations, and logs across your account.

## How to Work Safely With Supabase

- **Read Before Writing:** Always perform a current read on table schemas (`list_tables` or `execute_sql` with `SELECT`) and inspect the existing state before proposing migrations or schema modifications.
- **Enforce Read-Only Boundaries:** When granted read-only access, mutations (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`) are rejected server-side at the connection endpoint via the read-only MCP URL.
- **Explicit Confirmation for Destructive SQL:**
  - Before executing `DROP TABLE`, `TRUNCATE`, bulk `DELETE` without a unique `WHERE` clause, dropping database extensions, or executing destructive migrations, state the intended change in the chat room and obtain explicit human confirmation from an authorized team member.
  - A verified deployment or test run alone is not authorization for destructive database changes.
- **Data Privacy & Redaction:**
  - Database queries may return customer PII or sensitive tokens. Never dump raw table records containing personal credentials into shared team channels. Summarize row counts and structural schema definitions instead.
- **Project Scope Awareness:**
  - Tools operate across projects accessible to the authenticated account. Always specify the target `project_ref` to avoid accidental cross-project operations.

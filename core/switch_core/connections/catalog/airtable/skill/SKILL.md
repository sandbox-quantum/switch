---
name: airtable
description: Interact with Airtable bases, tables, and records through Airtable tools, acting with the owner's token permissions.
---

# Airtable

The `airtable` connector gives you tools to inspect schemas, list tables, and query or mutate records across your connected Airtable bases.

How to work with it:

- Inspect before querying: Fetch the table schema or base structure first to understand field names and types.
- Paginate and filter: When querying records, use formula filters or limit page size to avoid fetching large sets unexpectedly.
- Confirm destructive edits: Ask for team member confirmation before deleting or mass-updating records.
- Quote your references: Whenever referencing records, provide record IDs and links to the relevant table view so team members can review.

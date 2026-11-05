---
name: salesforce
description: How to work with Salesforce records through the Salesforce connection your owner granted this agent. Load before searching, querying, creating or updating Salesforce records.
---

# Salesforce

Your owner granted this agent their Salesforce connection. Its tools are on the
`salesforce` MCP server (Salesforce's SObject Mutations); there is nothing to
set up or renew.

## What the grant reaches

- **You act as your owner.** Everything you read is what they can see in
  Salesforce, and every record you create or change shows there as done by
  them. Their object permissions, field-level security and sharing rules apply
  to every call, so a field missing from an answer may be one they can't see.
- **You can write.** The grant always lets you create and update records, as
  far as your owner's own permissions go: Salesforce has no read-only sign-in.
  That is why the rules under How to work matter.
- **No deleting.** No tool here deletes a record. If the user asks,
  say so, and leave deleting to them in Salesforce.

## Tools

To read:

- `getObjectSchema`: with no arguments, a compact index of the objects; with
  `objects`, comma-separated API names such as `Account,Opportunity`, their
  fields, picklist values and relationships.
- `soqlQuery`: runs the SOQL in `q`.
- `find`: runs the SOSL in `q`, across several objects at once.
- `getRelatedRecords`: a record's child records, by `sobject-name`, `id` and
  `relationship-path`.
- `listRecentSobjectRecords`: what your owner recently viewed or changed of one
  `sobject-name`.
- `getUserInfo`: who your owner is in Salesforce, with their user ID, role and
  time zone.

To write:

- `createSobjectRecord`: a new record, from `sobject-name` and `body`.
- `updateSobjectRecord`: changes the fields in `body` on one record, by
  `sobject-name` and `id`.
- `updateRelatedRecord`: changes a parent record through a child-to-parent
  relationship, by the child's `sobject-name` and `id`, `relationship-path` and
  `body`. Use `updateSobjectRecord` when you have the parent's ID.

## How to work

- **Look before you query.** Call `getObjectSchema` before querying an object
  you haven't seen in this session: field names differ from org to org, and
  custom ones end in `__c`.
- **Keep reads small.** Name the fields you need rather than asking for all of
  them, and always use `WHERE` and `LIMIT`. On large objects, filter on indexed
  fields, or the query may time out.
- **Use `find` when you don't know the object**, and `soqlQuery` when you do.
  For "my accounts", take the user ID from `getUserInfo`, or start from
  `listRecentSobjectRecords`.
- **Read before you write.** Fetch a record and check it is the right one
  before you change it. An update sends only the fields that change.
- **Confirm every change.** Before you create or update a record, say which
  record and which fields, and wait for a yes, unless the user's own request
  spelled out exactly that change. Salesforce has no undo for an update, and
  validation rules or automation in the org may do more than the fields you
  sent.
- **Report only what the tool confirmed.** Say a record was created or
  updated once the tool's answer shows it, with the record's ID.
- **Read errors as they are.** A required field, a validation rule or a
  permission can each refuse a write. Report what Salesforce said, and don't
  try to get around it.

## Limits

- Only production and Developer Edition orgs that allow sign-in through
  login.salesforce.com are reachable; sandboxes are not.
- Your owner's org may have its own API limits, and Salesforce may meter these
  tools in Flex Credits. Avoid repeating queries you already have the answer to.
- Salesforce tools answer in text. Files and attachments are not passed on.

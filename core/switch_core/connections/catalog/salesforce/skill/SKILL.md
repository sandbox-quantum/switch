---
name: salesforce
description: Read, query, search, create, and update Salesforce CRM records.
---

# Salesforce Connector

This skill enables agents to inspect CRM schemas, run SOQL queries, execute SOSL text searches, and create or update records in Salesforce via the Salesforce Hosted MCP server (`platform/sobject-mutations`).

All actions execute within the permissions, field-level security (FLS), and sharing rules of the connecting Salesforce user.

## Available Tools

The `platform/sobject-mutations` server exposes the following tools:

- `getObjectSchema`: Inspects Salesforce schema definitions.
  - Without arguments: returns a concise index of queryable standard and custom objects.
  - With an object name (e.g. `Account`, `Contact`, `Lead`, `Opportunity`): returns detailed field metadata, field types, picklist values, and relationships.
- `soqlQuery`: Executes a SOQL query against Salesforce to retrieve records.
- `find`: Performs a SOSL text search across searchable fields (e.g. name, email, phone) across multiple objects.
- `createSobjectRecord`: Creates a new record for a standard or custom object with specified field-value pairs. Returns the created record ID on success.
- `updateSobjectRecord`: Modifies specified fields on an existing record identified by its record ID. Unmentioned fields remain unchanged.
- `updateRelatedRecord`: Updates related child records through relationship paths.

> **Note on Deletions**: Deleting records is not supported by this server. Permanent deletions are deliberately omitted to safeguard customer data.

## Best Practices and Rules

1. **Schema Discovery First**:
   - Always inspect object schemas using `getObjectSchema` before composing queries or creating/updating records.
   - Do not guess custom field names or API names (e.g. verify whether a field is standard like `Industry` or custom with `__c`).

2. **Bounded and Specific Queries**:
   - Always select specific fields required for the task.
   - Always include a `LIMIT` clause in SOQL queries to prevent excessively large result sets.
   - Use `find` when searching for terms across multiple record types or when the exact record location is unknown.

3. **Verify Before Mutation**:
   - Before updating any record with `updateSobjectRecord`, read the existing record first using `soqlQuery` to verify its current state and field values.
   - Only supply fields that need to be changed; do not overwrite unchanged fields.

4. **Explicit User Intent and Confirmation**:
   - Require clear user instruction before creating or modifying records.
   - Summarize the intended changes (record type, record ID, and fields being updated) before initiating the mutation.

5. **Tool Response Verification**:
   - Never assume or report that a creation or update succeeded without confirming a successful tool execution response.
   - If a validation rule, required field constraint, or permission error is returned, report the exact error message clearly to the user.


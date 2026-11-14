---
name: snowflake
description: Query and work with Snowflake data through the MCP server a Snowflake administrator set up - SQL, Cortex Analyst, Cortex Search and Cortex agents - acting with the owner's Snowflake role.
---

# Snowflake

The `snowflake` MCP server gives you the tools a Snowflake administrator put
on it: often a SQL execution tool, and sometimes Cortex Analyst (questions in
plain language over a semantic view), Cortex Search, a Cortex agent or custom
functions. List the tools first; each server has its own.

How to work with it:

- Read before you write. Look at a table's columns and a few rows (`DESCRIBE
  TABLE`, `SELECT ... LIMIT 10`) before querying it in earnest, and always
  put a `LIMIT` on exploratory queries: a warehouse bills by the second.
- You act with the owner's Snowflake role. If it lets you change data,
  change it only when you were asked to, and say what you changed. Before
  `DELETE`, `TRUNCATE`, `DROP`, `ALTER` or `UPDATE` without a narrow `WHERE`,
  say exactly what will happen and wait for a yes.
- Quote what you found: the SQL you ran, and the database, schema and table,
  so a person can check it.
- Data can include personal or customer information. Summarise rather than
  copying many raw rows into rooms.

If a tool answers that an object "does not exist or not authorized", the
role cannot see it: say so, rather than trying other names. If it answers
"Insufficient privileges", the role may not do that; a Snowflake
administrator grants it. "Access denied for trial accounts" means the SQL
tool does not run on a Snowflake trial.

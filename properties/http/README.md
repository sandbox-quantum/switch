# HTTP properties

The gateway, fuzzed from its OpenAPI schema by [Schemathesis](https://schemathesis.readthedocs.io).
`core/tests/switch_core/properties/test_http_surface.py` serves the real gateway
app (the role matrix's, whose stand-ins answer 418 where a route reaches a
platform or a vendor) over HTTP, as the database role row-level security applies
to, and runs the Schemathesis CLI twice: as an admin of a second workspace, so it
has objects, then as an admin of the first, whose path and query parameters that
look like ids (`id`, `*_id`) are often ids of the second's objects (`hooks.py`).

```bash
just properties-http                      # 25 examples a route; two runs of ten minutes at most
SCHEMATHESIS_EXAMPLES=100 SCHEMATHESIS_MAX_SECONDS=1200 just properties-http
```

The time budget is for each of the two runs. Each run's whole output is kept in
`build/properties/http` (the workflow uploads it), and a run that was refused with
401 on most requests fails, because it lost its session and tested little.

It needs Docker and runs nightly (`properties-scheduled.yml`), not on a pull
request. The checks are `not_a_server_error` (`api.no-5xx`),
`response_schema_conformance`, and `no_foreign_ids`
(`tenancy.no-cross-tenant-ids`): no response to the first workspace names a UUID
of the second that the request did not itself name.

## The baseline

`baseline.json` lists the failures accepted for now, each a route and a kind of
failure. A failure not in it fails the run; a listed one that no longer happens
is reported as unobserved and can be pruned. To record what a run found:

```bash
SCHEMATHESIS_BASELINE_UPDATE=1 just properties-http
```

Never record a `no_foreign_ids` failure: that is a leak. What is in it is, in
the main, routes that answer 500 on input they should refuse, cloud-agent routes
that answer 503 on a server without them, and error bodies (mostly 422) whose
shape is not the one the schema documents.

## What it leaves out

- Routes that would end the session it asks as (`ENDS_THE_SESSION` in the test).
- A NUL in a string: many routes answer 500 on one, so every run would be that
  one bug on route after route. Remove `--generation-allow-x00 false` once fixed.
- Ids in request bodies; only path and query parameters carry the other
  workspace's ids so far.

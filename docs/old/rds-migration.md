# Moving Postgres to RDS

Status: **proposal**. Nothing here has been applied. The instance does not
exist; the cutover has not been rehearsed. Everything in §7 is for a human with
cluster and account credentials to run, and each step is meant to be read
before it is run rather than pasted.

Context: multi-tenancy Phase 0 (CHOO-2622), from the design spike's §6. The
argument for doing it first is short — an in-namespace Postgres on a
PersistentVolumeClaim is fine for a pilot, customer data needs provable backups
and point-in-time recovery, and migrating a database with live tenants on it is
much worse than migrating one now.

## 1. What Switch asks of the database

Read this before choosing an instance shape; two of these have bitten people.

- **PostgreSQL 16.** What the chart runs today (`postgres:16-alpine`), so the
  migration is homogeneous, same major version. Match it on RDS and the whole
  question of dump compatibility disappears.
- **No extensions.** No migration issues `CREATE EXTENSION`, so nothing has to
  be on the RDS allowlist and nothing needs a superuser to install.
- **`LISTEN` / `NOTIFY` — load-bearing.** Message delivery is a trigger on
  `messages` calling `pg_notify`, and one long-lived connection holding a
  `LISTEN` (`switch_core/db/notify_ddl.py`, `switch_core/messages/notify.py`).
  This is core Postgres and works on RDS. It does **not** survive a transaction
  pooler — see §4, which is the one thing in this document that can silently
  break the product.
- **Attachments live in the database.** `media_blobs.data` is a `bytea` column,
  so uploads count against storage and against backup size. Size the volume
  against attachment traffic, not against row counts.
- **Two databases on one instance.** The chart provisions `switch` and
  `mattermost` on the same server. Both move together, or the Mattermost bridge
  loses its state.
- **Two roles, not one.** Row-level security is inert against the role that
  owns the tables it protects — Postgres exempts a table's owner from its own
  policies — so the connection switch-core serves requests as must be a
  separate, unprivileged role from whatever ran the migrations. The RDS master
  user stays the schema owner; it is never the runtime connection. See §7 step
  2 for the exact role to create, and note that `BYPASSRLS` is deliberately
  never granted to it — that would be the same exemption as ownership, by a
  different door.
- **Connections are sized against agents, not people.** Each switch-core
  replica opens up to `db_pool_size + db_max_overflow` (30 + 10 today), plus
  one unpooled connection for the listener. Bearer-token auth hits the database
  on every authenticated request and every agent connection beats every 2s, so
  the pool is a function of fleet size. RDS derives `max_connections` from
  instance memory by default — check the resolved value against
  `replicas × 41 + Mattermost's pool + headroom` rather than assuming.

## 2. Instance shape

Proposed, not decided — the numbers are for whoever provisions it to argue
with:

| Setting | Proposed | Why |
|---|---|---|
| Engine | PostgreSQL 16.x | Same major version as today; homogeneous migration. |
| Multi-AZ | Yes | The failover is the reason to be on RDS at all. Costs a second instance. |
| Backup retention | 7 days minimum | Point-in-time recovery is the stated Phase 0 goal; 1 day is not "provable backups". |
| Storage | gp3, autoscaling on | Attachments are in the database, so growth is not flat. |
| Storage encryption | Yes | Cannot be turned on later without a snapshot-restore dance. |
| Public accessibility | No | Reachable from the cluster's VPC only. |
| Deletion protection | Yes | |
| `rds.force_ssl` | 1 (the default on 15+) | Makes the TLS work in §5 mandatory rather than optional. |
| Parameter group | Custom, not default | You will need one eventually; making it at creation avoids a reboot later. |
| Minor version upgrades | Auto, in a chosen window | Each one is a brief outage — see §6. |

`max_connections` and `effective_cache_size` are the two parameters worth
setting deliberately rather than inheriting; the connection maths is in §1.

## 3. What is already in place, and what is missing

The chart can already point at an external database:
`postgresql.mode: existing` skips the StatefulSet and connects to
`postgresql.external.{host,port,username,database}`, with the password from a
Secret (`existingSecret` supports external-secrets). `sslMode` is plumbed
through to both switch-core and Mattermost.

What was missing was a certificate authority. A verifying TLS mode had no way
to be told which one to trust, so `verify-ca` and `verify-full` fell back to
the system trust store and could not validate an RDS certificate at all. Both
halves of that are now closed:

- `DB_SSL_ROOT_CERT` takes a PEM bundle, and the connection is built from an
  SSL context rather than a bare mode string. A path that is not a readable
  file, or a bundle set alongside a non-verifying mode, is refused at startup
  rather than discovered on the first connection.
- `postgresql.caBundle` in the chart carries the bundle — inline, or the name
  of a ConfigMap you already have — and mounts it into everything that connects:
  switch-core, the migration Job and Mattermost. A verifying `sslMode` with no
  bundle, or a bundle with a mode that would ignore it, fails at template time
  rather than rolling out pods that cannot connect.

## 4. Do not put a transaction pooler in front of it

The obvious next thought after "RDS" is "RDS Proxy". Do not, without reading
this first.

- **RDS Proxy.** Listening on a notification channel is one of the documented
  conditions that *pins* a PostgreSQL connection: the client keeps that backend
  until the session ends and no other client can reuse it. AWS also documents
  that session pinning filters are not supported for PostgreSQL, so there is no
  way to opt out. A pinned listener is not a disaster — it is one permanently
  pinned backend — but the proxy buys nothing for it, and the pinning metric
  will look alarming to whoever finds it later.
- **pgbouncer in transaction mode.** `LISTEN` is marked *never* supported under
  transaction pooling. `NOTIFY` works, so the failure is asymmetric and quiet:
  messages are written and announced, and nothing is listening. Rooms simply go
  slow, then stop delivering. Session pooling is fine.

If connection count becomes the problem, the honest fix is the application's
pool size, not a pooler.

Nothing enforces this today — it is a note, and notes are forgotten. A
follow-up should make the constraint impossible to miss from the outside, in
whatever provisions the database.

## 5. TLS

RDS publishes a global CA bundle covering every commercial region:

```
https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

The current default authority is `rds-ca-rsa2048-g1`. Register the root only —
AWS is explicit that intermediates should not be added to a trust store. Server
certificates are rotated by RDS on their own schedule and do not need the
bundle re-downloaded.

In a deployment that is `postgresql.sslMode: verify-full` plus
`postgresql.caBundle`; outside one, the same two settings are `DB_SSL_MODE` and
`DB_SSL_ROOT_CERT`.

**`verify-full` checks the hostname**, and the certificate carries the RDS
endpoint DNS name. Connect to `<instance>.<id>.<region>.rds.amazonaws.com`, not
to a friendlier CNAME of our own — an alias fails hostname verification. If a
stable internal name is wanted, that is an argument for `verify-ca`, and it is
a real downgrade: the certificate is proven to be issued by AWS, not to be this
database's.

## 6. The listener and failover

A Multi-AZ failover moves a DNS record and every existing connection has to be
re-established; AWS quotes 60–120 seconds. A minor-version patch takes the
instance offline briefly for the same effect. So the listener's connection will
drop, in normal operation, on a schedule someone else chooses.

This is already handled, and worth stating so nobody "fixes" it: the listener
treats a reconnect as *everything may have moved* and wakes every subscriber,
which read from their own cursors. Announcements missed while disconnected are
lost and do not need replaying — the worst a lost announcement costs is a
delayed read that the next one triggers anyway. What a failover does cost is
up to two minutes of delivery latency, which should be expected rather than
investigated.

Two related points for whoever watches this:

- `pool_pre_ping` is on, so pooled connections recover on their own after a
  failover rather than serving one error each.
- The notification queue is bounded (8 GB) and fills only if a listener sits in
  a long transaction. Ours does not, but a queue-full alarm is cheap.

## 7. Cutover

For a database of this size with an agreed downtime window, `pg_dump` /
`pg_restore` is both the simplest path and the one AWS recommends for a
homogeneous, whole-database migration. Logical replication (self-managed
publisher → RDS subscriber) is supported and is the fallback if the window
turns out to be unacceptable — it does not carry DDL, so it trades a shorter
outage for a fiddlier cutover. The usual reason to fear it does not apply here:
the schema has no sequences at all, every id being generated by the application,
so there is nothing to reset behind a replicated cutover.

**Before the window**

1. Provision the instance (§2) and confirm it is reachable from the cluster and
   from nowhere else.
2. Create the `switch` and `mattermost` databases and the application role. The
   RDS master user is not a superuser, and `pg_dumpall` needs privileges it does
   not have — so recreate roles by hand rather than restoring a globals dump.

   The role Switch serves traffic as is a plain login with nothing beyond
   what it needs to read and write rows — no `SUPERUSER`, no `CREATEDB`, no
   `CREATEROLE`, and deliberately no `BYPASSRLS`, which would exempt it from
   row-level security exactly the way owning the tables would:

   ```sql
   CREATE ROLE switch_app LOGIN PASSWORD '<generate one>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   ```

   That is the only manual step in the database. Nothing here grants
   `switch_app` anything on `switch` or `mattermost` — switch-core does that
   itself at boot, from the owner connection (the RDS master user, over
   `DB_OWNER_USER` / `DB_OWNER_PASSWORD`), immediately after running Alembic.
   The master user stays the schema owner throughout; it is configured as the
   owner connection, never as `DB_USER`, so it is never the connection every
   request is served over.

   Both halves go into the chart values together:

   ```yaml
   postgresql:
     mode: existing
     external:
       username: switch_app        # DB_USER — the restricted runtime role
     owner:
       username: <the master user> # DB_OWNER_USER — migrations and grants
   secrets:
     postgresPassword: <switch_app's password>
     dbOwnerPassword: <the master password>
   ```

   Note `secrets.postgresPassword` is the *runtime* role's password here, not
   the master's: in existing mode it is whatever `external.username`
   authenticates with. Setting one half without the other renders fine and
   will not necessarily fail on the deploy that introduces it —

   - **`external.username` moved, `owner.username` left empty.** switch-core
     has no owner to migrate as, so it migrates as the restricted role. With
     nothing pending that is a no-op and the deployment comes up clean; the
     next release carrying a migration dies at boot. Mattermost breaks
     immediately, though, because in existing mode it follows
     `external.username` unless an owner is configured, and the restricted
     role has no rights in the `mattermost` database.
   - **`owner.username` set, `external.username` left at the master user.**
     switch-core refuses to serve: the runtime connection owns the tables its
     own policies protect, so the policies are inert against it and tenants
     are not isolated.

   An instance that is already on RDS needs the same two values and the same
   `CREATE ROLE`; only the dump and restore below are specific to the move.

3. Download the CA bundle and put it in `postgresql.caBundle` — as
   `existingConfigMap` if it is synced in from elsewhere, otherwise inline.
4. **Rehearse the whole thing** against a scratch database, and time it. The
   number you get is the downtime estimate; the one you guess is not.
5. Announce the window.

**In the window**

6. Scale switch-core to zero. Writes must stop before the dump starts — a dump
   taken from a live database is consistent but stale by the time it lands, and
   the difference is lost messages.
7. `pg_dump -Fc` each database, then restore with

   ```
   pg_restore -j 4 --no-owner --no-privileges --exit-on-error -d switch switch.dump
   ```

   All three flags earn their place. Without the first two the restore tries to
   `ALTER ... OWNER TO` the source's owner and every such statement fails,
   because the RDS master user is not a superuser and cannot grant away
   ownership it does not hold. Without `--exit-on-error` those failures are
   *reported and ignored*: the tables and rows arrive, the summary says "errors
   ignored on restore: N" among the output, and it is entirely possible to read
   past it. The exit code is 1 either way, so trust the exit code over the
   screen.
8. Verify before switching anything, on both sides: row counts per table,
   number of indexes, foreign keys and triggers, the `alembic_version` row, and
   that the notify function and its trigger are there
   (`\df switch_notify_message`, `\dS+ messages`). The trigger is what delivery
   depends on and it is exactly what a restore with the wrong flags drops.
9. Point the chart at RDS (`postgresql.mode: existing`, `external.host`,
   `sslMode`, the CA bundle) and deploy. Leave the old StatefulSet and its PVC
   in place — that is the rollback.
10. Scale back up. Watch that migrations report clean, that agents reconnect,
    and then send a real message in a real room and confirm it arrives. Delivery
    is the one thing unit tests here cannot prove for you: it needs the trigger,
    the listener and TLS all working at once.

**Rollback**: revert the chart to `mode: managed` and redeploy. The old volume
still holds the data as of the dump, so the loss is whatever was written to RDS
after the switch — which is why step 10 comes before announcing success.

**After**

11. Keep the old PVC for an agreed period, then delete it deliberately.
12. Confirm a point-in-time restore actually works, on a throwaway instance. An
    untested backup is a belief, not a backup, and proving it is the reason for
    the whole exercise.

## 8. What has been rehearsed, and what has not

The cutover was walked through locally before any of it was proposed for real:
two throwaway Postgres 16 containers, one standing in for the current
in-cluster database and one for RDS — TLS on, and owned by a role with
`CREATEDB`/`CREATEROLE` but deliberately **not** superuser, which is the shape
of the RDS master user. A migrated schema with 500 messages and a binary blob
was dumped from the first and restored into the second.

Confirmed:

- The restore carries everything that matters — 39 tables, 68 indexes, 63
  foreign keys, the notify function and its trigger, the `alembic_version` row,
  and a `bytea` blob byte-identical by checksum.
- The ownership failure in step 7 is real: a restore without `--no-owner
  --no-privileges` fails 40 statements as a non-superuser, and reports them as
  ignored. With the flags it is clean.
- `verify-full` connects against a server whose certificate is signed by the
  supplied bundle, and refuses one signed by an unrelated CA.
- **The hostname trap is real.** With a certificate naming only the server's
  own hostname, connecting by any other name fails with `Hostname mismatch`
  under `verify-full` and succeeds under `verify-ca`. That is exactly the
  choice §5 describes, so make it deliberately.
- Delivery survives the move: with the app connecting over `verify-full` to the
  restored database, an insert into `messages` reached a live `LISTEN`
  subscriber. Trigger, listener and TLS working together, which is the thing
  worth proving.
- Alembic connects over `verify-full` too — a separate code path from the
  application engine, and the one the migration Job uses.
- A `DB_SSL_ROOT_CERT` pointing nowhere is refused at startup, by name.

Not covered, and only an instance can settle it: RDS Proxy pinning, failover
behaviour, `rds.force_ssl`, and how long the dump and restore actually take at
production size. Step 4 is still required.

## 9. Open questions

- Which environments move, and in what order? Doing the lowest-traffic one
  first is how the runbook gets debugged cheaply.
- Multi-AZ everywhere, or only where downtime is contractual? It roughly
  doubles the instance cost.
- Does the demo environment share an instance with anything else, or stay
  separate as the deployment discussion assumed?
- Who owns the maintenance window, and does anyone need telling before a minor
  version upgrade takes delivery down for a minute?

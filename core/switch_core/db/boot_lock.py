"""A Postgres session-level advisory lock around boot-time schema work.

Two replicas of switch-core starting at once is not a hypothetical: it is what
a rolling deploy or a crash-restart racing a fresh pod produces routinely, and
two things `main()` does at boot are only safe run by one replica at a time
across the whole deployment:

- `alembic upgrade head`, plus the runtime role's grant re-issue that runs
  immediately after it (`main._prepare_database`). Two replicas applying the
  same migration concurrently contend on the same catalogue rows Postgres
  itself locks for DDL — the usual outcome is a deadlock or a "duplicate
  object" error, not a race either side quietly wins — and the grant re-issue
  right after it touches `pg_default_acl`, which two `ALTER DEFAULT
  PRIVILEGES` statements running at once contend on the same way.
- The deployment-wide seeding in `run()` (the admin user and the
  agent-registration bootstrap key). Unlike the migration, this is not one
  transaction: `_seed_agent_registration_bootstrap_key` reads its own state,
  decides what to do, and writes it back across several separate sessions, so
  a transaction-scoped lock cannot cover it — two replicas mid-seed can each
  read "no bootstrap key yet" and both insert one, colliding on the unique
  `key_hash` at best and duplicating a key that is supposed to be one per
  deployment at worst.

Postgres's advisory locks exist for exactly this shape of problem: a lock with
no table or row behind it, held for as long as an application decides rather
than for one transaction. `pg_advisory_lock` is the session-level form —
acquired and released explicitly (or implicitly when the session ends) by
whichever database session took it, independent of whatever transactions come
and go on that session in between. That is also why `boot_lock` opens a
connection of its own on `NullPool` rather than borrowing one from a pool: a
pooled connection can be checked back in — and handed to a different caller —
before the code between acquire and release has finished, at which point the
lock is still held, but by a connection nothing here controls any more, and it
would not be released until the pool happened to recycle that connection.

`pg_advisory_lock` takes a single 64-bit signed key, and every advisory lock
in a database shares one flat namespace — there is no per-caller or per-module
subspace to register into, and the session-level and transaction-level forms
share it too, so `pg_advisory_xact_lock` is not a separate space to hide in.
Coordination is therefore entirely by convention: every caller has to agree
out of band on which integers are taken.

Switch has one other advisory lock, and it is worth naming rather than
assuming away: `db/stores/message_store.py` serialises a room's message
sequence with `pg_advisory_xact_lock(hashtext(room_id))`. It cannot collide
with `BOOT_LOCK_KEY`, and the reason is arithmetic rather than luck —
`hashtext` returns `integer`, so every key that lock can ever take lies in the
signed 32-bit range, and `BOOT_LOCK_KEY` is deliberately chosen far outside
it. Keeping the two apart by *domain* rather than by a list of taken values is
what makes this survive a room id nobody has seen yet. A future third use
should either pick another constant outside the 32-bit range and say so here,
or accept that it is sharing a space with every room in the deployment.

One more property matters for where this sits in the boot sequence:
`pg_advisory_lock` lives in `pg_catalog`, not in `public`. A `REVOKE ALL ON
SCHEMA public FROM PUBLIC` — tightening what the runtime role can do in the
application schema — has no bearing on whether it may call a `pg_catalog`
function, so the lock is available on the runtime connection precisely when
`DB_OWNER_USER` is unset and that connection is boot's only option (see
`SwitchConfig.owner_database_url`).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.config import SwitchConfig

# The one key this module uses. Advisory locks share a single namespace per
# database, so the exact value carries no meaning of its own — it only has to
# be fixed, and outside the signed 32-bit range every `hashtext`-derived room
# lock lives in (see the module docstring). Generated once as a random 63-bit
# value and hardcoded rather than derived at call time, so a reader can see at
# a glance that it never changes between boots or between replicas, which is
# the one property that matters for two replicas to contend on the same lock
# at all.
#
# `test_main.py` pins the 32-bit separation, so changing this value to
# something that could collide fails a test rather than going unnoticed.
BOOT_LOCK_KEY = 4_127_659_302_481_907_553


@asynccontextmanager
async def boot_lock(config: SwitchConfig) -> AsyncIterator[None]:
    """Hold Switch's one boot-time advisory lock for the duration of the block.

    Connects as the schema owner where one is configured
    (`config.owner_database_url`) and as the runtime role otherwise — the same
    rule `migrations/env.py` applies to the migration connection itself, and
    for the same reason: on a fresh deployment the runtime role may not exist
    yet, so the owner is the only connection guaranteed to be there, and where
    neither role is distinguished (a developer's scratch database) the runtime
    connection is both.

    Uses `config.db_connect_args` rather than the application engine's
    `app_connect_args` — the same choice `main._prepare_database` and
    `migrations/env.py` make — because this connection carries no request
    traffic and the idle-in-transaction timeout that only applies to the
    application engine would be actively wrong here: the lock is meant to be
    held across slow, multi-statement boot work, not torn down because it sat
    idle between two of its steps.

    A dedicated `NullPool` engine, opened and disposed around the lock rather
    than reused: an advisory lock belongs to the session that took it, and the
    only way to guarantee this code — not a pool, not a future checkout of the
    same connection — controls when it is released is to own that connection
    outright for exactly as long as the lock is held.

    `isolation_level="AUTOCOMMIT"` so `pg_advisory_lock`/`pg_advisory_unlock`
    each take effect immediately as their own statement, rather than SQLAlchemy
    auto-beginning a transaction on the first `execute` and leaving it open,
    uncommitted, for however long the guarded block takes to run. The lock
    itself does not need a transaction — it is a property of the session, not
    of any transaction on it — so there is nothing to commit and no reason to
    hold one open around boot work that can take a while.
    """
    url = config.owner_database_url or config.database_url
    engine = create_async_engine(
        url,
        poolclass=NullPool,
        connect_args=config.db_connect_args,
        isolation_level="AUTOCOMMIT",
    )
    try:
        async with engine.connect() as connection:
            await connection.execute(
                text("SELECT pg_advisory_lock(:key)"), {"key": BOOT_LOCK_KEY}
            )
            try:
                yield
            finally:
                await connection.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": BOOT_LOCK_KEY}
                )
    finally:
        await engine.dispose()

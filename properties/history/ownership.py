"""Who runs each piece of run-once work, and who holds each connection, now,
for the replica fault scenarios.

    DB_HOST=localhost DB_PORT=... DB_OWNER_USER=... DB_OWNER_PASSWORD=... DB_NAME=... \
        uv run --project core python properties/history/ownership.py --kind bridge

prints one JSON object:

* `holders`: every `ownership_leases` row of the kind, as its key, the process
  named as holder (or null once let go), the row's claim token, whether that
  holder's process lease holds by the database's clock, as the claim in
  `OwnershipStore` reads it, and the process that should own the key among
  the live ones (`ownership.owner_of`), which the work settles on.
* `agent_connections`: every agent connection still open by its row, as its
  id, its agent, the process holding it, its incarnation, and whether that
  process's lease holds.
* `controllers`: every controller with a connection, as its id, the
  connection, the process holding it, and whether that process's lease holds.
* `processes`: every process lease, as its id and whether it holds.
* `timers`: the product's own timers, in seconds, that a scenario's waits are
  derived from: how long a process lease holds unrenewed (`lease_ttl`), how
  often every process balances (`balance_interval`), how often a process
  renews (`renew_every`), how often a process checks the leases of the
  connections held elsewhere (`watch_seconds`), how often every signal family
  re-checks what the process holds (`recheck_seconds`), how often a client
  that reads rooms looks for rows it was not woken for (`room_recheck`), how long a held row
  lasts when no signal could reach it (`cache_ttl`, the default of
  `AGENT_AUTH_CACHE_TTL_SECONDS`, which the lane does not set), and how often a
  listening connection proves itself alive (`listener_heartbeat`) and waits
  before its first reconnect (`reconnect_backoff`). A scenario reads them here
  rather than restating them, so a change to a timer moves its waits with it.

Connects as the schema owner, as `delivery.py` does: the rows are not
tenant-scoped.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

import asyncpg

from switch_core.bridges.agent.protocol.connection_rows import WATCH_SECONDS
from switch_core.config import SwitchConfig
from switch_core.messages import notify
from switch_core.ownership import BALANCE_INTERVAL_SECONDS, owner_of
from switch_core.process_lease import LEASE_TTL, RENEW_EVERY_SECONDS
from switch_core.signals import (
    HEARTBEAT_SECONDS,
    RECHECK_SECONDS,
    RECONNECT_BACKOFF_BASE,
)
from switch_core.transport import postgres as transport


async def read(connection: asyncpg.Connection, kind: str) -> dict[str, object]:
    ttl = LEASE_TTL.total_seconds()
    held = (
        "p.id IS NOT NULL AND p.stopped_at IS NULL "
        "AND p.beat_at > now() - make_interval(secs => $1)"
    )
    holders = await connection.fetch(
        f"""
        SELECT o.key, o.process_id, o.token, ({held}) AS live
        FROM ownership_leases o
        LEFT JOIN switch_core_processes p ON p.id = o.process_id
        WHERE o.kind = $2
        ORDER BY o.key
        """,
        ttl,
        kind,
    )
    agent_connections = await connection.fetch(
        f"""
        SELECT c.id, c.agent_id, c.process_id, c.incarnation, ({held}) AS live
        FROM agent_connections c
        LEFT JOIN switch_core_processes p ON p.id = c.process_id
        WHERE c.closed_at IS NULL
        ORDER BY c.id
        """,
        ttl,
    )
    controllers = await connection.fetch(
        f"""
        SELECT c.id, c.connection_id, c.connection_process_id AS process_id,
            ({held}) AS live
        FROM agent_controllers c
        LEFT JOIN switch_core_processes p ON p.id = c.connection_process_id
        WHERE c.connection_id IS NOT NULL
        ORDER BY c.id
        """,
        ttl,
    )
    processes = await connection.fetch(
        f"""
        SELECT p.id, ({held}) AS live
        FROM switch_core_processes p
        ORDER BY p.id
        """,
        ttl,
    )
    live = [row["id"] for row in processes if row["live"]]
    return {
        "holders": [
            {
                "key": row["key"],
                "process_id": row["process_id"],
                "token": row["token"],
                "live": bool(row["live"]),
                "owner": owner_of(kind, row["key"], live),
            }
            for row in holders
        ],
        "agent_connections": [
            {
                "id": row["id"],
                "agent_id": row["agent_id"],
                "process_id": row["process_id"],
                "incarnation": row["incarnation"],
                "live": bool(row["live"]),
            }
            for row in agent_connections
        ],
        "controllers": [
            {
                "id": row["id"],
                "connection_id": row["connection_id"],
                "process_id": row["process_id"],
                "live": bool(row["live"]),
            }
            for row in controllers
        ],
        "processes": [
            {"id": row["id"], "live": bool(row["live"])} for row in processes
        ],
        "timers": {
            "lease_ttl": ttl,
            "balance_interval": BALANCE_INTERVAL_SECONDS,
            "renew_every": RENEW_EVERY_SECONDS,
            "watch_seconds": WATCH_SECONDS,
            "recheck_seconds": RECHECK_SECONDS,
            "room_recheck": transport.RECHECK_SECONDS,
            "cache_ttl": SwitchConfig.model_fields[
                "agent_auth_cache_ttl_seconds"
            ].default,
            "listener_heartbeat": max(HEARTBEAT_SECONDS, notify.HEARTBEAT_SECONDS),
            "reconnect_backoff": max(
                RECONNECT_BACKOFF_BASE, notify.RECONNECT_BACKOFF_BASE
            ),
        },
    }


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True, help="the kind of work, e.g. bridge")
    args = parser.parse_args(argv)
    names = ("DB_HOST", "DB_PORT", "DB_OWNER_USER", "DB_OWNER_PASSWORD", "DB_NAME")
    missing = [name for name in names if name not in os.environ]
    if missing:
        print(f"ownership: {', '.join(missing)} not set", file=sys.stderr)
        return 2
    connection = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        user=os.environ["DB_OWNER_USER"],
        password=os.environ["DB_OWNER_PASSWORD"],
        database=os.environ["DB_NAME"],
    )
    try:
        print(json.dumps(await read(connection, args.kind)))
    finally:
        await connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))

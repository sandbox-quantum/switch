"""Who runs each piece of run-once work now, for the replica fault scenarios.

    DB_HOST=localhost DB_PORT=... DB_OWNER_USER=... DB_OWNER_PASSWORD=... DB_NAME=... \
        uv run --project core python properties/history/ownership.py --kind bridge

prints one JSON object:

* `holders`: every `ownership_leases` row of the kind, as its key, the process
  named as holder (or null once let go), the row's claim token, and whether
  that holder's process lease holds by the database's clock, as the claim in
  `OwnershipStore` reads it.
* `processes`: every process lease, as its id and whether it holds.
* `timers`: the product's own timers, in seconds, that a scenario's waits are
  derived from: how long a process lease holds unrenewed (`lease_ttl`), how
  often every process balances (`balance_interval`), and how often a process
  renews (`renew_every`). A scenario reads them here rather than restating
  them, so a change to a timer moves its waits with it.

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

from switch_core.ownership import BALANCE_INTERVAL_SECONDS
from switch_core.process_lease import LEASE_TTL, RENEW_EVERY_SECONDS


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
    processes = await connection.fetch(
        f"""
        SELECT p.id, ({held}) AS live
        FROM switch_core_processes p
        ORDER BY p.id
        """,
        ttl,
    )
    return {
        "holders": [
            {
                "key": row["key"],
                "process_id": row["process_id"],
                "token": row["token"],
                "live": bool(row["live"]),
            }
            for row in holders
        ],
        "processes": [
            {"id": row["id"], "live": bool(row["live"])} for row in processes
        ],
        "timers": {
            "lease_ttl": ttl,
            "balance_interval": BALANCE_INTERVAL_SECONDS,
            "renew_every": RENEW_EVERY_SECONDS,
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

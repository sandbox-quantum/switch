"""Cut one replica's listening connection, for the bus fault scenarios.

    DB_HOST=localhost DB_PORT=... DB_OWNER_USER=... DB_OWNER_PASSWORD=... DB_NAME=... \
        uv run --project core python properties/history/listeners.py \
        --replica 1 --role signals --window 12

Every connection names its process and what it is for (`db.engine
.connection_name`), so `replica-1-<suffix> signals` is replica 1's signal bus
and nothing else. This waits for that connection's next heartbeat, then ends
its backend with `pg_terminate_backend`, and ends every backend under the name
again each `--every` seconds until `--window` has passed: a listener that
reconnects inside the window is cut again, so the replica hears nothing sent
while the window lasts, apart from what a reconnect's own resync reads.

Cutting just after a heartbeat is the case a listener is slowest to notice by
heartbeat alone: its next proof that the connection is alive is a whole
heartbeat away. Postgres says when the connection last did anything
(`state_change`), and a held listener does nothing but its heartbeat.

Prints two JSON lines: one as soon as the first cut is made, with when
(`first_cut_at`, epoch milliseconds), so a scenario can act while the replica
is deaf; and one once the window has passed and the listener is back, with
every cut, as when it was made and the backends it ended, and when a
connection under the name was seen again after the last cut (`back_at`, or
null if none was within `BACK_WITHIN_SECONDS`).
Fails if no connection with the name is found before the first cut, since a
cut that ends nothing tests nothing.

Connects as the schema owner, as `delivery.py` does: ending another role's
backend takes a superuser or membership of that role.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import asyncpg

from switch_core.signals import HEARTBEAT_SECONDS

# How soon after a heartbeat the first cut is made.
JUST_AFTER_SECONDS = 1.0

# How long to wait for the listener to come back once the cuts stop: past the
# reconnect backoff's cap, so a listener that waits the cap is still seen.
BACK_WITHIN_SECONDS = 30.0


def pattern(replica: int, role: str) -> str:
    return f"replica-{replica}-% {role}"


async def wait_for_heartbeat(connection: asyncpg.Connection, name: str) -> None:
    """Return just after the named connection's heartbeat, or fail once two
    heartbeats pass without one."""
    deadline = time.monotonic() + 2 * HEARTBEAT_SECONDS + 5
    while time.monotonic() < deadline:
        since = await connection.fetchval(
            """
            SELECT min(extract(epoch FROM now() - state_change))
            FROM pg_stat_activity
            WHERE application_name LIKE $1
            """,
            name,
        )
        if since is not None and since < JUST_AFTER_SECONDS:
            return
        await asyncio.sleep(0.1)
    raise SystemExit(
        f"listeners: no connection named {name!r} did anything in two heartbeats"
    )


async def wait_until_back(connection: asyncpg.Connection, name: str) -> int | None:
    deadline = time.monotonic() + BACK_WITHIN_SECONDS
    while time.monotonic() < deadline:
        if await connection.fetchval(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE $1",
            name,
        ):
            return round(time.time() * 1000)
        await asyncio.sleep(0.1)
    return None


async def cut(connection: asyncpg.Connection, name: str) -> list[int]:
    rows = await connection.fetch(
        """
        SELECT pid FROM pg_stat_activity
        WHERE application_name LIKE $1 AND pg_terminate_backend(pid)
        """,
        name,
    )
    return [row["pid"] for row in rows]


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replica", type=int, required=True, choices=(1, 2))
    parser.add_argument(
        "--role",
        required=True,
        help="what the connection is for, as main names it: signals, messages, ...",
    )
    parser.add_argument(
        "--window", type=float, required=True, help="seconds to keep cutting"
    )
    parser.add_argument(
        "--every", type=float, default=0.25, help="seconds between cuts"
    )
    args = parser.parse_args(argv)
    names = ("DB_HOST", "DB_PORT", "DB_OWNER_USER", "DB_OWNER_PASSWORD", "DB_NAME")
    missing = [name for name in names if name not in os.environ]
    if missing:
        print(f"listeners: {', '.join(missing)} not set", file=sys.stderr)
        return 2
    connection = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        user=os.environ["DB_OWNER_USER"],
        password=os.environ["DB_OWNER_PASSWORD"],
        database=os.environ["DB_NAME"],
    )
    name = pattern(args.replica, args.role)
    try:
        await wait_for_heartbeat(connection, name)
        first_cut_at = time.time()
        first = await cut(connection, name)
        if not first:
            raise SystemExit(f"listeners: no connection named {name!r} to cut")
        print(json.dumps({"first_cut_at": round(first_cut_at * 1000)}), flush=True)
        cuts = [{"at": round(first_cut_at * 1000), "pids": first}]
        until = time.monotonic() + args.window
        while time.monotonic() < until:
            await asyncio.sleep(args.every)
            ended = await cut(connection, name)
            if ended:
                cuts.append({"at": round(time.time() * 1000), "pids": ended})
        back_at = await wait_until_back(connection, name)
    finally:
        await connection.close()
    print(json.dumps({"cuts": cuts, "back_at": back_at}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))

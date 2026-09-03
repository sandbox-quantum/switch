"""Check that the recorded messages agree with what the message bus holds.

Every message is written to Postgres alongside the send, but the write happens
after delivery and cannot fail it — so a database problem leaves a row missing
for a message that really was sent. This walks a room's history on the bus,
compares it against the recorded rows, and reports the difference.

Run it against a real deployment before moving any read path onto those rows.
Unit tests cannot answer this question: the thing being checked is whether two
records of the same live traffic agree.

Only the window in which recording was active is compared — from the oldest
recorded message in each room, or from `--since`. Messages older than that are
legitimately absent and are not reported as drift.

Exits non-zero when any room disagrees, so it can gate a deployment.

Usage:
    just reconcile-messages
    just reconcile-messages --room <switch-room-uuid>
    just reconcile-messages --since 2026-09-01T00:00:00+00:00
    just reconcile-messages --verbose
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime

from sqlalchemy import select

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.messages import RoomReconciliation, reconcile_room
from switch_core.transport.matrix import MatrixTransport

# The admin client is a member of every room by design, which is what makes it
# the one identity that can read every room's history.
READER_CLIENT_TYPE = "admin"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--room",
        help="A single Switch room id. Defaults to every non-archived room.",
    )
    parser.add_argument(
        "--since",
        help=(
            "ISO-8601 instant to compare from, overriding the per-room "
            "recorded-from cutoff. Anything older is not reported as missing."
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="List every differing event rather than only the counts.",
    )
    return parser.parse_args()


def _report(reconciliation: RoomReconciliation, *, verbose: bool) -> None:
    print(reconciliation.summary())
    if reconciliation.ignored_by_type:
        counts = ", ".join(
            f"{name}={count}"
            for name, count in sorted(reconciliation.ignored_by_type.items())
        )
        print(f"    not sends, so not compared: {counts}")
    if not verbose:
        return
    for event_id in reconciliation.missing_rows:
        print(f"    missing row: {event_id}")
    for event_id in reconciliation.unsent_rows:
        print(f"    recorded but not on the bus: {event_id}")
    for mismatch in reconciliation.mismatches:
        print(f"    {mismatch.describe()}")


async def _run(args: argparse.Namespace) -> int:
    since = datetime.fromisoformat(args.since) if args.since else None

    config = SwitchConfig()
    engine = create_engine_from_config(config)
    session_factory = create_session_factory(engine)

    async with session_factory() as session:
        readers = await ClientStore().get_by_type(session, READER_CLIENT_TYPE)
        if not readers:
            print(
                f"No {READER_CLIENT_TYPE} client exists, so no identity can read "
                "every room. Start switch-core once to provision it.",
                file=sys.stderr,
            )
            return 2
        reader = readers[0]
        query = select(Room).where(Room.archived_at.is_(None))
        if args.room:
            query = query.where(Room.id == args.room)
        rooms = list((await session.execute(query)).scalars().all())

    if not rooms:
        print("No rooms to check.", file=sys.stderr)
        return 2

    transport = MatrixTransport(
        server_url=config.matrix_server,
        user_id=reader.matrix_user_id,
        password=reader.password,
        device_id=reader.device_id,
        access_token=reader.access_token,
    )
    await transport.connect()
    joined = set(await transport.joined_rooms())

    drifted = 0
    unreadable: list[str] = []
    try:
        for room in rooms:
            if room.matrix_room_id not in joined:
                # Reporting a room nobody can read as clean would be the worst
                # possible answer, so it is named and counted as a failure.
                unreadable.append(f"{room.name} ({room.matrix_room_id})")
                continue
            async with session_factory() as session:
                reconciliation = await reconcile_room(
                    transport, session, room, since=since
                )
            _report(reconciliation, verbose=args.verbose)
            if not reconciliation.clean:
                drifted += 1
    finally:
        await transport.close()
        await engine.dispose()

    if unreadable:
        print(
            f"\n{len(unreadable)} room(s) the {READER_CLIENT_TYPE} client is not "
            "in, so they were not checked:",
            file=sys.stderr,
        )
        for where in unreadable:
            print(f"    {where}", file=sys.stderr)

    print(f"\n{len(rooms) - len(unreadable)} room(s) checked, {drifted} with drift.")
    return 1 if (drifted or unreadable) else 0


def main() -> int:
    return asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())

"""Reconstruct room history from the message bus into the message log.

Rows exist from the moment the recorder was deployed. Everything older is on
the homeserver and nowhere else, which stopped being harmless when the read
path moved to Postgres: those messages are now invisible to every agent rather
than merely unqueried.

This walks each room to its start and writes the messages that have no row.
Reconstructed rows are numbered below zero, so they order correctly against
the live log without disturbing it, and no delivery cursor moves — nobody is
sent last March's messages tonight.

Safe to re-run. `transport_event_id` is unique and each page commits on its
own, so a walk that fails halfway leaves what it finished and picks up from
there.

Run it against a real deployment. Start with `--dry-run` on one room.

Usage:
    just backfill-messages --dry-run
    just backfill-messages --room <switch-room-uuid>
    just backfill-messages

In a deployment it is the same command inside the image:
    python -m switch_core.cli.backfill --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages import backfill_room
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
        "--dry-run",
        action="store_true",
        help=(
            "Read the history and report what would be written, without "
            "writing it. Start here."
        ),
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help=(
            "Treat 'nothing to walk' as success. For unattended runs — a "
            "first boot has no admin client and no rooms yet, and a stack "
            "that refuses to start over an empty database is worse than one "
            "with nothing to backfill."
        ),
    )
    return parser.parse_args()


class _ReadOnlyStore(MessageStore):
    """Counts what a real run would write, and writes nothing.

    A dry run has to walk exactly as far as a real one and make exactly the
    same decisions, so it shares everything but the insert.
    """

    async def create_historical(self, session, message, attachments):  # type: ignore[no-untyped-def]
        return message


async def _run(args: argparse.Namespace) -> int:
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
            return 0 if args.allow_empty else 2
        reader = readers[0]
        query = select(Room).where(Room.archived_at.is_(None))
        if args.room:
            query = query.where(Room.id == args.room)
        rooms = list((await session.execute(query)).scalars().all())

    if not rooms:
        print("No rooms to backfill.", file=sys.stderr)
        return 0 if args.allow_empty else 2

    transport = MatrixTransport(
        server_url=config.matrix_server,
        user_id=reader.matrix_user_id,
        password=reader.password,
        device_id=reader.device_id,
        access_token=reader.access_token,
    )
    await transport.connect()
    joined = set(await transport.joined_rooms())

    store: MessageStore = _ReadOnlyStore() if args.dry_run else MessageStore()
    written = 0
    incomplete = 0
    unreadable: list[str] = []
    try:
        for room in rooms:
            if room.matrix_room_id not in joined:
                # A room nobody can read is not a room with no history, and
                # reporting it as done would be the one answer that misleads.
                unreadable.append(f"{room.name} ({room.matrix_room_id})")
                continue
            report = await backfill_room(transport, session_factory, room, store=store)
            print(report.summary())
            written += report.written
            incomplete += 1 if report.incomplete else 0
    finally:
        await transport.close()
        await engine.dispose()

    if unreadable:
        print(
            f"\n{len(unreadable)} room(s) the {READER_CLIENT_TYPE} client is not "
            "in, so they were not backfilled:",
            file=sys.stderr,
        )
        for where in unreadable:
            print(f"    {where}", file=sys.stderr)

    verb = "would be written" if args.dry_run else "written"
    print(
        f"\n{len(rooms) - len(unreadable)} room(s) walked, {written} message(s) {verb}."
    )
    if incomplete:
        print(
            f"{incomplete} room(s) hit the page limit and are only partially "
            "reconstructed. Re-run to continue.",
            file=sys.stderr,
        )
    return 1 if (unreadable or incomplete) else 0


def main() -> int:
    return asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())

"""Recover recent room history from Slack instead of the message bus.

The bus backfill reads the homeserver, which is both hard on it and impossible
once it is gone. For a bridged room Slack holds the same conversation and holds
it first, so the history can come from there with the homeserver untouched.

Only Slack bridges are covered, deliberately: they are where the history worth
keeping is, and a room bridged to nothing was never on a platform to read back.

Rows are numbered below zero exactly as the bus backfill numbers them, so
nothing is redelivered and no cursor moves. Messages the bridge relayed keep
the event id Switch already gave them.

Safe to re-run: an id is either already recorded or it is not, and the check
happens per message.

Usage:
    just slack-backfill --dry-run
    just slack-backfill --bridge <bridge-uuid> --room <switch-room-uuid>
    just slack-backfill

In a deployment it is the same command inside the image:
    python -m switch_core.cli.slack_backfill --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from slack_sdk.web.async_client import AsyncWebClient
from sqlalchemy import select

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import CollaborationBridge, Room
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages.slack_backfill import (
    MESSAGES_PER_ROOM,
    backfill_channel,
    load_sender_directory,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", help="One Slack bridge id. Defaults to all active.")
    parser.add_argument("--room", help="One Switch room id. Defaults to every room.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read Slack and report what would be written, without writing it.",
    )
    parser.add_argument(
        "--messages-per-room",
        type=int,
        default=MESSAGES_PER_ROOM,
        metavar="N",
        help=(
            "How many of a room's messages to recover, newest first "
            f"(default {MESSAGES_PER_ROOM}). Thread replies count towards it."
        ),
    )
    return parser.parse_args()


class _ReadOnlyStore(MessageStore):
    """Reads exactly as far as a real run and writes nothing."""

    async def create_historical(self, session, message, attachments):  # type: ignore[no-untyped-def]
        return message


async def _run(args: argparse.Namespace) -> int:
    config = SwitchConfig()
    engine = create_engine_from_config(config)
    session_factory = create_session_factory(engine)
    store: MessageStore = _ReadOnlyStore() if args.dry_run else MessageStore()

    async with session_factory() as session:
        query = select(CollaborationBridge).where(CollaborationBridge.type == "slack")
        if args.bridge:
            query = query.where(CollaborationBridge.id == args.bridge)
        else:
            query = query.where(CollaborationBridge.status == "active")
        bridges = list((await session.execute(query)).scalars().all())

    if not bridges:
        print("No active Slack bridge to read from.", file=sys.stderr)
        return 2

    written = 0
    skipped: list[str] = []
    try:
        for bridge in bridges:
            token = (bridge.connection_config or {}).get("bot_token")
            if not token:
                skipped.append(f"{bridge.display_name}: no bot token")
                continue
            slack = AsyncWebClient(token=token)

            async with session_factory() as session:
                senders = await load_sender_directory(session, bridge.id)
                rooms_query = (
                    select(Room)
                    .where(Room.bridge_id == bridge.id)
                    .where(Room.archived_at.is_(None))
                    .where(Room.external_channel_id.is_not(None))
                )
                if args.room:
                    rooms_query = rooms_query.where(Room.id == args.room)
                rooms = list((await session.execute(rooms_query)).scalars().all())

            print(f"\n{bridge.display_name}: {len(rooms)} room(s)")
            for room in rooms:
                report = await backfill_channel(
                    slack,
                    session_factory,
                    room,
                    bridge_id=bridge.id,
                    store=store,
                    senders=senders,
                    messages_per_room=args.messages_per_room,
                )
                print(f"  {report.summary()}")
                written += report.written
                if report.error:
                    skipped.append(f"{report.room_name}: {report.error}")
    finally:
        await engine.dispose()

    verb = "would be written" if args.dry_run else "written"
    print(f"\n{written} message(s) {verb}.")
    if skipped:
        print(f"\n{len(skipped)} channel(s) skipped:", file=sys.stderr)
        for line in skipped:
            print(f"    {line}", file=sys.stderr)
    return 1 if skipped else 0


def main() -> int:
    return asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())

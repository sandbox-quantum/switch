"""Reconstructs a bridged room's recent history from Slack.

The other backfill walks the message bus. That was the only source while Matrix
held the history, and it is the wrong source now: it reads the homeserver hard
enough to hurt it, and after the deletion there is no homeserver to read at all.

Slack has the same conversation, and for a bridged room it is the *original* —
the bus only ever carried a copy of it. So for the rooms that matter most, the
history can be recovered from the platform it came from, with the homeserver
left out of it entirely.

**It keeps the ids Switch already minted.** `bridge_message_map` records the
Slack `ts` against the event id for everything the bridge ever relayed, so a
message recovered this way is written under the id it originally had rather
than a new one. A thread root still resolves, and anything referring to it
still points at the right row. Only messages from before the channel was
bridged need an id of their own, and theirs is derived from the channel and the
`ts` so a second run recognises its own work.

**Recent, not complete.** A room carries `MESSAGES_PER_ROOM` messages by
default, newest first. What an agent reads is the recent conversation; the
value of the twelve-hundredth message back does not justify the requests it
costs, and a job that finishes is worth more than one that is exhaustive.

Thread replies count towards that limit and are fetched for the roots in range,
because a Switch room's conversation happens in threads: fifty channel-level
messages would be fifty thread openings and none of the discussion under them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from switch_core.db.models import BridgeMessageMap, Client, ExternalUser, Message

if TYPE_CHECKING:
    from slack_sdk.web.async_client import AsyncWebClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.models import Room
    from switch_core.db.stores.message_store import MessageStore

logger = logging.getLogger(__name__)

# One page of Slack history. Slack allows up to 999; 200 is what a Tier 3 app
# returns comfortably and keeps a single response small enough to hold.
PAGE_SIZE = 200

# How much of a channel's past is worth recovering, newest first. Deliberately
# its own number rather than the bus backfill's: that one is bounded by what a
# homeserver will tolerate being asked, this one by what an agent will ever
# read. Raise it with `--messages-per-room`.
MESSAGES_PER_ROOM = 50

# A stop for a channel that keeps handing out pages. Only reached if the limit
# never is, which means a channel of nothing but events the log does not keep.
MAX_PAGES = 20


@dataclass
class SlackBackfillReport:
    room_id: str
    channel_id: str
    room_name: str
    api_calls: int = 0
    seen: int = 0
    written: int = 0
    already_present: int = 0
    kept_original_id: int = 0
    unmapped_sender: int = 0
    error: str | None = None

    def summary(self) -> str:
        if self.error:
            return f"{self.room_name} ({self.channel_id}): SKIPPED — {self.error}"
        line = (
            f"{self.room_name} ({self.channel_id}): {self.written} written, "
            f"{self.already_present} already recorded, {self.seen} seen "
            f"in {self.api_calls} API call(s)"
        )
        if self.kept_original_id:
            line += f"; {self.kept_original_id} kept their original event id"
        if self.unmapped_sender:
            line += f"; {self.unmapped_sender} from senders Switch does not know"
        return line


@dataclass
class SenderDirectory:
    """Slack user id → the Switch identity that speaks for them.

    Built once per bridge. A user who has never spoken through Switch has no
    puppet, and rather than create one for a message from last year the row
    records the Slack id and whatever name Slack gives it — the log is a record
    of what was said, and a sender it cannot name is still worth keeping.
    """

    by_slack_id: dict[str, tuple[str, str]] = field(default_factory=dict)

    def resolve(self, slack_user_id: str, fallback_name: str) -> tuple[str, str, bool]:
        known = self.by_slack_id.get(slack_user_id)
        if known is not None:
            return known[0], known[1], True
        return f"slack:{slack_user_id}", fallback_name or slack_user_id, False


async def load_sender_directory(
    session: AsyncSession, bridge_id: str
) -> SenderDirectory:
    rows = (
        await session.execute(
            select(
                ExternalUser.external_user_id,
                Client.matrix_user_id,
                Client.display_name,
            )
            .join(Client, Client.id == ExternalUser.client_id)
            .where(ExternalUser.bridge_id == bridge_id)
        )
    ).all()
    return SenderDirectory(
        by_slack_id={r[0]: (r[1], r[2]) for r in rows},
    )


async def load_event_ids(
    session: AsyncSession, bridge_id: str, channel_id: str
) -> dict[str, str]:
    """Slack `ts` → the event id Switch gave it, for this channel.

    `external_post_id` is `channel:ts`, which is how the adapter writes it when
    it relays a message, so the map is already keyed the way this needs it.
    """
    rows = (
        await session.execute(
            select(BridgeMessageMap.external_post_id, BridgeMessageMap.matrix_event_id)
            .where(BridgeMessageMap.bridge_id == bridge_id)
            .where(BridgeMessageMap.external_post_id.like(f"{channel_id}:%"))
        )
    ).all()
    return {post_id.split(":", 1)[1]: event_id for post_id, event_id in rows}


def _event_id_for(channel_id: str, ts: str, known: dict[str, str]) -> tuple[str, bool]:
    """The id this message should be written under.

    The one Switch already gave it if the bridge relayed it, so the row lands
    where anything pointing at it expects. Otherwise one derived from the
    channel and the `ts` — deterministic, so re-running recognises its own rows
    through the unique constraint rather than writing them twice.
    """
    existing = known.get(ts)
    if existing is not None:
        return existing, True
    return f"sw_slack_{channel_id}_{ts.replace('.', '')}", False


def _is_worth_keeping(raw: dict[str, Any]) -> bool:
    """Whether a Slack history entry belongs in the log.

    Joins, channel topics and the rest of Slack's housekeeping carry a
    `subtype`; a message someone typed does not. Slack's own tombstones for
    deleted messages are excluded for the same reason the bus walk excludes a
    leave: the log records what was said.
    """
    if raw.get("subtype") in {None, "thread_broadcast", "file_share"}:
        return bool(raw.get("text") or raw.get("files"))
    return False


async def backfill_channel(
    slack: AsyncWebClient,
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    *,
    bridge_id: str,
    store: MessageStore,
    senders: SenderDirectory,
    messages_per_room: int = MESSAGES_PER_ROOM,
) -> SlackBackfillReport:
    """Recover one channel's recent history into the message log."""
    channel_id = room.external_channel_id or ""
    report = SlackBackfillReport(
        room_id=room.id, channel_id=channel_id, room_name=room.name
    )

    try:
        candidates = await _collect(slack, channel_id, messages_per_room, report)
    except Exception as error:  # noqa: BLE001 — one channel must not stop the rest
        report.error = str(error)
        logger.warning("Slack history unavailable for %s: %s", channel_id, error)
        return report

    async with session_factory() as session:
        known = await load_event_ids(session, bridge_id, channel_id)

    # Newest first, so the newest reconstructed message takes -1 and the walk
    # runs the same direction as the bus backfill's.
    for raw in candidates[:messages_per_room]:
        await _write(
            raw, session_factory, room, channel_id, known, store, senders, report
        )
    return report


async def _collect(
    slack: AsyncWebClient,
    channel_id: str,
    limit: int,
    report: SlackBackfillReport,
) -> list[dict[str, Any]]:
    """The newest `limit` messages in a channel, thread replies included.

    Roots are read first because Slack only returns those from `history`, then
    each root that has replies is expanded. The merged list is sorted by `ts`
    so "newest" means newest in the room rather than newest at channel level —
    a thread answered this morning under a root from last week belongs near the
    top, and ordering by root would bury it.
    """
    roots: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        page = await slack.conversations_history(
            channel=channel_id, limit=PAGE_SIZE, cursor=cursor
        )
        report.api_calls += 1
        page_messages: list[dict[str, Any]] = list(page.get("messages", []))
        roots.extend(m for m in page_messages if _is_worth_keeping(m))
        cursor = (page.get("response_metadata") or {}).get("next_cursor") or None
        if len(roots) >= limit or not cursor:
            break

    collected = list(roots)
    for root in roots[:limit]:
        if not root.get("reply_count"):
            continue
        replies = await slack.conversations_replies(
            channel=channel_id, ts=root["ts"], limit=PAGE_SIZE
        )
        report.api_calls += 1
        reply_messages: list[dict[str, Any]] = list(replies.get("messages", []))
        collected.extend(
            m
            for m in reply_messages
            if m.get("ts") != root.get("ts") and _is_worth_keeping(m)
        )

    collected.sort(key=lambda m: float(m.get("ts", 0)), reverse=True)
    return collected


async def _write(
    raw: dict[str, Any],
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    channel_id: str,
    known: dict[str, str],
    store: MessageStore,
    senders: SenderDirectory,
    report: SlackBackfillReport,
) -> None:
    ts = str(raw.get("ts", ""))
    if not ts:
        return
    report.seen += 1
    event_id, was_mapped = _event_id_for(channel_id, ts, known)

    async with session_factory() as session:
        if await store.get_by_transport_event_id(session, event_id) is not None:
            report.already_present += 1
            return

        sender_id, sender_name, mapped_sender = senders.resolve(
            str(raw.get("user") or raw.get("bot_id") or ""),
            str(raw.get("username") or ""),
        )
        thread_ts = raw.get("thread_ts")
        thread_root = None
        if thread_ts and thread_ts != ts:
            thread_root = known.get(str(thread_ts))

        text = str(raw.get("text") or "")
        message = Message(
            room_id=room.id,
            transport_event_id=event_id,
            sender_matrix_id=sender_id,
            sender_name=sender_name,
            event_type="m.room.message",
            msgtype="m.text",
            body=text,
            thread_root_event_id=thread_root,
            content={"msgtype": "m.text", "body": text, "sender_name": sender_name},
            sent_at=_sent_at(ts),
        )
        await store.create_historical(session, message, [])
        await session.commit()

    report.written += 1
    if was_mapped:
        report.kept_original_id += 1
    if not mapped_sender:
        report.unmapped_sender += 1


def _sent_at(ts: str):  # type: ignore[no-untyped-def]
    """Slack's `ts` is epoch seconds with microseconds after the point."""
    from datetime import UTC, datetime

    return datetime.fromtimestamp(float(ts), tz=UTC)

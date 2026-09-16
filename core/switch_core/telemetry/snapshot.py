"""The daily usage snapshot, and the room-activation events derived with it.

Most of what the product wants to know — how many users, rooms, agents,
sessions and connectors, and how many of them are actually active — is a count
of things the server already stores. Counting them here, once a day, is what
lets those questions be answered without any room, tenant or person ever being
identified: the ids stay in the database where they belong, and only the
totals leave.

**Everything is counted per tenant and summed.** Not because the answer is
reported per tenant — it is not, deliberately — but because row-level security
means it has to be. Under the restricted runtime role a session with no tenant
bound reads *nothing* from a scoped table, so a single `SELECT count(*) FROM
rooms` would return zero on a correctly configured deployment and the whole
snapshot would be a page of confident zeroes. `all_tenant_ids` answers the one
question no tenant can be scoped to, and each tenant's rows are then read on a
session bound to it, exactly as the rest of the tree does.

The room-activation events ride along here rather than being emitted from the
message path, and that is a deliberate trade. Detecting "this room just became
active" at write time would mean a per-room flag and three extra queries on the
hottest path in the server, to learn something nobody needs within a day.
Asking the message table once a day instead costs nothing at write time, needs
no new state, and is exactly as accurate — the timestamps it reads were always
there.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Select, and_, case, distinct, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    CollaborationBridge,
    Message,
    MessageAttachment,
    Room,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids

logger = logging.getLogger(__name__)

# `clients.type` for a human. One puppet per external user per bridge, created
# when a person first speaks on a bridged channel — so this is the only row in
# the schema that stands for "a person did something", and every "human" count
# below is a count of these.
HUMAN_CLIENT_TYPE = "user"
AGENT_CLIENT_TYPE = "agent"

# The platforms reported individually. Fixed rather than derived from what is
# configured, so a deployment with no Discord bridge reports zero rather than
# omitting the property — the catalogue requires every key every time.
PLATFORMS = ("slack", "mattermost", "discord", "teams", "telegram")

_DAY = timedelta(days=1)
_WEEK = timedelta(days=7)


@dataclass
class UsageCounts:
    """The snapshot's numbers, accumulated across tenants."""

    tenant_count: int = 0
    user_count: int = 0
    user_active_1d: int = 0
    user_active_7d: int = 0
    room_count: int = 0
    room_agent_created_count: int = 0
    room_system_created_count: int = 0
    room_active_1d: int = 0
    room_active_7d: int = 0
    room_archived_count: int = 0
    room_internal_only_count: int = 0
    room_membership_total: int = 0
    room_users_max: int = 0
    agent_count: int = 0
    agent_active_7d: int = 0
    agent_claude_code_count: int = 0
    agent_codex_count: int = 0
    agent_opencode_count: int = 0
    agent_other_count: int = 0
    connector_configured_count: int = 0
    connector_counts: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(PLATFORMS, 0)
    )
    message_count_1d: int = 0
    message_from_human_1d: int = 0
    message_from_agent_1d: int = 0
    turn_human_to_agent_1d: int = 0
    turn_agent_to_human_1d: int = 0
    turn_agent_to_agent_1d: int = 0
    attachment_count_1d: int = 0

    def as_event_properties(self, *, session_live_count: int) -> dict[str, float]:
        """Flatten to exactly the properties `usage_snapshot` declares."""
        properties: dict[str, float] = {
            "tenant_count": self.tenant_count,
            "user_count": self.user_count,
            "user_active_1d": self.user_active_1d,
            "user_active_7d": self.user_active_7d,
            "room_count": self.room_count,
            "room_agent_created_count": self.room_agent_created_count,
            "room_system_created_count": self.room_system_created_count,
            "room_active_1d": self.room_active_1d,
            "room_active_7d": self.room_active_7d,
            "room_archived_count": self.room_archived_count,
            "room_internal_only_count": self.room_internal_only_count,
            "room_membership_total": self.room_membership_total,
            "room_users_mean": (
                round(self.room_membership_total / self.room_count, 2)
                if self.room_count
                else 0.0
            ),
            "room_users_max": self.room_users_max,
            "agent_count": self.agent_count,
            "agent_active_7d": self.agent_active_7d,
            "agent_claude_code_count": self.agent_claude_code_count,
            "agent_codex_count": self.agent_codex_count,
            "agent_opencode_count": self.agent_opencode_count,
            "agent_other_count": self.agent_other_count,
            "session_live_count": session_live_count,
            "connector_configured_count": self.connector_configured_count,
            "message_count_1d": self.message_count_1d,
            "message_from_human_1d": self.message_from_human_1d,
            "message_from_agent_1d": self.message_from_agent_1d,
            "turn_human_to_agent_1d": self.turn_human_to_agent_1d,
            "turn_agent_to_human_1d": self.turn_agent_to_human_1d,
            "turn_agent_to_agent_1d": self.turn_agent_to_agent_1d,
            "attachment_count_1d": self.attachment_count_1d,
        }
        for platform in PLATFORMS:
            properties[f"connector_{platform}_count"] = self.connector_counts[platform]
        return properties


@dataclass(frozen=True)
class NewlyActiveRoom:
    """A room whose first human interaction happened in the window just read."""

    # When the room actually went active. Carried rather than derived, because
    # the activation milestone is measured from this and not from the moment
    # the snapshot pass happened to run — a pass is up to a whole interval
    # late, and always late in the same direction.
    first_active_at: datetime
    seconds_since_room_created: float
    bridge_platform: str
    channel_type: str
    agent_count: int
    created_by_kind: str


def _room_has_an_agent(tenant_id: str) -> Select[tuple[str]]:
    """Correlated subquery: the message's room has an agent in it."""
    return (
        select(ClientRoom.room_id)
        .join(Client, Client.id == ClientRoom.client_id)
        .where(
            ClientRoom.room_id == Message.room_id,
            ClientRoom.tenant_id == tenant_id,
            Client.type == AGENT_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
        )
    )


def _human_interaction(tenant_id: str, since: datetime) -> Select[tuple[str]]:
    """Room ids a human spoke in since `since`.

    "Interaction" is a human posting in a room that has an agent in it. Both
    halves matter: a message from a bridge relay or the admin client is not a
    person, and a person talking in a room with no agent is not using the
    product this telemetry is about. Two agents talking to each other is
    likewise not activity, which is why this keys on the human side only.
    """
    return (
        select(distinct(Message.room_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Client.type == HUMAN_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
            exists(_room_has_an_agent(tenant_id)),
        )
    )


def _active_humans(tenant_id: str, since: datetime) -> Select[tuple[str | None]]:
    """Distinct human clients who interacted since `since`."""
    return (
        select(distinct(Message.sender_client_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Client.type == HUMAN_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
            exists(_room_has_an_agent(tenant_id)),
        )
    )


async def _count(session: AsyncSession, query: Select[Any]) -> int:
    result = await session.execute(select(func.count()).select_from(query.subquery()))
    return int(result.scalar_one())


async def _scalar(session: AsyncSession, query: Select[Any]) -> int:
    result = await session.execute(query)
    return int(result.scalar_one() or 0)


async def collect_tenant_counts(
    session: AsyncSession, tenant_id: str, counts: UsageCounts, now: datetime
) -> None:
    """Add one tenant's numbers to `counts`.

    The session must already be bound to `tenant_id`, **and** every query names
    the tenant explicitly as well. That looks redundant and is not: the policy
    is what does not apply on an owner connection, so a read that leans on it
    alone returns every tenant's rows on every pass and a fan-out over N
    tenants counts each row N times. `db/tenant_lookup.py` states the rule and
    every other fan-out in the tree follows it — this is a count, so the
    duplication would be silent rather than visible.
    """
    day_ago = now - _DAY
    week_ago = now - _WEEK

    counts.user_active_1d += await _count(session, _active_humans(tenant_id, day_ago))
    counts.user_active_7d += await _count(session, _active_humans(tenant_id, week_ago))
    counts.room_active_1d += await _count(
        session, _human_interaction(tenant_id, day_ago)
    )
    counts.room_active_7d += await _count(
        session, _human_interaction(tenant_id, week_ago)
    )

    # Rooms, split three ways by who made them, because there are three kinds
    # and they mean different things. `created_by_kind` is stamped into the
    # room's metadata at creation; a room made before that existed carries
    # nothing and is counted as user-created — the conservative reading, since
    # both other paths are newer than the stamp.
    #
    # `system` is the one worth naming: a channel Switch adopted because it was
    # invited to it on the platform. Folding those into the headline would make
    # "rooms a human created" mean "channels this workspace happens to have" on
    # any deployment with a busy Slack.
    kind = Room.metadata_["created_by_kind"].astext
    live = (Room.tenant_id == tenant_id, Room.archived_at.is_(None))
    counts.room_count += await _scalar(
        session,
        select(func.count())
        .select_from(Room)
        .where(*live, (kind == "user") | kind.is_(None)),
    )
    counts.room_agent_created_count += await _scalar(
        session, select(func.count()).select_from(Room).where(*live, kind == "agent")
    )
    counts.room_system_created_count += await _scalar(
        session, select(func.count()).select_from(Room).where(*live, kind == "system")
    )
    counts.room_archived_count += await _scalar(
        session,
        select(func.count())
        .select_from(Room)
        .where(Room.tenant_id == tenant_id, Room.archived_at.is_not(None)),
    )
    counts.room_internal_only_count += await _scalar(
        session,
        select(func.count()).select_from(Room).where(*live, Room.bridge_id.is_(None)),
    )

    # Human membership per room, as a total and a maximum. The mean is derived
    # from the total rather than averaged per tenant, so a deployment with one
    # busy tenant and one idle one reports the real figure instead of the mean
    # of two means.
    #
    # Counted over the same population as `room_count` — user-created rooms —
    # because the mean is derived from this total divided by that count. Over
    # different populations the pair can report a mean above the maximum, which
    # is impossible for any one set of rooms and reads as a broken metric.
    per_room = (
        select(func.count(ClientRoom.client_id).label("members"))
        .join(Client, Client.id == ClientRoom.client_id)
        .join(Room, Room.id == ClientRoom.room_id)
        .where(
            ClientRoom.tenant_id == tenant_id,
            Client.tenant_id == tenant_id,
            Client.type == HUMAN_CLIENT_TYPE,
            *live,
            (kind == "user") | kind.is_(None),
        )
        .group_by(ClientRoom.room_id)
        .subquery()
    )
    membership = await session.execute(
        select(
            func.coalesce(func.sum(per_room.c.members), 0),
            func.coalesce(func.max(per_room.c.members), 0),
        )
    )
    total, largest = membership.one()
    counts.room_membership_total += int(total)
    counts.room_users_max = max(counts.room_users_max, int(largest))

    # Agents, split by the runtime behind them.
    runtime = Agent.metadata_["known_agent_type"].astext
    by_runtime = await session.execute(
        select(runtime, func.count())
        .select_from(Agent)
        .where(Agent.tenant_id == tenant_id)
        .group_by(runtime)
    )
    for name, count in by_runtime.all():
        if name == "claude-code":
            counts.agent_claude_code_count += count
        elif name == "codex":
            counts.agent_codex_count += count
        elif name == "opencode":
            counts.agent_opencode_count += count
        else:
            counts.agent_other_count += count
        counts.agent_count += count

    counts.agent_active_7d += await _count(
        session,
        select(distinct(Message.sender_client_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= week_ago,
            Client.type == AGENT_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
        ),
    )

    # Connectors, by platform. Configured, not connected — whether each is
    # currently up is process state, added by the caller.
    by_platform = await session.execute(
        select(CollaborationBridge.type, func.count())
        .select_from(CollaborationBridge)
        .where(CollaborationBridge.tenant_id == tenant_id)
        .group_by(CollaborationBridge.type)
    )
    for platform, count in by_platform.all():
        counts.connector_configured_count += count
        if platform in counts.connector_counts:
            counts.connector_counts[platform] += count

    # Messages in the last day, and who sent them. Only live messages: `seq`
    # is negative for reconstructed history, and a backfill is not traffic.
    counts.message_count_1d += await _scalar(
        session,
        select(func.count())
        .select_from(Message)
        .where(
            Message.tenant_id == tenant_id, Message.sent_at >= day_ago, Message.seq > 0
        ),
    )
    by_sender = await session.execute(
        select(Client.type, func.count())
        .select_from(Message)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= day_ago,
            Message.seq > 0,
            Client.tenant_id == tenant_id,
        )
        .group_by(Client.type)
    )
    for client_type, count in by_sender.all():
        if client_type == HUMAN_CLIENT_TYPE:
            counts.message_from_human_1d += count
        elif client_type == AGENT_CLIENT_TYPE:
            counts.message_from_agent_1d += count

    await _collect_turns(session, tenant_id, counts, day_ago)

    counts.attachment_count_1d += await _scalar(
        session,
        select(func.count())
        .select_from(MessageAttachment)
        .join(Message, Message.id == MessageAttachment.message_id)
        .where(
            MessageAttachment.tenant_id == tenant_id,
            Message.tenant_id == tenant_id,
            Message.sent_at >= day_ago,
        ),
    )


async def _collect_turns(
    session: AsyncSession, tenant_id: str, counts: UsageCounts, since: datetime
) -> None:
    """Who replied to whom, in the window.

    A turn is a message paired with the one before it in the same room, so the
    pairing is read off `seq` — which is a total order within a room with no
    ties, assigned in commit order, and therefore the only ordering where
    "the previous message" means what it says. A timestamp would tie.

    Only three pairings are counted, and the ones left out are deliberate:
    human→human is two people talking with no agent involved, and a turn whose
    predecessor is a bridge relay or the admin client is machinery rather than
    conversation. The first message in a room has no predecessor and is not a
    turn at all.

    The window is applied to the *current* message, not the pair, so a reply
    this morning to a question asked last night still counts — which is the
    right reading of "turns today", and avoids a turn falling through the gap
    between two windows.
    """
    kind = case(
        (Client.type == HUMAN_CLIENT_TYPE, "human"),
        (Client.type == AGENT_CLIENT_TYPE, "agent"),
        else_="other",
    )
    paired = (
        select(
            kind.label("sender"),
            func.lag(kind)
            .over(partition_by=Message.room_id, order_by=Message.seq)
            .label("previous"),
            Message.sent_at.label("sent_at"),
        )
        .select_from(Message)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Client.tenant_id == tenant_id,
            Message.seq > 0,
        )
        .subquery()
    )
    rows = await session.execute(
        select(paired.c.sender, paired.c.previous, func.count())
        .where(paired.c.sent_at >= since, paired.c.previous.is_not(None))
        .group_by(paired.c.sender, paired.c.previous)
    )
    for sender, previous, count in rows.all():
        if sender == "agent" and previous == "human":
            counts.turn_human_to_agent_1d += count
        elif sender == "human" and previous == "agent":
            counts.turn_agent_to_human_1d += count
        elif sender == "agent" and previous == "agent":
            counts.turn_agent_to_agent_1d += count


async def room_had_human_activity(
    session: AsyncSession, tenant_id: str, room_id: str
) -> bool:
    """Whether a human has ever posted in this room.

    The session must already be bound to `tenant_id`; the predicate is named
    anyway, for the reason `collect_tenant_counts` gives.
    """
    found = await session.execute(
        select(Message.id)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.room_id == room_id,
            Message.seq > 0,
            Client.type == HUMAN_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is not None


async def collect_usage(
    session_factory: async_sessionmaker[AsyncSession], *, now: datetime | None = None
) -> UsageCounts:
    """Every tenant's numbers, summed into one set of deployment totals."""
    moment = now or datetime.now(UTC)
    counts = UsageCounts()
    tenant_ids = await all_tenant_ids(session_factory)
    counts.tenant_count = len(tenant_ids)
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            await collect_tenant_counts(session, tenant_id, counts, moment)
    # `users` carries no tenant, so it is counted once for the deployment
    # rather than per tenant — summing a global table over tenants would
    # multiply it by however many there are.
    async with session_factory() as session:
        counts.user_count = await _scalar(
            session, select(func.count()).select_from(User)
        )
    return counts


async def newly_active_rooms(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    since: datetime,
    now: datetime | None = None,
) -> list[NewlyActiveRoom]:
    """Rooms whose *first* human interaction happened after `since`.

    The window is what makes this once-per-room without storing anything: a
    room qualifies only if its earliest human message falls inside it, and each
    window starts where the last one ended. A room that was already active
    before `since` has an earlier first message and is skipped for good.

    The cost of that is a room can be reported late — up to one window — and
    cannot be reported at all if the deployment was down when the window that
    covered it would have run. Both are acceptable for a figure nobody reads
    inside a day, and neither can produce a duplicate.
    """
    moment = now or datetime.now(UTC)
    found: list[NewlyActiveRoom] = []

    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            first_interaction = (
                select(
                    Message.room_id.label("room_id"),
                    func.min(Message.sent_at).label("first_at"),
                )
                .join(Client, Client.id == Message.sender_client_id)
                .where(
                    Message.tenant_id == tenant_id,
                    Client.tenant_id == tenant_id,
                    Client.type == HUMAN_CLIENT_TYPE,
                    Message.seq > 0,
                )
                .group_by(Message.room_id)
                .subquery()
            )
            agent_count = (
                select(func.count())
                .select_from(ClientRoom)
                .join(Client, Client.id == ClientRoom.client_id)
                .where(
                    ClientRoom.room_id == Room.id,
                    ClientRoom.tenant_id == tenant_id,
                    Client.type == AGENT_CLIENT_TYPE,
                    Client.tenant_id == tenant_id,
                )
                .scalar_subquery()
            )
            rows = await session.execute(
                select(
                    Room.created_at,
                    first_interaction.c.first_at,
                    Room.channel_type,
                    Room.bridge_id,
                    Room.metadata_["created_by_kind"].astext,
                    agent_count,
                )
                .join(first_interaction, first_interaction.c.room_id == Room.id)
                .where(
                    and_(
                        Room.tenant_id == tenant_id,
                        first_interaction.c.first_at > since,
                        first_interaction.c.first_at <= moment,
                    )
                )
            )

            platforms = await _bridge_platforms(session)
            for created_at, first_at, channel_type, bridge_id, kind, agents in rows:
                found.append(
                    NewlyActiveRoom(
                        first_active_at=as_utc(first_at),
                        seconds_since_room_created=max(
                            (first_at - created_at).total_seconds(), 0.0
                        ),
                        bridge_platform=normalise_platform(platforms.get(bridge_id)),
                        channel_type=normalise_channel_type(channel_type),
                        agent_count=int(agents or 0),
                        created_by_kind=normalise_actor_kind(kind),
                    )
                )
    return found


async def _bridge_platforms(session: AsyncSession) -> dict[str | None, str]:
    """Bridge id → platform, for the tenant this session is bound to."""
    rows = await session.execute(
        select(CollaborationBridge.id, CollaborationBridge.type)
    )
    return {bridge_id: platform for bridge_id, platform in rows.all()}


def as_utc(moment: datetime) -> datetime:
    """A timestamp column as an aware UTC datetime."""
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def normalise_actor_kind(kind: str | None) -> str:
    """A stamped `created_by_kind` as the catalogue spells it.

    Rooms predating the stamp carry nothing and read as `user`, the same
    conservative default the room counts use. Anything unrecognised reads as
    `system` rather than raising: an unknown origin is machinery, and a room
    creation must not fail because a later kind was added without touching
    this file.
    """
    if kind in ("user", "agent", "system"):
        return str(kind)
    return "user" if kind is None else "system"


def normalise_channel_type(channel_type: str | None) -> str:
    """A `rooms.channel_type` as the catalogue spells it.

    The column predates the catalogue and carries a value the closed set does
    not: `group`, the pre-rename name for a private channel (see the
    `rename channel types` migration). Mapped rather than passed through,
    because an unmapped value would raise at the point of emission and take a
    room creation down with it.
    """
    if channel_type in ("channel_public", "channel_private", "direct"):
        return str(channel_type)
    if channel_type == "group":
        return "channel_private"
    if channel_type == "channel":
        return "channel_public"
    return "none"


def normalise_platform(platform: str | None) -> str:
    """A bridge type as the catalogue spells it."""
    return platform if platform in PLATFORMS else "none"


def normalise_known_agent_type(metadata: dict | None) -> str:
    """The runtime behind an agent, as the catalogue spells it."""
    if not metadata:
        return "none"
    declared = metadata.get("known_agent_type")
    if declared is None:
        return "none"
    if declared in ("claude-code", "codex", "opencode"):
        return str(declared)
    return "other"


def summarise(counts: UsageCounts, active: Sequence[NewlyActiveRoom]) -> str:
    """A one-line log of what a snapshot pass found, for the server's own log.

    Worth logging even when telemetry is switched off: an operator asking "what
    would this send?" should be able to answer it from the log rather than by
    reading the code or by turning reporting on to find out.
    """
    return (
        f"rooms={counts.room_count} active_7d={counts.room_active_7d} "
        f"users={counts.user_count} active_users_7d={counts.user_active_7d} "
        f"agents={counts.agent_count} messages_1d={counts.message_count_1d} "
        f"newly_active_rooms={len(active)}"
    )

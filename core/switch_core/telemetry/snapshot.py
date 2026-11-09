"""The daily usage snapshot, and the room-activation events derived with it.

Counting here rather than emitting per occurrence is what lets these questions
be answered with no room, tenant or person identified: the ids stay in the
database and only totals leave.

**Counted per tenant and summed**, because row-level security requires it — a
session with nothing bound reads nothing from a scoped table, so an unscoped
`COUNT` answers zero on a correctly configured deployment.

Room activation is derived here rather than detected at write time, which
would need a per-room flag and three extra queries on the hottest path to learn
something nobody needs within a day.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import (
    CompoundSelect,
    Select,
    and_,
    case,
    distinct,
    exists,
    func,
    select,
    union,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from switch_core import messaging_platforms
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.admin_messages import AUTO_REPLY_FLAG, SENDER_IS_APP_MARKER
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    Document,
    ExternalUser,
    ExternalUserClaim,
    Message,
    MessageAttachment,
    Package,
    Reference,
    Room,
    RoomGroup,
    User,
    room_documents,
    room_references,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.telemetry.catalogue import connector_count_property
from switch_core.telemetry.deployment import CONNECTOR_ADDED_PREFIX, claims_named
from switch_core.telemetry.internal import internal_email_condition

logger = logging.getLogger(__name__)

# `clients.type` for a human on a messaging platform: one human actor per
# external user per bridge.
HUMAN_CLIENT_TYPE = "user"
AGENT_CLIENT_TYPE = "agent"

# Who counts as a person in the snapshot: people on messaging platforms. Its
# figures were defined before Switch Console chat existed and keep that
# definition.
SNAPSHOT_PERSON_TYPES = (HUMAN_CLIENT_TYPE,)
# Who counts as a person everywhere else: in the period counts, a room
# becoming active, and whether a removed room was ever used. A person on a
# messaging platform, or in Switch Console through their `member` client.
# Someone who uses both is two people, as someone on two platforms already is.
PERSON_CLIENT_TYPES = (HUMAN_CLIENT_TYPE, MEMBER_CLIENT_TYPE)


# What a participant said, as opposed to everything else the transport stores in
# the same table: arrivals, tool and LLM call reports, task transitions. A
# command typed on a platform is something a person said.
SPOKEN_EVENT_TYPES = ("m.room.message", "com.switch.command")

_DAY = timedelta(days=1)
# How far back the turn pairing looks for a message's predecessor. See
# `_turns`.
_TURN_LOOKBACK = timedelta(days=2)
_WEEK = timedelta(days=7)


@dataclass
class UsageCounts:
    """The snapshot's numbers, accumulated across tenants."""

    # How many tenants actually made it into the sums below — not how many
    # tenants the deployment has. `collect_usage` collects one tenant at a
    # time into a scratch instance of this class and only folds it in once
    # that tenant's queries all succeed, so a tenant excluded after a failure
    # is excluded here too. That is what makes a partial pass a visibly
    # smaller number instead of the full tenant count sitting on top of an
    # undercounted everything else.
    tenant_count: int = 0
    # Tenants whose queries raised and were stepped over. Sits beside
    # `tenant_count` so a pass that excluded some is self-describing on the
    # wire: without it, a partial pass is every count dropping at once with
    # nothing to attribute it to.
    tenant_failed_count: int = 0
    # Wall time to collect the whole pass. Roughly twenty queries per tenant
    # against the database that is also serving rooms, so what it costs at
    # scale is a real question — and a background task is invisible to the
    # HTTP request histogram that times everything else.
    duration_ms: int = 0
    user_count: int = 0
    # Accounts on the company's own email domains, so staff can be told from
    # customers inside one deployment. Counted once for the deployment, like
    # `user_count`.
    user_internal_count: int = 0
    # Switch accounts that used a room with an agent: an account counts when a
    # chat account it has claimed spoke. Counted from the ids below once every
    # tenant is in, since one account can be active in several tenants and a
    # per-tenant count would add it once for each. Bots never link an account,
    # so it needs no bot rule.
    user_active_1d: int = 0
    user_active_7d: int = 0
    # Of those, accounts on the company's own email domains, so active staff
    # can be taken out of the headline without a per-event flag.
    user_internal_active_1d: int = 0
    user_internal_active_7d: int = 0
    active_user_ids_1d: set[str] = field(default_factory=set)
    active_user_ids_7d: set[str] = field(default_factory=set)
    # Chat identities — a Slack, Mattermost or other platform account — that
    # used a room with an agent, whether or not anyone has claimed them. One
    # person on two platforms is two identities, and most identities belong to
    # no Switch account, which is why this runs above `user_active_*`.
    # `chat_identity_count` is the whole population they are drawn from.
    # Integrations posting on a platform count here as well as people; the
    # period counts (`PeriodCounts`) split the two.
    chat_identity_count: int = 0
    chat_identity_active_1d: int = 0
    chat_identity_active_7d: int = 0
    # The other tiers, as chat identities like `chat_identity_active_*`:
    # anyone who said anything in any room, and anyone Switch has seen in a
    # room — see `_activity_tiers` for what that can and cannot see.
    chat_identity_posted_1d: int = 0
    chat_identity_posted_7d: int = 0
    chat_identity_in_room_count: int = 0
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
    # Every platform this build registered, not every one configured, so a
    # deployment with no Discord bridge reports zero rather than omitting the
    # property — the catalogue requires every key every time.
    connector_counts: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(messaging_platforms.keys(), 0)
    )
    message_count_1d: int = 0
    message_from_human_1d: int = 0
    message_from_agent_1d: int = 0
    turn_human_to_agent_1d: int = 0
    turn_agent_to_human_1d: int = 0
    turn_agent_to_agent_1d: int = 0
    attachment_count_1d: int = 0
    reference_count: int = 0
    reference_attached_count: int = 0
    document_count: int = 0
    document_attached_count: int = 0
    package_count: int = 0
    room_group_count: int = 0
    api_key_count: int = 0

    def as_event_properties(self, *, session_live_count: int) -> dict[str, float]:
        """Flatten to exactly the properties `usage_snapshot` declares."""
        properties: dict[str, float] = {
            "tenant_count": self.tenant_count,
            "tenant_failed_count": self.tenant_failed_count,
            "duration_ms": self.duration_ms,
            "user_count": self.user_count,
            "user_internal_count": self.user_internal_count,
            "user_active_1d": self.user_active_1d,
            "user_active_7d": self.user_active_7d,
            "user_internal_active_1d": self.user_internal_active_1d,
            "user_internal_active_7d": self.user_internal_active_7d,
            "chat_identity_count": self.chat_identity_count,
            "chat_identity_active_1d": self.chat_identity_active_1d,
            "chat_identity_active_7d": self.chat_identity_active_7d,
            "chat_identity_posted_1d": self.chat_identity_posted_1d,
            "chat_identity_posted_7d": self.chat_identity_posted_7d,
            "chat_identity_in_room_count": self.chat_identity_in_room_count,
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
            "reference_count": self.reference_count,
            "reference_attached_count": self.reference_attached_count,
            "document_count": self.document_count,
            "document_attached_count": self.document_attached_count,
            "package_count": self.package_count,
            "room_group_count": self.room_group_count,
            "api_key_count": self.api_key_count,
        }
        for platform, count in self.connector_counts.items():
            properties[connector_count_property(platform)] = count
        return properties


@dataclass(frozen=True)
class NewlyActiveRoom:
    """A room that became active in the window just read. See `newly_active_rooms`."""

    # The milestone is measured from this, not from when the pass ran: a pass
    # is up to a whole interval late, always in the same direction.
    first_active_at: datetime
    seconds_since_room_created: float
    bridge_platform: str
    channel_type: str
    agent_count: int
    created_by_kind: str


def _rooms_with_an_agent(tenant_id: str) -> CompoundSelect:
    """Room ids with an agent in them now, or that an agent has posted in.

    Uncorrelated, and matched with `IN` rather than as an `OR` of two
    `EXISTS`, so Postgres plans it as one semi-join: hashed across the tenant
    for the snapshot, or narrowed to the single room `room_had_human_activity`
    asks about. An `OR` of correlated probes cannot be planned that way and
    re-runs both for every human message, which on a large room with no agent
    is quadratic — and that check runs on every room archive and delete.

    Aliased so neither arm correlates with the human's `Client` and `Message`
    in the enclosing query.
    """
    member = aliased(Client)
    poster = aliased(Client)
    agent_message = aliased(Message)
    return union_all(
        select(ClientRoom.room_id)
        .join(member, member.id == ClientRoom.client_id)
        .where(
            ClientRoom.tenant_id == tenant_id,
            member.type == AGENT_CLIENT_TYPE,
            member.tenant_id == tenant_id,
        ),
        select(agent_message.room_id)
        .join(poster, poster.id == agent_message.sender_client_id)
        .where(
            agent_message.tenant_id == tenant_id,
            agent_message.seq > 0,
            poster.type == AGENT_CLIENT_TYPE,
            poster.tenant_id == tenant_id,
        ),
    )


def _human_activity_conditions(
    tenant_id: str, person_types: tuple[str, ...]
) -> tuple[Any, ...]:
    """A person said something in a room with an agent: the activity the
    identity and account counts are built on, and, less integrations
    (`_room_activity_conditions`), the room counts. Assumes the caller has
    already joined `Client` on `Message.sender_client_id`.

    Both conditions are kept:

    - **The room must have an agent in it, or have had one post in it.** A
      message from a bridge relay or the admin client is not a person, and a
      person talking in a room with no agent is not using the product this
      telemetry is about — two agents talking to each other is likewise not
      activity, which is why this keys on the human side only. Membership
      alone would make the lifetime questions depend on who is in the room at
      the moment they are asked: a busy room whose agents were removed before
      it was archived would read as never used. An agent's messages outlive
      its membership, so they answer for the room's history.
    - **`seq` must be positive.** `MessageStore.create_historical` backfills
      imported history with a negative `seq`, and a backfill is not someone
      using the product today. Nothing calls it yet, so this half is a latent
      guard rather than a live one — but it costs nothing to apply everywhere
      a message is read as activity, and every count in this module that
      already reads live traffic (`collect_tenant_counts`'s message and turn
      counts) applies the identical filter, so leaving it off here would be
      the inconsistent choice.
    """
    return (
        *_human_message_conditions(tenant_id, person_types),
        Message.room_id.in_(_rooms_with_an_agent(tenant_id)),
    )


def _room_activity_conditions(
    tenant_id: str, person_types: tuple[str, ...]
) -> tuple[Any, ...]:
    """The one definition of "a person used this room", shared by every path
    that asks it: the room-activity gauges, the period counts, the
    once-per-room activation event, the first-room-active evidence, and the
    "was this room ever active" check on deletion and archival.

    Who counts as a person is the caller's `person_types`, and the paths do
    not all agree on it. The snapshot's released gauges (`room_active_*`)
    count people on messaging platforms only (`SNAPSHOT_PERSON_TYPES`); every
    other path counts a person in Switch Console too (`PERSON_CLIENT_TYPES`).
    So a room used only from Switch Console chat becomes active, counts in the
    period counts and reads as ever active, but is not in `room_active_*`.

    `_human_activity_conditions`, less a post the bridge marked as an
    integration's (`SENDER_IS_APP_MARKER`): an alerting app posting into a
    room with an agent is not anyone using it. By post rather than by
    identity: an integration's posts relayed before its bridge marked them
    carry no mark, and are read as a person's.
    """
    return (
        *_human_activity_conditions(tenant_id, person_types),
        ~Message.content.has_key(SENDER_IS_APP_MARKER),
    )


def _spoken() -> tuple[Any, ...]:
    """Something a participant said, not a row the transport stored beside it.

    Every durable event is a row in `messages`, so without this an agent
    joining a room or reporting a tool call reads as an agent message, and a
    person being added to a room reads as that person being active. The
    notice Switch posts under an agent's name when the agent cannot take a
    request is excluded too: the agent did not say it.
    """
    return (
        Message.event_type.in_(SPOKEN_EVENT_TYPES),
        ~Message.content.has_key(AUTO_REPLY_FLAG),
    )


def _human_message_conditions(
    tenant_id: str, person_types: tuple[str, ...]
) -> tuple[Any, ...]:
    """The message half of `_human_activity_conditions`: a person said it, and
    it is live traffic rather than a backfill."""
    return (
        Client.type.in_(person_types),
        Client.tenant_id == tenant_id,
        Message.seq > 0,
        *_spoken(),
    )


def _human_interaction(
    tenant_id: str, since: datetime, until: datetime, person_types: tuple[str, ...]
) -> Select[tuple[str]]:
    """Room ids a person used in `[since, until)`. See
    `_room_activity_conditions`."""
    return (
        select(distinct(Message.room_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            *_room_activity_conditions(tenant_id, person_types),
        )
    )


def _active_accounts(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[str]]:
    """Distinct Switch accounts that used a room in `[since, until)`: an account
    is active when a chat account it has claimed spoke. A chat account several
    people claim makes each of them active. See `_human_activity_conditions`."""
    return (
        select(distinct(ExternalUserClaim.user_id))
        .select_from(Message)
        .join(Client, Client.id == Message.sender_client_id)
        .join(
            ExternalUser,
            and_(
                ExternalUser.client_id == Client.id, ExternalUser.tenant_id == tenant_id
            ),
        )
        .join(
            ExternalUserClaim,
            and_(
                ExternalUserClaim.external_user_id == ExternalUser.id,
                ExternalUserClaim.tenant_id == tenant_id,
            ),
        )
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            *_human_activity_conditions(tenant_id, SNAPSHOT_PERSON_TYPES),
        )
    )


def _active_console_accounts(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[str | None]]:
    """Distinct Switch accounts that used a room from Switch Console chat in
    `[since, until)`. A `member` client speaks for its account directly
    (`Client.user_id`), with no chat identity to claim. See
    `_human_activity_conditions`."""
    return (
        select(distinct(Client.user_id))
        .select_from(Message)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            *_human_activity_conditions(tenant_id, (MEMBER_CLIENT_TYPE,)),
        )
    )


def _active_humans(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[str | None]]:
    """Distinct chat identities who used a room in `[since, until)`,
    integrations included. See `_human_activity_conditions`."""
    return (
        select(distinct(Message.sender_client_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            *_human_activity_conditions(tenant_id, SNAPSHOT_PERSON_TYPES),
        )
    )


def _identity_activity(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[int, int]]:
    """How many people, and how many integrations, used a room in
    `[since, until)`, in one read of the window's messages.

    An identity that posted as an app at least once in the window (a post the
    bridge marked `SENDER_IS_APP_MARKER` because its platform said an
    integration sent it) is an integration for the whole window, not only for
    its marked posts: a bot's posts from before its bridge marked them carry
    no marker, and counting those as a person's would keep it in the people
    count until they age out. Every other identity is a person, on a messaging
    platform or in Switch Console.
    """
    per_identity = (
        select(
            func.bool_or(Message.content.has_key(SENDER_IS_APP_MARKER)).label("is_bot")
        )
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            *_human_activity_conditions(tenant_id, PERSON_CLIENT_TYPES),
        )
        .group_by(Message.sender_client_id)
        .subquery()
    )
    return select(
        func.count().filter(~per_identity.c.is_bot),
        func.count().filter(per_identity.c.is_bot),
    ).select_from(per_identity)


def _activity_tiers(
    tenant_id: str, day_ago: datetime, week_ago: datetime
) -> Select[tuple[int, int, int]]:
    """Distinct human clients who said anything in any room in the last day
    and week, and those Switch has seen in a room: a member of a live room
    now, or anyone who posted in the last week.

    The posters are `_active_humans` without the agent condition: someone
    talking only to other people is not using an agent, but is not passive
    either. They are folded into the room count so the tiers nest: someone who
    posted this week and then left, or whose room was archived, is no longer a
    member of a live room but has still been seen. Rooms of every origin, like
    the activity counts: a person in an adopted channel is in Switch whether
    or not anybody created that room here.

    Not a channel's whole audience. A person gets a membership row only when
    they post, are added by name, or join after the channel was adopted;
    nothing records the members a channel already had, so someone who has
    only ever read is not here.

    One statement over one read of the week's messages, so the three come from
    the same snapshot and nest exactly, and the scan is not repeated per tier.
    """
    posters = (
        select(
            Message.sender_client_id.label("client_id"),
            func.max(Message.sent_at).label("last_posted_at"),
        )
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= week_ago,
            *_human_message_conditions(tenant_id, SNAPSHOT_PERSON_TYPES),
        )
        .group_by(Message.sender_client_id)
        .cte("posters")
    )
    members = (
        select(ClientRoom.client_id)
        .join(Client, Client.id == ClientRoom.client_id)
        .join(Room, Room.id == ClientRoom.room_id)
        .where(
            ClientRoom.tenant_id == tenant_id,
            Client.tenant_id == tenant_id,
            Client.type == HUMAN_CLIENT_TYPE,
            Room.tenant_id == tenant_id,
            Room.archived_at.is_(None),
        )
    )
    seen = union(members, select(posters.c.client_id)).subquery("seen")
    return select(
        select(func.count())
        .select_from(posters)
        .where(posters.c.last_posted_at >= day_ago)
        .scalar_subquery(),
        select(func.count()).select_from(posters).scalar_subquery(),
        select(func.count()).select_from(seen).scalar_subquery(),
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

    counts.active_user_ids_1d |= set(
        (await session.execute(_active_accounts(tenant_id, day_ago, now))).scalars()
    )
    counts.active_user_ids_7d |= set(
        (await session.execute(_active_accounts(tenant_id, week_ago, now))).scalars()
    )
    counts.chat_identity_count += await _scalar(
        session,
        select(func.count())
        .select_from(Client)
        .where(Client.tenant_id == tenant_id, Client.type == HUMAN_CLIENT_TYPE),
    )
    counts.chat_identity_active_1d += await _count(
        session, _active_humans(tenant_id, day_ago, now)
    )
    counts.chat_identity_active_7d += await _count(
        session, _active_humans(tenant_id, week_ago, now)
    )
    posted_1d, posted_7d, in_room = (
        await session.execute(_activity_tiers(tenant_id, day_ago, week_ago))
    ).one()
    counts.chat_identity_posted_1d += posted_1d
    counts.chat_identity_posted_7d += posted_7d
    counts.chat_identity_in_room_count += in_room
    counts.room_active_1d += await _count(
        session, _human_interaction(tenant_id, day_ago, now, SNAPSHOT_PERSON_TYPES)
    )
    counts.room_active_7d += await _count(
        session, _human_interaction(tenant_id, week_ago, now, SNAPSHOT_PERSON_TYPES)
    )

    # A room predating the stamp reads as user-created, the conservative
    # answer. `system` is a channel Switch was invited to; folding those in
    # would make the headline mean "channels this workspace happens to have".
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
    # Same population as `room_count`, since the mean divides one by the
    # other — different populations can report a mean above the maximum.
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
        session, _active_agents(tenant_id, week_ago, now)
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
        session, _message_count(tenant_id, day_ago, now)
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
            *_spoken(),
        )
        .group_by(Client.type)
    )
    for client_type, count in by_sender.all():
        if client_type == HUMAN_CLIENT_TYPE:
            counts.message_from_human_1d += count
        elif client_type == AGENT_CLIENT_TYPE:
            counts.message_from_agent_1d += count

    await _collect_resource_counts(session, tenant_id, counts)

    (
        human_to_agent,
        agent_to_human,
        agent_to_agent,
    ) = await _turns(session, tenant_id, day_ago, now, SNAPSHOT_PERSON_TYPES)
    counts.turn_human_to_agent_1d += human_to_agent
    counts.turn_agent_to_human_1d += agent_to_human
    counts.turn_agent_to_agent_1d += agent_to_agent

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


async def _collect_resource_counts(
    session: AsyncSession, tenant_id: str, counts: UsageCounts
) -> None:
    """What the tenant has built up, and how much of it is actually in a room.

    The attached figures are the point. A library of references nobody ever
    attached and one attached to every room are the same number under
    `reference_count`, and they mean opposite things about whether the feature
    is working.
    """
    for table, name in (
        (Reference, "reference_count"),
        (Document, "document_count"),
        (Package, "package_count"),
        (RoomGroup, "room_group_count"),
        (ApiKey, "api_key_count"),
    ):
        setattr(
            counts,
            name,
            getattr(counts, name)
            + await _scalar(
                session,
                select(func.count())
                .select_from(table)
                .where(table.tenant_id == tenant_id),
            ),
        )

    for junction, column, name in (
        (room_references, "reference_id", "reference_attached_count"),
        (room_documents, "document_id", "document_attached_count"),
    ):
        setattr(
            counts,
            name,
            getattr(counts, name)
            + await _scalar(
                session,
                select(func.count(distinct(junction.c[column]))).where(
                    junction.c.tenant_id == tenant_id
                ),
            ),
        )


async def _turns(
    session: AsyncSession,
    tenant_id: str,
    since: datetime,
    until: datetime,
    person_types: tuple[str, ...],
) -> tuple[int, int, int]:
    """Who replied to whom in `[since, until)`: turns from a person to an
    agent, from an agent to a person, and from one agent to another.

    A turn is a message paired with the one before it in the same room, so the
    pairing is read off `seq` — which is a total order within a room with no
    ties, assigned in commit order, and therefore the only ordering where
    "the previous message" means what it says. A timestamp would tie.

    Only three pairings are counted, and the ones left out are deliberate:
    person→person is two people talking with no agent involved, and a turn
    whose predecessor is a bridge relay or the admin client is machinery
    rather than conversation. The first message in a room has no predecessor
    and is not a turn at all.

    The window is applied to the *current* message, not the pair, so a reply
    this morning to a question asked last night still counts — which is the
    right reading of "turns today", and avoids a turn falling through the gap
    between two windows.
    """
    kind = case(
        (Client.type.in_(person_types), "human"),
        (Client.type == AGENT_CLIENT_TYPE, "agent"),
        else_="other",
    )
    paired = (
        select(
            kind.label("sender"),
            Message.sender_client_id.label("sender_id"),
            func.lag(kind)
            .over(partition_by=Message.room_id, order_by=Message.seq)
            .label("previous"),
            func.lag(Message.sender_client_id)
            .over(partition_by=Message.room_id, order_by=Message.seq)
            .label("previous_id"),
            Message.sent_at.label("sent_at"),
        )
        .select_from(Message)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Client.tenant_id == tenant_id,
            Message.seq > 0,
            # Before the window function, not after: an arrival or a report
            # between a question and its answer would otherwise be what the
            # answer is paired with.
            *_spoken(),
            # Bounded, or the window covers the tenant's whole history every
            # pass. The outer `sent_at` filter cannot be pushed in at the
            # start: the window partitions by room, so narrowing the input
            # would change which message counts as the predecessor. The
            # lookback is wider than the window so a reply to yesterday still
            # finds what it answered. The end can be: nothing after it is
            # anything's predecessor.
            Message.sent_at >= since - _TURN_LOOKBACK,
            Message.sent_at < until,
        )
        .subquery()
    )
    rows = await session.execute(
        select(paired.c.sender, paired.c.previous, func.count())
        .where(
            paired.c.sent_at >= since,
            paired.c.previous.is_not(None),
            # A reply needs two participants: without this an agent answering
            # across three messages scores as two agent-to-agent turns.
            paired.c.sender_id != paired.c.previous_id,
        )
        .group_by(paired.c.sender, paired.c.previous)
    )
    by_pair = {(sender, previous): count for sender, previous, count in rows.all()}
    return (
        by_pair.get(("agent", "human"), 0),
        by_pair.get(("human", "agent"), 0),
        by_pair.get(("agent", "agent"), 0),
    )


def _active_agents(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[str | None]]:
    """Distinct agents that said something in `[since, until)`."""
    return (
        select(distinct(Message.sender_client_id))
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            Client.type == AGENT_CLIENT_TYPE,
            Client.tenant_id == tenant_id,
            *_spoken(),
        )
    )


def _message_count(
    tenant_id: str, since: datetime, until: datetime
) -> Select[tuple[int]]:
    """Messages participants said in `[since, until)`, from the message table.
    Live traffic only: `seq` is negative for reconstructed history."""
    return (
        select(func.count())
        .select_from(Message)
        .where(
            Message.tenant_id == tenant_id,
            Message.sent_at >= since,
            Message.sent_at < until,
            Message.seq > 0,
            *_spoken(),
        )
    )


async def room_had_human_activity(
    session: AsyncSession, tenant_id: str, room_id: str
) -> bool:
    """Whether this room has ever seen a person use it. See
    `_room_activity_conditions`.

    The session must already be bound to `tenant_id`; the predicate is named
    anyway, for the reason `collect_tenant_counts` gives.

    The agent condition is asked of the one room rather than of each message.
    Uncorrelated, Postgres evaluates it once before reading anything, so a
    room with no agent is answered without scanning its history — this runs
    on every archive and delete.
    """
    agent_rooms = _rooms_with_an_agent(tenant_id).subquery()
    found = await session.execute(
        select(Message.id)
        .join(Client, Client.id == Message.sender_client_id)
        .where(
            Message.tenant_id == tenant_id,
            Message.room_id == room_id,
            *_human_message_conditions(tenant_id, PERSON_CLIENT_TYPES),
            ~Message.content.has_key(SENDER_IS_APP_MARKER),
            exists(
                select(agent_rooms.c.room_id).where(agent_rooms.c.room_id == room_id)
            ),
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is not None


def _merge_tenant_counts(total: UsageCounts, tenant: UsageCounts) -> None:
    """Fold one tenant's collected numbers into the running deployment totals.

    Every field sums across tenants except `room_users_max` — the busiest room
    in the deployment is the largest of each tenant's busiest room, not their
    sum — and `connector_counts`, which sums per platform rather than as a
    dict. Neither `tenant_count` nor `user_count` is touched here: the first is
    the caller's to advance once a tenant's merge succeeds, and the second is
    never collected per tenant at all.
    """
    skip = {
        "tenant_count",
        "tenant_failed_count",
        "duration_ms",
        "user_count",
        "user_internal_count",
        "user_active_1d",
        "user_active_7d",
        "user_internal_active_1d",
        "user_internal_active_7d",
        "active_user_ids_1d",
        "active_user_ids_7d",
        "room_users_max",
        "connector_counts",
    }
    for f in fields(UsageCounts):
        if f.name in skip:
            continue
        setattr(total, f.name, getattr(total, f.name) + getattr(tenant, f.name))
    total.room_users_max = max(total.room_users_max, tenant.room_users_max)
    total.active_user_ids_1d |= tenant.active_user_ids_1d
    total.active_user_ids_7d |= tenant.active_user_ids_7d
    for platform, count in tenant.connector_counts.items():
        total.connector_counts[platform] += count


async def _internal_among(session: AsyncSession, user_ids: set[str]) -> int:
    """How many of `user_ids` are accounts on the company's own domains."""
    if not user_ids:
        return 0
    return await _scalar(
        session,
        select(func.count())
        .select_from(User)
        .where(User.id.in_(user_ids), internal_email_condition(User.email)),
    )


async def collect_usage(
    session_factory: async_sessionmaker[AsyncSession], *, now: datetime | None = None
) -> UsageCounts:
    """Every tenant's numbers, summed into one set of deployment totals.

    One tenant's failure does not take the whole pass down. Its queries run
    against a scratch `UsageCounts` rather than the running total, so a query
    that raises partway through a tenant leaves nothing from that tenant
    behind — not the fields collected before the failure, not any after —
    and the loop moves on to the next tenant with the total untouched. See
    `UsageCounts.tenant_count` and `tenant_failed_count` for how that failure
    is disclosed rather than swallowed.
    """
    moment = now or datetime.now(UTC)
    # Monotonic, not the wall clock: an NTP step mid-pass would otherwise
    # produce a duration the pass did not take, and a negative one is worse
    # than none at all — nothing at the far end can tell it from data.
    started = time.monotonic()
    counts = UsageCounts()
    tenant_ids = await all_tenant_ids(session_factory)
    failed_tenants: list[str] = []
    for tenant_id in tenant_ids:
        tenant_counts = UsageCounts()
        try:
            async with tenant_session(session_factory, tenant_id) as session:
                await collect_tenant_counts(session, tenant_id, tenant_counts, moment)
        except Exception:
            logger.exception(
                "Usage snapshot: failed to collect counts for tenant %s", tenant_id
            )
            failed_tenants.append(tenant_id)
            continue
        _merge_tenant_counts(counts, tenant_counts)
        counts.tenant_count += 1
    if failed_tenants:
        logger.error(
            "Usage snapshot: excluded %d of %d tenant(s) from this pass: %s. "
            "tenant_count on the emitted snapshot reports only what was "
            "counted, so it will read lower than the deployment's real "
            "tenant count until this is fixed.",
            len(failed_tenants),
            len(tenant_ids),
            ", ".join(failed_tenants),
        )
    counts.tenant_failed_count = len(failed_tenants)
    # `users` carries no tenant, so it is counted once for the deployment
    # rather than per tenant — summing a global table over tenants would
    # multiply it by however many there are.
    async with session_factory() as session:
        counts.user_count = await _scalar(
            session, select(func.count()).select_from(User)
        )
        counts.user_internal_count = await _scalar(
            session,
            select(func.count())
            .select_from(User)
            .where(internal_email_condition(User.email)),
        )
        counts.user_internal_active_1d = await _internal_among(
            session, counts.active_user_ids_1d
        )
        counts.user_internal_active_7d = await _internal_among(
            session, counts.active_user_ids_7d
        )
    counts.user_active_1d = len(counts.active_user_ids_1d)
    counts.user_active_7d = len(counts.active_user_ids_7d)
    counts.duration_ms = round((time.monotonic() - started) * 1000)
    return counts


@dataclass
class PeriodCounts:
    """Distinct use over one finished period (`periods.Period`).

    By the snapshot's definitions, with two differences. People are anyone
    who said something in a room with an agent, on a messaging platform or in
    Switch Console (`PERSON_CLIENT_TYPES`), where the snapshot counts only the
    first; the rooms, turns and accounts follow, so an account counts when a
    chat identity it claimed spoke or when it spoke in Console chat itself.
    And `chat_identity_active_*` is split into people and integrations
    (`_identity_activity`)."""

    room_active: int = 0
    person_identity_active: int = 0
    bot_identity_active: int = 0
    account_ids: set[str] = field(default_factory=set)
    agent_active: int = 0
    message_count: int = 0
    turn_human_to_agent: int = 0
    turn_agent_to_human: int = 0
    turn_agent_to_agent: int = 0
    tenant_failed_count: int = 0

    @property
    def account_active(self) -> int:
        return len(self.account_ids)


async def collect_period_counts(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_ids: Sequence[str],
    start: datetime,
    end: datetime,
) -> PeriodCounts:
    """`tenant_ids`' distinct use in `[start, end)`, summed like
    `collect_usage`: one tenant's failure leaves nothing of it behind and is
    disclosed in `tenant_failed_count`. Accounts are a set across tenants, so
    one account active in two counts once. The tenants are the caller's, read
    once for every period a pass reports."""
    counts = PeriodCounts()
    failed_tenants: list[str] = []
    for tenant_id in tenant_ids:
        try:
            async with tenant_session(session_factory, tenant_id) as session:
                rooms = await _count(
                    session,
                    _human_interaction(tenant_id, start, end, PERSON_CLIENT_TYPES),
                )
                people, bots = (
                    await session.execute(_identity_activity(tenant_id, start, end))
                ).one()
                accounts = set(
                    (
                        await session.execute(_active_accounts(tenant_id, start, end))
                    ).scalars()
                )
                accounts |= {
                    user_id
                    for user_id in (
                        await session.execute(
                            _active_console_accounts(tenant_id, start, end)
                        )
                    ).scalars()
                    if user_id is not None
                }
                agents = await _count(session, _active_agents(tenant_id, start, end))
                messages = await _scalar(session, _message_count(tenant_id, start, end))
                turns = await _turns(
                    session, tenant_id, start, end, PERSON_CLIENT_TYPES
                )
        except Exception:
            logger.exception(
                "Usage period: failed to collect counts for tenant %s", tenant_id
            )
            failed_tenants.append(tenant_id)
            continue
        counts.room_active += rooms
        counts.person_identity_active += people
        counts.bot_identity_active += bots
        counts.account_ids |= accounts
        counts.agent_active += agents
        counts.message_count += messages
        counts.turn_human_to_agent += turns[0]
        counts.turn_agent_to_human += turns[1]
        counts.turn_agent_to_agent += turns[2]
    if failed_tenants:
        logger.error(
            "Usage period %s to %s: excluded %d of %d tenant(s): %s. Its counts "
            "read low, and tenant_failed_count on the event says so.",
            start.isoformat(),
            end.isoformat(),
            len(failed_tenants),
            len(tenant_ids),
            ", ".join(failed_tenants),
        )
    counts.tenant_failed_count = len(failed_tenants)
    return counts


async def collect_each_period_counts(
    session_factory: async_sessionmaker[AsyncSession],
    spans: Sequence[tuple[datetime, datetime]],
) -> list[PeriodCounts | None]:
    """`collect_period_counts` for each `(start, end)` in `spans`, in order,
    reading which tenants there are once for all of them rather than once a
    period. None for a span whose counts could not be collected at all, which
    is logged; a tenant that fails is contained within its span as usual."""
    tenant_ids = await all_tenant_ids(session_factory)
    counted: list[PeriodCounts | None] = []
    for start, end in spans:
        try:
            counted.append(
                await collect_period_counts(
                    session_factory, tenant_ids=tenant_ids, start=start, end=end
                )
            )
        except Exception:
            logger.exception(
                "Usage period %s to %s could not be counted.",
                start.isoformat(),
                end.isoformat(),
            )
            counted.append(None)
    return counted


async def milestones_passed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    activated_before: datetime | None,
) -> set[str]:
    """The milestones the database shows this deployment has passed, for
    `deployment.settle_from_evidence`.

    `activated_before` limits the room-activity evidence to rooms that went
    live before it (`_RoomActivation`): a room that went live later is the
    next snapshot pass's to report, and settling it here would lose it.

    - `first_room_created`: a room a person made exists.
    - `first_room_active`: a person used one of those rooms with an agent in
      it (`_room_activity_conditions`).
    - `first_agent_session`: the same, as `SUPERSEDED_MILESTONES` reads it: a
      person using a room with an agent means sessions have run.
    - `first_agent_registered`: an agent exists.
    - `first_agent_connected`: an agent has said something, which it can do
      only once it has been online.
    - `first_connector_added`: a connector a person added (not the setup
      step's own) has connected, as its first-connect claim records.

    Evidence of what is still there, so a deployment whose only room was
    deleted claims no `first_room_created`, and reports it, late, at its next.
    Raises if any tenant cannot be read: settling from part of the evidence
    would report the rest as firsts that are not.
    """
    passed: set[str] = set()
    connected = set(await claims_named(session_factory, CONNECTOR_ADDED_PREFIX))
    kind = Room.metadata_["created_by_kind"].astext
    by_a_person = (kind == "user") | kind.is_(None)
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            activation = _RoomActivation.of(tenant_id)
            checks: dict[str, Select[Any]] = {
                "first_room_created": select(Room.id).where(
                    Room.tenant_id == tenant_id, by_a_person
                ),
                "first_room_active": select(Room.id)
                .join(
                    activation.first_interaction,
                    activation.first_interaction.c.room_id == Room.id,
                )
                .outerjoin(
                    activation.agent_joined,
                    activation.agent_joined.c.room_id == Room.id,
                )
                .outerjoin(
                    activation.agent_posted,
                    activation.agent_posted.c.room_id == Room.id,
                )
                .where(
                    Room.tenant_id == tenant_id,
                    by_a_person,
                    activation.agent_since.is_not(None),
                    *(
                        (activation.activated_at < activated_before,)
                        if activated_before is not None
                        else ()
                    ),
                ),
                "first_agent_registered": select(Agent.id).where(
                    Agent.tenant_id == tenant_id
                ),
                "first_agent_connected": select(Message.id)
                .join(Client, Client.id == Message.sender_client_id)
                .where(
                    Message.tenant_id == tenant_id,
                    Client.tenant_id == tenant_id,
                    Client.type == AGENT_CLIENT_TYPE,
                    *_spoken(),
                ),
                "first_connector_added": select(CollaborationBridge.id).where(
                    CollaborationBridge.tenant_id == tenant_id,
                    CollaborationBridge.preconfigured.is_(False),
                    CollaborationBridge.id.in_(connected),
                ),
            }
            for milestone, query in checks.items():
                if milestone in passed:
                    continue
                if await session.scalar(select(exists(query))):
                    passed.add(milestone)
    if "first_room_active" in passed:
        passed.add("first_agent_session")
    return passed


@dataclass(frozen=True)
class _RoomActivation:
    """When each room of a tenant went live: the later of its first
    interaction by a person (`_room_activity_conditions`) and the first sign
    of an agent in it (the first current agent member to join, or the first
    agent message, whichever came first). The one definition the snapshot's
    `newly_active_rooms` and the evidence settlement share, so a room the
    settlement leaves alone is one the snapshot will report.

    A query joins `first_interaction` to `Room`, outer-joins the other two,
    and keeps rows where `agent_since` is not null.
    """

    first_interaction: Any
    agent_joined: Any
    agent_posted: Any
    agent_since: Any
    activated_at: Any

    @classmethod
    def of(cls, tenant_id: str) -> _RoomActivation:
        first_interaction = (
            select(
                Message.room_id.label("room_id"),
                func.min(Message.sent_at).label("first_at"),
            )
            .join(Client, Client.id == Message.sender_client_id)
            .where(
                Message.tenant_id == tenant_id,
                *_room_activity_conditions(tenant_id, PERSON_CLIENT_TYPES),
            )
            .group_by(Message.room_id)
            .subquery()
        )
        agent_joined = (
            select(
                ClientRoom.room_id.label("room_id"),
                func.min(ClientRoom.joined_at).label("at"),
            )
            .join(Client, Client.id == ClientRoom.client_id)
            .where(
                ClientRoom.tenant_id == tenant_id,
                Client.type == AGENT_CLIENT_TYPE,
                Client.tenant_id == tenant_id,
            )
            .group_by(ClientRoom.room_id)
            .subquery()
        )
        agent_posted = (
            select(
                Message.room_id.label("room_id"),
                func.min(Message.sent_at).label("at"),
            )
            .join(Client, Client.id == Message.sender_client_id)
            .where(
                Message.tenant_id == tenant_id,
                Message.seq > 0,
                Client.type == AGENT_CLIENT_TYPE,
                Client.tenant_id == tenant_id,
            )
            .group_by(Message.room_id)
            .subquery()
        )
        # LEAST and GREATEST skip NULLs, so a room with no agent at all would
        # otherwise become active at its first human message.
        agent_since = func.least(agent_joined.c.at, agent_posted.c.at)
        return cls(
            first_interaction=first_interaction,
            agent_joined=agent_joined,
            agent_posted=agent_posted,
            agent_since=agent_since,
            activated_at=func.greatest(first_interaction.c.first_at, agent_since),
        )


async def newly_active_rooms(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    since: datetime,
    now: datetime | None = None,
) -> list[NewlyActiveRoom]:
    """Rooms that became active after `since`.

    A room becomes active the moment it has both a human message and an agent:
    the later of its earliest human message and the earliest sign of an agent
    (the first agent to join among its current members, or the first agent
    message, whichever came first). Taking the later of the two is what lets a
    room where somebody spoke before any agent was added still be reported,
    once the agent arrives.

    The window is what makes this once-per-room without storing anything: a
    room qualifies only if it became active inside it, and each window starts
    where the last one ended. A room that was already active before `since` is
    skipped for good.

    The cost of that is a room can be reported late — up to one window — and
    cannot be reported at all if the deployment was down when the window that
    covered it would have run. Both are acceptable for a figure nobody reads
    inside a day. Two duplicates are possible. An agent that never posted,
    removed and added back, moves its room's join time later, and the room can
    be reported a second time. And a Slack room that only an integration had
    made active, which releases before integrations stopped counting reported,
    is reported again the first time a person speaks in it.

    One tenant's failure is contained to that tenant, the same as
    `collect_usage`: its rooms are collected into a scratch list first and only
    folded into the result if every query for it succeeds, so a query that
    raises partway through never contributes a partial set of rooms. The
    caller advances its watermark regardless, so a contained tenant's rooms
    for this window are never reported — logged as an error rather than
    crashing the pass.
    """
    moment = now or datetime.now(UTC)
    found: list[NewlyActiveRoom] = []
    tenant_ids = await all_tenant_ids(session_factory)
    failed_tenants: list[str] = []

    for tenant_id in tenant_ids:
        tenant_found: list[NewlyActiveRoom] = []
        try:
            async with tenant_session(session_factory, tenant_id) as session:
                activation = _RoomActivation.of(tenant_id)
                activated_at = activation.activated_at
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
                        activated_at,
                        Room.channel_type,
                        Room.bridge_id,
                        Room.metadata_["created_by_kind"].astext,
                        agent_count,
                    )
                    .join(
                        activation.first_interaction,
                        activation.first_interaction.c.room_id == Room.id,
                    )
                    .outerjoin(
                        activation.agent_joined,
                        activation.agent_joined.c.room_id == Room.id,
                    )
                    .outerjoin(
                        activation.agent_posted,
                        activation.agent_posted.c.room_id == Room.id,
                    )
                    .where(
                        and_(
                            Room.tenant_id == tenant_id,
                            activation.agent_since.is_not(None),
                            activated_at > since,
                            activated_at <= moment,
                        )
                    )
                )

                platforms = await _bridge_platforms(session)
                for (
                    created_at,
                    active_at,
                    channel_type,
                    bridge_id,
                    kind,
                    agents,
                ) in rows:
                    tenant_found.append(
                        NewlyActiveRoom(
                            first_active_at=as_utc(active_at),
                            seconds_since_room_created=max(
                                (active_at - created_at).total_seconds(), 0.0
                            ),
                            bridge_platform=normalise_platform(
                                platforms.get(bridge_id)
                            ),
                            channel_type=normalise_channel_type(channel_type),
                            agent_count=int(agents or 0),
                            created_by_kind=normalise_actor_kind(kind),
                        )
                    )
        except Exception:
            logger.exception(
                "Usage snapshot: failed to collect newly-active rooms for tenant %s",
                tenant_id,
            )
            failed_tenants.append(tenant_id)
            continue
        found.extend(tenant_found)

    if failed_tenants:
        logger.error(
            "Usage snapshot: could not check %d of %d tenant(s) for "
            "newly-active rooms: %s. Any room of theirs that went active in "
            "this window will never be reported as room_became_active: the "
            "next window starts where this one ends.",
            len(failed_tenants),
            len(tenant_ids),
            ", ".join(failed_tenants),
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
    """A bridge type as the catalogue spells it.

    `none` only where there is no bridge at all. A type this build has not
    registered — a connection whose adapter was since removed — is still a
    bridge on some platform, so it is `unknown` rather than a claim that the
    room has no bridge.
    """
    if not platform:
        return "none"
    if messaging_platforms.lookup(platform) is None:
        return "unknown"
    return platform


def normalise_template_kind(kind: str | None) -> str:
    """A template's kind as the catalogue spells it.

    The column is free text, so only the three the product uses are named and
    an operator's own kind reports as `other`.
    """
    return kind if kind in ("room", "group", "agent") else "other"


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

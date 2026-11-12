"""Make Public rooms on private channels Private: a workspace admin's
one-off clean-up after rooms began taking their visibility from their channel.

A room made before that kept the visibility it was created with, so a room
bound to a private channel, a group or a DM can still be Public, showing that
channel's messages to the whole workspace in Switch. `count` and `preview`
say which rooms those are; `apply` makes the ones an admin confirmed Private.

Both read only Switch's own records. A workspace can have hundreds of such
rooms, and a platform call per room per page load would spend the bot's rate
limit, which its everyday work shares, once per pod and per admin. The one
platform call is `ask_platform`, for rooms whose channel type was never
recorded: it is asked for explicitly, a small batch at a time and paced, and
saves each answer on the room, so a channel is asked about once whichever pod
serves the request.

Rooms worth a second look are listed with the reason rather than left out (a
hidden room is one the admin forgets):

- Its channel's members cannot be listed (Telegram; Discord without the
  members intent). A Private room is seen by the people in it, and on such a
  platform the room only knows the people who have posted. The others would
  lose sight of their own room.
- Its channel's type is not recorded (rooms from before it was).
- Its messaging app is not running here.

Nothing here runs on its own: it is an admin action, dry run first.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    Room,
)
from switch_core.db.session_scope import tenant_session
from switch_core.room_policy import PRIVATE_CHANNELS

logger = logging.getLogger(__name__)

#: The history line each room made Private gets. The channel is named as
#: unchanged so nobody reading it on the platform thinks the channel moved.
MADE_PRIVATE_NOTICE = (
    "A workspace admin made this room Private in Switch; the channel is unchanged."
)

#: The most rooms one `ask_platform` asks about. Slack allows about 50
#: channel lookups a minute per workspace, shared with the bot's own work.
ASK_BATCH = 20
#: Seconds between two asks in one batch.
ASK_PAUSE = 0.5
#: Seconds to wait for one answer before stopping the batch.
PLATFORM_TIMEOUT = 10.0
#: The most rooms one `apply` changes.
APPLY_MAX = 200
#: Seconds between two history notices after an apply, so a large batch does
#: not post to every channel at once.
NOTICE_PAUSE = 0.5

#: Channel types worth saving when a platform reports one.
_RECORDABLE = ("channel_public", "channel_private", "group", "direct")

#: Why a listed room starts unticked.
Caution = Literal[
    # The platform cannot list the channel's members.
    "members_not_listed",
    # The channel's type is not recorded: ask the platform, or check by hand.
    "channel_type_not_recorded",
    # The room's messaging app is not running here.
    "bridge_not_connected",
]

#: Why a confirmed room was not changed.
SkipReason = Literal["not_found", "already_private", "archived", "not_eligible"]

#: Why a room asked about got no recorded type.
UnansweredReason = Literal["bridge_not_connected", "could_not_tell"]

#: Why a batch of asks stopped before the end.
StopReason = Literal["rate_limited", "timed_out"]


class _Adapter(Protocol):
    async def get_channel_type(self, channel_id: str) -> str: ...

    def can_list_channel_members(
        self, channel_id: str, channel_type: str | None
    ) -> bool: ...


class _Lifecycle(Protocol):
    def get(self, bridge_id: str) -> Any: ...


class _RoomChanges(Protocol):
    def room_changed(self, tenant_id: str, room_id: str) -> None: ...


class _NoticePoster(Protocol):
    async def __call__(
        self, tenant_id: str, transport_room_id: str, body: str
    ) -> None: ...


@dataclass(frozen=True)
class Candidate:
    room_id: str
    name: str
    bridge_id: str
    bridge_name: str | None
    bridge_type: str | None
    # The recorded type; None when none was recorded.
    channel_type: str | None
    # People Switch counts as in the room: those it found in the channel or
    # who have posted, and Switch Console members.
    people: int
    # Whether the platform can list the channel's members; None when its
    # messaging app is not running here.
    members_listed: bool | None
    cautions: tuple[Caution, ...] = ()

    @property
    def recommended(self) -> bool:
        """Ticked in the preview: nothing about it needs a second look."""
        return not self.cautions


@dataclass
class ApplyResult:
    changed: list[str] = field(default_factory=list)
    skipped: list[tuple[str, SkipReason]] = field(default_factory=list)


@dataclass
class AskResult:
    # Rooms whose type the platform gave and is now recorded.
    answered: list[tuple[str, str]] = field(default_factory=list)
    unanswered: list[tuple[str, UnansweredReason]] = field(default_factory=list)
    # Set when the batch stopped early; the rest were not asked.
    stopped: StopReason | None = None
    # Rooms still without a recorded type after this batch.
    remaining: int = 0


def _candidates() -> Any:
    """Public, unarchived, bridged rooms on a private channel, a group, a DM,
    or a channel of unrecorded type."""
    return select(Room).where(
        Room.read_visibility == "public",
        Room.archived_at.is_(None),
        Room.bridge_id.is_not(None),
        Room.external_channel_id.is_not(None),
        or_(Room.channel_type.is_(None), Room.channel_type.in_(PRIVATE_CHANNELS)),
    )


def _could_be_private(channel_type: str | None) -> bool:
    """A recorded type that is private, or none recorded at all."""
    return channel_type is None or channel_type in PRIVATE_CHANNELS


def _rate_limited(exc: BaseException) -> bool:
    """A platform's refusal for asking too often: Slack's `ratelimited`, or
    an HTTP 429 from any of them."""
    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) == 429:
        return True
    if getattr(exc, "status", None) == 429:
        return True
    try:
        return bool(response is not None and response.get("error") == "ratelimited")
    except Exception:
        return False


async def _people_by_room(
    session: AsyncSession, room_ids: Collection[str]
) -> dict[str, int]:
    """How many people each room has: platform accounts and Switch Console
    members, each counted once."""
    if not room_ids:
        return {}
    platform = (
        select(ClientRoom.room_id, func.count())
        .join(ExternalUser, ExternalUser.client_id == ClientRoom.client_id)
        .where(ClientRoom.room_id.in_(room_ids))
        .group_by(ClientRoom.room_id)
    )
    console = (
        select(ClientRoom.room_id, func.count())
        .join(Client, Client.id == ClientRoom.client_id)
        .where(ClientRoom.room_id.in_(room_ids), Client.type == MEMBER_CLIENT_TYPE)
        .group_by(ClientRoom.room_id)
    )
    counts: dict[str, int] = {}
    for query in (platform, console):
        for room_id, count in (await session.execute(query)).all():
            counts[room_id] = counts.get(room_id, 0) + int(count)
    return counts


async def _bridges(
    session: AsyncSession, bridge_ids: Iterable[str]
) -> dict[str, CollaborationBridge]:
    ids = set(bridge_ids)
    if not ids:
        return {}
    result = await session.execute(
        select(CollaborationBridge).where(CollaborationBridge.id.in_(ids))
    )
    return {bridge.id: bridge for bridge in result.scalars().all()}


#: Notice tasks still running, so they are not collected mid-way.
_notice_tasks: set[asyncio.Task[None]] = set()


class PrivateChannelRooms:
    """The count, the preview, asking the platform, and the change; see the
    module docstring."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        collab_lifecycle: _Lifecycle,
        room_changes: _RoomChanges,
        post_notice: _NoticePoster | None,
        platform_timeout: float = PLATFORM_TIMEOUT,
        ask_pause: float = ASK_PAUSE,
        notice_pause: float = NOTICE_PAUSE,
    ) -> None:
        self._session_factory = session_factory
        self._collab_lifecycle = collab_lifecycle
        self._room_changes = room_changes
        self._post_notice = post_notice
        self._platform_timeout = platform_timeout
        self._ask_pause = ask_pause
        self._notice_pause = notice_pause

    async def count(self, tenant_id: str) -> int:
        """How many rooms `preview` would list. One query; no platform."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            result = await session.execute(
                select(func.count()).select_from(_candidates().subquery())
            )
            return int(result.scalar_one())

    async def preview(self, tenant_id: str) -> list[Candidate]:
        """Every room `count` counts, with what an admin needs to decide.
        Reads only Switch's records; changes nothing."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = list((await session.execute(_candidates())).scalars().all())
            people = await _people_by_room(session, [room.id for room in rooms])
            bridges = await _bridges(
                session, (room.bridge_id for room in rooms if room.bridge_id)
            )

        candidates: list[Candidate] = []
        for room in rooms:
            bridge_id = room.bridge_id or ""
            core = self._collab_lifecycle.get(bridge_id)
            members_listed: bool | None = None
            cautions: list[Caution] = []
            if room.channel_type is None:
                cautions.append("channel_type_not_recorded")
            if core is None:
                cautions.append("bridge_not_connected")
            else:
                members_listed = core.adapter.can_list_channel_members(
                    room.external_channel_id or "", room.channel_type
                )
                if not members_listed:
                    cautions.append("members_not_listed")
            bridge = bridges.get(bridge_id)
            candidates.append(
                Candidate(
                    room_id=room.id,
                    name=room.name,
                    bridge_id=bridge_id,
                    bridge_name=bridge.display_name if bridge else None,
                    bridge_type=bridge.type if bridge else None,
                    channel_type=room.channel_type,
                    people=people.get(room.id, 0),
                    members_listed=members_listed,
                    cautions=tuple(cautions),
                )
            )
        candidates.sort(key=lambda c: (c.recommended, c.name.casefold(), c.room_id))
        return candidates

    async def ask_platform(
        self,
        tenant_id: str,
        room_ids: Collection[str] | None = None,
        *,
        limit: int = ASK_BATCH,
    ) -> AskResult:
        """Ask the platform what kind of channel each of up to `limit` listed
        rooms of unrecorded type is (of `room_ids` when given), and record the
        answer on the room.

        One room at a time, `ask_pause` apart. A rate limit or an answer that
        takes too long stops the batch there: the admin asks again later. A
        room the platform cannot place (a channel it no longer has) stays
        unrecorded and is said so. A type is written only where none is yet,
        so two admins asking at once never overwrite each other.
        """
        result = AskResult()
        async with tenant_session(self._session_factory, tenant_id) as session:
            query = _candidates().where(Room.channel_type.is_(None))
            if room_ids is not None:
                query = query.where(Room.id.in_(list(room_ids)))
            rooms = list(
                (await session.execute(query.order_by(Room.name, Room.id).limit(limit)))
                .scalars()
                .all()
            )

        asked = 0
        for room in rooms:
            core = self._collab_lifecycle.get(room.bridge_id or "")
            if core is None:
                result.unanswered.append((room.id, "bridge_not_connected"))
                continue
            if asked:
                await asyncio.sleep(self._ask_pause)
            asked += 1
            try:
                channel_type = await asyncio.wait_for(
                    core.adapter.get_channel_type(room.external_channel_id or ""),
                    self._platform_timeout,
                )
            except TimeoutError:
                result.stopped = "timed_out"
                break
            except Exception as exc:
                if _rate_limited(exc):
                    result.stopped = "rate_limited"
                    break
                logger.info(
                    "The platform could not say what channel room %s is on: %s",
                    room.id,
                    exc,
                )
                result.unanswered.append((room.id, "could_not_tell"))
                continue
            if channel_type not in _RECORDABLE:
                result.unanswered.append((room.id, "could_not_tell"))
                continue
            async with tenant_session(self._session_factory, tenant_id) as session:
                await session.execute(
                    update(Room)
                    .where(Room.id == room.id, Room.channel_type.is_(None))
                    .values(channel_type=channel_type)
                )
                await session.commit()
            self._room_changes.room_changed(tenant_id, room.id)
            result.answered.append((room.id, channel_type))

        async with tenant_session(self._session_factory, tenant_id) as session:
            remaining = await session.execute(
                select(func.count()).select_from(
                    _candidates().where(Room.channel_type.is_(None)).subquery()
                )
            )
            result.remaining = int(remaining.scalar_one())
        return result

    async def apply(
        self, tenant_id: str, room_ids: Collection[str], *, actor_user_id: str
    ) -> ApplyResult:
        """Make the confirmed rooms Private, and only them; at most
        `APPLY_MAX` at once.

        Each is checked again first, under a row lock, so a room changed since
        the preview is skipped rather than changed twice or against what the
        admin saw: one already Private, archived, unbridged, or now recorded
        as a public channel. A room whose type is not recorded is changed: the
        admin saw it listed and confirmed it.

        Every change and its audit event land in one transaction, and each
        room is announced to whoever is watching it. The history lines follow
        in the background, `notice_pause` apart; one that cannot be posted is
        logged, since the change and its audit event stand without it.
        """
        wanted = list(dict.fromkeys(room_ids))
        if len(wanted) > APPLY_MAX:
            raise ValueError(f"At most {APPLY_MAX} rooms can be changed at once.")
        result = ApplyResult()
        changed: list[Room] = []
        async with tenant_session(self._session_factory, tenant_id) as session:
            found = {
                room.id: room
                for room in (
                    await session.execute(
                        select(Room).where(Room.id.in_(wanted)).with_for_update()
                    )
                )
                .scalars()
                .all()
            }
            for room_id in wanted:
                room = found.get(room_id)
                if room is None:
                    result.skipped.append((room_id, "not_found"))
                elif room.read_visibility == "private":
                    result.skipped.append((room_id, "already_private"))
                elif room.archived_at is not None:
                    result.skipped.append((room_id, "archived"))
                elif (
                    not room.bridge_id
                    or not room.external_channel_id
                    or not _could_be_private(room.channel_type)
                ):
                    result.skipped.append((room_id, "not_eligible"))
                else:
                    room.read_visibility = "private"
                    await record_audit_event(
                        session,
                        tenant_id=tenant_id,
                        actor_user_id=actor_user_id,
                        action=AuditAction.ROOM_MADE_PRIVATE,
                        target_type="room",
                        target_id=room.id,
                        details={
                            "room_name": room.name,
                            "bridge_id": room.bridge_id,
                            "channel_type": room.channel_type,
                            "previous_read_visibility": "public",
                            "source": "private_channel_rooms",
                        },
                    )
                    changed.append(room)
                    result.changed.append(room_id)
            await session.commit()

        for room in changed:
            logger.info(
                "Room %s was made private by %s: its channel is %s",
                room.id,
                actor_user_id,
                room.channel_type or "of an unrecorded type",
            )
            self._room_changes.room_changed(tenant_id, room.id)
        if changed:
            task = asyncio.create_task(
                self._notify_all(
                    tenant_id, [room.transport_room_id for room in changed]
                )
            )
            _notice_tasks.add(task)
            task.add_done_callback(_notice_tasks.discard)
        return result

    async def _notify_all(self, tenant_id: str, transport_room_ids: list[str]) -> None:
        for index, transport_room_id in enumerate(transport_room_ids):
            if index:
                await asyncio.sleep(self._notice_pause)
            await self._notify(tenant_id, transport_room_id)

    async def _notify(self, tenant_id: str, transport_room_id: str) -> None:
        if self._post_notice is None:
            logger.warning(
                "No notice for room %s, made private: nothing here can post one",
                transport_room_id,
            )
            return
        try:
            await self._post_notice(tenant_id, transport_room_id, MADE_PRIVATE_NOTICE)
        except Exception:
            logger.warning(
                "Could not post the made-private notice in room %s",
                transport_room_id,
                exc_info=True,
            )


def notice_poster(client_lifecycle: Any) -> _NoticePoster:
    """Post a room notice as the workspace's admin client, the way Switch's
    other notices are posted. Raises when this process runs none."""
    from switch_core.clients.actor import SystemActor

    async def post(tenant_id: str, transport_room_id: str, body: str) -> None:
        admin = next(
            (
                client
                for client in client_lifecycle.get_by_type("admin", tenant_id)
                if isinstance(client, SystemActor)
            ),
            None,
        )
        if admin is None:
            raise RuntimeError(f"No admin client is running for tenant {tenant_id}")
        await admin.send_admin(
            transport_room_id,
            body,
            message_type=AdminMessageType.ROOM_SETTINGS_NOTICE,
            thread_root_id=None,
        )

    return post

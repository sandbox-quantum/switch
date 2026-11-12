"""Make Public rooms on private channels Private: a workspace admin's
one-off clean-up after rooms began taking their visibility from their channel.

A room made before that kept the visibility it was created with, so a room
bound to a private channel, a group or a DM can still be Public, showing that
channel's messages to the whole workspace in Switch. `preview` lists those
rooms and changes nothing; `apply` makes the ones an admin confirmed Private.

Two things make a room worth a second look before it is changed, and the
preview says which rather than leaving the room out (a hidden room is one the
admin forgets):

- Its channel's members cannot be listed (Telegram; Discord without the
  members intent). A Private room is seen by the people in it, and on such a
  platform the room only knows the people who have posted. The others would
  lose sight of their own room.
- Its channel's type is not recorded (rooms from before it was). The
  platform is asked; when it cannot say, the room is listed as unknown.

Nothing here runs on its own: it is an admin action, dry run first.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from sqlalchemy import func, select
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

#: Seconds to wait for a platform to answer about one channel, so one slow
#: messaging app does not hold up the whole preview.
PLATFORM_TIMEOUT = 10.0

#: Why a listed room starts unticked.
Caution = Literal[
    # The platform cannot list the channel's members.
    "members_not_listed",
    # The channel's type is not recorded and the platform could not say it.
    "channel_type_unknown",
    # The room's messaging app is not connected here, so neither could be asked.
    "bridge_not_connected",
]

#: Why a confirmed room was not changed.
SkipReason = Literal["not_found", "already_private", "archived", "not_eligible"]


class _Adapter(Protocol):
    async def get_channel_type(self, channel_id: str) -> str: ...

    async def can_list_channel_members(self, channel_id: str) -> bool: ...


class _Core(Protocol):
    adapter: _Adapter


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
    # The recorded type, or the platform's answer when none was recorded;
    # None when neither is known.
    channel_type: str | None
    # People Switch counts as in the room: those it found in the channel or
    # who have posted, and Switch Console members.
    people: int
    # Whether the platform can list the channel's members; None when it
    # could not be asked.
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


def _bridged_public_rooms() -> Any:
    return select(Room).where(
        Room.read_visibility == "public",
        Room.archived_at.is_(None),
        Room.bridge_id.is_not(None),
        Room.external_channel_id.is_not(None),
    )


def _could_be_private(channel_type: str | None) -> bool:
    """A recorded type that is private, or none recorded at all."""
    return channel_type is None or channel_type in PRIVATE_CHANNELS


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


class PrivateChannelRooms:
    """The preview and the change; see the module docstring."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        collab_lifecycle: _Lifecycle,
        room_changes: _RoomChanges,
        post_notice: _NoticePoster | None,
        platform_timeout: float = PLATFORM_TIMEOUT,
    ) -> None:
        self._session_factory = session_factory
        self._collab_lifecycle = collab_lifecycle
        self._room_changes = room_changes
        self._post_notice = post_notice
        self._platform_timeout = platform_timeout

    async def _ask(self, call: Any, what: str, room_id: str) -> Any:
        """The platform's answer, or None when it failed or took too long."""
        try:
            return await asyncio.wait_for(call, self._platform_timeout)
        except Exception:
            logger.warning(
                "Could not ask the platform %s for room %s",
                what,
                room_id,
                exc_info=True,
            )
            return None

    async def preview(self, tenant_id: str) -> list[Candidate]:
        """Every unarchived Public room in the workspace bound to a private
        channel, a group or a DM, or to a channel whose type is not recorded
        but which the platform says is private or cannot say. Changes
        nothing, and records nothing, not even a type the platform reported.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = [
                room
                for room in (await session.execute(_bridged_public_rooms()))
                .scalars()
                .all()
                if _could_be_private(room.channel_type)
            ]
            people = await _people_by_room(session, [room.id for room in rooms])
            bridges = await _bridges(
                session, (room.bridge_id for room in rooms if room.bridge_id)
            )

        candidates: list[Candidate] = []
        for room in rooms:
            bridge_id = room.bridge_id or ""
            channel_id = room.external_channel_id or ""
            core = self._collab_lifecycle.get(bridge_id)
            channel_type = room.channel_type
            members_listed: bool | None = None
            cautions: list[Caution] = []
            if core is None:
                cautions.append("bridge_not_connected")
            else:
                if channel_type is None:
                    channel_type = await self._ask(
                        core.adapter.get_channel_type(channel_id),
                        "for its channel's type",
                        room.id,
                    )
                    if channel_type is not None and not _could_be_private(channel_type):
                        # The platform says the channel is public: the room's
                        # visibility already matches it.
                        continue
                    if channel_type is None:
                        cautions.append("channel_type_unknown")
                members_listed = await self._ask(
                    core.adapter.can_list_channel_members(channel_id),
                    "whether it lists its channel's members",
                    room.id,
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
                    channel_type=channel_type,
                    people=people.get(room.id, 0),
                    members_listed=members_listed,
                    cautions=tuple(cautions),
                )
            )
        candidates.sort(key=lambda c: (c.recommended, c.name.casefold(), c.room_id))
        return candidates

    async def apply(
        self, tenant_id: str, room_ids: Collection[str], *, actor_user_id: str
    ) -> ApplyResult:
        """Make the confirmed rooms Private, and only them.

        Each is checked again first, under a row lock, so a room changed since
        the preview is skipped rather than changed twice or against what the
        admin saw: one already Private, archived, unbridged, or now recorded
        as a public channel. A room whose type is not recorded is changed: the
        admin saw it listed and confirmed it.

        Every change and its audit event land in one transaction. Then each
        room is announced to whoever is watching it, and gets its history
        line; a notice that cannot be posted is logged, since the change and
        its audit event stand without it.
        """
        result = ApplyResult()
        wanted = list(dict.fromkeys(room_ids))
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
            await self._notify(tenant_id, room)
        return result

    async def _notify(self, tenant_id: str, room: Room) -> None:
        if self._post_notice is None:
            logger.warning(
                "No notice for room %s, made private: nothing here can post one",
                room.id,
            )
            return
        try:
            await self._post_notice(
                tenant_id, room.transport_room_id, MADE_PRIVATE_NOTICE
            )
        except Exception:
            logger.warning(
                "Could not post the made-private notice in room %s",
                room.id,
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

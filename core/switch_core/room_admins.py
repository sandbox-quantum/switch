"""Making people room admins, and taking it away.

A room's owner, or a workspace admin, may make other people in the room room
admins. A room admin changes the room as its owner does; `room_policy` says
what stays with the owner. Every surface (the gateway routes, the chat
commands, the agent tools) goes through `grant` and `revoke` here, so the
rules on who can be one live in one place:

- only a person, never an agent: grants name a Switch user;
- a current member of the workspace, who takes part in the room;
- not the room's owner, who has every right already.

Leaving the room takes the role away (`RoomStore.prune_admins`), and so does
being handed the room (`accounts/transfer.py`).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core import room_policy
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Room, RoomAdmin, TenantMember, require_tenant_id
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_policy import RoomCaller


class RoomAdminRefused(Exception):
    """A grant or revoke was refused. `status` is the HTTP status that fits;
    the message says why, in plain words."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Standing:
    """Where a person stands in a room: whether they take part in it, and
    whether they are one of its room admins."""

    in_room: bool
    room_admin: bool


async def standing(
    session: AsyncSession, room_store: RoomStore, room_id: str, user_id: str | None
) -> Standing:
    """`Standing` for `user_id` in `room_id`. A caller with no user (an agent
    nobody owns, a chat poster with no linked account) is neither."""
    if user_id is None:
        return Standing(in_room=False, room_admin=False)
    in_room = bool(await room_store.involved_room_ids(session, user_id, [room_id]))
    if not in_room:
        return Standing(in_room=False, room_admin=False)
    room_admin = bool(await room_store.admin_room_ids(session, user_id, [room_id]))
    return Standing(in_room=True, room_admin=room_admin)


async def is_room_admin(
    session: AsyncSession, room_store: RoomStore, room_id: str, user_id: str | None
) -> bool:
    """Whether `user_id` is a room admin of `room_id` right now."""
    if user_id is None:
        return False
    return bool(await room_store.admin_room_ids(session, user_id, [room_id]))


async def list_admins(
    session: AsyncSession, room_store: RoomStore, room_id: str
) -> list[RoomAdmin]:
    """The room's room admins, longest-standing first."""
    return await room_store.list_admins(session, room_id)


def _require_manage(caller: RoomCaller, room: Room) -> None:
    decision = room_policy.decide(caller, room, "manage_admins", owns_target=False)
    if not decision.allowed:
        raise RoomAdminRefused(403, decision.reason or "Not allowed.")


async def grant(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    *,
    caller: RoomCaller,
    user_id: str,
) -> bool:
    """Make `user_id` a room admin of `room`, for `caller`. Returns False when
    they already were one. Raises `RoomAdminRefused` with the reason when
    `caller` may not, or `user_id` can't be one."""
    _require_manage(caller, room)
    tenant_id = require_tenant_id()
    if room.owner_id == user_id:
        raise RoomAdminRefused(
            400, "They own this room, so they can change it already."
        )
    member = await session.get(TenantMember, (tenant_id, user_id))
    if member is None:
        raise RoomAdminRefused(
            400, "Only members of this workspace can be room admins."
        )
    if not await room_store.involved_room_ids(session, user_id, [room.id]):
        raise RoomAdminRefused(
            400,
            "Only people in the room can be room admins. Add them to the room first.",
        )
    added = await room_store.add_admin(
        session, room.id, user_id, granted_by=caller.principal.id
    )
    if added:
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=caller.principal.id,
            action=AuditAction.ROOM_ADMIN_ADDED,
            target_type="room",
            target_id=room.id,
            details={"user_id": user_id},
        )
    return added


async def revoke(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    *,
    caller: RoomCaller,
    user_id: str,
) -> bool:
    """Take `user_id` off `room`'s room admins, for `caller`. Returns False
    when they weren't one. A room admin may always step down themselves;
    otherwise it is the owner's or a workspace admin's to do."""
    stepping_down = (
        caller.owner_rights
        and caller.principal.id is not None
        and caller.principal.id == user_id
    )
    if not stepping_down:
        _require_manage(caller, room)
    removed = await room_store.remove_admin(session, room.id, user_id)
    if removed:
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=caller.principal.id,
            action=AuditAction.ROOM_ADMIN_REMOVED,
            target_type="room",
            target_id=room.id,
            details={"user_id": user_id},
        )
    return removed

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

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core import room_policy
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Room,
    RoomAdmin,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.external_user_store import ExternalUserStore
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
    return await add(session, room_store, room, user_id, by=caller.principal.id)


async def add(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    user_id: str,
    *,
    by: str | None,
    chat_account: str | None = None,
) -> bool:
    """`grant`, for a surface that has already asked the room policy whether
    `by` may (`manage_admins`): the chat commands, which ask it for whoever
    posted. Checks only that `user_id` can be a room admin. `chat_account` is
    the chat account a command came from, recorded beside `by`, which for an
    account several people claim is only the first of them."""
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
    added = await room_store.add_admin(session, room.id, user_id, granted_by=by)
    if added:
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=by,
            action=AuditAction.ROOM_ADMIN_ADDED,
            target_type="room",
            target_id=room.id,
            details=_details(user_id, chat_account),
        )
    return added


def steps_down(caller: RoomCaller, user_id: str) -> bool:
    """Whether `caller` is the room admin `user_id` taking themselves off,
    which they may always do. Not through an agent others can address."""
    return (
        caller.owner_rights
        and caller.principal.id is not None
        and caller.principal.id == user_id
    )


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
    if not steps_down(caller, user_id):
        _require_manage(caller, room)
    return await remove(session, room_store, room, user_id, by=caller.principal.id)


async def remove(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    user_id: str,
    *,
    by: str | None,
    chat_account: str | None = None,
) -> bool:
    """`revoke`, for a surface that has already decided `by` may; `chat_account`
    as for `add`."""
    removed = await room_store.remove_admin(session, room.id, user_id)
    if removed:
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=by,
            action=AuditAction.ROOM_ADMIN_REMOVED,
            target_type="room",
            target_id=room.id,
            details=_details(user_id, chat_account),
        )
    return removed


def _details(user_id: str, chat_account: str | None) -> dict[str, str]:
    details = {"user_id": user_id}
    if chat_account is not None:
        details["chat_account"] = chat_account
    return details


async def find_person(
    session: AsyncSession, room_store: RoomStore, room: Room, name: str
) -> str:
    """The Switch user a chat command means by `name`: someone in the room
    who goes by it on the room's platform and has linked that account to
    Switch, or, in a room with no platform channel (a Switch Console chat), a
    Switch user in it by that name. Switch names aren't unique, so a bridged
    room never falls back to them: a typo must not reach someone else. Raises
    `RoomAdminRefused` saying why when nobody fits, more than one person
    does, or the account isn't linked to exactly one Switch user."""
    wanted = name.strip().lstrip("@").lower()
    if room.bridge_id:
        members = [
            m
            for m in await ExternalUserStore().get_by_room(session, room.id)
            if m.bridge_id == room.bridge_id
            # By name, and by platform id, which is how a mention a platform
            # escaped (Slack's `<@U123>`) arrives.
            and wanted in (m.external_username.lower(), m.external_user_id.lower())
        ]
        if members:
            claims = await ExternalUserStore().claims_for(
                session, [m.id for m in members]
            )
            user_ids = {c.user_id for m in members for c in claims.get(m.id, [])}
            if not user_ids:
                raise RoomAdminRefused(
                    400,
                    f"{name} hasn't linked this chat account to a Switch "
                    "account, so Switch can't tell who they are. They can link "
                    "it in Switch Console.",
                )
            if len(user_ids) > 1:
                raise RoomAdminRefused(
                    400,
                    f"{name}'s chat account is linked to more than one Switch "
                    "account, so Switch can't tell which of them is meant.",
                )
            return user_ids.pop()
        raise RoomAdminRefused(400, f"Nobody in this room goes by `{wanted}`.")
    candidates = (
        await session.scalars(select(User.id).where(func.lower(User.name) == wanted))
    ).all()
    involved = [
        uid
        for uid in candidates
        if await room_store.involved_room_ids(session, uid, [room.id])
    ]
    if len(involved) == 1:
        return involved[0]
    if involved:
        raise RoomAdminRefused(
            400,
            f"More than one person in this room goes by `{wanted}`, so Switch "
            "can't tell which is meant. Use Switch Console or the room's page "
            "instead.",
        )
    raise RoomAdminRefused(400, f"Nobody in this room goes by `{wanted}`.")

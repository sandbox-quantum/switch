"""Names on a workspace's Activity page.

A workspace's admins already see their own people by name, so Activity names
the people an entry is about, and the admin who made a change, instead of
making the admin match keyed ids by hand. Only the workspace's **own members**
are named: a target keyed id is matched by hashing each member's id with the
keyed-id key, and an actor by user id. Operator entries stay "Switch operator"
(no actor id, `actor_kind: "operator"`), so no operator is ever named here.

Without a keyed-id key on this server, targets are left unnamed; nothing falls
back to showing raw ids.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TenantMember, User
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id


class _Entry(Protocol):
    actor_user_id: str | None
    target_type: str
    target_id: str | None
    details: dict[str, Any] | None


async def member_names(session: AsyncSession, tenant_id: str) -> dict[str, str]:
    """User id → name, for the workspace's members only."""
    rows = await session.execute(
        select(User.id, User.name)
        .join(TenantMember, TenantMember.user_id == User.id)
        .where(TenantMember.tenant_id == tenant_id)
    )
    return {user_id: name for user_id, name in rows.all()}


def names_for(
    entries: Iterable[_Entry],
    *,
    members: Mapping[str, str],
    key: KeyedIdKey | None,
) -> list[tuple[str | None, str | None]]:
    """(actor name, target name) for each entry, each None when it isn't one
    of the workspace's own members."""
    by_keyed = (
        {
            key.keyed_id(KeyedIdKind.USER, user_id): name
            for user_id, name in members.items()
        }
        if key is not None
        else {}
    )
    out: list[tuple[str | None, str | None]] = []
    for entry in entries:
        operator = (entry.details or {}).get("actor_kind") == "operator"
        actor = (
            None
            if operator or entry.actor_user_id is None
            else members.get(entry.actor_user_id)
        )
        target: str | None = None
        if entry.target_type == "user" and entry.target_id is not None:
            if is_keyed_id(entry.target_id):
                target = by_keyed.get(entry.target_id)
            else:
                target = members.get(entry.target_id)
        out.append((actor, target))
    return out

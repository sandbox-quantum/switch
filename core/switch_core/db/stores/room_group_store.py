from collections.abc import Sequence
from typing import Protocol

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Room, RoomGroup, require_tenant_id

# Separates the groups in a path such as "Fraud/Incidents": the top-level group
# first, then each child by name. Group names may not contain it, so a path
# always means one thing.
GROUP_PATH_SEPARATOR = "/"


class RoomGroupNameTaken(ValueError):
    """A group with the same name already sits under the same parent (or at
    the top level). Sibling names are unique so that a path names one group."""


class _GroupNode(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def parent_group_id(self) -> str | None: ...


def _same_name(a: str, b: str) -> bool:
    return a.strip().casefold() == b.strip().casefold()


def group_path(group: _GroupNode, by_id: dict[str, _GroupNode]) -> str:
    """The group's root-first path, e.g. "Fraud/Incidents"."""
    names: list[str] = []
    cursor: _GroupNode | None = group
    seen: set[str] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        names.append(cursor.name)
        parent_id = cursor.parent_group_id
        cursor = by_id.get(parent_id) if parent_id is not None else None
    return GROUP_PATH_SEPARATOR.join(reversed(names))


def _or_list(items: Sequence[str]) -> str:
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} or {items[-1]}"


def resolve_group_reference(groups: Sequence[_GroupNode], reference: str) -> str:
    """Resolve a group id, a bare group name, or a path to a group id.

    A path ("Fraud/Incidents") starts at a top-level group and names each child
    in turn; whitespace around each segment is ignored, so the displayed
    "Fraud / Incidents" form works too. A bare name must be unique in the
    tenant; when it is not, the error lists each match by its path, or by
    its id where the path cannot single it out, so the caller can retry with
    one. A path through an ambiguous ancestor is refused the same way, with
    the ids of the groups it could mean. Names match exactly (case-sensitive).

    Raises ValueError when nothing matches or the reference is ambiguous.
    """
    by_id: dict[str, _GroupNode] = {g.id: g for g in groups}
    if reference in by_id:
        return reference
    segments = [s.strip() for s in reference.split(GROUP_PATH_SEPARATOR)]
    if any(not s for s in segments):
        raise ValueError(
            f"Room group path '{reference}' has an empty segment; write a path "
            "as 'Parent/Child'"
        )

    if len(segments) == 1:
        matches = [g for g in groups if g.name.strip() == segments[0]]
        if not matches:
            raise ValueError(f"No room group named '{reference}'")
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous room group '{reference}': use "
                f"{_or_list(_ways_to_name(matches, by_id))}"
            )
        return matches[0].id

    # Every group the path so far could mean: one, unless a legacy duplicate
    # on the way has made an ancestor ambiguous.
    candidates: list[_GroupNode] = []
    ambiguous_ancestor: str | None = None
    for i, segment in enumerate(segments):
        parent_ids: set[str | None] = {g.id for g in candidates} if i else {None}
        children = [
            g
            for g in groups
            if g.parent_group_id in parent_ids and g.name.strip() == segment
        ]
        if not i:
            where = "at the top level"
        elif len(candidates) == 1:
            where = f"under '{group_path(candidates[0], by_id)}'"
        else:
            where = (
                f"under any of the {len(candidates)} groups at "
                f"'{group_path(candidates[0], by_id)}'"
            )
        if not children:
            raise ValueError(
                f"No room group '{reference}': there is no group named "
                f"'{segment}' {where}"
            )
        if len(children) > 1 and i < len(segments) - 1 and ambiguous_ancestor is None:
            ambiguous_ancestor = (
                f"{len(children)} groups are named '{segment}' {where}, so the "
                "path does not single out one group"
            )
        candidates = children

    if ambiguous_ancestor is not None:
        ways = _or_list([f"'{group_path(g, by_id)}' (id '{g.id}')" for g in candidates])
        which = "its id" if len(candidates) == 1 else "the id of the one you mean"
        raise ValueError(
            f"Ambiguous room group '{reference}': {ambiguous_ancestor}; pass "
            f"{which} instead: {ways}"
        )
    if len(candidates) > 1:
        ids = _or_list([f"'{g.id}'" for g in candidates])
        raise ValueError(
            f"Ambiguous room group '{reference}': {len(candidates)} groups are "
            f"named '{segments[-1]}' {where}; pass one of their ids instead: {ids}"
        )
    return candidates[0].id


def _ways_to_name(
    matches: Sequence[_GroupNode], by_id: dict[str, _GroupNode]
) -> list[str]:
    """How to name each of several same-named groups: its path, or its id
    where the path cannot single it out (a sibling with the same name, or a
    name on the way that contains the separator, both left from before sibling
    names were unique). A top-level match is named by its id: its path is the
    bare name that was ambiguous in the first place."""
    paths = {g.id: group_path(g, by_id) for g in matches}
    out: list[str] = []
    for g in sorted(matches, key=lambda m: (paths[m.id] == m.name, paths[m.id])):
        path = paths[g.id]
        shared = sum(1 for p in paths.values() if p == path) > 1
        if path == g.name:
            out.append(f"id '{g.id}' for the top-level '{path}'")
        elif shared or _has_separator_on_path(g, by_id):
            out.append(f"'{path}' (id '{g.id}')")
        else:
            out.append(f"'{path}'")
    return out


def _has_separator_on_path(group: _GroupNode, by_id: dict[str, _GroupNode]) -> bool:
    cursor: _GroupNode | None = group
    seen: set[str] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        if GROUP_PATH_SEPARATOR in cursor.name:
            return True
        parent_id = cursor.parent_group_id
        cursor = by_id.get(parent_id) if parent_id is not None else None
    return False


def _check_new_name(name: str) -> None:
    if not name.strip():
        raise ValueError("A room group name cannot be empty")
    if GROUP_PATH_SEPARATOR in name:
        raise ValueError(
            f"A room group name cannot contain '{GROUP_PATH_SEPARATOR}': it "
            "separates the groups in a path such as 'Fraud/Incidents'"
        )


class RoomGroupStore:
    """Storage for room groups (`room_groups`), a named tree of organizational
    groups that rooms can belong to.

    Groups nest via `parent_group_id` (a self-reference). The store enforces the
    tree invariant — no group may be its own ancestor — and implements
    promote-on-delete: deleting a group reparents its children to the deleted
    group's parent (member rooms become standalone via the `ON DELETE SET NULL`
    foreign key on `rooms.group_id`).

    It also keeps sibling names unique (case-insensitively, ignoring outer
    whitespace) and refuses names containing the path separator, so a path
    such as "Fraud/Incidents" names exactly one group. Both are checked here
    rather than by a database constraint, because tenants may already hold
    sibling duplicates from before the rule; those keep working and are
    reached by id.
    """

    async def create(
        self,
        session: AsyncSession,
        *,
        name: str,
        description: str | None,
        color: str | None,
        parent_group_id: str | None,
    ) -> RoomGroup:
        _check_new_name(name)
        if parent_group_id is not None:
            parent = await session.get(RoomGroup, parent_group_id)
            if parent is None:
                raise ValueError(f"Parent group not found: {parent_group_id}")
        await self._refuse_sibling_named(
            session, name, parent_group_id, moving_group_id=None
        )
        group = RoomGroup(
            name=name,
            description=description,
            color=color,
            parent_group_id=parent_group_id,
        )
        session.add(group)
        await session.flush()
        return group

    async def get(self, session: AsyncSession, group_id: str) -> RoomGroup | None:
        return await session.get(RoomGroup, group_id)

    async def get_all(self, session: AsyncSession) -> list[RoomGroup]:
        result = await session.execute(select(RoomGroup).order_by(RoomGroup.created_at))
        return list(result.scalars().all())

    async def resolve(self, session: AsyncSession, reference: str) -> str:
        """Resolve a group id, bare name or path to a group id (see
        `resolve_group_reference`). Raises ValueError when unknown or
        ambiguous."""
        return resolve_group_reference(await self.get_all(session), reference)

    async def update_fields(
        self,
        session: AsyncSession,
        group_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        color: str | None = None,
        parent_group_id: str | None = None,
        reparent: bool = False,
    ) -> RoomGroup:
        """Update a group's fields.

        `parent_group_id` is only applied when `reparent=True`, so that callers
        can distinguish "make this group top-level" (`parent_group_id=None,
        reparent=True`) from "leave the parent unchanged" (`reparent=False`).
        Reparenting validates that the new parent does not create a cycle.
        """
        # Lock before reading the group: a rename or reparent committed while
        # we wait would otherwise leave us checking sibling names under a
        # parent, or against a name, the group no longer has.
        await self._lock_names(session)
        group = await session.get(RoomGroup, group_id, populate_existing=True)
        if group is None:
            raise ValueError(f"Room group not found: {group_id}")
        renamed = name is not None and name != group.name
        if renamed:
            assert name is not None
            _check_new_name(name)
        if reparent:
            await self._validate_reparent(session, group_id, parent_group_id)
        new_parent = parent_group_id if reparent else group.parent_group_id
        if renamed or new_parent != group.parent_group_id:
            await self._refuse_sibling_named(
                session,
                name if name is not None else group.name,
                new_parent,
                moving_group_id=group_id,
            )
        if name is not None:
            group.name = name
        if description is not None:
            group.description = description
        if color is not None:
            group.color = color
        if reparent:
            group.parent_group_id = parent_group_id
        await session.flush()
        return group

    async def delete(self, session: AsyncSession, group_id: str) -> bool:
        """Delete a group, promoting its children to the group's own parent.

        Member rooms become standalone automatically (`rooms.group_id` is
        `ON DELETE SET NULL`). Returns False if the group does not exist.
        Raises `RoomGroupNameTaken` when a child would land next to a group
        with its name.
        """
        # Lock before reading the group: a rename or reparent committed while
        # we wait would otherwise leave us promoting children under a parent
        # the group no longer has.
        await self._lock_names(session)
        group = await session.get(RoomGroup, group_id, populate_existing=True)
        if group is None:
            return False
        await self._refuse_promotion_clash(session, group)
        # Promote direct children to this group's parent before deleting, so the
        # FK's SET NULL behaviour (which would orphan them to top-level) is
        # superseded by the parent we choose here.
        await session.execute(
            update(RoomGroup)
            .where(RoomGroup.parent_group_id == group_id)
            .values(parent_group_id=group.parent_group_id)
        )
        await session.delete(group)
        await session.flush()
        return True

    async def _lock_names(self, session: AsyncSession) -> None:
        """Serialise the tenant's group-name changes until the transaction
        ends, so two concurrent creates cannot both see a free name."""
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": f"room-group-names:{require_tenant_id()}"},
        )

    async def _siblings(
        self, session: AsyncSession, parent_group_id: str | None
    ) -> list[RoomGroup]:
        parent_clause = (
            RoomGroup.parent_group_id.is_(None)
            if parent_group_id is None
            else RoomGroup.parent_group_id == parent_group_id
        )
        # Names as committed, not as this session last loaded them: another
        # session may have renamed a sibling before we took the lock.
        result = await session.execute(
            select(RoomGroup)
            .where(parent_clause)
            .execution_options(populate_existing=True)
        )
        return list(result.scalars().all())

    async def _where(self, session: AsyncSession, parent_group_id: str | None) -> str:
        if parent_group_id is None:
            return "at the top level"
        by_id: dict[str, _GroupNode] = {g.id: g for g in await self.get_all(session)}
        parent = by_id.get(parent_group_id)
        if parent is None:
            return f"under group {parent_group_id}"
        return f"under '{group_path(parent, by_id)}'"

    async def _refuse_sibling_named(
        self,
        session: AsyncSession,
        name: str,
        parent_group_id: str | None,
        *,
        moving_group_id: str | None,
    ) -> None:
        """Raise `RoomGroupNameTaken` if a group other than `moving_group_id`
        already has `name` under `parent_group_id`."""
        await self._lock_names(session)
        for sibling in await self._siblings(session, parent_group_id):
            if sibling.id != moving_group_id and _same_name(sibling.name, name):
                raise RoomGroupNameTaken(
                    f"A room group named '{sibling.name}' already exists "
                    f"{await self._where(session, parent_group_id)}"
                )

    async def _refuse_promotion_clash(
        self, session: AsyncSession, group: RoomGroup
    ) -> None:
        await self._lock_names(session)
        children = await self._siblings(session, group.id)
        if not children:
            return
        staying = [
            g
            for g in await self._siblings(session, group.parent_group_id)
            if g.id != group.id
        ]
        for child in children:
            for other in staying:
                if _same_name(child.name, other.name):
                    where = (
                        "to the top level"
                        if group.parent_group_id is None
                        else await self._where(session, group.parent_group_id)
                    )
                    raise RoomGroupNameTaken(
                        f"Cannot delete room group '{group.name}': its subgroup "
                        f"'{child.name}' would move {where}, where a group named "
                        f"'{other.name}' already exists. Rename or move one of "
                        "them first"
                    )

    async def _validate_reparent(
        self, session: AsyncSession, group_id: str, parent_group_id: str | None
    ) -> None:
        if parent_group_id is None:
            return
        if parent_group_id == group_id:
            raise ValueError("A group cannot be its own parent")
        # Read fresh, under the lock `update_fields` holds: a move another
        # session committed must count, or two crossing moves make a cycle.
        parent = await session.get(RoomGroup, parent_group_id, populate_existing=True)
        if parent is None:
            raise ValueError(f"Parent group not found: {parent_group_id}")
        # Walk up from the proposed parent; if we reach `group_id`, the new
        # parent is a descendant of the group, which would create a cycle.
        cursor: str | None = parent_group_id
        seen: set[str] = set()
        while cursor is not None:
            if cursor == group_id:
                raise ValueError(
                    "Cannot reparent a group under one of its own descendants"
                )
            if cursor in seen:
                break
            seen.add(cursor)
            ancestor = await session.get(RoomGroup, cursor, populate_existing=True)
            cursor = ancestor.parent_group_id if ancestor else None

    async def get_room_counts(self, session: AsyncSession) -> dict[str, int]:
        """Return a mapping of group_id → number of rooms directly in that group."""
        result = await session.execute(
            select(Room.group_id, func.count(Room.id))
            .where(Room.group_id.is_not(None))
            .group_by(Room.group_id)
        )
        return {gid: count for gid, count in result.all() if gid is not None}

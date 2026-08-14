"""Declarative provisioning of a multi-room engagement from YAML.

An *engagement* is a room group plus a set of rooms and the directed links
between them — the reusable shape behind a team's room network (e.g. a
workforce hub that delegates work out to feature / bug hubs). It builds on the
single-room provisioning in :mod:`switch_core.rooms_yaml`: each room is a
:class:`~switch_core.rooms_yaml.RoomSpec` provisioned via
:meth:`RoomYamlService.provision_room`, filed under a freshly created group,
then wired together with cross-room links.

Provisioning is preflight-then-group-then-rooms-then-links: agent and bridge
names are validated across every room up front (fail loud before anything is
created, so a typo does not leave an orphan group), then the group and rooms
are created, then links are attached best-effort — per-room attachment
failures and link failures are collected into the result rather than silently
dropped.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import yaml
from pydantic import BaseModel, ValidationError, model_validator

from switch_core.rooms_yaml import ProvisionResult, RoomSpec

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.resource.service import ResourceService
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.collaboration_bridge_store import (
        CollaborationBridgeStore,
    )
    from switch_core.db.stores.room_group_store import RoomGroupStore
    from switch_core.rooms_yaml import RoomYamlService

logger = logging.getLogger(__name__)


# ── Spec models ───────────────────────────────────────────────────────────


class GroupSpec(BaseModel):
    """The room group that holds the engagement. ``parent`` names an existing
    group to nest under (resolved by name); omit for a top-level group."""

    model_config = {"extra": "forbid"}
    name: str
    description: str | None = None
    color: str | None = None
    parent: str | None = None


class EngagementRoomSpec(RoomSpec):
    """A room in an engagement: a standard :class:`RoomSpec` plus a stable
    ``key`` used to reference it from ``links``, and the per-room extras the
    single-room spec does not carry (join-event listeners, agent aliases)."""

    key: str
    join_event_listeners: list[str] = []
    aliases: dict[str, str] = {}


class LinkSpec(BaseModel):
    """A directed pointer from one engagement room to another. ``from`` / ``to``
    are room ``key`` values; ``label`` is the relationship hint shown to
    participants."""

    model_config = {"extra": "forbid", "populate_by_name": True}
    from_key: str
    to_key: str
    label: str

    @model_validator(mode="before")
    @classmethod
    def _accept_from_to(cls, data: Any) -> Any:
        # `from` is a Python keyword, so the YAML keys `from`/`to` are mapped
        # onto `from_key`/`to_key` here rather than via field aliases.
        if isinstance(data, dict):
            data = dict(data)
            if "from" in data:
                data["from_key"] = data.pop("from")
            if "to" in data:
                data["to_key"] = data.pop("to")
        return data


class EngagementSpec(BaseModel):
    model_config = {"extra": "forbid"}
    group: GroupSpec
    rooms: list[EngagementRoomSpec]
    links: list[LinkSpec] = []

    @model_validator(mode="after")
    def _validate(self) -> EngagementSpec:
        if not self.rooms:
            raise ValueError("engagement must define at least one room")
        keys = [r.key for r in self.rooms]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            raise ValueError(f"duplicate room keys: {', '.join(dupes)}")
        known = set(keys)
        for link in self.links:
            for side, key in (("from", link.from_key), ("to", link.to_key)):
                if key not in known:
                    raise ValueError(f"link {side} references unknown room key {key!r}")
            if link.from_key == link.to_key:
                raise ValueError(
                    f"link cannot point a room at itself: {link.from_key!r}"
                )
        for room in self.rooms:
            if room.users and room.bridge is None:
                raise ValueError(
                    f"room {room.key!r} attaches users but has no bridge "
                    "(users live on a collaboration bridge)"
                )
        return self


class EngagementProvisionResult(BaseModel):
    group_id: str
    group_name: str
    rooms: list[ProvisionResult] = []
    created_links: list[dict[str, str]] = []
    failed_links: list[dict[str, str]] = []


class EngagementYamlService:
    """Parse / provision a multi-room engagement as YAML. Free of HTTP concerns
    so it is unit-testable and reusable for MCP / CLI surfaces. Delegates each
    room to :class:`RoomYamlService` and only adds the group + links on top."""

    def __init__(
        self,
        *,
        room_yaml: RoomYamlService,
        room_group_store: RoomGroupStore,
        resource_service: ResourceService,
        agent_store: AgentStore,
        bridge_store: CollaborationBridgeStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._room_yaml = room_yaml
        self._groups = room_group_store
        self._resources = resource_service
        self._agent_store = agent_store
        self._bridge_store = bridge_store
        self._session_factory = session_factory

    # ── Parse ─────────────────────────────────────────────────────────────

    def parse(self, text: str) -> EngagementSpec:
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML: {e}") from e
        if not isinstance(data, dict) or "engagement" not in data:
            raise ValueError("YAML must have a single top-level 'engagement:' mapping")
        try:
            return EngagementSpec.model_validate(data["engagement"])
        except ValidationError as e:
            raise ValueError(f"Invalid engagement spec: {e}") from e

    # ── Provision ─────────────────────────────────────────────────────────

    async def provision(
        self, spec: EngagementSpec, *, user_id: str, is_admin: bool
    ) -> EngagementProvisionResult:
        await self._preflight(spec)

        parent_id = await self._resolve_parent_group_id(spec.group.parent)
        async with self._session_factory() as session:
            group = await self._groups.create(
                session,
                name=spec.group.name,
                description=spec.group.description,
                color=spec.group.color,
                parent_group_id=parent_id,
            )
            await session.commit()
            group_id, group_name = group.id, group.name

        key_to_room_id: dict[str, str] = {}
        room_results: list[ProvisionResult] = []
        for room in spec.rooms:
            result = await self._room_yaml.provision_room(
                room,
                user_id=user_id,
                is_admin=is_admin,
                group_id=group_id,
                join_event_listeners=room.join_event_listeners or None,
                aliases=room.aliases or None,
            )
            room_results.append(result)
            key_to_room_id[room.key] = result.room_id

        created_links, failed_links = await self._create_links(
            spec.links, key_to_room_id
        )

        return EngagementProvisionResult(
            group_id=group_id,
            group_name=group_name,
            rooms=room_results,
            created_links=created_links,
            failed_links=failed_links,
        )

    async def _preflight(self, spec: EngagementSpec) -> None:
        """Fail loud on bad agent / bridge names across every room before we
        create the group, so a typo does not leave a half-built engagement."""
        bridge_names = {r.bridge for r in spec.rooms if r.bridge is not None}
        agent_names = sorted({n for r in spec.rooms for n in r.agents})
        async with self._session_factory() as session:
            if bridge_names:
                bridges = await self._bridge_store.get_all(session)
                by_name: dict[str, int] = {}
                for b in bridges:
                    by_name[b.display_name] = by_name.get(b.display_name, 0) + 1
                for name in sorted(bridge_names):
                    count = by_name.get(name, 0)
                    if count == 0:
                        raise ValueError(f"Unknown bridge: {name!r}")
                    if count > 1:
                        raise ValueError(
                            f"Ambiguous bridge name {name!r}: {count} bridges match"
                        )
            if agent_names:
                found = await self._agent_store.get_by_names(session, agent_names)
                found_names = {a.name for a in found}
                missing = [n for n in agent_names if n not in found_names]
                if missing:
                    raise ValueError(f"Unknown agents: {', '.join(missing)}")

    async def _resolve_parent_group_id(self, parent_name: str | None) -> str | None:
        if parent_name is None:
            return None
        async with self._session_factory() as session:
            groups = await self._groups.get_all(session)
        matches = [g for g in groups if g.name == parent_name]
        if not matches:
            raise ValueError(f"Unknown parent group: {parent_name!r}")
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous parent group name {parent_name!r}: "
                f"{len(matches)} groups match"
            )
        return matches[0].id

    async def _create_links(
        self, links: list[LinkSpec], key_to_room_id: dict[str, str]
    ) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        created: list[dict[str, str]] = []
        failed: list[dict[str, str]] = []
        # Each link gets its own session so one failure (e.g. a duplicate link)
        # is isolated and does not roll back the links that succeeded.
        for link in links:
            source_id = key_to_room_id[link.from_key]
            target_id = key_to_room_id[link.to_key]
            try:
                async with self._session_factory() as session:
                    await self._resources.attach_linked_room(
                        session,
                        source_room_id=source_id,
                        target_room_id=target_id,
                        label=link.label,
                    )
                    await session.commit()
                created.append(
                    {"from": link.from_key, "to": link.to_key, "label": link.label}
                )
            except Exception as e:
                failed.append(
                    {"from": link.from_key, "to": link.to_key, "error": str(e)}
                )
        return created, failed

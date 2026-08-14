"""Declarative provisioning of a single room from YAML, and export back.

This is the first step toward configurable room-network packages.
v1 is deliberately a single-room bootstrap tool: one ``room:`` mapping is parsed
into a fully-resolved :class:`RoomSpec` (no parameters / no templating), then
provisioned in one shot on top of the existing :class:`RoomService.create_room`
primitive. Export is the inverse: a live room is read back into the same
surface so it round-trips.

Provisioning is room-first and best-effort: the room is created first (which
fails loud on bad agents / refs / config), then inline references and docs are
attached, with any post-creation failures collected into ``failed_attachments``
rather than silently dropped.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal, cast

import yaml
from pydantic import BaseModel, ValidationError, model_validator

from switch_core.bridges.collaboration.models import ChannelType
from switch_core.bridges.resource.registry import validate_reference_value
from switch_core.room_service import RoleSpec, RoomCreateConfig

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.resource.service import ResourceService
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.collaboration_bridge_store import (
        CollaborationBridgeStore,
    )
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)


# ── Spec models ───────────────────────────────────────────────────────────
#
# An external reference in a room spec is one of three distinct shapes. They
# are kept as separate models (rather than one model with a discriminating
# validator) so each carries exactly its own fields; ``extra="forbid"`` makes
# the union unambiguous — the presence of ``id`` / ``name`` / ``type`` selects
# the variant.


class ExistingReferenceById(BaseModel):
    """Attach an existing external reference by id (exact, unambiguous)."""

    model_config = {"extra": "forbid"}
    id: str


class ExistingReferenceByName(BaseModel):
    """Attach an existing external reference by name (resolved over the
    caller's owned + public references; ambiguity is an error)."""

    model_config = {"extra": "forbid"}
    name: str


class InlineExternalReference(BaseModel):
    """Define a brand-new external reference inline; always creates one. Mirrors
    the fields of ``ResourceService.create_reference`` for an external ref."""

    model_config = {"extra": "forbid"}
    type: str
    name: str
    description: str
    instructions: str
    value: dict[str, Any]
    read_visibility: str = "private"
    write_visibility: str = "private"

    @model_validator(mode="after")
    def _validate_value(self) -> InlineExternalReference:
        # Validate the value bag against the type's schema now, so a bad inline
        # reference fails at parse time rather than mid-provision.
        self.value = validate_reference_value(self.type, self.value)
        return self


ExternalReferenceEntry = (
    ExistingReferenceById | ExistingReferenceByName | InlineExternalReference
)


class DocSpec(BaseModel):
    name: str
    description: str
    instructions: str
    content: str


class RoomSpec(BaseModel):
    name: str
    description: str
    instructions: str | None = None
    # Collaboration bridge display name; omit for an internal-only room.
    bridge: str | None = None
    channel_type: Literal["channel_public", "channel_private"] = "channel_public"
    read_visibility: str = "public"
    write_visibility: str = "public"
    agents: list[str] = []
    users: list[str] = []
    roles: list[RoleSpec] = []
    references: list[ExternalReferenceEntry] = []
    docs: list[DocSpec] = []


class ProvisionResult(BaseModel):
    room_id: str
    room_name: str
    attached_reference_ids: list[str] = []
    created_reference_ids: list[str] = []
    created_document_ids: list[str] = []
    role_names: list[str] = []
    failed_attachments: list[dict[str, Any]] = []


# ── YAML literal-block dumper (keeps multiline doc content readable) ────────


class _SpecDumper(yaml.SafeDumper):
    pass


def _str_representer(dumper: yaml.SafeDumper, data: str) -> Any:
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_SpecDumper.add_representer(str, _str_representer)


class RoomYamlService:
    """Parse / provision / export a single room as YAML. Free of HTTP concerns
    so it is unit-testable and reusable for future MCP / CLI surfaces."""

    def __init__(
        self,
        *,
        room_service: RoomService,
        resource_service: ResourceService,
        room_store: RoomStore,
        agent_store: AgentStore,
        bridge_store: CollaborationBridgeStore,
        external_user_store: ExternalUserStore,
        room_role_store: RoomRoleStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._rooms = room_service
        self._resources = resource_service
        self._room_store = room_store
        self._agent_store = agent_store
        self._bridge_store = bridge_store
        self._external_users = external_user_store
        self._room_roles = room_role_store
        self._session_factory = session_factory

    # ── Parse ─────────────────────────────────────────────────────────────

    def parse(self, text: str) -> RoomSpec:
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML: {e}") from e
        if not isinstance(data, dict) or "room" not in data:
            raise ValueError("YAML must have a single top-level 'room:' mapping")
        try:
            return RoomSpec.model_validate(data["room"])
        except ValidationError as e:
            raise ValueError(f"Invalid room spec: {e}") from e

    # ── Provision ───────────────────────────────────────────────────────────

    async def provision(
        self, spec: RoomSpec, *, user_id: str, is_admin: bool
    ) -> ProvisionResult:
        """Provision a single standalone room (no group / listeners / aliases)."""
        return await self.provision_room(
            spec,
            user_id=user_id,
            is_admin=is_admin,
            group_id=None,
            join_event_listeners=None,
            aliases=None,
        )

    async def provision_room(
        self,
        spec: RoomSpec,
        *,
        user_id: str,
        is_admin: bool,
        group_id: str | None,
        join_event_listeners: list[str] | None,
        aliases: dict[str, str] | None,
    ) -> ProvisionResult:
        """Provision one room from a spec, optionally filed under a group with
        join-event listeners and agent aliases. This is the reusable per-room
        primitive the engagement provisioner builds on; ``provision`` is the
        standalone single-room wrapper. Cross-room links are attached by the
        caller after all rooms exist (target ids do not exist until then)."""
        bridge_id = await self._resolve_bridge_id(spec.bridge)
        if spec.users and bridge_id is None:
            raise ValueError(
                "Cannot attach users to a room with no bridge "
                "(users live on a collaboration bridge)"
            )

        attached_ref_ids, inline_refs = await self._resolve_references(
            spec.references, user_id=user_id, is_admin=is_admin
        )

        config = RoomCreateConfig(
            name=spec.name,
            description=spec.description,
            instructions=spec.instructions,
            channel_type=cast(ChannelType, spec.channel_type),
            agent_names=spec.agents or None,
            user_names=spec.users or None,
            bridge_id=bridge_id,
            created_by=user_id,
            owner_id=user_id,
            acting_user_id=user_id,
            acting_is_admin=is_admin,
            read_visibility=spec.read_visibility,
            write_visibility=spec.write_visibility,
            roles=spec.roles or None,
            reference_ids=attached_ref_ids or None,
            group_id=group_id,
            join_event_listeners=join_event_listeners,
            aliases=aliases,
        )
        result = await self._rooms.create_room(config)
        room_id = result.room.id
        failures: list[dict[str, Any]] = list(result.failed_attachments)

        created_ref_ids = await self._create_inline_references(
            room_id, inline_refs, user_id=user_id, is_admin=is_admin, failures=failures
        )
        created_doc_ids = await self._create_inline_docs(
            room_id, spec.docs, user_id=user_id, failures=failures
        )

        return ProvisionResult(
            room_id=room_id,
            room_name=result.room.name,
            attached_reference_ids=attached_ref_ids,
            created_reference_ids=created_ref_ids,
            created_document_ids=created_doc_ids,
            role_names=[r.name for r in spec.roles],
            failed_attachments=failures,
        )

    async def _resolve_bridge_id(self, bridge_name: str | None) -> str | None:
        if bridge_name is None:
            return None
        async with self._session_factory() as session:
            bridges = await self._bridge_store.get_all(session)
        matches = [b for b in bridges if b.display_name == bridge_name]
        if not matches:
            raise ValueError(f"Unknown bridge: {bridge_name!r}")
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous bridge name {bridge_name!r}: {len(matches)} bridges match"
            )
        return matches[0].id

    async def _resolve_references(
        self, entries: list[ExternalReferenceEntry], *, user_id: str, is_admin: bool
    ) -> tuple[list[str], list[InlineExternalReference]]:
        """Resolve attach-existing references up front (fail loud on missing /
        ambiguous / no-access). Returns (attach-existing ids, inline entries)."""
        attached_ids: list[str] = []
        inline: list[InlineExternalReference] = []
        async with self._session_factory() as session:
            visible = await self._resources.list_references_for_user(session, user_id)
            by_name: dict[str, list[str]] = {}
            for ref in visible:
                by_name.setdefault(ref.name, []).append(ref.id)
            for entry in entries:
                if isinstance(entry, ExistingReferenceById):
                    # Raises if missing or the user cannot read it.
                    await self._resources.get_reference_for_user(
                        session, entry.id, user_id, is_admin=is_admin
                    )
                    attached_ids.append(entry.id)
                elif isinstance(entry, ExistingReferenceByName):
                    matches = by_name.get(entry.name, [])
                    if not matches:
                        raise ValueError(
                            f"No reference named {entry.name!r} is accessible"
                        )
                    if len(matches) > 1:
                        raise ValueError(
                            f"Ambiguous reference name {entry.name!r}: "
                            f"{len(matches)} matches; attach by 'id' instead"
                        )
                    attached_ids.append(matches[0])
                else:
                    inline.append(entry)
        return attached_ids, inline

    async def _create_inline_references(
        self,
        room_id: str,
        entries: list[InlineExternalReference],
        *,
        user_id: str,
        is_admin: bool,
        failures: list[dict[str, Any]],
    ) -> list[str]:
        created: list[str] = []
        async with self._session_factory() as session:
            for entry in entries:
                try:
                    ref = await self._resources.create_reference(
                        session,
                        owner_id=user_id,
                        read_visibility=entry.read_visibility,
                        write_visibility=entry.write_visibility,
                        type=entry.type,
                        name=entry.name,
                        description=entry.description,
                        instructions=entry.instructions,
                        value=entry.value,
                    )
                    await self._resources.attach_reference_to_room(
                        session, room_id, ref.id, user_id=user_id, is_admin=is_admin
                    )
                    created.append(ref.id)
                except Exception as e:
                    failures.append(
                        {"kind": "reference", "id": entry.name, "error": str(e)}
                    )
            await session.commit()
        return created

    async def _create_inline_docs(
        self,
        room_id: str,
        docs: list[DocSpec],
        *,
        user_id: str,
        failures: list[dict[str, Any]],
    ) -> list[str]:
        created: list[str] = []
        async with self._session_factory() as session:
            for doc in docs:
                try:
                    created_doc = await self._resources.create_room_document_for_user(
                        session,
                        room_id=room_id,
                        owner_id=user_id,
                        name=doc.name,
                        description=doc.description,
                        instructions=doc.instructions,
                        content=doc.content,
                    )
                    created.append(created_doc.id)
                except Exception as e:
                    failures.append(
                        {"kind": "document", "id": doc.name, "error": str(e)}
                    )
            await session.commit()
        return created

    # ── Export ────────────────────────────────────────────────────────────

    async def export(
        self,
        room_id: str,
        *,
        agents: bool = True,
        users: bool = True,
        references: bool = True,
        docs: bool = True,
        roles: bool = True,
    ) -> str:
        """Read a live room back into the import surface and dump it to YAML.

        References export as attach-by-``id``. Only room-scoped documents are
        exported (as inline docs) — they are the only docs the import surface
        can recreate. Each section can be dropped via its toggle.
        """
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            bridge_display_name: str | None = None
            if room.bridge_id:
                bridge = await self._bridge_store.get(session, room.bridge_id)
                if bridge:
                    bridge_display_name = bridge.display_name

            name = room.name
            if bridge_display_name and name.startswith(f"{bridge_display_name}: "):
                name = name[len(bridge_display_name) + 2 :]

            data: dict[str, Any] = {
                "name": name,
                "description": room.description,
            }
            if room.instructions:
                data["instructions"] = room.instructions
            if bridge_display_name:
                data["bridge"] = bridge_display_name
            data["channel_type"] = room.channel_type
            data["read_visibility"] = room.read_visibility
            data["write_visibility"] = room.write_visibility

            if agents:
                agent_ids = await self._room_store.get_agent_ids(session, room.id)
                names: list[str] = []
                for aid in agent_ids:
                    agent = await self._agent_store.get(session, aid)
                    if agent is not None:
                        names.append(agent.name)
                if names:
                    data["agents"] = sorted(names)

            if users and room.bridge_id:
                client_ids = await self._room_store.get_client_ids(session, room.id)
                ext_users = await self._external_users.get_by_bridge(
                    session, room.bridge_id
                )
                client_to_name = {
                    eu.client_id: eu.external_username for eu in ext_users
                }
                user_names = sorted(
                    client_to_name[cid] for cid in client_ids if cid in client_to_name
                )
                if user_names:
                    data["users"] = user_names

            if roles:
                role_rows = await self._room_roles.list_roles(session, room.id)
                if role_rows:
                    data["roles"] = [
                        {
                            "name": r.name,
                            "instructions": r.instructions,
                            "exclusive": r.exclusive,
                        }
                        for r in role_rows
                    ]

            if references:
                refs = await self._resources.list_room_references(session, room.id)
                if refs:
                    data["references"] = [{"id": r.id} for r in refs]

            if docs:
                room_docs = await self._resources.list_room_documents(session, room.id)
                scoped = [d for d in room_docs if d.room_id == room.id]
                if scoped:
                    data["docs"] = [
                        {
                            "name": d.name,
                            "description": d.description,
                            "instructions": d.instructions,
                            "content": d.content,
                        }
                        for d in scoped
                    ]

        return cast(
            str,
            yaml.dump(
                {"room": data},
                Dumper=_SpecDumper,
                sort_keys=False,
                allow_unicode=True,
                default_flow_style=False,
            ),
        )

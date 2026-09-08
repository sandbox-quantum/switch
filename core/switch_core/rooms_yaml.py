"""Declarative provisioning of rooms from YAML, and export back.

Two document shapes are supported, discriminated by top-level key:

* **Single-room** (``room:`` key): provisions one room with its attachments.
* **Group** (``group:`` + ``rooms:`` keys): provisions a room group, several
  rooms filed under it, and optional directed links between them.

Both shapes accept a ``params:`` block and an optional ``version:`` key.
``parse(text, inputs)`` resolves params and interpolates ``{name}``
throughout the document tree before validation.  A literal ``{word}`` that
collides with a declared param name *is* substituted — this is accepted for
v0; ``sensitive: true`` is deferred to a later version.

Provisioning is best-effort: rooms are created in order, and a failure on one
room does not roll back earlier ones — partial results are reported honestly.

Export emits resolved rooms and never emits ``params:``.
"""

from __future__ import annotations

import logging
import re
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
    from switch_core.db.stores.room_group_store import RoomGroupStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

# ── Template parameters (v0) ─────────────────────────────────────────────

PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ParamSpec(BaseModel):
    model_config = {"extra": "forbid"}
    type: Literal["string", "number", "boolean", "enum"] = "string"
    description: str | None = None
    default: str | int | float | bool | None = None
    enum: list[str] | None = None


def _coerce(value: Any, spec: ParamSpec, name: str) -> str | int | float | bool:
    """Coerce a raw input value to the declared type."""
    t = spec.type
    if t == "string":
        return str(value)
    if t == "number":
        try:
            f = float(value)
            return int(f) if f == int(f) else f
        except (ValueError, TypeError, OverflowError) as e:
            raise ValueError(f"param {name!r}: expected a number, got {value!r}") from e
    if t == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            low = value.lower()
            if low in ("true", "1", "yes"):
                return True
            if low in ("false", "0", "no"):
                return False
        raise ValueError(f"param {name!r}: expected a boolean, got {value!r}")
    # enum
    s = str(value)
    if spec.enum and s not in spec.enum:
        raise ValueError(f"param {name!r}: {s!r} is not one of {spec.enum}")
    return s


def resolve_params(
    declared: dict[str, ParamSpec],
    inputs: dict[str, Any] | None,
) -> dict[str, str | int | float | bool]:
    """Merge inputs over defaults, enforce required, coerce types."""
    inputs = inputs or {}
    undeclared = set(inputs) - set(declared)
    if undeclared:
        raise ValueError(f"Undeclared input(s): {', '.join(sorted(undeclared))}")
    resolved: dict[str, str | int | float | bool] = {}
    missing: list[str] = []
    for name, spec in declared.items():
        if name in inputs:
            resolved[name] = _coerce(inputs[name], spec, name)
        elif spec.default is not None:
            resolved[name] = _coerce(spec.default, spec, name)
        else:
            missing.append(name)
    if missing:
        raise ValueError(f"Missing required param(s): {', '.join(missing)}")
    return resolved


def interpolate(
    node: Any,
    values: dict[str, str | int | float | bool],
) -> Any:
    """Recursively substitute ``{name}`` placeholders in *node*.

    If an entire string is exactly one placeholder for a declared param the
    typed value is returned unchanged (so a boolean/enum param can fill a
    non-string field).  Otherwise each declared placeholder in the string is
    replaced with ``str(value)``.  Undeclared ``{word}`` patterns are left
    untouched so that JSON braces and other non-param patterns survive.
    """
    if isinstance(node, str):
        # Whole-field substitution: the entire string is one placeholder.
        m = PLACEHOLDER_RE.fullmatch(node)
        if m and m.group(1) in values:
            return values[m.group(1)]

        # Partial substitution within the string.
        def _replace(m: re.Match[str]) -> str:
            key = m.group(1)
            if key in values:
                return str(values[key])
            return m.group(0)  # leave undeclared placeholders intact

        return PLACEHOLDER_RE.sub(_replace, node)
    if isinstance(node, dict):
        return {k: interpolate(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [interpolate(item, values) for item in node]
    return node


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
        # Only the value bag's shape can be checked here: parse() is
        # synchronous and holds neither a session nor a principal, so whether
        # the type exists and is readable is settled in _resolve_references.
        self.value = validate_reference_value(self.value)
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
    aliases: dict[str, str] | None = None


class ProvisionResult(BaseModel):
    room_id: str
    room_name: str
    attached_reference_ids: list[str] = []
    created_reference_ids: list[str] = []
    created_document_ids: list[str] = []
    role_names: list[str] = []
    failed_attachments: list[dict[str, Any]] = []


# ── Group document models ────────────────────────────────────────────────


class GroupLinkSpec(BaseModel):
    model_config = {"extra": "forbid"}
    from_: str  # room name within the document
    to: str
    label: str

    @model_validator(mode="before")
    @classmethod
    def _rename_from(cls, data: Any) -> Any:
        """Accept ``from`` in YAML (a Python keyword) as ``from_``."""
        if isinstance(data, dict) and "from" in data:
            data = {**data, "from_": data.pop("from")}
        return data


class GroupMeta(BaseModel):
    model_config = {"extra": "forbid"}
    name: str
    description: str | None = None
    color: str | None = None


class GroupSpec(BaseModel):
    group: GroupMeta
    rooms: list[RoomSpec]
    links: list[GroupLinkSpec] = []


class GroupProvisionResult(BaseModel):
    group_id: str
    group_name: str
    rooms: list[ProvisionResult] = []
    errors: list[dict[str, Any]] = []


# ── YAML literal-block dumper (keeps multiline doc content readable) ────────


class _SpecDumper(yaml.SafeDumper):
    pass


def _str_representer(dumper: yaml.SafeDumper, data: str) -> Any:
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_SpecDumper.add_representer(str, _str_representer)


class RoomYamlService:
    """Parse / provision / export rooms from YAML. Free of HTTP concerns
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
        room_group_store: RoomGroupStore,
        room_role_store: RoomRoleStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._rooms = room_service
        self._resources = resource_service
        self._room_store = room_store
        self._agent_store = agent_store
        self._bridge_store = bridge_store
        self._external_users = external_user_store
        self._room_groups = room_group_store
        self._room_roles = room_role_store
        self._session_factory = session_factory

    # ── Parse ─────────────────────────────────────────────────────────────

    @staticmethod
    def _load_and_resolve(
        text: str,
        inputs: dict[str, Any] | None,
        allowed_keys: set[str],
    ) -> dict[str, Any]:
        """YAML load → version check → params resolution → interpolation.

        Returns the top-level dict with string values already interpolated.
        """
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML: {e}") from e
        if not isinstance(data, dict):
            raise ValueError("YAML document must be a mapping")

        extra = set(data) - allowed_keys
        if extra:
            raise ValueError(f"Unknown top-level key(s): {', '.join(sorted(extra))}")

        version = data.get("version", 0)
        if not isinstance(version, int):
            raise ValueError(
                f"'version' must be an integer, got {type(version).__name__}"
            )

        raw_params = data.get("params")
        if raw_params is not None:
            if not isinstance(raw_params, dict):
                raise ValueError("'params' must be a mapping")
            try:
                declared = {
                    k: ParamSpec.model_validate(v) for k, v in raw_params.items()
                }
            except ValidationError as e:
                raise ValueError(f"Invalid param spec: {e}") from e
        else:
            declared = {}

        if inputs and not declared:
            raise ValueError("Inputs supplied but the template declares no params")

        if declared:
            values = resolve_params(declared, inputs)
            return {k: interpolate(v, values) for k, v in data.items()}
        return data

    def parse(
        self, text: str, inputs: dict[str, Any] | None = None
    ) -> RoomSpec | GroupSpec:
        """Parse a YAML template into a RoomSpec (single room) or GroupSpec.

        The top-level key discriminates: ``room:`` → RoomSpec, ``group:`` +
        ``rooms:`` → GroupSpec.
        """
        try:
            raw = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML: {e}") from e
        if not isinstance(raw, dict):
            raise ValueError("YAML document must be a mapping")

        if "group" in raw:
            return self._parse_group(text, inputs)
        if "room" in raw:
            return self._parse_room(text, inputs)
        raise ValueError("YAML must have a top-level 'room:' or 'group:' mapping")

    def _parse_room(self, text: str, inputs: dict[str, Any] | None = None) -> RoomSpec:
        data = self._load_and_resolve(text, inputs, {"room", "params", "version"})
        try:
            return RoomSpec.model_validate(data["room"])
        except ValidationError as e:
            raise ValueError(f"Invalid room spec: {e}") from e

    def _parse_group(
        self, text: str, inputs: dict[str, Any] | None = None
    ) -> GroupSpec:
        data = self._load_and_resolve(
            text, inputs, {"group", "rooms", "links", "params", "version"}
        )
        if "rooms" not in data:
            raise ValueError("Group document requires a 'rooms:' list")
        try:
            group_meta = GroupMeta.model_validate(data["group"])
        except ValidationError as e:
            raise ValueError(f"Invalid group spec: {e}") from e
        raw_rooms = data["rooms"]
        if not isinstance(raw_rooms, list) or not raw_rooms:
            raise ValueError("'rooms:' must be a non-empty list")
        rooms: list[RoomSpec] = []
        for i, entry in enumerate(raw_rooms):
            try:
                rooms.append(RoomSpec.model_validate(entry))
            except ValidationError as e:
                raise ValueError(f"Invalid room spec at index {i}: {e}") from e
        raw_links = data.get("links", [])
        if not isinstance(raw_links, list):
            raise ValueError("'links:' must be a list")
        links: list[GroupLinkSpec] = []
        for i, entry in enumerate(raw_links):
            try:
                links.append(GroupLinkSpec.model_validate(entry))
            except ValidationError as e:
                raise ValueError(f"Invalid link spec at index {i}: {e}") from e
        room_names = {r.name for r in rooms}
        for link in links:
            for end, name in [("from", link.from_), ("to", link.to)]:
                if name not in room_names:
                    raise ValueError(
                        f"Link {end} {name!r} does not match any room name"
                    )
        return GroupSpec(group=group_meta, rooms=rooms, links=links)

    # ── Provision ───────────────────────────────────────────────────────────

    async def provision(
        self, spec: RoomSpec, *, user_id: str, is_admin: bool
    ) -> ProvisionResult:
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
            aliases=spec.aliases,
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

    async def provision_group(
        self, spec: GroupSpec, *, user_id: str, is_admin: bool
    ) -> GroupProvisionResult:
        """Provision a room group, its rooms, and resolve intra-document links.

        Order: group row → each room with ``group_id`` → links by name.
        Partial failure on a room is reported, not rolled back.
        """
        async with self._session_factory() as session:
            group = await self._room_groups.create(
                session,
                name=spec.group.name,
                description=spec.group.description,
                color=spec.group.color,
                parent_group_id=None,
            )
            await session.commit()
            group_id = group.id

        room_results: list[ProvisionResult] = []
        errors: list[dict[str, Any]] = []
        name_to_room_id: dict[str, str] = {}

        for i, room_spec in enumerate(spec.rooms):
            try:
                result = await self._provision_room_in_group(
                    room_spec, group_id=group_id, user_id=user_id, is_admin=is_admin
                )
                room_results.append(result)
                name_to_room_id[room_spec.name] = result.room_id
            except Exception as e:
                errors.append(
                    {"room_index": i, "room_name": room_spec.name, "error": str(e)}
                )

        for link in spec.links:
            from_id = name_to_room_id.get(link.from_)
            to_id = name_to_room_id.get(link.to)
            if from_id is None or to_id is None:
                errors.append(
                    {
                        "kind": "link",
                        "from": link.from_,
                        "to": link.to,
                        "error": "one or both rooms were not created",
                    }
                )
                continue
            try:
                async with self._session_factory() as session:
                    await self._resources.attach_linked_room(
                        session,
                        source_room_id=from_id,
                        target_room_id=to_id,
                        label=link.label,
                    )
                    await session.commit()
            except Exception as e:
                errors.append(
                    {
                        "kind": "link",
                        "from": link.from_,
                        "to": link.to,
                        "error": str(e),
                    }
                )

        return GroupProvisionResult(
            group_id=group_id,
            group_name=spec.group.name,
            rooms=room_results,
            errors=errors,
        )

    async def _provision_room_in_group(
        self,
        spec: RoomSpec,
        *,
        group_id: str,
        user_id: str,
        is_admin: bool,
    ) -> ProvisionResult:
        """Provision a single room with ``group_id`` set."""
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
            group_id=group_id,
            created_by=user_id,
            owner_id=user_id,
            acting_user_id=user_id,
            acting_is_admin=is_admin,
            read_visibility=spec.read_visibility,
            write_visibility=spec.write_visibility,
            roles=spec.roles or None,
            reference_ids=attached_ref_ids or None,
            aliases=spec.aliases,
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
        ambiguous / no-access) and check every inline entry's type resolves for
        this principal. Returns (attach-existing ids, inline entries)."""
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
                    # Raises if the type does not exist or the user cannot
                    # read it — here, before create_room, so provisioning
                    # aborts with nothing created.
                    await self._resources.resolve_type_for_principal(
                        session, entry.type, user_id=user_id, is_admin=is_admin
                    )
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
                        is_admin=is_admin,
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
                id_to_name: dict[str, str] = {}
                for aid in agent_ids:
                    agent = await self._agent_store.get(session, aid)
                    if agent is not None:
                        id_to_name[aid] = agent.name
                if id_to_name:
                    data["agents"] = sorted(id_to_name.values())
                alias_map = await self._room_store.list_aliases(session, room.id)
                if alias_map:
                    data["aliases"] = {
                        id_to_name[aid]: alias
                        for aid, alias in alias_map.items()
                        if aid in id_to_name
                    }

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

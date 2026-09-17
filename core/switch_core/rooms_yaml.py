"""Declarative provisioning of a single room from YAML, and export back.

v0 supports a ``params:`` block beside ``room:`` that declares typed,
defaultable placeholders. ``parse(text, inputs)`` resolves them and
interpolates ``{name}`` throughout the ``room:`` tree before validation, so
one file can stamp out many rooms with different inputs.  A literal
``{word}`` that collides with a declared param name *is* substituted — this
is accepted for v0; ``sensitive: true`` is deferred to a later version.

An optional top-level ``version:`` key (default ``0``) is accepted and
validated as an integer, but not acted on yet.

Provisioning is room-first and best-effort: the room is created first (which
fails loud on bad agents / refs / config), then inline references and docs are
attached, with any post-creation failures collected into ``failed_attachments``
rather than silently dropped.

Export emits resolved rooms and never emits ``params:``.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING, Any, Literal, cast

import yaml
from pydantic import BaseModel, ValidationError, model_validator

from switch_core.bridges.collaboration.models import ChannelType
from switch_core.bridges.resource.registry import validate_reference_value
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.room_service import RoleSpec, RoomCreateConfig

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.resource.service import ResourceService
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.db.models import Room
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.collaboration_bridge_store import (
        CollaborationBridgeStore,
    )
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

# ── Template parameters (v0) ─────────────────────────────────────────────

# How long a kickoff waits for the room's members to join before posting.
KICKOFF_JOIN_TIMEOUT = 30.0

PLACEHOLDER_RE = re.compile(r"\{(\$?[A-Za-z_][A-Za-z0-9_]*)\}")

# Param types whose value names something the server already has. They
# interpolate as plain strings; the difference is that the server checks the
# name before provisioning and the Console offers a picker instead of a text
# box. The value is the name a template would write: an agent's name, a
# bridge's display name, a room's name, a platform username.
ENTITY_PARAM_TYPES = ("agent", "bridge", "room", "user")

ParamType = Literal[
    "string", "number", "boolean", "enum", "agent", "bridge", "room", "user"
]


class ParamSpec(BaseModel):
    model_config = {"extra": "forbid"}
    type: ParamType = "string"
    description: str | None = None
    default: str | int | float | bool | None = None
    enum: list[str] | None = None
    # Rendering hint for string params that carry long text (a task brief,
    # instructions): the form shows a textarea instead of a one-line input,
    # which would strip the pasted text's newlines.
    multiline: bool = False


def _coerce(value: Any, spec: ParamSpec, name: str) -> str | int | float | bool:
    """Coerce a raw input value to the declared type."""
    t = spec.type
    if t == "string" or t in ENTITY_PARAM_TYPES:
        return str(value)
    if t == "number":
        if isinstance(value, bool):
            raise ValueError(f"param {name!r}: expected a number, got {value!r}")
        if isinstance(value, int):
            return value  # keep int as int; no float roundtrip, no precision loss
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
    if inputs is not None and not isinstance(inputs, dict):
        raise ValueError("'inputs' must be a mapping of param name to value")
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


class TemplateDocument(BaseModel):
    """Top-level shape of a room template file (for JSON Schema generation)."""

    room: RoomSpec
    params: dict[str, ParamSpec] | None = None
    kickoff: str | None = None


@dataclass(frozen=True)
class ParsedTemplate:
    """What ``parse_template`` makes of one template plus one set of inputs."""

    spec: RoomSpec
    kickoff: str | None
    #: The template's declared params, by name.
    params: dict[str, ParamSpec]
    #: The value each declared param resolved to (input or default), coerced.
    values: dict[str, str | int | float | bool]


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
        client_lifecycle: ClientLifecycleService | None = None,
    ) -> None:
        self._rooms = room_service
        self._resources = resource_service
        self._room_store = room_store
        self._agent_store = agent_store
        self._bridge_store = bridge_store
        self._external_users = external_user_store
        self._room_roles = room_role_store
        self._session_factory = session_factory
        self._client_lifecycle = client_lifecycle

    # ── Parse ─────────────────────────────────────────────────────────────

    def parse(
        self,
        text: str,
        inputs: dict[str, Any] | None = None,
        builtins: dict[str, str] | None = None,
    ) -> tuple[RoomSpec, str | None]:
        """Parse a YAML template into a ``RoomSpec`` and optional kickoff message.

        The short form of ``parse_template`` for callers that only need the
        room; the gateway uses the long form so it can also check the
        entity-typed params before provisioning.
        """
        parsed = self.parse_template(text, inputs=inputs, builtins=builtins)
        return parsed.spec, parsed.kickoff

    def parse_template(
        self,
        text: str,
        inputs: dict[str, Any] | None = None,
        builtins: dict[str, str] | None = None,
    ) -> ParsedTemplate:
        """Parse a YAML template into its room spec, kickoff, and resolved params.

        ``builtins`` are server-injected variables (e.g. ``{creator}``) that
        are always available for interpolation alongside user-supplied
        ``inputs``.  They are resolved first and never collide with declared
        params; a param named ``creator`` would shadow the built-in, which is
        intentional (the template author owns the namespace).
        """
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML: {e}") from e
        if not isinstance(data, dict) or "room" not in data:
            raise ValueError("YAML must have a single top-level 'room:' mapping")

        allowed_keys = {"room", "params", "version", "kickoff"}
        extra = set(data) - allowed_keys
        if extra:
            raise ValueError(f"Unknown top-level key(s): {', '.join(sorted(extra))}")

        # version: accepted, not acted on yet.
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

        # Build the interpolation values: builtins first, then params override
        values: dict[str, str | int | float | bool] = dict(builtins or {})
        resolved: dict[str, str | int | float | bool] = {}
        if declared:
            resolved = resolve_params(declared, inputs)
            values.update(resolved)

        if values:
            room_data = interpolate(data["room"], values)
            kickoff_raw = data.get("kickoff")
            kickoff = (
                interpolate(kickoff_raw, values)
                if isinstance(kickoff_raw, str)
                else None
            )
        else:
            room_data = data["room"]
            kickoff = (
                data.get("kickoff") if isinstance(data.get("kickoff"), str) else None
            )

        try:
            spec = RoomSpec.model_validate(room_data)
        except ValidationError as e:
            raise ValueError(f"Invalid room spec: {e}") from e
        return ParsedTemplate(
            spec=spec, kickoff=kickoff, params=declared, values=resolved
        )

    # ── Entity params ─────────────────────────────────────────────────────

    async def check_entity_params(self, parsed: ParsedTemplate) -> None:
        """Every entity-typed param must name something this server has.

        Raises ``ValueError`` in the ``param 'x': ...`` form the Console maps
        back onto the field. Runs between ``parse_template`` and ``provision``
        so a bad name fails at the input, not as a half-built room. A ``user``
        param resolves on the bridge the room will land on, hence the parsed
        spec rather than the raw inputs.
        """
        wanted: dict[str, list[tuple[str, str]]] = {}
        for name, spec in parsed.params.items():
            if spec.type in ENTITY_PARAM_TYPES:
                wanted.setdefault(spec.type, []).append(
                    (name, str(parsed.values[name]))
                )
        if not wanted:
            return

        async with self._session_factory() as session:
            if "agent" in wanted:
                names = [value for _, value in wanted["agent"]]
                agents = await self._agent_store.get_by_names(session, names)
                known = {a.name for a in agents}
                for param, value in wanted["agent"]:
                    if value not in known:
                        raise ValueError(
                            f"param {param!r}: no agent named {value!r} on this server"
                        )
            if "bridge" in wanted:
                bridges = {
                    b.display_name: b for b in await self._bridge_store.get_all(session)
                }
                for param, value in wanted["bridge"]:
                    bridge = bridges.get(value)
                    if bridge is None:
                        raise ValueError(
                            f"param {param!r}: no messaging app named {value!r} "
                            "on this server"
                        )
                    if bridge.status != "active":
                        raise ValueError(
                            f"param {param!r}: messaging app {value!r} is not running"
                        )
            if "room" in wanted:
                rooms = {r.name for r in await self._room_store.get_all(session)}
                for param, value in wanted["room"]:
                    if value not in rooms:
                        raise ValueError(
                            f"param {param!r}: no room named {value!r} on this server"
                        )

        if "user" in wanted:
            bridge_id = await self._resolve_bridge_id(parsed.spec.bridge)
            if bridge_id is None:
                param = wanted["user"][0][0]
                raise ValueError(
                    f"param {param!r}: a user can only be looked up on a messaging "
                    "app, and this template has none"
                )
            names = [value for _, value in wanted["user"]]
            found = await self._rooms.resolve_bridge_users(bridge_id, names)
            for param, value in wanted["user"]:
                if value not in found:
                    raise ValueError(
                        f"param {param!r}: no user named {value!r} on the "
                        "room's messaging app"
                    )

    async def builtins_for(
        self, *, user_id: str, name: str, email: str, text: str
    ) -> dict[str, str]:
        """The server-injected ``{$...}`` variables for one create call.

        ``$creator`` is the name the creator goes by on the template's bridge,
        the identity they have linked there, which is what ``users:``
        resolution and channel invites understand. A bridged template that
        uses ``{$creator}`` is refused without such a link rather than guessed
        from the gateway account name, which is rarely a platform account.
        Without a bridge there is nobody to invite, so the gateway name stands
        in.
        """
        creator = name
        bridge_id = await self._peek_bridge_id(text)
        if bridge_id is not None:
            async with self._session_factory() as session:
                claimed = await self._external_users.get_by_user(session, user_id)
                bridge = await self._bridge_store.get(session, bridge_id)
            claim = next((ext for ext in claimed if ext.bridge_id == bridge_id), None)
            if claim is not None:
                creator = claim.external_username
            elif "{$creator}" in text:
                app = (
                    bridge.display_name if bridge is not None else "this messaging app"
                )
                raise ValueError(
                    f"this template puts you in the room as {{$creator}}, but you "
                    f"have no linked account on {app}. Link your account under "
                    "Identities, then create the room again"
                )
        return {
            "$creator": creator,
            "$creator_email": email,
            "$date": str(date.today()),
            "$timestamp": str(int(time.time())),
        }

    async def _peek_bridge_id(self, text: str) -> str | None:
        """The bridge the template will land on, read before interpolation.

        Best-effort: an unparseable template, an interpolated bridge name, or
        an unknown bridge all answer None; parse/provision fails loudly later
        when it matters. A template naming no bridge lands on the default one,
        same as provisioning."""
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError:
            return None
        if not isinstance(data, dict):
            return None
        room = data.get("room")
        if not isinstance(room, dict):
            return None
        bridge = room.get("bridge")
        if bridge is not None and (
            not isinstance(bridge, str) or PLACEHOLDER_RE.search(bridge)
        ):
            return None
        try:
            return await self._resolve_bridge_id(bridge)
        except ValueError:
            return None

    # ── Provision ───────────────────────────────────────────────────────────

    async def provision(
        self,
        spec: RoomSpec,
        *,
        user_id: str,
        is_admin: bool,
        kickoff: str | None = None,
        creator_name: str | None = None,
    ) -> ProvisionResult:
        """Create the room and everything the spec attaches to it.

        ``kickoff`` is posted once the room exists, by the platform on the
        creator's behalf (see ``_send_kickoff``); ``creator_name`` is how the
        message names them.
        """
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
            from_template=True,
            owner_id=user_id,
            acting_user_id=user_id,
            acting_is_admin=is_admin,
            read_visibility=spec.read_visibility,
            write_visibility=spec.write_visibility,
            roles=spec.roles or None,
            reference_ids=attached_ref_ids or None,
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

        if kickoff:
            await self._send_kickoff(
                result.room,
                kickoff,
                agent_names=spec.agents,
                user_id=user_id,
                user_name=creator_name,
                failures=failures,
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
            async with self._session_factory() as session:
                default = await self._bridge_store.get_default(session)
            return default.id if default else None
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

    # ── Kickoff ───────────────────────────────────────────────────────────

    async def _send_kickoff(
        self,
        room: Room,
        text: str,
        *,
        agent_names: list[str],
        user_id: str,
        user_name: str | None,
        failures: list[dict[str, Any]],
    ) -> None:
        """Post the kickoff into the room the template just created.

        Switch posts it on the creator's behalf, so nobody is impersonated:
        the message renders as the app, and each agent it mentions applies
        its policy to the creator, for this one event. It goes out as a
        one-line headline in the channel plus the text in that headline's
        thread, so the channel keeps one line per kickoff.

        Best-effort like references and docs: a kickoff that cannot be posted
        is reported in ``failures``, not fatal. The agents are waited for
        first, because a client drops events that land before its own join.
        """

        def fail(error: str) -> None:
            failures.append({"kind": "kickoff", "id": "kickoff", "error": error})

        if self._client_lifecycle is None:
            fail("kickoff posting is not configured on this server")
            return
        admins = self._client_lifecycle.get_by_type("admin", room.tenant_id)
        admin = next((c for c in admins if isinstance(c, AdminClient)), None)
        if admin is None:
            fail("the platform has no client to post with")
            return

        late = await self._wait_for_kickoff_audience(
            room.matrix_room_id, admin, agent_names
        )
        if late:
            fail("did not join the room in time to see the kickoff: " + ", ".join(late))
        if "the platform" in late:
            return

        person = OnBehalfOf(user_id, user_name or user_id)
        headline = f"Template kickoff on behalf of @{person.name}"
        try:
            root_id = await admin.send_platform_message(
                room.matrix_room_id, headline, on_behalf_of=person
            )
            if root_id is None:
                fail("the platform could not post the kickoff")
                return
            event_id = await admin.send_platform_message(
                room.matrix_room_id,
                text,
                thread_root_id=root_id,
                on_behalf_of=person,
                reply_in_channel=True,
            )
        except Exception as e:
            fail(str(e))
            return
        if event_id is None:
            fail("the platform posted the kickoff headline but not its thread")

    async def _wait_for_kickoff_audience(
        self,
        matrix_room_id: str,
        admin: AdminClient,
        agent_names: list[str],
    ) -> list[str]:
        """Wait for the sender and the template's agents to be in the room.

        Returns the names of those that were not joined within the timeout:
        "the platform" for the sender itself, else the agent's name. An agent
        with no running client is not waited for; it is not in the room to
        miss anything.
        """
        late: list[str] = []
        if not await admin.wait_joined(matrix_room_id, KICKOFF_JOIN_TIMEOUT):
            late.append("the platform")
        if not agent_names or self._client_lifecycle is None:
            return late
        async with self._session_factory() as session:
            agents = await self._agent_store.get_by_names(session, agent_names)
        for agent in agents:
            client = self._client_lifecycle.get_by_agent_id(agent.id)
            if client is None:
                continue
            try:
                joined = await client.wait_joined(matrix_room_id, KICKOFF_JOIN_TIMEOUT)
            except RuntimeError:
                # Not connected: it is not receiving anything either way.
                continue
            if not joined:
                late.append(agent.name)
        return late

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

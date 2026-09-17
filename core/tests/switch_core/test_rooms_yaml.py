"""Tests for declarative room provisioning / export (switch_core.rooms_yaml).

The YAML service is exercised against a real PostgreSQL instance (per the
project rule). Matrix / bridge side effects are out of scope here, so
``RoomService.create_room`` is replaced by a faithful DB-only fake that creates
the room row, attaches agents/roles/references the same way the real service
does — enough for the resolution, best-effort, and export logic to be tested
for real.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
import pytest_asyncio
import yaml
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Reference,
    ReferenceType,
    Room,
    RoomGroup,
    RoomLink,
    RoomRole,
    User,
    room_agents,
    room_references,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomCreateResult
from switch_core.rooms_yaml import (
    ExistingReferenceById,
    GroupSpec,
    ParamSpec,
    RoomYamlService,
    interpolate,
    resolve_params,
)


class _AnyStr:
    def __eq__(self, other: object) -> bool:
        return isinstance(other, str)

    def __repr__(self) -> str:
        return "<any str>"


ANY_ROOM = _AnyStr()


class FakeRoomService:
    """DB-only stand-in for RoomService.create_room.

    Mirrors the parts of the real flow the YAML layer relies on: fail-loud
    agent-name resolution, room-row creation, and attachment of agents, roles,
    and existing references.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        agent_store: AgentStore,
    ) -> None:
        self._sf = session_factory
        self._agents = agent_store
        #: username → external id, the people a bridge would resolve.
        self.bridge_users: dict[str, str] = {}
        self.bridge_user_lookups: list[tuple[str, list[str]]] = []

    async def resolve_bridge_users(
        self, bridge_id: str, names: list[str]
    ) -> dict[str, str]:
        self.bridge_user_lookups.append((bridge_id, names))
        return {n: self.bridge_users[n] for n in names if n in self.bridge_users}

    async def create_room(self, config: RoomCreateConfig) -> RoomCreateResult:
        async with self._sf() as session:
            agent_ids: list[str] = []
            if config.agent_names:
                agents = await self._agents.get_by_names(session, config.agent_names)
                name_to_id = {a.name: a.id for a in agents}
                missing = [n for n in config.agent_names if n not in name_to_id]
                if missing:
                    raise ValueError(f"Unknown agents: {', '.join(missing)}")
                agent_ids = [name_to_id[n] for n in config.agent_names]

            room = Room(
                matrix_room_id=f"!{uuid.uuid4().hex}:test.local",
                name=config.name,
                description=config.description,
                channel_type=config.channel_type or "channel_public",
                bridge_id=config.bridge_id,
                instructions=config.instructions,
                created_by=config.created_by,
                created_by_agent_id=config.created_by_agent_id,
                agent_creation_depth=config.agent_creation_depth,
                owner_id=config.owner_id,
                read_visibility=config.read_visibility,
                write_visibility=config.write_visibility,
                group_id=config.group_id,
            )
            session.add(room)
            await session.flush()
            for aid in agent_ids:
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=aid)
                )
            for spec in config.roles or []:
                session.add(
                    RoomRole(
                        room_id=room.id,
                        name=spec.name,
                        instructions=spec.instructions,
                        exclusive=spec.exclusive,
                    )
                )
            for rid in config.reference_ids or []:
                await session.execute(
                    insert(room_references).values(room_id=room.id, reference_id=rid)
                )
            await session.commit()
            return RoomCreateResult(room=room, failed_attachments=[])


async def _make_agent(session: AsyncSession, name: str, user_id: str) -> Agent:
    api_key = ApiKey(
        user_id=user_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test.local",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


@pytest_asyncio.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]):
    """Seed a user + two agents, and wire up the YAML service."""
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    agent_store = AgentStore()
    fake_rooms = FakeRoomService(session_factory, agent_store)
    svc = RoomYamlService(
        room_service=fake_rooms,  # type: ignore[arg-type]
        resource_service=resource_service,
        room_store=RoomStore(),
        agent_store=agent_store,
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_role_store=RoomRoleStore(),
        session_factory=session_factory,
        room_group_store=RoomGroupStore(),
    )

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        session.add(user)
        await session.flush()
        user_id = user.id
        await _make_agent(session, "claude-code.alice", user_id)
        await _make_agent(session, "claude-code.bob", user_id)
        await session.commit()

    return {
        "svc": svc,
        "rooms": fake_rooms,
        "resource_service": resource_service,
        "session_factory": session_factory,
        "user_id": user_id,
    }


# ── parse ────────────────────────────────────────────────────────────────────


def _svc(env) -> RoomYamlService:
    return env["svc"]


def test_parse_minimal(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Room A"
          description: "desc"
        """
    )
    assert spec.name == "Room A"
    assert spec.channel_type == "channel_public"
    assert spec.references == []


def test_parse_returns_kickoff(env):
    spec, kickoff = _svc(env).parse(
        """
        room:
          name: "Room K"
          description: "desc"
        kickoff: "Start working now."
        """
    )
    assert spec.name == "Room K"
    assert kickoff == "Start working now."


def test_parse_no_kickoff_returns_none(env):
    _, kickoff = _svc(env).parse(
        """
        room:
          name: "Room N"
          description: "desc"
        """
    )
    assert kickoff is None


def test_parse_kickoff_interpolates_builtins(env):
    _, kickoff = _svc(env).parse(
        """
        room:
          name: "Room B"
          description: "desc"
        kickoff: "Welcome {$creator}, today is {$date}."
        """,
        builtins={"$creator": "alice", "$date": "2026-09-11"},
    )
    assert kickoff == "Welcome alice, today is 2026-09-11."


def test_parse_builtins_resolve_in_room(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "{$creator}'s room"
          description: "desc"
          users: ["{$creator_email}"]
        """,
        builtins={"$creator": "alice", "$creator_email": "alice@example.com"},
    )
    assert spec.name == "alice's room"
    assert spec.users == ["alice@example.com"]


def test_parse_rejects_missing_room_key(env):
    with pytest.raises(ValueError, match="top-level 'room:'"):
        _svc(env).parse("name: oops\ndescription: d\n")


def test_parse_rejects_malformed_yaml(env):
    with pytest.raises(ValueError, match="Invalid YAML"):
        _svc(env).parse("room: [unclosed\n")


def test_parse_inline_ref_missing_value_fails(env):
    with pytest.raises(ValueError, match="Invalid room spec"):
        _svc(env).parse(
            """
            room:
              name: "R"
              description: "d"
              references:
                - type: github
                  name: "repo"
                  description: "d"
                  instructions: "i"
            """
        )


def test_parse_inline_ref_bad_value_schema_fails(env):
    # Every reference value requires a non-empty urls list.
    with pytest.raises(ValueError, match="Invalid reference value"):
        _svc(env).parse(
            """
            room:
              name: "R"
              description: "d"
              references:
                - type: github
                  name: "repo"
                  description: "d"
                  instructions: "i"
                  value: { urls: [] }
            """
        )


def test_parse_reference_entry_requires_one_form(env):
    with pytest.raises(ValueError, match="Invalid room spec"):
        _svc(env).parse(
            """
            room:
              name: "R"
              description: "d"
              references:
                - { description: "no id, name, or type" }
            """
        )


# ── provision ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_basic_with_agents_roles_and_inline_ref(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Pilot"
          description: "pilot room"
          instructions: "be helpful"
          agents: ["claude-code.alice"]
          roles:
            - { name: manager, instructions: "coordinate", exclusive: true }
          references:
            - type: github
              name: "Switch repo"
              description: "the repo"
              instructions: "use it"
              value: { urls: ["https://github.com/example-org/switch"] }
          docs:
            - name: "Onboarding"
              description: "start here"
              instructions: "read first"
              content: "# Onboarding\\nhello"
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    assert result.room_name == "Pilot"
    assert len(result.created_reference_ids) == 1
    assert len(result.created_document_ids) == 1
    assert result.role_names == ["manager"]
    assert result.failed_attachments == []


@pytest.mark.asyncio
async def test_provision_no_agents_or_users(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Agentless"
          description: "no agents, no users"
          docs:
            - { name: "D", description: "d", instructions: "i", content: "c" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)
    assert result.room_name == "Agentless"
    assert len(result.created_document_ids) == 1
    assert result.failed_attachments == []


@pytest.mark.asyncio
async def test_provision_unknown_agent_fails_loud(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          agents: ["does-not-exist"]
        """
    )
    with pytest.raises(ValueError, match="Unknown agents"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)


@pytest.mark.asyncio
async def test_provision_unknown_reference_type_fails_before_the_room_exists(env):
    """An inline reference naming an unresolvable type aborts provisioning.

    parse() cannot catch this — it is synchronous and holds neither a session
    nor a principal — so the check lives in ``_resolve_references``, which runs
    before ``create_room``. Nothing may be created.
    """
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Bad type"
          description: "d"
          references:
            - type: never_registered
              name: "R"
              description: "d"
              instructions: "i"
              value: { urls: ["https://example.com/thing"] }
        """
    )
    with pytest.raises(ValueError, match="Unknown reference type 'never_registered'"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    async with env["session_factory"]() as session:
        rooms = (
            (await session.execute(select(Room).where(Room.name == "Bad type")))
            .scalars()
            .all()
        )
        refs = (
            (
                await session.execute(
                    select(Reference).where(Reference.type == "never_registered")
                )
            )
            .scalars()
            .all()
        )
    assert rooms == []
    assert refs == []


@pytest.mark.asyncio
async def test_provision_inline_ref_of_a_user_defined_type(env):
    """A type the principal can read provisions like a built-in."""
    async with env["session_factory"]() as session:
        session.add(
            ReferenceType(
                type="notion",
                owner_id=env["user_id"],
                read_visibility="private",
                write_visibility="private",
                display_name="Notion",
                instructions="Read the linked Notion pages.",
                value_hint="Paste links to Notion pages.",
            )
        )
        await session.commit()

    spec, _ = _svc(env).parse(
        """
        room:
          name: "Custom type"
          description: "d"
          references:
            - type: notion
              name: "Spec page"
              description: "d"
              instructions: "i"
              value: { urls: ["https://example.com/notion/spec"] }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)
    assert len(result.created_reference_ids) == 1
    assert result.failed_attachments == []


@pytest.mark.asyncio
async def test_provision_attach_reference_by_name(env):
    # Seed an existing reference owned by the user.
    async with env["session_factory"]() as session:
        ref = await env["resource_service"].create_reference(
            session,
            owner_id=env["user_id"],
            is_admin=False,
            read_visibility="private",
            write_visibility="private",
            type="confluence",
            name="Team space",
            description="d",
            instructions="i",
            value={"urls": ["https://x.atlassian.net/wiki/spaces/T"]},
        )
        await session.commit()
        ref_id = ref.id

    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          references:
            - { name: "Team space" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)
    assert result.attached_reference_ids == [ref_id]
    assert result.created_reference_ids == []


@pytest.mark.asyncio
async def test_provision_attach_reference_by_name_unknown_fails(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          references:
            - { name: "no such ref" }
        """
    )
    with pytest.raises(ValueError, match="No reference named"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)


@pytest.mark.asyncio
async def test_provision_ambiguous_reference_name_fails(env):
    async with env["session_factory"]() as session:
        for _ in range(2):
            await env["resource_service"].create_reference(
                session,
                owner_id=env["user_id"],
                is_admin=False,
                read_visibility="private",
                write_visibility="private",
                type="github",
                name="dup",
                description="d",
                instructions="i",
                value={"urls": ["https://github.com/a/b"]},
            )
        await session.commit()

    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          references:
            - { name: "dup" }
        """
    )
    with pytest.raises(ValueError, match="Ambiguous reference name"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)


@pytest.mark.asyncio
async def test_provision_duplicate_doc_name_is_best_effort(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          docs:
            - { name: "Same", description: "d", instructions: "i", content: "a" }
            - { name: "Same", description: "d", instructions: "i", content: "b" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)
    # Room + first doc created; the duplicate is reported, not raised.
    assert len(result.created_document_ids) == 1
    assert len(result.failed_attachments) == 1
    assert result.failed_attachments[0]["kind"] == "document"
    assert result.failed_attachments[0]["id"] == "Same"


@pytest.mark.asyncio
async def test_provision_users_without_bridge_fails(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "R"
          description: "d"
          users: ["bob"]
        """
    )
    with pytest.raises(ValueError, match="without a bridge|no bridge"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)


# ── export ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_export_round_trips_within_import_surface(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Export me"
          description: "to export"
          instructions: "instr"
          agents: ["claude-code.alice"]
          roles:
            - { name: worker, instructions: "do work", exclusive: false }
          references:
            - type: jira
              name: "Board"
              description: "d"
              instructions: "i"
              value: { urls: ["https://x.atlassian.net/browse/AB-1"] }
          docs:
            - name: "Doc1"
              description: "d"
              instructions: "i"
              content: "line1\\nline2"
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    yaml_text = await _svc(env).export(result.room_id)
    reparsed, _ = _svc(env).parse(yaml_text)

    assert reparsed.name == "Export me"
    assert reparsed.instructions == "instr"
    assert sorted(reparsed.agents) == ["claude-code.alice"]
    assert [r.name for r in reparsed.roles] == ["worker"]
    # References export as attach-by-id.
    assert len(reparsed.references) == 1
    assert isinstance(reparsed.references[0], ExistingReferenceById)
    assert reparsed.references[0].id == result.created_reference_ids[0]
    # Room-scoped docs export inline with content.
    assert len(reparsed.docs) == 1
    assert reparsed.docs[0].name == "Doc1"
    assert reparsed.docs[0].content == "line1\nline2"


@pytest.mark.asyncio
async def test_export_toggles_drop_sections(env):
    spec, _ = _svc(env).parse(
        """
        room:
          name: "Toggle"
          description: "d"
          agents: ["claude-code.alice"]
          roles:
            - { name: worker, instructions: "w", exclusive: false }
          docs:
            - { name: "D", description: "d", instructions: "i", content: "c" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    yaml_text = await _svc(env).export(
        result.room_id, agents=False, roles=False, docs=False
    )
    reparsed, _ = _svc(env).parse(yaml_text)
    assert reparsed.agents == []
    assert reparsed.roles == []
    assert reparsed.docs == []


@pytest.mark.asyncio
async def test_export_unknown_room_fails(env):
    with pytest.raises(ValueError, match="Room not found"):
        await _svc(env).export("does-not-exist")


@pytest.mark.asyncio
async def test_export_includes_users_from_bridge(env):
    """A bridged room with an external user in it exports that user by name."""
    sf = env["session_factory"]
    async with sf() as session:
        bridge_client = Client(
            matrix_user_id="@bridge:test.local",
            display_name="bridge",
            type="collaboration_bridge",
        )
        user_client = Client(
            matrix_user_id="@bob:test.local",
            display_name="bob",
            type="external_user",
        )
        session.add_all([bridge_client, user_client])
        await session.flush()
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="Mattermost",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        session.add(
            ExternalUser(
                bridge_id=bridge.id,
                external_user_id="ext-bob",
                external_username="bob",
                client_id=user_client.id,
            )
        )
        room = Room(
            matrix_room_id="!bridged:test.local",
            name="Mattermost: Bridged",
            description="d",
            channel_type="channel_public",
            bridge_id=bridge.id,
            owner_id=env["user_id"],
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.flush()
        session.add(ClientRoom(client_id=user_client.id, room_id=room.id))
        await session.commit()
        room_id = room.id

    yaml_text = await _svc(env).export(room_id)
    reparsed, _ = _svc(env).parse(yaml_text)
    # The "Mattermost: " display-name prefix is stripped on export.
    assert reparsed.name == "Bridged"
    assert reparsed.bridge == "Mattermost"
    assert reparsed.users == ["bob"]


# ── resolve_params ──────────────────────────────────────────────────────────


def test_resolve_params_defaults_only():
    declared = {
        "owner": ParamSpec(type="string"),
        "repo": ParamSpec(type="string", default="sandbox-quantum/switch"),
    }
    values = resolve_params(declared, {"owner": "alice"})
    assert values == {"owner": "alice", "repo": "sandbox-quantum/switch"}


def test_resolve_params_override_default():
    declared = {
        "repo": ParamSpec(type="string", default="sandbox-quantum/switch"),
    }
    values = resolve_params(declared, {"repo": "other/repo"})
    assert values == {"repo": "other/repo"}


def test_resolve_params_missing_required():
    declared = {"owner": ParamSpec(type="string")}
    with pytest.raises(ValueError, match="Missing required param.*owner"):
        resolve_params(declared, {})


def test_resolve_params_undeclared_input():
    declared = {"owner": ParamSpec(type="string")}
    with pytest.raises(ValueError, match="Undeclared input.*extra"):
        resolve_params(declared, {"owner": "a", "extra": "b"})


def test_resolve_params_enum_valid():
    declared = {
        "vis": ParamSpec(type="enum", enum=["channel_public", "channel_private"]),
    }
    values = resolve_params(declared, {"vis": "channel_public"})
    assert values == {"vis": "channel_public"}


def test_resolve_params_enum_invalid():
    declared = {
        "vis": ParamSpec(type="enum", enum=["channel_public", "channel_private"]),
    }
    with pytest.raises(ValueError, match="not one of"):
        resolve_params(declared, {"vis": "direct"})


def test_resolve_params_boolean_coercion():
    declared = {"flag": ParamSpec(type="boolean")}
    assert resolve_params(declared, {"flag": True}) == {"flag": True}
    assert resolve_params(declared, {"flag": "false"}) == {"flag": False}


def test_resolve_params_number_coercion():
    declared = {"count": ParamSpec(type="number")}
    assert resolve_params(declared, {"count": "42"}) == {"count": 42}
    assert resolve_params(declared, {"count": 3.14}) == {"count": 3.14}


def test_resolve_params_number_bad():
    declared = {"count": ParamSpec(type="number")}
    with pytest.raises(ValueError, match="expected a number"):
        resolve_params(declared, {"count": "abc"})


def test_resolve_params_number_rejects_bool():
    declared = {"count": ParamSpec(type="number")}
    with pytest.raises(ValueError, match="expected a number"):
        resolve_params(declared, {"count": True})


def test_resolve_params_number_preserves_large_int():
    declared = {"n": ParamSpec(type="number")}
    big = 10**18 + 1  # loses precision if routed through float
    assert resolve_params(declared, {"n": big}) == {"n": big}


def test_resolve_params_rejects_non_dict_inputs():
    declared = {"owner": ParamSpec(type="string")}
    with pytest.raises(ValueError, match="'inputs' must be a mapping"):
        resolve_params(declared, [1, 2, 3])


# ── interpolate ─────────────────────────────────────────────────────────────


def test_interpolate_whole_field_typed():
    """A whole-field placeholder returns the typed value, not a string."""
    result = interpolate("{flag}", {"flag": True})
    assert result is True


def test_interpolate_partial_string():
    result = interpolate("hello {name}!", {"name": "world"})
    assert result == "hello world!"


def test_interpolate_undeclared_left_intact():
    result = interpolate("{unknown} stays", {})
    assert result == "{unknown} stays"


def test_interpolate_nested_dict_and_list():
    node = {
        "a": "{x}",
        "b": ["{y}", "literal"],
        "c": {"nested": "prefix-{x}"},
    }
    values = {"x": "X", "y": "Y"}
    result = interpolate(node, values)
    assert result == {
        "a": "X",
        "b": ["Y", "literal"],
        "c": {"nested": "prefix-X"},
    }


def test_interpolate_non_string_passthrough():
    assert interpolate(42, {"x": "y"}) == 42
    assert interpolate(None, {"x": "y"}) is None


# ── parse with params ──────────────────────────────────────────────────────


def test_parse_with_params_defaults_only(env):
    spec, _ = _svc(env).parse(
        """
        params:
          owner:
            type: string
            default: "alice"
        room:
          name: "{owner} local-deploy"
          description: "{owner}'s room"
        """
    )
    assert spec.name == "alice local-deploy"
    assert spec.description == "alice's room"


def test_parse_with_params_override(env):
    spec, _ = _svc(env).parse(
        """
        params:
          owner:
            type: string
            default: "alice"
        room:
          name: "{owner} local-deploy"
          description: "{owner}'s room"
        """,
        inputs={"owner": "bob"},
    )
    assert spec.name == "bob local-deploy"


def test_parse_with_params_missing_required_raises(env):
    with pytest.raises(ValueError, match="Missing required param.*owner"):
        _svc(env).parse(
            """
            params:
              owner:
                type: string
            room:
              name: "{owner} room"
              description: "d"
            """
        )


def test_parse_with_params_undeclared_input_raises(env):
    with pytest.raises(ValueError, match="Undeclared input.*extra"):
        _svc(env).parse(
            """
            params:
              owner:
                type: string
            room:
              name: "{owner} room"
              description: "d"
            """,
            inputs={"owner": "a", "extra": "b"},
        )


def test_parse_inputs_against_paramless_file_raises(env):
    with pytest.raises(ValueError, match="no params"):
        _svc(env).parse(
            """
            room:
              name: "R"
              description: "d"
            """,
            inputs={"owner": "a"},
        )


def test_parse_unknown_placeholder_left_intact(env):
    spec, _ = _svc(env).parse(
        """
        params:
          owner:
            type: string
        room:
          name: "{owner} room"
          description: "JSON brace {not_a_param} survives"
        """,
        inputs={"owner": "alice"},
    )
    assert spec.description == "JSON brace {not_a_param} survives"


def test_parse_whole_field_typed_substitution(env):
    """An enum param used as the whole value of channel_type stays valid."""
    spec, _ = _svc(env).parse(
        """
        params:
          visibility:
            type: enum
            enum: [channel_public, channel_private]
            default: channel_private
        room:
          name: "R"
          description: "d"
          channel_type: "{visibility}"
        """
    )
    assert spec.channel_type == "channel_private"


def test_parse_interpolation_into_docs_content(env):
    spec, _ = _svc(env).parse(
        """
        params:
          owner:
            type: string
        room:
          name: "R"
          description: "d"
          docs:
            - name: "Guide"
              description: "d"
              instructions: "i"
              content: "Welcome, {owner}."
        """,
        inputs={"owner": "alice"},
    )
    assert spec.docs[0].content == "Welcome, alice."


def test_parse_interpolation_into_references_value(env):
    spec, _ = _svc(env).parse(
        """
        params:
          repo:
            type: string
        room:
          name: "R"
          description: "d"
          references:
            - type: github
              name: "Repo"
              description: "d"
              instructions: "i"
              value:
                urls: ["https://github.com/{repo}"]
        """,
        inputs={"repo": "org/project"},
    )
    assert spec.references[0].value == {"urls": ["https://github.com/org/project"]}  # type: ignore[union-attr]


def test_parse_version_key_accepted(env):
    spec, _ = _svc(env).parse(
        """
        version: 0
        room:
          name: "R"
          description: "d"
        """
    )
    assert spec.name == "R"


def test_parse_version_non_integer_rejected(env):
    with pytest.raises(ValueError, match="integer"):
        _svc(env).parse(
            """
            version: "one"
            room:
              name: "R"
              description: "d"
            """
        )


def test_parse_unknown_top_level_key_rejected(env):
    with pytest.raises(ValueError, match="Unknown top-level key"):
        _svc(env).parse(
            """
            room:
              name: "R"
              description: "d"
            extra_key: bad
            """
        )


# ── provision with params (integration) ────────────────────────────────────


TEMPLATE = """\
params:
  owner:
    type: string
    description: Whose room this is
  deploy_agent:
    type: string
    description: The agent that runs deployments
  repo:
    type: string
    default: "sandbox-quantum/switch"
  visibility:
    type: enum
    enum: [channel_public, channel_private]
    default: channel_private
room:
  name: "{owner} local-deploy"
  description: "{owner}'s local deployment room for {repo}"
  channel_type: "{visibility}"
  agents: ["{deploy_agent}"]
  instructions: |
    You run local deployments of {repo} for {owner}.
"""


@pytest.mark.asyncio
async def test_provision_template_two_owners(env):
    """The same template instantiates twice with different owners."""
    svc = _svc(env)
    spec1, _ = svc.parse(
        TEMPLATE, inputs={"owner": "alice", "deploy_agent": "claude-code.alice"}
    )
    r1 = await svc.provision(spec1, user_id=env["user_id"], is_admin=False)
    spec2, _ = svc.parse(
        TEMPLATE, inputs={"owner": "bob", "deploy_agent": "claude-code.bob"}
    )
    r2 = await svc.provision(spec2, user_id=env["user_id"], is_admin=False)
    assert r1.room_name == "alice local-deploy"
    assert r2.room_name == "bob local-deploy"
    assert r1.room_id != r2.room_id

    # Export shows resolved values, no placeholders.
    yaml1 = await svc.export(r1.room_id)
    yaml2 = await svc.export(r2.room_id)
    assert "{owner}" not in yaml1
    assert "{owner}" not in yaml2
    assert "alice" in yaml1
    assert "bob" in yaml2


@pytest.mark.asyncio
async def test_provision_template_missing_required_400(env):
    """A required param left blank raises before any room is created."""
    svc = _svc(env)
    with pytest.raises(ValueError, match="Missing required param.*owner"):
        svc.parse(TEMPLATE, inputs={"deploy_agent": "claude-code.alice"})

    # Verify no room was created.
    async with env["session_factory"]() as session:
        rooms = (
            (
                await session.execute(
                    select(Room).where(Room.name.like("%local-deploy%"))
                )
            )
            .scalars()
            .all()
        )
    assert rooms == []


# ── endpoint test (JSON body) ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_endpoint_json_body(env):
    """Call the real create_room_from_yaml with a JSON request."""
    import json
    from unittest.mock import AsyncMock

    from fastapi import HTTPException

    from switch_core.gateway.rooms import create_room_from_yaml

    svc = _svc(env)
    user_id = env["user_id"]
    # Not an administrator of anything: this exercises body parsing, and the
    # caller owns the room it creates.
    is_admin = False
    user = User(name="alice", email="alice@example.com", role="member")
    # Poke the id to match the seeded user so provision works.
    object.__setattr__(user, "id", user_id)

    body = json.dumps(
        {
            "yaml": TEMPLATE,
            "inputs": {"owner": "carol", "deploy_agent": "claude-code.alice"},
        }
    ).encode()

    request = AsyncMock()
    request.headers = {"content-type": "application/json"}
    request.body.return_value = body

    async with env["session_factory"]() as session:
        result = await create_room_from_yaml(request, session, svc, user, is_admin)
    assert result.room_name == "carol local-deploy"

    # Non-string yaml value → 400.
    bad_body = json.dumps({"yaml": 123}).encode()
    request.body.return_value = bad_body
    async with env["session_factory"]() as session:
        with pytest.raises(HTTPException) as exc_info:
            await create_room_from_yaml(request, session, svc, user, is_admin)
    assert exc_info.value.status_code == 400


# ── kickoff ─────────────────────────────────────────────────────────────────


class FakeAdminClient(AdminClient):
    """Records platform sends; never touches a transport."""

    def __init__(self) -> None:  # noqa: D107 - test double, no super().__init__
        self.sent: list[dict[str, Any]] = []
        self.joined = True
        self.send_error: Exception | None = None
        self.send_returns: str | None = "$kickoff"

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        return self.joined

    async def send_platform_message(  # type: ignore[override]
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id=None,
        on_behalf_of=None,
        reply_in_channel=False,
    ) -> str | None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(
            {
                "room_id": room_id,
                "body": body,
                "on_behalf_of": on_behalf_of,
                "thread_root_id": thread_root_id,
                "reply_in_channel": reply_in_channel,
            }
        )
        return self.send_returns


class FakeAgentClient:
    def __init__(self, joined: bool = True) -> None:
        self.joined = joined

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        return self.joined


class FakeLifecycle:
    def __init__(self, admin: AdminClient | None) -> None:
        self.admin = admin
        self.agent_clients: dict[str, FakeAgentClient] = {}

    def get_by_type(self, client_type: str, tenant_id: str) -> list:
        if self.admin is not None and client_type == "admin":
            return [self.admin]
        return []

    def get_by_agent_id(self, agent_id: str):
        return self.agent_clients.get(agent_id)


def _with_kickoff(
    env, admin: AdminClient | None
) -> tuple[RoomYamlService, FakeLifecycle]:
    lifecycle = FakeLifecycle(admin)
    svc = _svc(env)
    svc._client_lifecycle = lifecycle  # type: ignore[assignment]
    return svc, lifecycle


KICKOFF_TEMPLATE = """
params:
  coder:
    type: agent
room:
  name: "kick"
  description: "d"
  agents: ["{coder}"]
kickoff: |
  @{coder} start on the brief.
"""


@pytest.mark.asyncio
async def test_provision_kickoff_posts_as_platform_on_behalf_of_creator(env):
    """The kickoff goes out through the admin client with the creator named
    in the marker, after interpolation, and the room reports no failure."""
    admin = FakeAdminClient()
    svc, _ = _with_kickoff(env, admin)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec,
        kickoff=kickoff,
        user_id=env["user_id"],
        is_admin=False,
        creator_name="alice",
    )
    assert result.failed_attachments == []
    person = OnBehalfOf(env["user_id"], "alice")
    assert admin.sent == [
        {
            "room_id": ANY_ROOM,
            "body": "Template kickoff on behalf of @alice",
            "on_behalf_of": person,
            "thread_root_id": None,
            "reply_in_channel": False,
        },
        {
            "room_id": ANY_ROOM,
            "body": "@claude-code.alice start on the brief.\n",
            "on_behalf_of": person,
            "thread_root_id": "$kickoff",
            "reply_in_channel": True,
        },
    ]


@pytest.mark.asyncio
async def test_provision_kickoff_send_failure_is_reported_not_fatal(env):
    admin = FakeAdminClient()
    admin.send_error = RuntimeError("transport down")
    svc, _ = _with_kickoff(env, admin)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False
    )
    assert result.room_id
    assert result.failed_attachments == [
        {"kind": "kickoff", "id": "kickoff", "error": "transport down"}
    ]


@pytest.mark.asyncio
async def test_provision_kickoff_none_event_id_is_a_failure(env):
    """The admin client answers None when the send did not happen; that is a
    failure, not a silent success."""
    admin = FakeAdminClient()
    admin.send_returns = None
    svc, _ = _with_kickoff(env, admin)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False
    )
    assert [f["error"] for f in result.failed_attachments] == [
        "the platform could not post the kickoff"
    ]


@pytest.mark.asyncio
async def test_provision_kickoff_waits_for_agents_and_reports_the_late(env):
    """An agent whose client has not joined by the timeout is named in the
    failure; the kickoff is still posted for the ones that did."""
    admin = FakeAdminClient()
    svc, lifecycle = _with_kickoff(env, admin)
    async with env["session_factory"]() as session:
        agent = await AgentStore().get_by_name(session, "claude-code.alice")
    lifecycle.agent_clients[agent.id] = FakeAgentClient(joined=False)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False
    )
    assert [f["error"] for f in result.failed_attachments] == [
        "did not join the room in time to see the kickoff: claude-code.alice"
    ]
    assert len(admin.sent) == 2


@pytest.mark.asyncio
async def test_provision_kickoff_not_posted_when_platform_never_joins(env):
    admin = FakeAdminClient()
    admin.joined = False
    svc, _ = _with_kickoff(env, admin)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False
    )
    assert admin.sent == []
    assert result.failed_attachments[0]["error"].startswith("did not join")


@pytest.mark.asyncio
async def test_provision_kickoff_without_admin_client_is_reported(env):
    svc, _ = _with_kickoff(env, None)
    spec, kickoff = svc.parse(KICKOFF_TEMPLATE, inputs={"coder": "claude-code.alice"})
    result = await svc.provision(
        spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False
    )
    assert result.failed_attachments == [
        {
            "kind": "kickoff",
            "id": "kickoff",
            "error": "the platform has no client to post with",
        }
    ]


@pytest.mark.asyncio
async def test_provision_without_kickoff_posts_nothing(env):
    admin = FakeAdminClient()
    svc, _ = _with_kickoff(env, admin)
    spec, kickoff = svc.parse("room:\n  name: quiet\n  description: d\n")
    assert kickoff is None
    await svc.provision(spec, kickoff=kickoff, user_id=env["user_id"], is_admin=False)
    assert admin.sent == []


# ── builtins_for ────────────────────────────────────────────────────────────


async def _seed_bridge_with_claim(
    session_factory,
    *,
    display_name: str,
    is_default: bool,
    claimed_by: str | None,
    external_username: str,
) -> str:
    """A bridge, an external user on it, and optionally a claim. Returns the
    bridge id."""
    async with session_factory() as session:
        bridge_client = Client(
            matrix_user_id=f"@bridge-{display_name.lower()}:test.local",
            display_name=display_name,
            type="collaboration_bridge",
        )
        user_client = Client(
            matrix_user_id=f"@{external_username}-{display_name.lower()}:test.local",
            display_name=external_username,
            type="external_user",
        )
        session.add_all([bridge_client, user_client])
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name=display_name,
            client_id=bridge_client.id,
            status="active",
            is_default=is_default,
        )
        session.add(bridge)
        await session.flush()
        ext = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"U-{external_username}",
            external_username=external_username,
            client_id=user_client.id,
        )
        session.add(ext)
        await session.flush()
        if claimed_by is not None:
            session.add(ExternalUserClaim(external_user_id=ext.id, user_id=claimed_by))
        await session.commit()
        return bridge.id


@pytest.mark.asyncio
async def test_builtins_creator_falls_back_to_gateway_name(env):
    """No bridge at all: $creator is the gateway account name."""
    builtins = await _svc(env).builtins_for(
        user_id=env["user_id"],
        name="alice",
        email="alice@example.com",
        text="room:\n  name: n\n  description: d\n",
    )
    assert builtins["$creator"] == "alice"
    assert builtins["$creator_email"] == "alice@example.com"
    assert "$date" in builtins and "$timestamp" in builtins


@pytest.mark.asyncio
async def test_builtins_creator_uses_claimed_identity_on_default_bridge(env):
    """A claim on the template's (default) bridge wins over the gateway name."""
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=True,
        claimed_by=env["user_id"],
        external_username="abel.dantas",
    )
    builtins = await _svc(env).builtins_for(
        user_id=env["user_id"],
        name="alice",
        email="alice@example.com",
        text="room:\n  name: n\n  description: d\n",
    )
    assert builtins["$creator"] == "abel.dantas"


@pytest.mark.asyncio
async def test_builtins_creator_ignores_unclaimed_identity(env):
    """An external user nobody claimed does not become $creator."""
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=True,
        claimed_by=None,
        external_username="abel.dantas",
    )
    builtins = await _svc(env).builtins_for(
        user_id=env["user_id"],
        name="alice",
        email="alice@example.com",
        text="room:\n  name: n\n  description: d\n",
    )
    assert builtins["$creator"] == "alice"


@pytest.mark.asyncio
async def test_builtins_refuses_unclaimed_creator_when_the_template_needs_one(env):
    """A bridged template that uses {$creator} needs a linked account: the
    gateway name is not a platform handle, and guessing produced private
    channels the creator could not enter."""
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=True,
        claimed_by=None,
        external_username="abel.dantas",
    )
    with pytest.raises(ValueError, match=r"no linked account on Slack"):
        await _svc(env).builtins_for(
            user_id=env["user_id"],
            name="alice",
            email="alice@example.com",
            text='room:\n  name: n\n  description: d\n  users: ["{$creator}"]\n',
        )


@pytest.mark.asyncio
async def test_builtins_creator_resolves_named_bridge(env):
    """A template naming a non-default bridge resolves the claim on THAT
    bridge."""
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Mattermost",
        is_default=True,
        claimed_by=env["user_id"],
        external_username="abel.mm",
    )
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=False,
        claimed_by=env["user_id"],
        external_username="abel.slack",
    )
    builtins = await _svc(env).builtins_for(
        user_id=env["user_id"],
        name="alice",
        email="alice@example.com",
        text='room:\n  name: n\n  description: d\n  bridge: "Slack"\n',
    )
    assert builtins["$creator"] == "abel.slack"


@pytest.mark.asyncio
async def test_builtins_creator_resolves_a_bridge_param_from_inputs(env):
    """A `bridge:` written as `{bridge}` is filled from the inputs before the
    claim is looked up, so the creator is found on the app they picked."""
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Mattermost",
        is_default=True,
        claimed_by=env["user_id"],
        external_username="abel.mm",
    )
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=False,
        claimed_by=env["user_id"],
        external_username="abel.slack",
    )
    text = (
        "params:\n  bridge:\n    type: bridge\n"
        'room:\n  name: n\n  description: d\n  bridge: "{bridge}"\n'
        '  users: ["{$creator}"]\n'
    )
    svc = _svc(env)
    picked = await svc.builtins_for(
        user_id=env["user_id"],
        name="alice",
        email="alice@example.com",
        text=text,
        inputs={"bridge": "Slack"},
    )
    assert picked["$creator"] == "abel.slack"
    # No input for it and no default: the app is unknown, so the gateway
    # name stands in rather than a guess at one bridge's claim.
    unset = await svc.builtins_for(
        user_id=env["user_id"], name="alice", email="alice@example.com", text=text
    )
    assert unset["$creator"] == "alice"


CHAIN_TEXT = (
    "params:\n  bridge:\n    type: bridge\n    default: [Teams, $first]\n"
    "  helper:\n    type: agent\n    default: [nobody, $first]\n"
    'room:\n  name: n\n  description: d\n  bridge: "{bridge}"\n'
    '  agents: ["{helper}"]\n'
)


async def test_resolve_defaults_walks_each_chain_in_order(env):
    """The first candidate the server has wins: Teams is not set up, so the
    bridge falls through to the default app; no agent is called nobody, so the
    first agent by name stands in. An input the caller did send is kept."""
    for name, is_default in (("Mattermost", False), ("Slack", True)):
        await _seed_bridge_with_claim(
            env["session_factory"],
            display_name=name,
            is_default=is_default,
            claimed_by=env["user_id"],
            external_username=f"abel.{name.lower()}",
        )
    svc = _svc(env)

    filled = await svc.resolve_defaults(CHAIN_TEXT, None)
    assert filled == {"bridge": "Slack", "helper": "claude-code.alice"}

    kept = await svc.resolve_defaults(CHAIN_TEXT, {"bridge": "Mattermost"})
    assert kept == {"bridge": "Mattermost", "helper": "claude-code.alice"}

    named = CHAIN_TEXT.replace("[Teams, $first]", "[Mattermost, $first]")
    assert (await svc.resolve_defaults(named, None))["bridge"] == "Mattermost"


async def test_a_chain_with_no_hit_is_reported_as_missing(env):
    text = (
        "params:\n  bridge:\n    type: bridge\n    default: [Teams, $first]\n"
        'room:\n  name: n\n  description: d\n  bridge: "{bridge}"\n'
    )
    svc = _svc(env)
    assert await svc.resolve_defaults(text, None) is None
    with pytest.raises(ValueError, match="none of the candidates listed for bridge"):
        svc.parse_template(text)


def test_a_list_default_is_refused_on_a_param_with_no_list(env):
    text = (
        "params:\n  topic:\n    type: string\n    default: [a, b]\n"
        "room:\n  name: n\n  description: d\n"
    )
    with pytest.raises(ValueError, match="a list default applies to params of type"):
        _svc(env).parse_template(text, inputs={"topic": "x"})


def test_new_is_only_for_room_params(env):
    with pytest.raises(ValueError, match="'\\$new' applies to params of type room"):
        ParamSpec(type="bridge", default=["$new"])
    assert ParamSpec(type="room", default=["$new"]).default == ["$new"]


def test_required_and_input_default_from_the_default(env):
    assert ParamSpec(type="string").is_required
    assert not ParamSpec(type="string", default="x").is_required
    assert ParamSpec(type="string", default="x", required=True).is_required
    assert ParamSpec(type="string").input == "ask"
    with pytest.raises(ValueError, match="a fixed param needs a default"):
        ParamSpec(type="string", input="fixed")
    with pytest.raises(ValueError, match="cannot be optional"):
        ParamSpec(type="agent", required=False)
    assert not ParamSpec(type="room", required=False).is_required


def test_an_optional_string_left_empty_is_empty(env):
    spec, _ = _svc(env).parse(
        "params:\n  suffix:\n    type: string\n    required: false\n"
        'room:\n  name: "n{suffix}"\n  description: d\n'
    )
    assert spec.name == "n"


async def test_an_unset_optional_entity_param_passes_the_entity_check(env):
    """``check_entity_params`` skips a param ``resolve_params`` gave no value,
    instead of asking for it."""
    svc = _svc(env)
    parsed = svc.parse_template(
        "params:\n  bridge:\n    type: bridge\n    required: false\n"
        'room:\n  name: n\n  description: d\n  bridge: "{bridge}"\n'
    )
    assert "bridge" not in parsed.values
    await svc.check_entity_params(parsed)


async def test_a_chain_resolves_over_an_input_sent_as_null(env):
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=True,
        claimed_by=env["user_id"],
        external_username="abel.slack",
    )
    text = (
        "params:\n  app:\n    type: bridge\n    default: [Slack, $first]\n"
        'room:\n  name: n\n  description: d\n  bridge: "{app}"\n'
    )
    assert await _svc(env).resolve_defaults(text, {"app": None}) == {"app": "Slack"}


def test_an_optional_bridge_left_empty_lands_on_the_default_app(env):
    """The room's bridge field written as `{bridge}` is cleared rather than
    left as a placeholder, so provisioning picks the default messaging app."""
    spec, _ = _svc(env).parse(
        "params:\n  bridge:\n    type: bridge\n    required: false\n"
        'room:\n  name: n\n  description: d\n  bridge: "{bridge}"\n'
    )
    assert spec.bridge is None


def test_pattern_and_bounds_are_enforced(env):
    svc = _svc(env)
    text = (
        "params:\n  team:\n    type: string\n    pattern: '[a-z]+'\n"
        "  size:\n    type: number\n    min: 1\n    max: 5\n"
        'room:\n  name: "{team}"\n  description: "size {size}"\n'
    )
    spec, _ = svc.parse(text, inputs={"team": "alpha", "size": 3})
    assert spec.name == "alpha"
    assert spec.description == "size 3"
    with pytest.raises(ValueError, match="does not match the pattern"):
        svc.parse(text, inputs={"team": "Alpha1", "size": 3})
    with pytest.raises(ValueError, match="above the maximum 5"):
        svc.parse(text, inputs={"team": "alpha", "size": 9})
    with pytest.raises(ValueError, match="'pattern' applies to params of type string"):
        ParamSpec(type="number", pattern="x")
    with pytest.raises(ValueError, match="not a valid regular expression"):
        ParamSpec(type="string", pattern="(")


def test_label_and_the_new_fields_ride_into_the_schema(env):
    from switch_core.rooms_yaml import template_json_schema

    props = template_json_schema()["$defs"]["ParamSpec"]["properties"]
    for key in ("label", "required", "input", "pattern", "min", "max"):
        assert key in props
    assert "prefill" not in props


def test_parse_multiline_param_option(env):
    """`multiline: true` is a valid param option and rides into the schema."""
    spec, _ = _svc(env).parse(
        "params:\n"
        "  brief:\n"
        "    type: string\n"
        "    multiline: true\n"
        "room:\n"
        "  name: n\n"
        "  description: d\n"
        "  instructions: |\n"
        "    {brief}\n",
        inputs={"brief": "line one\nline two\n## Acceptance\n- item"},
    )
    assert spec.instructions == "line one\nline two\n## Acceptance\n- item\n"

    from switch_core.rooms_yaml import template_json_schema

    schema = template_json_schema()
    assert "multiline" in schema["$defs"]["ParamSpec"]["properties"]


# ── entity params ───────────────────────────────────────────────────────────


def test_resolve_params_entity_types_coerce_to_string():
    """agent/bridge/room/user are string-valued: the entity's name."""
    declared = {
        "coder": ParamSpec(type="agent"),
        "app": ParamSpec(type="bridge"),
        "escalate_to": ParamSpec(type="room"),
        "owner": ParamSpec(type="user"),
    }
    resolved = resolve_params(
        declared,
        {
            "coder": "claude-code.alice",
            "app": "Slack",
            "escalate_to": "ops",
            "owner": 7,
        },
    )
    assert resolved == {
        "coder": "claude-code.alice",
        "app": "Slack",
        "escalate_to": "ops",
        "owner": "7",
    }


def test_template_schema_advertises_entity_types():
    """The Console reads the allowed types off the schema, so the new ones
    must be in it or every typed template is rejected client-side."""
    from switch_core.rooms_yaml import template_json_schema

    schema = template_json_schema()
    allowed = schema["$defs"]["ParamSpec"]["properties"]["type"]["enum"]
    assert {"agent", "bridge", "room", "user"} <= set(allowed)


def _entity_template(param_type: str, extra_room: str = "") -> str:
    return (
        "params:\n"
        "  pick:\n"
        f"    type: {param_type}\n"
        "room:\n"
        "  name: n\n"
        "  description: d\n"
        f"{extra_room}"
        "  instructions: 'uses {pick}'\n"
    )


@pytest.mark.asyncio
async def test_check_entity_params_agent_must_exist(env):
    svc = _svc(env)
    ok = svc.parse_template(
        _entity_template("agent"), inputs={"pick": "claude-code.alice"}
    )
    await svc.check_entity_params(ok)

    bad = svc.parse_template(_entity_template("agent"), inputs={"pick": "nobody"})
    with pytest.raises(ValueError, match=r"param 'pick': no agent named 'nobody'"):
        await svc.check_entity_params(bad)


@pytest.mark.asyncio
async def test_check_entity_params_bridge_must_exist_and_run(env):
    svc = _svc(env)
    await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=True,
        claimed_by=None,
        external_username="someone",
    )
    ok = svc.parse_template(_entity_template("bridge"), inputs={"pick": "Slack"})
    await svc.check_entity_params(ok)

    bad = svc.parse_template(_entity_template("bridge"), inputs={"pick": "Teams"})
    with pytest.raises(
        ValueError, match=r"param 'pick': no messaging app named 'Teams'"
    ):
        await svc.check_entity_params(bad)

    async with env["session_factory"]() as session:
        bridge = (await session.execute(select(CollaborationBridge))).scalar_one()
        bridge.status = "stopped"
        await session.commit()
    stopped = svc.parse_template(_entity_template("bridge"), inputs={"pick": "Slack"})
    with pytest.raises(
        ValueError, match=r"param 'pick': messaging app 'Slack' is not running"
    ):
        await svc.check_entity_params(stopped)


@pytest.mark.asyncio
async def test_check_entity_params_room_must_exist(env):
    svc = _svc(env)
    spec, _ = svc.parse("room:\n  name: ops\n  description: d\n")
    await svc.provision(spec, user_id=env["user_id"], is_admin=False)

    ok = svc.parse_template(_entity_template("room"), inputs={"pick": "ops"})
    await svc.check_entity_params(ok)

    bad = svc.parse_template(_entity_template("room"), inputs={"pick": "nowhere"})
    with pytest.raises(ValueError, match=r"param 'pick': no room named 'nowhere'"):
        await svc.check_entity_params(bad)


@pytest.mark.asyncio
async def test_check_entity_params_user_resolves_on_the_rooms_bridge(env):
    svc = _svc(env)
    bridge_id = await _seed_bridge_with_claim(
        env["session_factory"],
        display_name="Slack",
        is_default=False,
        claimed_by=None,
        external_username="someone",
    )
    env["rooms"].bridge_users = {"bob": "U-bob"}
    text = _entity_template("user", extra_room='  bridge: "Slack"\n')

    ok = svc.parse_template(text, inputs={"pick": "bob"})
    await svc.check_entity_params(ok)
    assert env["rooms"].bridge_user_lookups == [(bridge_id, ["bob"])]

    bad = svc.parse_template(text, inputs={"pick": "eve"})
    with pytest.raises(ValueError, match=r"param 'pick': no user named 'eve'"):
        await svc.check_entity_params(bad)


@pytest.mark.asyncio
async def test_check_entity_params_user_needs_a_bridge(env):
    """No bridge named and no default: a user param has nowhere to look."""
    svc = _svc(env)
    parsed = svc.parse_template(_entity_template("user"), inputs={"pick": "bob"})
    with pytest.raises(ValueError, match=r"param 'pick': a user can only be looked up"):
        await svc.check_entity_params(parsed)


@pytest.mark.asyncio
async def test_check_entity_params_ignores_plain_params(env):
    """Nothing to check means no store access and no error."""
    svc = _svc(env)
    parsed = svc.parse_template(
        "params:\n  label:\n    type: string\nroom:\n  name: '{label}'\n  description: d\n",
        inputs={"label": "anything"},
    )
    await svc.check_entity_params(parsed)


# ── group parse ─────────────────────────────────────────────────────────────


GROUP_TEMPLATE = """\
version: 0
params:
  newcomer:
    type: string
group:
  name: "Onboarding"
  description: "Lobby + per-person workroom"
  color: "#3b82f6"
rooms:
  - name: "{newcomer} lobby"
    description: "Welcome room for {newcomer}"
    agents: ["claude-code.alice"]
    aliases:
      claude-code.alice: greeter
  - name: "{newcomer} workroom"
    description: "Work room for {newcomer}"
    agents: ["claude-code.bob"]
links:
  - from: "{newcomer} lobby"
    to: "{newcomer} workroom"
    label: workroom
"""


def _group(env, text: str, inputs: dict | None = None) -> GroupSpec:
    spec = _svc(env).parse_template(text, inputs=inputs).spec
    assert isinstance(spec, GroupSpec)
    return spec


def test_parse_group_returns_group_spec(env):
    spec = _group(env, GROUP_TEMPLATE, {"newcomer": "dana"})
    assert spec.group.name == "Onboarding"
    assert spec.group.color == "#3b82f6"
    assert [r.name for r in spec.rooms] == ["dana lobby", "dana workroom"]
    assert spec.rooms[0].aliases == {"claude-code.alice": "greeter"}
    assert len(spec.links) == 1
    assert (spec.links[0].from_, spec.links[0].to) == ("dana lobby", "dana workroom")


def test_parse_group_params_interpolate_alias_keys(env):
    spec = _group(
        env,
        """\
params:
  bot:
    type: string
group:
  name: "G"
rooms:
  - name: "R"
    description: "d"
    agents: ["{bot}"]
    aliases:
      "{bot}": helper
""",
        {"bot": "claude-code.alice"},
    )
    assert spec.rooms[0].agents == ["claude-code.alice"]
    assert spec.rooms[0].aliases == {"claude-code.alice": "helper"}


def test_parse_group_builtins_resolve_in_rooms(env):
    parsed = _svc(env).parse_template(
        """\
group:
  name: "G"
rooms:
  - name: "{$creator}'s room"
    description: "d"
""",
        builtins={"$creator": "dana"},
    )
    assert isinstance(parsed.spec, GroupSpec)
    assert parsed.spec.rooms[0].name == "dana's room"


def test_parse_group_room_kickoffs_stay_on_their_rooms(env):
    spec = _group(
        env,
        """\
group:
  name: "G"
rooms:
  - name: "A"
    description: "d"
    kickoff: "hello A"
  - name: "B"
    description: "d"
""",
    )
    assert [r.kickoff for r in spec.rooms] == ["hello A", None]


def test_parse_group_rejects_top_level_kickoff(env):
    with pytest.raises(ValueError, match="inside each entry of 'rooms:'"):
        _svc(env).parse_template(
            """\
group:
  name: "G"
rooms:
  - name: "A"
    description: "d"
kickoff: "hello"
"""
        )


def test_parse_room_rejects_nested_kickoff(env):
    with pytest.raises(ValueError, match="top level"):
        _svc(env).parse_template(
            """\
room:
  name: "A"
  description: "d"
  kickoff: "hello"
"""
        )


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ('group:\n  name: "G"\n', "'rooms:'"),
        ('group:\n  name: "G"\nrooms: []\n', "non-empty"),
        (
            'group:\n  name: "G"\nrooms:\n  - name: lobby\n    description: d\n'
            "  - name: lobby\n    description: d2\n",
            "Duplicate room name",
        ),
        (
            'group:\n  name: "G"\nrooms:\n  - name: A\n    description: d\n'
            "links:\n  - from: A\n    to: B\n    label: x\n",
            "does not match",
        ),
        (
            'group:\n  name: "G"\nrooms:\n  - name: A\n    description: d\nextra: bad\n',
            "Unknown top-level",
        ),
        ("name: oops\ndescription: d\n", "'room:' or 'group:'"),
    ],
)
def test_parse_group_shape_errors(env, text, message):
    with pytest.raises(ValueError, match=message):
        _svc(env).parse_template(text)


def test_parse_short_form_refuses_a_group(env):
    with pytest.raises(ValueError, match="group template"):
        _svc(env).parse(
            'group:\n  name: "G"\nrooms:\n  - name: A\n    description: d\n'
        )


def test_template_schema_covers_both_shapes():
    from switch_core.rooms_yaml import template_json_schema

    schema = template_json_schema()
    branches = schema["oneOf"] if "oneOf" in schema else schema["anyOf"]
    titles = {b["$ref"].rsplit("/", 1)[-1] for b in branches}
    assert titles == {"RoomTemplateDocument", "GroupTemplateDocument"}
    assert "aliases" in schema["$defs"]["RoomSpec"]["properties"]


# ── group provision ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_group_two_rooms_linked(env):
    """The onboarder-shaped template imports in one call: both rooms exist,
    grouped together, linked to each other."""
    svc = _svc(env)
    spec = _group(env, GROUP_TEMPLATE, {"newcomer": "dana"})

    result = await svc.provision_group(spec, user_id=env["user_id"], is_admin=False)

    assert result.group_name == "Onboarding"
    assert [r.room_name for r in result.rooms] == ["dana lobby", "dana workroom"]
    assert result.errors == []

    async with env["session_factory"]() as session:
        group = await session.get(RoomGroup, result.group_id)
        assert group is not None
        assert (group.name, group.color) == ("Onboarding", "#3b82f6")
        for rr in result.rooms:
            room = await session.get(Room, rr.room_id)
            assert room is not None
            assert room.group_id == result.group_id
        link = await session.get(
            RoomLink, (result.rooms[0].room_id, result.rooms[1].room_id)
        )
        assert link is not None
        assert link.label == "workroom"


@pytest.mark.asyncio
async def test_provision_group_reports_a_failed_room_and_keeps_the_rest(env):
    svc = _svc(env)
    spec = _group(
        env,
        """\
group:
  name: "Collider"
rooms:
  - name: "safe room"
    description: "d"
    agents: ["claude-code.alice"]
  - name: "boom room"
    description: "d"
    agents: ["does-not-exist"]
links:
  - from: "safe room"
    to: "boom room"
    label: next
""",
    )
    result = await svc.provision_group(spec, user_id=env["user_id"], is_admin=False)

    assert [r.room_name for r in result.rooms] == ["safe room"]
    assert result.errors[0]["room_name"] == "boom room"
    assert "does-not-exist" in result.errors[0]["error"]
    # The link could not be made either, and says so rather than vanishing.
    assert result.errors[1]["kind"] == "link"
    async with env["session_factory"]() as session:
        assert await session.get(RoomGroup, result.group_id) is not None


@pytest.mark.asyncio
async def test_provision_group_posts_each_rooms_kickoff(env, monkeypatch):
    svc = _svc(env)
    posted: list[tuple[str, str]] = []

    async def fake_send(room, kickoff, **kwargs):
        posted.append((room.name, kickoff))

    monkeypatch.setattr(svc, "_send_kickoff", fake_send)
    spec = _group(
        env,
        """\
group:
  name: "G"
rooms:
  - name: "A"
    description: "d"
    kickoff: "start A"
  - name: "B"
    description: "d"
""",
    )
    await svc.provision_group(
        spec, user_id=env["user_id"], is_admin=False, creator_name="alice"
    )
    assert posted == [("A", "start A")]


@pytest.mark.asyncio
async def test_check_entity_params_covers_every_room_of_a_group(env):
    svc = _svc(env)
    parsed = svc.parse_template(
        """\
params:
  pick:
    type: agent
group:
  name: "G"
rooms:
  - name: "A"
    description: "d"
  - name: "B"
    description: "uses {pick}"
""",
        inputs={"pick": "nobody"},
    )
    with pytest.raises(ValueError, match="param 'pick': no agent named 'nobody'"):
        await svc.check_entity_params(parsed)


@pytest.mark.asyncio
async def test_endpoint_json_body_group(env):
    """The /from-yaml endpoint provisions a group document."""
    import json
    from unittest.mock import AsyncMock

    from switch_core.gateway.rooms import create_room_from_yaml

    svc = _svc(env)
    user = User(name="alice", email="alice@example.com", role="member")
    object.__setattr__(user, "id", env["user_id"])
    request = AsyncMock()
    request.headers = {"content-type": "application/json"}
    request.body.return_value = json.dumps(
        {"yaml": GROUP_TEMPLATE, "inputs": {"newcomer": "frank"}}
    ).encode()

    async with env["session_factory"]() as session:
        result = await create_room_from_yaml(request, session, svc, user, False)
    assert result.group_name == "Onboarding"
    assert [r.room_name for r in result.rooms] == ["frank lobby", "frank workroom"]


@pytest.mark.asyncio
async def test_export_emits_aliases(env):
    svc = _svc(env)
    spec = _group(
        env,
        """\
group:
  name: "G"
rooms:
  - name: "A"
    description: "d"
    agents: ["claude-code.alice"]
    aliases:
      claude-code.alice: greeter
""",
    )
    result = await svc.provision_group(spec, user_id=env["user_id"], is_admin=False)
    room_id = result.rooms[0].room_id
    # FakeRoomService does not seed aliases; write the row the real one would.
    async with env["session_factory"]() as session:
        agent = (await AgentStore().get_by_names(session, ["claude-code.alice"]))[0]
        await session.execute(
            room_agents.update()
            .where(room_agents.c.room_id == room_id)
            .where(room_agents.c.agent_id == agent.id)
            .values(alias="greeter")
        )
        await session.commit()
    exported = yaml.safe_load(await svc.export(room_id))
    assert exported["room"]["aliases"] == {"claude-code.alice": "greeter"}


def test_parse_rejects_non_string_kickoff(env):
    with pytest.raises(ValueError, match="'kickoff' must be a string"):
        _svc(env).parse_template(
            "room:\n  name: r\n  description: d\nkickoff: [hello]\n"
        )


@pytest.mark.asyncio
async def test_provision_reports_a_kickoff_that_raises(env, monkeypatch):
    svc = _svc(env)

    async def boom(*args, **kwargs):
        raise RuntimeError("admin client is gone")

    monkeypatch.setattr(svc, "_send_kickoff", boom)
    parsed = svc.parse_template("room:\n  name: r\n  description: d\nkickoff: hi\n")
    result = await svc.provision(
        parsed.spec, kickoff=parsed.kickoff, user_id=env["user_id"], is_admin=False
    )
    assert result.room_name == "r"
    assert result.failed_attachments == [
        {"kind": "kickoff", "id": "kickoff", "error": "admin client is gone"}
    ]

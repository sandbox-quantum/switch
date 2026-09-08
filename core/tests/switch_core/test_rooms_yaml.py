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

import pytest
import pytest_asyncio
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
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
    svc = RoomYamlService(
        room_service=FakeRoomService(session_factory, agent_store),  # type: ignore[arg-type]
        resource_service=resource_service,
        room_store=RoomStore(),
        agent_store=agent_store,
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_group_store=RoomGroupStore(),
        room_role_store=RoomRoleStore(),
        session_factory=session_factory,
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
        "resource_service": resource_service,
        "session_factory": session_factory,
        "user_id": user_id,
    }


# ── parse ────────────────────────────────────────────────────────────────────


def _svc(env) -> RoomYamlService:
    return env["svc"]


def test_parse_minimal(env):
    spec = _svc(env).parse(
        """
        room:
          name: "Room A"
          description: "desc"
        """
    )
    assert spec.name == "Room A"
    assert spec.channel_type == "channel_public"
    assert spec.references == []


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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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

    spec = _svc(env).parse(
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

    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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

    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    reparsed = _svc(env).parse(yaml_text)

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
    spec = _svc(env).parse(
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
    reparsed = _svc(env).parse(yaml_text)
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
    reparsed = _svc(env).parse(yaml_text)
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    spec = _svc(env).parse(
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
    r1 = await svc.provision(
        svc.parse(
            TEMPLATE, inputs={"owner": "alice", "deploy_agent": "claude-code.alice"}
        ),
        user_id=env["user_id"],
        is_admin=False,
    )
    r2 = await svc.provision(
        svc.parse(TEMPLATE, inputs={"owner": "bob", "deploy_agent": "claude-code.bob"}),
        user_id=env["user_id"],
        is_admin=False,
    )
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

    result = await create_room_from_yaml(request, svc, user)
    assert result.room_name == "carol local-deploy"

    # Non-string yaml value → 400.
    bad_body = json.dumps({"yaml": 123}).encode()
    request.body.return_value = bad_body
    with pytest.raises(HTTPException) as exc_info:
        await create_room_from_yaml(request, svc, user)
    assert exc_info.value.status_code == 400


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


def test_parse_group_returns_group_spec(env):
    spec = _svc(env).parse(GROUP_TEMPLATE, inputs={"newcomer": "dana"})
    assert isinstance(spec, GroupSpec)
    assert spec.group.name == "Onboarding"
    assert spec.group.color == "#3b82f6"
    assert len(spec.rooms) == 2
    assert spec.rooms[0].name == "dana lobby"
    assert spec.rooms[1].name == "dana workroom"
    assert len(spec.links) == 1
    assert spec.links[0].from_ == "dana lobby"
    assert spec.links[0].to == "dana workroom"


def test_parse_group_params_interpolate_aliases(env):
    template = """\
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
"""
    spec = _svc(env).parse(template, inputs={"bot": "claude-code.alice"})
    assert isinstance(spec, GroupSpec)
    assert spec.rooms[0].aliases == {"claude-code.alice": "helper"}


def test_parse_group_missing_rooms_key(env):
    with pytest.raises(ValueError, match="'rooms:'"):
        _svc(env).parse(
            """
            group:
              name: "G"
            """
        )


def test_parse_group_empty_rooms_list(env):
    with pytest.raises(ValueError, match="non-empty"):
        _svc(env).parse(
            """
            group:
              name: "G"
            rooms: []
            """
        )


def test_parse_group_link_bad_name(env):
    with pytest.raises(ValueError, match="does not match"):
        _svc(env).parse(
            """
            group:
              name: "G"
            rooms:
              - name: "A"
                description: "d"
            links:
              - from: "A"
                to: "B"
                label: "x"
            """
        )


def test_parse_group_unknown_top_level_key(env):
    with pytest.raises(ValueError, match="Unknown top-level"):
        _svc(env).parse(
            """
            group:
              name: "G"
            rooms:
              - name: "A"
                description: "d"
            extra: bad
            """
        )


# ── group provision ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_group_two_rooms_linked(env):
    """The onboarder-shaped template imports in one call: both rooms exist,
    grouped together, linked to each other."""
    svc = _svc(env)
    spec = svc.parse(GROUP_TEMPLATE, inputs={"newcomer": "dana"})
    assert isinstance(spec, GroupSpec)

    result = await svc.provision_group(spec, user_id=env["user_id"], is_admin=False)

    assert result.group_name == "Onboarding"
    assert len(result.rooms) == 2
    assert result.rooms[0].room_name == "dana lobby"
    assert result.rooms[1].room_name == "dana workroom"
    assert result.errors == []

    # Both rooms filed under the same group.
    sf = env["session_factory"]
    async with sf() as session:
        group = await session.get(RoomGroup, result.group_id)
        assert group is not None
        assert group.name == "Onboarding"
        assert group.color == "#3b82f6"

        for rr in result.rooms:
            room = await session.get(Room, rr.room_id)
            assert room is not None
            assert room.group_id == result.group_id

        # Link exists from lobby → workroom.
        link = await session.get(
            RoomLink,
            (result.rooms[0].room_id, result.rooms[1].room_id),
        )
        assert link is not None
        assert link.label == "workroom"


@pytest.mark.asyncio
async def test_provision_group_params_across_rooms(env):
    """Params interpolate across the whole document from one inputs dict."""
    svc = _svc(env)
    spec = svc.parse(GROUP_TEMPLATE, inputs={"newcomer": "eve"})
    assert isinstance(spec, GroupSpec)
    result = await svc.provision_group(spec, user_id=env["user_id"], is_admin=False)

    assert result.rooms[0].room_name == "eve lobby"
    assert result.rooms[1].room_name == "eve workroom"


@pytest.mark.asyncio
async def test_provision_group_partial_failure_collision(env):
    """When the second room name collides, group + first room exist and the
    error names the collision."""
    svc = _svc(env)

    # Provision once to create "dana lobby".
    spec1 = svc.parse(GROUP_TEMPLATE, inputs={"newcomer": "dana"})
    assert isinstance(spec1, GroupSpec)
    await svc.provision_group(spec1, user_id=env["user_id"], is_admin=False)

    # Build a group whose second room collides with an existing name.
    collision_template = """\
group:
  name: "Collider"
rooms:
  - name: "safe room"
    description: "d"
    agents: ["claude-code.alice"]
  - name: "dana lobby"
    description: "d"
    agents: ["claude-code.bob"]
"""
    spec2 = svc.parse(collision_template)
    assert isinstance(spec2, GroupSpec)

    # FakeRoomService doesn't enforce unique names, so we need to pre-create
    # the collision. Instead, make the second room reference an unknown agent.
    collision_template_bad_agent = """\
group:
  name: "Collider"
rooms:
  - name: "safe room"
    description: "d"
    agents: ["claude-code.alice"]
  - name: "boom room"
    description: "d"
    agents: ["does-not-exist"]
"""
    spec3 = svc.parse(collision_template_bad_agent)
    assert isinstance(spec3, GroupSpec)
    result = await svc.provision_group(spec3, user_id=env["user_id"], is_admin=False)

    # Group + first room exist, second room errored.
    assert result.group_name == "Collider"
    assert len(result.rooms) == 1
    assert result.rooms[0].room_name == "safe room"
    assert len(result.errors) == 1
    assert result.errors[0]["room_name"] == "boom room"
    assert "does-not-exist" in result.errors[0]["error"]

    # Verify the group row was created.
    sf = env["session_factory"]
    async with sf() as session:
        group = await session.get(RoomGroup, result.group_id)
        assert group is not None


# ── single-room regression ──────────────────────────────────────────────────


def test_single_room_parse_still_works(env):
    """Single-room documents keep working unchanged after adding group support."""
    spec = _svc(env).parse(
        """
        room:
          name: "Room A"
          description: "desc"
        """
    )
    assert spec.name == "Room A"


def test_parse_rejects_neither_room_nor_group(env):
    with pytest.raises(ValueError, match="'room:' or 'group:'"):
        _svc(env).parse("name: oops\ndescription: d\n")


@pytest.mark.asyncio
async def test_endpoint_json_body_group(env):
    """The /from-yaml endpoint handles a group document."""
    import json
    from unittest.mock import AsyncMock

    from switch_core.gateway.rooms import create_room_from_yaml

    svc = _svc(env)
    user_id = env["user_id"]
    user = User(name="alice", email="alice@example.com", role="member")
    object.__setattr__(user, "id", user_id)

    body = json.dumps(
        {
            "yaml": GROUP_TEMPLATE,
            "inputs": {"newcomer": "frank"},
        }
    ).encode()

    request = AsyncMock()
    request.headers = {"content-type": "application/json"}
    request.body.return_value = body

    result = await create_room_from_yaml(request, svc, user)
    assert result.group_name == "Onboarding"
    assert len(result.rooms) == 2

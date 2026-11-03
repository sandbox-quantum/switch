from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.agent_icon import InvalidIconUrl, generated_icon_url
from switch_core.bridges.agent.operations import agent_management
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import definitions as ops
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_detail import AgentProfileUpdate
from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    Room,
    User,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.known_agents import known_agents
from switch_core.gateway.schemas import NamedEntry

SECRET_ID = "someone-the-owner-let-in"


class _NoBridges:
    """A deployment with no collaboration bridges running."""

    def bridges_for_tenant(self, tenant_id: str) -> list[object]:
        return []


def _service(session_factory: async_sessionmaker[AsyncSession]) -> AgentCore:
    svc = object.__new__(AgentCore)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = AgentConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.user_store = UserStore()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.room_role_store = RoomRoleStore()  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[assignment]
    return svc


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    return user


async def _make_agent(
    session: AsyncSession,
    name: str,
    *,
    owner_id: str | None,
    known: bool = True,
    parent_agent_id: str | None = None,
) -> Agent:
    api_key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        transport_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()

    if known:
        spec = known_agents()["claude-code"]
        opts = spec.parse_options({})
        integration_profile = spec.build_profile(opts).model_dump()
        metadata_ = {
            "known_agent_type": "claude-code",
            "known_agent_options": opts.model_dump(),
        }
    else:
        integration_profile = {"connection_model": "session_passive"}
        metadata_ = None

    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_addressable",
        connector_type="Claude Code",
        integration_profile=integration_profile,
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
        parent_agent_id=parent_agent_id,
        metadata_=metadata_,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestListAgents:
    async def test_unfiltered_lists_all_sorted_by_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            await _make_agent(session, "zeta", owner_id=owner.id)
            await _make_agent(session, "alpha", owner_id=owner.id)
            await session.commit()

        out = await svc.list_agents("caller", None, None, None)
        assert [a["name"] for a in out] == ["alpha", "zeta"]

    async def test_name_contains_is_case_insensitive_substring(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            await _make_agent(session, "data-bot", owner_id=owner.id)
            await _make_agent(session, "chatter", owner_id=owner.id)
            await session.commit()

        out = await svc.list_agents("caller", "BOT", None, None)
        assert [a["name"] for a in out] == ["data-bot"]

    async def test_owner_name_filter(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner_a = await _make_user(session, "alice")
            owner_b = await _make_user(session, "bob")
            await _make_agent(session, "a1", owner_id=owner_a.id)
            await _make_agent(session, "b1", owner_id=owner_b.id)
            await session.commit()

        out = await svc.list_agents("caller", None, "alice", None)
        assert [a["name"] for a in out] == ["a1"]
        assert out[0]["owner_name"] == "alice"

    async def test_known_agent_type_filter(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            await _make_agent(session, "known", owner_id=owner.id, known=True)
            await _make_agent(session, "other", owner_id=owner.id, known=False)
            await session.commit()

        out = await svc.list_agents("caller", None, None, "claude-code")
        assert [a["name"] for a in out] == ["known"]


class TestGetAgentDetail:
    async def test_returns_known_agent_detail(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            agent = await _make_agent(session, "target", owner_id=owner.id)
            await session.commit()
            agent_id = agent.id

        detail = await svc.get_agent_detail("caller", agent_id)
        assert detail.name == "target"
        assert detail.agent_type == "session_addressable"
        assert detail.known_agent_type == "claude-code"
        assert detail.known_agent_options is not None
        assert detail.known_agent_options["repo_dir"] is None
        assert detail.rooms == []
        assert detail.sessions == []
        assert detail.children == []

    async def test_missing_agent_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        with pytest.raises(ValueError, match="Agent not found"):
            await svc.get_agent_detail("caller", "nope")


async def _chat_account(session: AsyncSession, username: str) -> ExternalUser:
    bridge_client = Client(
        transport_user_id=f"@bridge-{username}:test",
        display_name="bridge",
        type="collaboration_bridge",
    )
    account_client = Client(
        transport_user_id=f"@{username}-chat:test",
        display_name=username,
        type="external_user",
    )
    session.add_all([bridge_client, account_client])
    await session.flush()
    bridge = CollaborationBridge(
        type="slack",
        display_name="Slack",
        client_id=bridge_client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    account = ExternalUser(
        bridge_id=bridge.id,
        external_user_id=f"U-{username}",
        external_username=username,
        client_id=account_client.id,
    )
    session.add(account)
    await session.flush()
    return account


def _entries(dimension: str | list[NamedEntry]) -> list[dict[str, str | None]]:
    assert isinstance(dimension, list)
    return [entry.model_dump() for entry in dimension]


class TestGetAgentAddressing:
    async def test_an_agent_reads_its_own_rules_with_names(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            helper = await _make_agent(session, "helper", owner_id=owner.id)
            bob = await _chat_account(session, "bob")
            room = Room(transport_room_id="!ops:test", name="ops", description="d")
            session.add(room)
            await session.flush()
            policy = AddressingPolicy(
                rules=[
                    AddressingRule(users=[], agents=[], owner=True),
                    AddressingRule(
                        rooms=[room.id],
                        users=[bob.id, "gone"],
                        agents=[helper.id],
                    ),
                ]
            )
            agent = await _make_agent(session, "me", owner_id=owner.id)
            agent.addressing_policy = policy.model_dump()
            await session.commit()
            ids = (agent.id, helper.id, bob.id, room.id)
        agent_id, helper_id, bob_id, room_id = ids

        addressing = await svc.get_agent_addressing(agent_id, agent_id)

        assert addressing.policy == "custom"
        assert addressing.rules is not None
        owner_rule, named_rule = addressing.rules
        assert owner_rule.owner is True
        assert owner_rule.users == []
        assert _entries(named_rule.rooms) == [{"id": room_id, "name": "ops"}]
        assert _entries(named_rule.users) == [
            {"id": bob_id, "name": "bob"},
            {"id": "gone", "name": None},
        ]
        assert _entries(named_rule.agents) == [{"id": helper_id, "name": "helper"}]
        assert named_rule.room_groups == "*"

    async def test_another_agent_sees_only_the_kind(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        requester_id, target_id = await _owned_pair(session_factory)
        async with session_factory() as session:
            target = await session.get(Agent, target_id)
            assert target is not None
            target.addressing_policy = owner_only_policy(["someone"]).model_dump()
            await session.commit()
        svc = _service(session_factory)

        addressing = await svc.get_agent_addressing(requester_id, target_id)

        assert addressing.model_dump(exclude_none=True) == {"policy": "custom"}

    async def test_the_default_policy_reads_as_owner_and_owner_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, target_id = await _owned_pair(session_factory)
        async with session_factory() as session:
            target = await session.get(Agent, target_id)
            assert target is not None
            target.addressing_policy = owner_and_owner_agents_policy().model_dump()
            await session.commit()
        svc = _service(session_factory)

        addressing = await svc.get_agent_addressing(target_id, target_id)

        assert addressing.policy == "owner_and_owner_agents"
        assert addressing.rules is not None
        assert len(addressing.rules) == 1
        assert addressing.rules[0].owner is True
        assert addressing.rules[0].owner_agents is True

    async def test_an_open_agent_has_no_rules(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, target_id = await _owned_pair(session_factory)
        svc = _service(session_factory)

        addressing = await svc.get_agent_addressing(target_id, target_id)

        assert addressing.model_dump() == {"policy": "anyone", "rules": []}

    async def test_missing_agent_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        with pytest.raises(ValueError, match="Agent not found"):
            await svc.get_agent_addressing("caller", "nope")


def _profile(
    *,
    description: str | None = None,
    display_name: str | None = None,
    icon_url: str | None = None,
    addressing: str | None = None,
    third_party_avatars: bool = True,
) -> AgentProfileUpdate:
    return AgentProfileUpdate.parse(
        description=description,
        display_name=display_name,
        icon_url=icon_url,
        addressing=addressing,
        third_party_avatars=third_party_avatars,
    )


async def _owned_pair(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        requester = await _make_agent(session, "req", owner_id=owner.id)
        target = await _make_agent(session, "target", owner_id=owner.id)
        await session.commit()
        return requester.id, target.id


class TestUpdateAgentDetail:
    async def test_changes_description_display_name_and_icon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        req_id, target_id = await _owned_pair(session_factory)

        detail = await svc.update_agent_detail(
            req_id,
            target_id,
            _profile(
                description="  Reviews pull requests  ",
                display_name="Reviewer",
                icon_url="https://example.com/reviewer.png",
            ),
        )

        assert detail.description == "Reviews pull requests"
        assert detail.display_name == "Reviewer"
        assert detail.icon_url == "https://example.com/reviewer.png"

    async def test_empty_string_clears_display_name_and_icon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        req_id, target_id = await _owned_pair(session_factory)
        await svc.update_agent_detail(
            req_id,
            target_id,
            _profile(display_name="Reviewer", icon_url="https://example.com/r.png"),
        )

        detail = await svc.update_agent_detail(
            req_id, target_id, _profile(display_name="", icon_url="")
        )

        assert detail.display_name is None
        assert detail.icon_url is None
        assert detail.description == "target desc"

    @pytest.mark.parametrize(
        ("choice", "stored"),
        [
            ("owner_only", owner_only_policy([]).model_dump()),
            ("owner_and_owner_agents", owner_and_owner_agents_policy().model_dump()),
            ("anyone", None),
        ],
    )
    async def test_addressing_maps_onto_the_policy(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        choice: str,
        stored: dict | None,
    ) -> None:
        svc = _service(session_factory)
        req_id, target_id = await _owned_pair(session_factory)
        await svc.update_agent_detail(
            req_id, target_id, _profile(addressing="owner_only")
        )

        await svc.update_agent_detail(req_id, target_id, _profile(addressing=choice))

        async with session_factory() as session:
            agent = await AgentStore().get(session, target_id)
            assert agent is not None
            assert agent.addressing_policy == stored

    def test_invalid_values_are_refused_before_anything_is_written(self) -> None:
        with pytest.raises(ValueError, match="addressing must be one of"):
            _profile(addressing="everyone")
        with pytest.raises(InvalidIconUrl):
            _profile(icon_url="http://localhost/icon.png")
        with pytest.raises(ValueError, match="description must not be blank"):
            _profile(description="   ")

    def test_an_avatar_service_icon_is_refused_only_when_the_server_turns_them_off(
        self,
    ) -> None:
        dicebear = generated_icon_url("target")
        with pytest.raises(InvalidIconUrl, match="third-party avatars turned off"):
            _profile(icon_url=dicebear, third_party_avatars=False)
        assert _profile(icon_url=dicebear).columns == {"icon_url": dicebear}
        other = "https://example.com/r.png"
        assert _profile(icon_url=other, third_party_avatars=False).columns == {
            "icon_url": other
        }

    async def test_non_owner_is_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner_a = await _make_user(session, "ownera")
            owner_b = await _make_user(session, "ownerb")
            requester = await _make_agent(session, "req", owner_id=owner_b.id)
            target = await _make_agent(session, "target", owner_id=owner_a.id)
            await session.commit()
            req_id, target_id = requester.id, target.id

        with pytest.raises(PermissionError):
            await svc.update_agent_detail(
                req_id, target_id, _profile(description="mine now")
            )
        async with session_factory() as session:
            agent = await AgentStore().get(session, target_id)
            assert agent is not None
            assert agent.description == "target desc"


class _RecordingAdapter:
    def __init__(self) -> None:
        self.updated: list[tuple[str, str | None, str]] = []

    async def update_agent_identity(self, agent: AgentIdentity) -> None:
        self.updated.append((agent.name, agent.display_name, agent.description))


class _RecordingBridges:
    def __init__(self, adapter: _RecordingAdapter) -> None:
        self.adapter = adapter
        self.bridge_type = "mattermost"

    def bridges_for_tenant(self, tenant_id: str) -> list[_RecordingBridges]:
        return [self]


class TestUpdateAgentDetailReachesTheBridges:
    """A platform handle that shows the label or the description follows an
    edit made through the agent tool, not only one made in the gateway."""

    @pytest.mark.parametrize(
        ("change", "expected"),
        [
            ({"display_name": "Reviewer"}, ("target", "Reviewer", "target desc")),
            ({"description": "Reviews PRs"}, ("target", None, "Reviews PRs")),
        ],
    )
    async def test_a_label_or_description_change_is_passed_on(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        change: dict[str, str],
        expected: tuple[str, str | None, str],
    ) -> None:
        svc = _service(session_factory)
        adapter = _RecordingAdapter()
        svc.collab_lifecycle = _RecordingBridges(adapter)  # type: ignore[assignment]
        req_id, target_id = await _owned_pair(session_factory)

        await svc.update_agent_detail(req_id, target_id, _profile(**change))

        assert adapter.updated == [expected]

    async def test_other_changes_are_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        adapter = _RecordingAdapter()
        svc.collab_lifecycle = _RecordingBridges(adapter)  # type: ignore[assignment]
        req_id, target_id = await _owned_pair(session_factory)

        await svc.update_agent_detail(
            req_id,
            target_id,
            _profile(icon_url="https://example.com/r.png", addressing="anyone"),
        )

        assert adapter.updated == []


def _keys(value: object) -> set[str]:
    """Every key in a JSON-shaped value, at any depth."""
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()


class TestAgentFacingResultsKeepPoliciesPrivate:
    """Who an agent's policy names is its owner's business: the operations
    agents call return `addressing` and never the raw policy, for the agent,
    its children, or a list of agents."""

    @pytest.fixture
    async def agents(
        self,
        monkeypatch: pytest.MonkeyPatch,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> AsyncIterator[tuple[str, str, str]]:
        svc = _service(session_factory)
        svc.config = SimpleNamespace(third_party_avatars_enabled=True)  # type: ignore[assignment]
        monkeypatch.setattr(op_context, "_protocol", svc)
        monkeypatch.setattr(agent_management, "_port", None)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            caller = await _make_agent(session, "caller", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            child = await _make_agent(
                session, "child", owner_id=owner.id, parent_agent_id=target.id
            )
            for agent in (caller, target, child):
                agent.addressing_policy = owner_only_policy(
                    [SECRET_ID, f"{agent.name}-friend"]
                ).model_dump()
            await session.commit()
            ids = (caller.id, target.id, child.id)
        token = set_call_context(
            CallContext(agent_id=ids[0], session_key=None, session=None)
        )
        yield ids
        reset_call_context(token)

    async def test_get_agent_detail_of_another_agent(
        self, agents: tuple[str, str, str]
    ) -> None:
        _, target_id, child_id = agents

        result = await ops.get_agent_detail(target_id)

        assert "addressing_policy" not in _keys(result)
        assert SECRET_ID not in json.dumps(result)
        assert [child["id"] for child in result["children"]] == [child_id]
        assert result["addressing"] == {"policy": "custom"}

    async def test_get_agent_detail_of_itself_names_its_rules_once(
        self, agents: tuple[str, str, str]
    ) -> None:
        caller_id, _, _ = agents

        result = await ops.get_agent_detail(caller_id)

        assert "addressing_policy" not in _keys(result)
        assert result["addressing"]["rules"]

    async def test_list_agents(self, agents: tuple[str, str, str]) -> None:
        result = await ops.list_agents()

        assert {agent["name"] for agent in result} == {"caller", "target", "child"}
        assert "addressing_policy" not in _keys(result)
        assert SECRET_ID not in json.dumps(result)

    async def test_update_agent_detail(self, agents: tuple[str, str, str]) -> None:
        _, target_id, _ = agents

        result = await ops.update_agent_detail(target_id, description="new")

        assert result["description"] == "new"
        assert "addressing_policy" not in _keys(result)
        assert SECRET_ID not in json.dumps(result)

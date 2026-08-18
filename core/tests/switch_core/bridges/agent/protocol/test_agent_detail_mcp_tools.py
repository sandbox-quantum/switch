from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_detail import AgentOptionsNotEditable
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.known_agents import KNOWN_AGENTS


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.user_store = UserStore()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.room_role_store = RoomRoleStore()  # type: ignore[attr-defined]
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
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
        password="x",
    )
    session.add_all([api_key, client])
    await session.flush()

    if known:
        spec = KNOWN_AGENTS["claude-code"]
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


class TestUpdateAgentDetail:
    async def test_merges_options_leaving_others_untouched(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            await session.commit()
            req_id, target_id = requester.id, target.id

        detail = await svc.update_agent_detail(
            req_id, target_id, {"repo_dir": "/work/dir"}, None, False
        )
        assert detail.known_agent_options is not None
        # The changed field is applied...
        assert detail.known_agent_options["repo_dir"] == "/work/dir"
        # ...and the untouched fields keep their prior values (partial merge).
        assert detail.known_agent_options["channels_enabled"] is True

    async def test_options_rebuild_integration_profile(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            await session.commit()
            req_id, target_id = requester.id, target.id

        detail = await svc.update_agent_detail(
            req_id, target_id, {"channels_enabled": False}, None, False
        )
        assert detail.integration_profile["connection_model"] == "session_passive"

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
                req_id, target_id, {"repo_dir": "/x"}, None, False
            )

    async def test_non_known_agent_options_not_editable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(
                session, "target", owner_id=owner.id, known=False
            )
            await session.commit()
            req_id, target_id = requester.id, target.id

        with pytest.raises(AgentOptionsNotEditable):
            await svc.update_agent_detail(
                req_id, target_id, {"repo_dir": "/x"}, None, False
            )

    async def test_set_and_clear_parent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            parent = await _make_agent(session, "parent", owner_id=owner.id)
            await session.commit()
            req_id, target_id, parent_id = requester.id, target.id, parent.id

        detail = await svc.update_agent_detail(
            req_id, target_id, None, parent_id, False
        )
        assert detail.parent_agent_id == parent_id

        detail = await svc.update_agent_detail(req_id, target_id, None, None, True)
        assert detail.parent_agent_id is None

    async def test_self_parent_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            await session.commit()
            req_id, target_id = requester.id, target.id

        with pytest.raises(ValueError, match="cannot be its own parent"):
            await svc.update_agent_detail(req_id, target_id, None, target_id, False)

    async def test_cycle_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            target = await _make_agent(session, "target", owner_id=owner.id)
            # `child` is already a descendant of `target`.
            child = await _make_agent(
                session, "child", owner_id=owner.id, parent_agent_id=target.id
            )
            await session.commit()
            req_id, target_id, child_id = requester.id, target.id, child.id

        # Re-parenting target under its own descendant would create a cycle.
        with pytest.raises(ValueError, match="descendant"):
            await svc.update_agent_detail(req_id, target_id, None, child_id, False)

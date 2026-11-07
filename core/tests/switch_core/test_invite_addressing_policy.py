from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.addressing import (
    AddressingPolicy,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.room_service import (
    AddressingRefusalError,
    RoomCreateConfig,
    RoomService,
)


def _agent(
    agent_id: str,
    name: str,
    owner_id: str | None = None,
    addressing_policy: AddressingPolicy | dict[str, Any] | None = None,
) -> SimpleNamespace:
    policy_dump = (
        addressing_policy.model_dump()
        if isinstance(addressing_policy, AddressingPolicy)
        else addressing_policy
    )
    return SimpleNamespace(
        id=agent_id,
        name=name,
        display_name=name.title(),
        owner_id=owner_id,
        addressing_policy=policy_dump,
    )


class _FakeSession:
    """Mock session supporting scalar and execute queries for testing."""

    def __init__(
        self,
        *,
        claims: dict[str, list[str]] | None = None,
        clients: dict[str, Any] | None = None,
    ) -> None:
        self.claims = claims or {}
        self.clients = clients or {}
        self.commit = AsyncMock()

    async def execute(self, statement: Any) -> Any:
        # Check if querying ExternalUserClaim
        str_stmt = str(statement)
        res = MagicMock()
        if "external_user_claims" in str_stmt.lower():
            # Extract searched external id if present, or return matching
            all_uids: list[str] = []
            for ext_id, uids in self.claims.items():
                all_uids.extend(uids)
            res.scalars.return_value.all.return_value = all_uids
        else:
            res.scalars.return_value.all.return_value = []
        return res

    async def scalar(self, statement: Any) -> Any:
        str_stmt = str(statement)
        if "clients" in str_stmt.lower():
            for c_id, client in self.clients.items():
                return client
        return None


def _build_room_service(
    agents: dict[str, Any],
    *,
    claims: dict[str, list[str]] | None = None,
    clients: dict[str, Any] | None = None,
    room_agents: list[str] | None = None,
) -> tuple[RoomService, list[str]]:
    added_agents: list[str] = []
    created_rooms: list[str] = []

    async def _get_many(_session: Any, ids: list[str]) -> list[Any]:
        return [agents[aid] for aid in ids if aid in agents]

    async def _get(_session: Any, agent_id: str) -> Any:
        return agents.get(agent_id)

    async def _get_by_name(_session: Any, name: str) -> Any:
        for a in agents.values():
            if a.name == name:
                return a
        return None

    agent_store = SimpleNamespace(
        get_many=_get_many,
        get=_get,
        get_by_name=_get_by_name,
        get_by_names=AsyncMock(return_value=list(agents.values())),
        get_children=AsyncMock(return_value=[]),
    )

    room_store = SimpleNamespace(
        get=AsyncMock(
            return_value=SimpleNamespace(
                id="room-1",
                group_id=None,
                tenant_id="t1",
                transport_room_id="!r:x",
                bridge_id=None,
                external_channel_id=None,
            )
        ),
        get_agent_ids=AsyncMock(return_value=list(room_agents or [])),
        add_agents=AsyncMock(
            side_effect=lambda _sess, _rid, aids, **_kw: added_agents.extend(aids)
        ),
        add_client=AsyncMock(),
        create=AsyncMock(side_effect=lambda _sess, r: created_rooms.append(r.id)),
        set_group=AsyncMock(),
    )

    class _FakeSessionFactory:
        def __call__(self) -> Any:
            class _Ctx:
                async def __aenter__(self) -> _FakeSession:
                    return _FakeSession(claims=claims, clients=clients)

                async def __aexit__(self, *args: Any) -> None:
                    pass

            return _Ctx()

    svc = RoomService.__new__(RoomService)
    svc._session_factory = _FakeSessionFactory()
    svc._provisioning = SimpleNamespace(create_room=AsyncMock(return_value="!r:x"))  # type: ignore[assignment]
    svc._client_lifecycle = SimpleNamespace(get_by_type=lambda *args: [])  # type: ignore[assignment]
    svc._agent_store = agent_store  # type: ignore[assignment]
    svc._room_store = room_store  # type: ignore[assignment]
    svc._collab_lifecycle = SimpleNamespace(get=lambda _bid: None)  # type: ignore[assignment]
    svc._resolve_agent_clients = lambda aids: {f"c-{aid}": f"@c-{aid}:x" for aid in aids}  # type: ignore[assignment]
    svc._invite_clients = AsyncMock()  # type: ignore[assignment]
    svc._validate_attachments = AsyncMock()  # type: ignore[assignment]
    svc._require_tenant_bridge = AsyncMock()  # type: ignore[assignment]
    svc._resolve_bridge_id = AsyncMock(return_value=None)  # type: ignore[assignment]
    svc._resolve_join_event_listeners = AsyncMock(return_value=set())  # type: ignore[assignment]
    svc._seed_aliases = AsyncMock()  # type: ignore[assignment]

    return svc, added_agents


class TestCheckAddressingPolicyForInvite:
    @pytest.mark.asyncio
    async def test_open_policy_allows_any_user_or_agent(self) -> None:
        agent_open = _agent("a_open", "open-bot", addressing_policy=AddressingPolicy())
        svc, _ = _build_room_service({"a_open": agent_open})

        session = _FakeSession()
        # Anyone can invite open agent
        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_open"], inviter_kind="user", inviter_id="u_stranger"
        )
        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_open"], inviter_kind="agent", inviter_id="a_stranger"
        )

    @pytest.mark.asyncio
    async def test_owner_allowed_to_invite_owner_only_agent(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, _ = _build_room_service({"a_strict": agent_strict})
        session = _FakeSession()

        # Owner is permitted
        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_strict"], inviter_kind="user", inviter_id="owner-1"
        )

    @pytest.mark.asyncio
    async def test_non_owner_refused_for_owner_only_agent(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, _ = _build_room_service({"a_strict": agent_strict})
        session = _FakeSession()

        with pytest.raises(AddressingRefusalError) as exc_info:
            await svc._check_addressing_policy_for_invite(
                session, "room-1", None, ["a_strict"], inviter_kind="user", inviter_id="stranger"
            )
        err = exc_info.value
        assert err.agent_name == "strict-bot"
        assert err.owner_id == "owner-1"
        assert "Cannot invite 'strict-bot': addressing policy allows only its owner (owner-1) to invite it." in str(err)

    @pytest.mark.asyncio
    async def test_unowned_agent_refusal_message(self) -> None:
        agent_unowned = _agent(
            "a_unowned", "unowned-bot", owner_id=None, addressing_policy=owner_only_policy([])
        )
        svc, _ = _build_room_service({"a_unowned": agent_unowned})
        session = _FakeSession()

        with pytest.raises(AddressingRefusalError) as exc_info:
            await svc._check_addressing_policy_for_invite(
                session, "room-1", None, ["a_unowned"], inviter_kind="user", inviter_id="stranger"
            )
        err = exc_info.value
        assert err.agent_name == "unowned-bot"
        assert err.owner_id is None
        assert "Cannot invite 'unowned-bot': addressing policy does not permit this invitation." in str(err)

    @pytest.mark.asyncio
    async def test_agent_inviter_same_owner_allowed(self) -> None:
        target = _agent(
            "a_target", "target-bot", owner_id="owner-1", addressing_policy=owner_and_owner_agents_policy()
        )
        inviter = _agent("a_inviter", "inviter-bot", owner_id="owner-1")
        svc, _ = _build_room_service({"a_target": target, "a_inviter": inviter})
        session = _FakeSession()

        # Inviter agent with same owner is allowed
        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_target"], inviter_kind="agent", inviter_id="a_inviter"
        )

    @pytest.mark.asyncio
    async def test_agent_inviter_different_owner_refused(self) -> None:
        target = _agent(
            "a_target", "target-bot", owner_id="owner-1", addressing_policy=owner_and_owner_agents_policy()
        )
        inviter = _agent("a_inviter", "inviter-bot", owner_id="owner-2")
        svc, _ = _build_room_service({"a_target": target, "a_inviter": inviter})
        session = _FakeSession()

        with pytest.raises(AddressingRefusalError) as exc_info:
            await svc._check_addressing_policy_for_invite(
                session, "room-1", None, ["a_target"], inviter_kind="agent", inviter_id="a_inviter"
            )
        assert exc_info.value.agent_name == "target-bot"
        assert exc_info.value.owner_id == "owner-1"

    @pytest.mark.asyncio
    async def test_system_inviter_always_allowed(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, _ = _build_room_service({"a_strict": agent_strict})
        session = _FakeSession()

        # System is exempt from addressing refusal
        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_strict"], inviter_kind="system", inviter_id=None
        )

    @pytest.mark.asyncio
    async def test_external_user_claim_matches_owner(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        # Inviter uses external Slack id "U_SLACK_1" which is claimed by "owner-1"
        svc, _ = _build_room_service(
            {"a_strict": agent_strict},
            claims={"U_SLACK_1": ["owner-1"]},
        )
        session = _FakeSession(claims={"U_SLACK_1": ["owner-1"]})

        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_strict"], inviter_kind="user", inviter_id="U_SLACK_1"
        )

    @pytest.mark.asyncio
    async def test_client_transport_user_matches_owner(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        client = SimpleNamespace(id="c-1", transport_user_id="@alice:matrix", user_id="owner-1")
        svc, _ = _build_room_service(
            {"a_strict": agent_strict},
            clients={"@alice:matrix": client},
        )
        session = _FakeSession(clients={"@alice:matrix": client})

        await svc._check_addressing_policy_for_invite(
            session, "room-1", None, ["a_strict"], inviter_kind="user", inviter_id="@alice:matrix"
        )


class TestAddAgentsToRoomAddressingPolicy:
    @pytest.mark.asyncio
    async def test_add_agents_owner_succeeds(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, added = _build_room_service({"a_strict": agent_strict})

        await svc.add_agents_to_room(
            "room-1", agent_ids=["a_strict"], inviter_id="owner-1", added_by_kind="user"
        )
        assert added == ["a_strict"]

    @pytest.mark.asyncio
    async def test_add_agents_non_owner_refused(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, added = _build_room_service({"a_strict": agent_strict})

        with pytest.raises(AddressingRefusalError):
            await svc.add_agents_to_room(
                "room-1", agent_ids=["a_strict"], inviter_id="stranger", added_by_kind="user"
            )
        assert added == []

    @pytest.mark.asyncio
    async def test_multiple_agents_one_refused_fails_atomically(self) -> None:
        agent_open = _agent("a_open", "open-bot", addressing_policy=AddressingPolicy())
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, added = _build_room_service({"a_open": agent_open, "a_strict": agent_strict})

        with pytest.raises(AddressingRefusalError):
            await svc.add_agents_to_room(
                "room-1",
                agent_ids=["a_open", "a_strict"],
                inviter_id="stranger",
                added_by_kind="user",
            )
        # Neither agent was added
        assert added == []

    @pytest.mark.asyncio
    async def test_existing_agents_not_checked_or_kicked(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        # "a_strict" is ALREADY in the room
        svc, added = _build_room_service({"a_strict": agent_strict}, room_agents=["a_strict"])

        # Stranger attempts to add it, but it's already present -> no refusal, no change
        await svc.add_agents_to_room(
            "room-1", agent_ids=["a_strict"], inviter_id="stranger", added_by_kind="user"
        )
        assert added == []


class TestCreateRoomAddressingPolicy:
    @pytest.mark.asyncio
    async def test_create_room_refuses_disallowed_agent(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, _ = _build_room_service({"a_strict": agent_strict})

        config = RoomCreateConfig(
            name="Test Room",
            description="A room",
            agent_ids=["a_strict"],
            acting_user_id="stranger",
            created_by_kind="user",
        )
        with pytest.raises(AddressingRefusalError):
            await svc.create_room(config)

    @pytest.mark.asyncio
    async def test_create_room_by_owner_succeeds(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, added = _build_room_service({"a_strict": agent_strict})

        config = RoomCreateConfig(
            name="Test Room",
            description="A room",
            agent_ids=["a_strict"],
            acting_user_id="owner-1",
            created_by_kind="user",
        )
        result = await svc.create_room(config)
        assert result.room.name == "Test Room"
        assert added == ["a_strict"]

    @pytest.mark.asyncio
    async def test_create_room_by_system_succeeds(self) -> None:
        agent_strict = _agent(
            "a_strict", "strict-bot", owner_id="owner-1", addressing_policy=owner_only_policy([])
        )
        svc, added = _build_room_service({"a_strict": agent_strict})

        config = RoomCreateConfig(
            name="System Room",
            description="Provisioned by system",
            agent_ids=["a_strict"],
            created_by_kind="system",
        )
        result = await svc.create_room(config)
        assert result.room.name == "System Room"
        assert added == ["a_strict"]

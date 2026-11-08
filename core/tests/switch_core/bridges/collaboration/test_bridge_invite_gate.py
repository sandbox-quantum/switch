"""Platform joins ask the same invite question as every other path (#805).

A bot can arrive in a channel without passing through Switch at all, so there
is no signed-in caller to ask. These tests pin how that case is answered: the
adder the platform names is judged as themselves, a join the platform does not
attribute is allowed but disclosed, and a refusal in a channel that already has
a room leaves the membership alone and says why in the channel.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.addressing import owner_only_policy, parse_policy
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin, InboundUserJoin
from switch_core.invites import Inviter, InviteRefused


class _Session:
    """Only ever a handle passed to a store; these fakes ignore it."""

    async def get(self, model: object, key: str) -> Any:
        return None


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield _Session()


def _agent(
    *,
    agent_id: str = "agent-1",
    name: str = "helper",
    owner_id: str | None = "owner-1",
    policy: object | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        name=name,
        owner_id=owner_id,
        display_name=None,
        addressing_policy=policy,
    )


class _AgentStore:
    def __init__(self, agents: list[Any]) -> None:
        self._by_name = {agent.name: agent for agent in agents}
        self._by_id = {agent.id: agent for agent in agents}

    async def get_by_name(self, session: object, name: str) -> Any:
        return self._by_name.get(name)

    async def get_many(self, session: object, ids: list[str]) -> list[Any]:
        return [self._by_id[i] for i in ids if i in self._by_id]


class _RoomStore:
    def __init__(self, members: list[str] | None = None) -> None:
        self._members = members or []

    async def get_agent_ids(self, session: object, room_id: str) -> list[str]:
        return list(self._members)


class _Adapter:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    async def admin_message(self, channel_id: str, content: str) -> str:
        self.messages.append((channel_id, content))
        return "m1"

    def slash_invite_hint(self) -> str | None:
        return None


class _RoomService:
    def __init__(self, *, refuse: list[str] | None = None) -> None:
        self.refuse = refuse or []
        self.added: list[tuple[str, list[str], Inviter]] = []
        self.owner_notices: list[tuple[Any, str]] = []

    async def add_agents_to_room(
        self,
        room_id: str,
        agent_names: list[str] | None = None,
        *,
        invited_by: Inviter,
        **kw: Any,
    ) -> None:
        if any(name in self.refuse for name in agent_names or []):
            raise InviteRefused([_agent(name=(agent_names or [""])[0])], invited_by)
        self.added.append((room_id, list(agent_names or []), invited_by))

    async def tell_owner(self, agent: Any, body: str) -> None:
        self.owner_notices.append((agent, body))

    async def create_room(self, config: Any, *, invited_by: Inviter) -> Any:
        raise AssertionError("this test does not create rooms")


class _ExternalUsers:
    def __init__(self, accounts: dict[str, list[Any]] | None = None) -> None:
        self._accounts = accounts or {}

    async def get_by_user(self, session: object, user_id: str) -> list[Any]:
        return self._accounts.get(user_id, [])


def _bridge(
    *,
    agents: list[Any] | None = None,
    room_service: _RoomService | None = None,
    members: list[str] | None = None,
    accounts: dict[str, list[Any]] | None = None,
) -> CollaborationCore:
    bridge = CollaborationCore.__new__(CollaborationCore)
    bridge._channel_locks = {}
    bridge._channel_to_room = {}
    bridge._bridge_id = "bridge-1"
    bridge._bridge_display_name = "Slack"
    bridge._session_factory = _session_factory  # type: ignore[assignment]
    bridge._agent_store = _AgentStore(agents or [])  # type: ignore[assignment]
    bridge._room_store = _RoomStore(members)  # type: ignore[assignment]
    bridge._adapter = _Adapter()  # type: ignore[assignment]
    bridge._room_service = room_service or _RoomService()  # type: ignore[assignment]
    bridge._external_user_store = _ExternalUsers(accounts)  # type: ignore[assignment]
    return bridge


def _join(adder: str | None) -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id="C1",
        channel_type="channel_public",
        agent_name="helper",
        channel_name="general",
        added_by_external_user_id=adder,
    )


class TestAdderIsJudged:
    async def test_a_reported_adder_is_the_person_who_added_this_bot(self) -> None:
        bridge = _bridge(agents=[_agent()])
        seen: list[Inviter] = []

        async def _create(**kw: Any) -> None:
            seen.append(kw["adder"])

        bridge._create_room_for_channel = _create  # type: ignore[method-assign]

        await bridge._handle_agent_joined_channel(_join("U1"))

        (adder,) = seen
        assert adder.kind == "platform_adder"
        assert adder.subject == "U1"
        assert adder.bridge_id == "bridge-1"
        # The platform named this person for one bot; they do not answer for
        # every bot that happens to be in the channel.
        assert adder.speaks_for == frozenset({"agent-1"})

    async def test_no_reported_adder_is_never_trusted_but_never_refused(self) -> None:
        bridge = _bridge(agents=[_agent()])
        seen: list[Inviter] = []

        async def _create(**kw: Any) -> None:
            seen.append(kw["adder"])

        bridge._create_room_for_channel = _create  # type: ignore[method-assign]

        await bridge._handle_agent_joined_channel(_join(None))

        (adder,) = seen
        assert adder.kind == "unknown"
        assert adder.is_judged is False

    async def test_switch_s_own_add_echoed_back_is_not_rejudged(self) -> None:
        """The bot joining after Switch added it must not ask again."""
        bridge = _bridge(agents=[_agent()], members=["agent-1"])
        bridge._channel_to_room["C1"] = ("room-1", "!r:test")
        service = _RoomService()
        bridge._room_service = service  # type: ignore[assignment]

        await bridge._handle_agent_joined_channel(_join("U1"))

        assert service.added == []

    async def test_a_refusal_in_an_existing_room_is_posted_and_changes_nothing(
        self,
    ) -> None:
        bridge = _bridge(
            agents=[_agent()],
            room_service=_RoomService(refuse=["helper"]),
        )
        bridge._channel_to_room["C1"] = ("room-1", "!r:test")

        await bridge._handle_agent_joined_channel(_join("U1"))

        assert len(bridge._adapter.messages) == 1
        channel_id, content = bridge._adapter.messages[0]
        assert channel_id == "C1"
        assert "owner" in content

    async def test_an_unattributed_join_in_an_existing_room_is_disclosed(
        self,
    ) -> None:
        """The join stands, and the owner is told nobody could vouch for it."""
        agent = _agent(policy=owner_only_policy([]).model_dump())
        bridge = _bridge(agents=[agent], room_service=_RoomService())
        bridge._channel_to_room["C1"] = ("room-1", "!r:test")

        await bridge._handle_agent_joined_channel(_join(None))

        assert bridge._room_service.added
        assert len(bridge._adapter.messages) == 1
        assert "didn't say who added it" in bridge._adapter.messages[0][1]

    async def test_a_user_join_that_is_really_an_agent_keeps_the_adder(self) -> None:
        bridge = _bridge(agents=[_agent()])
        seen: list[Inviter] = []

        async def _registered(name: str) -> bool:
            return True

        async def _create(**kw: Any) -> None:
            seen.append(kw["adder"])

        bridge._is_registered_agent = _registered  # type: ignore[method-assign]
        bridge._create_room_for_channel = _create  # type: ignore[method-assign]

        await bridge._handle_user_joined_channel(
            InboundUserJoin(
                channel_id="C1",
                channel_type="channel_public",
                external_user_id="B1",
                external_username="helper",
                added_by_external_user_id="U1",
            )
        )

        (adder,) = seen
        assert adder.kind == "platform_adder"
        assert adder.subject == "U1"


class TestDisclosure:
    async def test_a_restricted_agent_with_an_unknown_adder_is_disclosed(
        self,
    ) -> None:
        agent = _agent(policy=owner_only_policy([]).model_dump())
        bridge = _bridge(agents=[agent])
        service = _RoomService()
        bridge._room_service = service  # type: ignore[assignment]

        await bridge._disclose_unverified_joins(
            "C1", "general", [agent.id], Inviter.unknown_adder()
        )

        assert len(bridge._adapter.messages) == 1
        assert "didn't say who added it" in bridge._adapter.messages[0][1]
        # No account on this bridge, so the owner is told somewhere they read.
        assert len(service.owner_notices) == 1
        assert "general" in service.owner_notices[0][1]

    async def test_a_linked_owner_is_mentioned_in_the_channel_instead(
        self,
    ) -> None:
        agent = _agent(policy=owner_only_policy([]).model_dump())
        bridge = _bridge(
            agents=[agent],
            accounts={
                "owner-1": [
                    SimpleNamespace(bridge_id="bridge-1", external_username="alex")
                ]
            },
        )

        await bridge._disclose_unverified_joins(
            "C1", "general", [agent.id], Inviter.unknown_adder()
        )

        assert len(bridge._adapter.messages) == 1
        assert "@alex" in bridge._adapter.messages[0][1]
        assert bridge._room_service.owner_notices == []

    async def test_an_open_agent_is_not_disclosed(self) -> None:
        agent = _agent(policy=parse_policy(None).model_dump())
        bridge = _bridge(agents=[agent])

        await bridge._disclose_unverified_joins(
            "C1", "general", [agent.id], Inviter.unknown_adder()
        )

        assert bridge._adapter.messages == []

    async def test_a_direct_chat_is_not_disclosed(self) -> None:
        """A DM is not an invite, so there is no adder to have failed to name."""
        agent = _agent(policy=owner_only_policy([]).model_dump())
        bridge = _bridge(agents=[agent])

        await bridge._disclose_unverified_joins(
            "D1",
            "direct",
            [agent.id],
            Inviter.system("a direct chat is not an invite"),
        )

        assert bridge._adapter.messages == []

    async def test_a_join_the_platform_attributed_is_not_disclosed(self) -> None:
        agent = _agent(policy=owner_only_policy([]).model_dump())
        bridge = _bridge(agents=[agent])

        await bridge._disclose_unverified_joins(
            "C1",
            "general",
            [agent.id],
            Inviter.platform_adder("bridge-1", "U1").only_for([agent.id]),
        )

        assert bridge._adapter.messages == []

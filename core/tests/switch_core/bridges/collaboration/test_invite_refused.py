"""A platform join is judged like any other invite (#805).

Whoever adds the bridge's bot to a channel is putting an agent into a room, so
the agent's addressing policy decides, as that person. Refused agents are left
out and the channel is told why. The channel still gets its room, and an agent
already in a room is not removed. Where the platform does not say who added the
bot, nothing can be checked: the agent is added, with a notice if it is one that
only some people may invite."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.addressing import owner_only_policy
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.invites import Inviter, InviteRefused, PlatformInviter

_REFUSAL = (
    "helper doesn't take instructions from the person who added the bot, so it "
    "wasn't added. Its owner (Alice) can invite it, or can change who it takes "
    "instructions from."
)


def _refusal() -> InviteRefused:
    return InviteRefused(_REFUSAL, ["a-helper"], ["helper"])


def _agent(policy: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id="a-helper", name="helper", addressing_policy=policy, owner_id="o1"
    )


def _bridge(
    *, agent: SimpleNamespace, refuse_agents: list[str], in_room: bool = False
) -> SimpleNamespace:
    """A bridge whose room service refuses invites for `refuse_agents`."""
    notices: list[tuple[str, str, str | None]] = []
    created: list[tuple[list[str], Inviter]] = []
    added: list[tuple[list[str], Inviter]] = []
    room = SimpleNamespace(
        id="room-1", tenant_id="t1", transport_room_id="!room:switch.local"
    )

    class _Adapter:
        def slash_invite_hint(self) -> str | None:
            return None

        async def admin_message(
            self,
            channel_id: str,
            content: str,
            thread_root_id: str | None = None,
            *,
            message_type: str | None = None,
        ) -> str:
            notices.append((channel_id, content, message_type))
            return "m1"

    class _RoomService:
        async def create_room(
            self, config: Any, *, invited_by: Inviter
        ) -> SimpleNamespace:
            refused = [a for a in config.agent_ids if a in refuse_agents]
            if refused:
                raise InviteRefused(_REFUSAL, refused, ["helper"])
            created.append((list(config.agent_ids), invited_by))
            return SimpleNamespace(room=room)

        async def add_agents_to_room(
            self, room_id: str, *, agent_names: list[str], invited_by: Inviter
        ) -> None:
            if agent.id in refuse_agents:
                raise _refusal()
            added.append((agent_names, invited_by))

    class _AgentStore:
        async def get_by_name(self, session: Any, name: str) -> SimpleNamespace:
            return agent

    @asynccontextmanager
    async def session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def resolve_agents(channel_id: str, channel_type: str) -> list[str]:
        return [agent.id]

    async def adopt(channel_id: str) -> tuple[str, str] | None:
        return None

    bridge = SimpleNamespace(
        _adapter=_Adapter(),
        _room_service=_RoomService(),
        _agent_store=_AgentStore(),
        _session_factory=session_factory,
        _resolve_agents_for_channel=resolve_agents,
        _adopt_existing_room=adopt,
        add_room_mapping=lambda *args: None,
        _provisioning_channels=set(),
        _channel_to_room={"C1": ("room-1", "!room:switch.local")} if in_room else {},
        _room_tenants={},
        _bridge_display_name="Switch",
        _bridge_id="bridge-1",
        notices=notices,
        created=created,
        added=added,
    )
    for name in ("_tell_invite_refused", "_tell_inviter_unknown"):
        method = getattr(CollaborationCore, name)
        setattr(bridge, name, lambda *a, _m=method, **k: _m(bridge, *a, **k))
    bridge._create_room_for_channel = lambda **k: (
        CollaborationCore._create_room_for_channel(bridge, **k)
    )
    return bridge


def _join(added_by: str | None) -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id="C1",
        channel_type="channel_public",
        agent_name="helper",
        channel_name="general",
        added_by=added_by,
    )


async def _joined(bridge: SimpleNamespace, added_by: str | None) -> None:
    await CollaborationCore._handle_agent_joined_channel_locked(bridge, _join(added_by))


RESTRICTED = owner_only_policy([]).model_dump(mode="json")


class TestANewChannel:
    async def test_the_room_is_made_without_the_agent_its_adder_may_not_invite(
        self,
    ) -> None:
        bridge = _bridge(agent=_agent(RESTRICTED), refuse_agents=["a-helper"])
        await _joined(bridge, "U-bob")
        assert bridge.created == [([], PlatformInviter("bridge-1", "U-bob"))]
        assert bridge.notices[0] == ("C1", _REFUSAL, "agent_lifecycle")

    async def test_an_agent_its_adder_may_invite_is_in_the_room(self) -> None:
        bridge = _bridge(agent=_agent(RESTRICTED), refuse_agents=[])
        await _joined(bridge, "U-alice")
        assert bridge.created == [
            (["a-helper"], PlatformInviter("bridge-1", "U-alice"))
        ]
        assert bridge.notices == []

    async def test_an_unnamed_adder_cannot_be_checked_so_the_channel_is_told(
        self,
    ) -> None:
        bridge = _bridge(agent=_agent(RESTRICTED), refuse_agents=[])
        await _joined(bridge, None)
        assert bridge.created == [(["a-helper"], PlatformInviter("bridge-1", None))]
        [(channel, content, kind)] = bridge.notices
        assert (channel, kind) == ("C1", "agent_lifecycle")
        assert "helper was added here" in content
        assert "didn't say by whom" in content

    async def test_an_open_agent_needs_no_notice_when_the_adder_is_unnamed(
        self,
    ) -> None:
        bridge = _bridge(agent=_agent(None), refuse_agents=[])
        await _joined(bridge, None)
        assert bridge.created == [(["a-helper"], PlatformInviter("bridge-1", None))]
        assert bridge.notices == []


class TestAChannelThatAlreadyHasARoom:
    async def test_a_refused_agent_is_not_added_and_the_channel_is_told_why(
        self,
    ) -> None:
        bridge = _bridge(
            agent=_agent(RESTRICTED), refuse_agents=["a-helper"], in_room=True
        )
        await _joined(bridge, "U-bob")
        assert bridge.added == []
        assert bridge.notices == [("C1", _REFUSAL, "agent_lifecycle")]

    async def test_the_adder_is_passed_to_the_gate(self) -> None:
        bridge = _bridge(agent=_agent(RESTRICTED), refuse_agents=[], in_room=True)
        await _joined(bridge, "U-alice")
        assert bridge.added == [(["helper"], PlatformInviter("bridge-1", "U-alice"))]
        assert bridge.notices == []

    async def test_an_unnamed_adder_is_let_through_with_a_notice(self) -> None:
        bridge = _bridge(agent=_agent(RESTRICTED), refuse_agents=[], in_room=True)
        await _joined(bridge, None)
        assert bridge.added == [(["helper"], PlatformInviter("bridge-1", None))]
        assert "didn't say by whom" in bridge.notices[0][1]

"""Platform joins are judged by who added the agent.

When someone adds an agent's bot — or the bridge app — to a channel on the
platform, the room the bridge makes for that channel seats the channel's
agents on that person's authority. A person an agent's addressing policy
does not admit cannot pull it in: the agent is kept out of the room and the
refusal is posted in the channel. When the platform does not say who added
it, the join stands but is disclosed in the channel, with the owner told.

Exercised the way `test_bridge_no_agents_notice.py` exercises room
creation: the real `CollaborationCore` methods on a hand-built bridge,
with a fake room service standing in for the funnel the gate lives behind.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.invites import InviteRefused, PlatformInviter

_ROOM = SimpleNamespace(
    id="room-uuid", tenant_id="tenant-1", transport_room_id="!m:switch.local"
)

_AGENT = SimpleNamespace(
    id="a1",
    name="helper.bot",
    display_name=None,
    owner_id="user-owner",
    addressing_policy={"rules": []},
)


class _SessionCM:
    async def __aenter__(self) -> SimpleNamespace:
        return SimpleNamespace()

    async def __aexit__(self, *exc: object) -> bool:
        return False


def _session_factory() -> _SessionCM:
    return _SessionCM()


class _Adapter:
    def __init__(self) -> None:
        self.notices: list[tuple[str, str, str | None]] = []

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
        self.notices.append((channel_id, content, message_type))
        return "C123:999.9"


def _bridge(**overrides: Any) -> SimpleNamespace:
    async def _resolve_agents_for_channel(
        channel_id: str, channel_type: str
    ) -> list[str]:
        return ["a1", "a2"]

    async def _adopt_existing_room(channel_id: str) -> tuple[str, str] | None:
        return None

    async def _owner_handle(
        session: Any, agent: Any, bridge_id: str | None
    ) -> str | None:
        return "olivia"

    async def _get_by_name(session: Any, name: str) -> Any:
        return _AGENT if name == _AGENT.name else None

    async def _get(session: Any, agent_id: str) -> Any:
        return _AGENT if agent_id == _AGENT.id else None

    bridge = SimpleNamespace(
        _adapter=_Adapter(),
        _resolve_agents_for_channel=_resolve_agents_for_channel,
        _adopt_existing_room=_adopt_existing_room,
        add_room_mapping=lambda *a: None,
        _provisioning_channels=set(),
        _channel_to_room={},
        _room_tenants={},
        _bridge_display_name="Switch",
        _bridge_id="bridge-1",
        _session_factory=_session_factory,
        _invite_gate=SimpleNamespace(owner_handle=_owner_handle),
        _agent_store=SimpleNamespace(get_by_name=_get_by_name, get=_get),
    )
    # The methods under test call this one on themselves; on a hand-built
    # bridge it has to be bound by hand, like the entry points are.
    bridge._disclose_unverified = lambda channel_id, agents: (  # noqa: E731
        CollaborationCore._disclose_unverified(bridge, channel_id, agents)
    )
    for key, value in overrides.items():
        setattr(bridge, key, value)
    return bridge


async def test_a_refused_agent_is_kept_out_and_the_refusal_is_posted() -> None:
    configs: list[Any] = []

    class _RoomService:
        async def create_room(self, config: Any, *, invited_by: Any) -> SimpleNamespace:
            configs.append(config)
            if "a2" in config.agent_ids:
                raise InviteRefused(
                    "two.bot doesn't take instructions from you, so it "
                    "wasn't added. Ask its owner (Olivia Owner) to invite "
                    "it, or to change who it takes instructions from.",
                    ["a2"],
                    ["two.bot"],
                )
            return SimpleNamespace(room=_ROOM, invite_unverified=[])

    bridge = _bridge(_room_service=_RoomService())

    result = await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
        channel_name="general",
        added_by="U-STRANGER",
    )

    assert result == ("room-uuid", "!m:switch.local")
    # The room was made without the refused agent; the rest of the channel
    # is not held hostage to one agent's policy.
    assert [c.agent_ids for c in configs] == [["a1", "a2"], ["a1"]]
    refusals = [n for n in bridge._adapter.notices if "two.bot" in n[1]]
    assert len(refusals) == 1
    assert refusals[0][0] == "C1"
    assert "doesn't take instructions from you" in refusals[0][1]


async def test_an_unverified_seating_is_disclosed_in_the_channel() -> None:
    class _RoomService:
        async def create_room(self, config: Any, *, invited_by: Any) -> SimpleNamespace:
            return SimpleNamespace(room=_ROOM, invite_unverified=["a1"])

    bridge = _bridge(_room_service=_RoomService())

    result = await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
        channel_name="general",
    )

    assert result == ("room-uuid", "!m:switch.local")
    disclosures = [
        n for n in bridge._adapter.notices if "didn't say who added it" in n[1]
    ]
    assert len(disclosures) == 1
    assert disclosures[0][0] == "C1"
    assert "helper.bot" in disclosures[0][1]
    assert "@olivia" in disclosures[0][1]


async def test_an_agent_join_is_judged_as_who_added_it() -> None:
    seen: list[Any] = []

    class _RoomService:
        async def add_agents_to_room(
            self, room_id: str, **kwargs: Any
        ) -> SimpleNamespace:
            seen.append(kwargs["invited_by"])
            return SimpleNamespace(unverified=[])

    bridge = _bridge(
        _room_service=_RoomService(),
        _channel_to_room={"C1": ("room-1", "!t:switch.local")},
    )

    await CollaborationCore._handle_agent_joined_channel_locked(
        bridge,
        InboundAgentJoin(
            channel_id="C1",
            channel_type="channel_public",
            agent_name="helper.bot",
            added_by_external_user_id="U9",
        ),
    )

    assert seen == [PlatformInviter("bridge-1", "U9")]
    assert bridge._adapter.notices == []


async def test_a_refused_agent_join_posts_the_refusal_in_the_channel() -> None:
    class _RoomService:
        async def add_agents_to_room(self, room_id: str, **kwargs: Any) -> Any:
            raise InviteRefused(
                "helper.bot doesn't take instructions from you, so it "
                "wasn't added. Ask its owner (Olivia Owner) to invite it, "
                "or to change who it takes instructions from.",
                ["a1"],
                ["helper.bot"],
            )

    bridge = _bridge(
        _room_service=_RoomService(),
        _channel_to_room={"C1": ("room-1", "!t:switch.local")},
    )

    await CollaborationCore._handle_agent_joined_channel_locked(
        bridge,
        InboundAgentJoin(
            channel_id="C1",
            channel_type="channel_public",
            agent_name="helper.bot",
            added_by_external_user_id="U-STRANGER",
        ),
    )

    assert len(bridge._adapter.notices) == 1
    channel_id, content, _ = bridge._adapter.notices[0]
    assert channel_id == "C1"
    assert "doesn't take instructions from you" in content


async def test_an_unverified_agent_join_is_disclosed_in_the_channel() -> None:
    class _RoomService:
        async def add_agents_to_room(
            self, room_id: str, **kwargs: Any
        ) -> SimpleNamespace:
            return SimpleNamespace(unverified=[_AGENT])

    bridge = _bridge(
        _room_service=_RoomService(),
        _channel_to_room={"C1": ("room-1", "!t:switch.local")},
    )

    await CollaborationCore._handle_agent_joined_channel_locked(
        bridge,
        InboundAgentJoin(
            channel_id="C1",
            channel_type="channel_public",
            agent_name="helper.bot",
        ),
    )

    assert len(bridge._adapter.notices) == 1
    channel_id, content, _ = bridge._adapter.notices[0]
    assert channel_id == "C1"
    assert "didn't say who added it" in content
    assert "@olivia" in content

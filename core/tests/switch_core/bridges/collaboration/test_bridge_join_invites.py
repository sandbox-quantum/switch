"""Someone adds an agent's bot to a channel on the platform itself.

Switch judges them as the person the platform names. When it names nobody, the
join stands but the channel is told, so an owner's choice is never bypassed in
silence.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.addressing import owner_only_policy
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin, InboundUserJoin
from switch_core.invites import Inviter, InviteRefused

_ROOM = SimpleNamespace(
    id="room-1", tenant_id="tenant-1", transport_room_id="!room:switch.local"
)
_RESTRICTED = SimpleNamespace(
    id="a1",
    name="helper",
    display_name="Helper",
    addressing_policy=owner_only_policy([]).model_dump(),
    owner_id="owner-1",
)
_OPEN = SimpleNamespace(
    id="a2",
    name="friendly",
    display_name="Friendly",
    addressing_policy={"rules": []},
    owner_id="owner-2",
)
_BY_NAME = {agent.name: agent for agent in (_RESTRICTED, _OPEN)}


def _join(agent_name: str, added_by: str | None) -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id="chan-1",
        channel_type="channel_public",
        agent_name=agent_name,
        channel_name="war-room",
        added_by_external_user_id=added_by,
    )


class _RoomService:
    """Refuses `refused_ids` as the real gate would, and records what it was asked."""

    def __init__(self, refused_ids: set[str]) -> None:
        self.refused_ids = refused_ids
        self.added: list[tuple[str, Inviter]] = []
        self.created: list[tuple[list[str], Inviter]] = []
        self.told_owner: list[tuple[str, str]] = []

    async def tell_owner(self, agent: SimpleNamespace, body: str) -> None:
        self.told_owner.append((agent.id, body))

    async def refused_agents(
        self, inviter: Inviter, agent_ids: list[str], *, room_id: str, group_id: None
    ) -> list[SimpleNamespace]:
        return [
            agent
            for agent in _BY_NAME.values()
            if agent.id in agent_ids and agent.id in self.refused_ids
        ]

    async def add_agents_to_room(
        self, room_id: str, *, agent_names: list[str], invited_by: Inviter
    ) -> None:
        name = agent_names[0]
        if _BY_NAME[name].id in self.refused_ids:
            raise InviteRefused([_BY_NAME[name]], invited_by)  # type: ignore[list-item]
        self.added.append((name, invited_by))

    async def create_room(self, config: Any, *, invited_by: Inviter) -> SimpleNamespace:
        self.created.append((config.agent_ids, invited_by))
        return SimpleNamespace(room=_ROOM)


def _bridge(
    *,
    mapped: bool,
    in_channel: list[str] | None = None,
    already_in_room: list[str] | None = None,
    refused_ids: set[str] | None = None,
    owner_accounts: list[SimpleNamespace] | None = None,
) -> SimpleNamespace:
    notices: list[str] = []

    async def get_by_user(_session: object, _user_id: str) -> list[SimpleNamespace]:
        return list(owner_accounts or [])

    @asynccontextmanager
    async def session_factory():  # type: ignore[no-untyped-def]
        yield object()

    async def get_by_name(_session: object, name: str) -> SimpleNamespace | None:
        return _BY_NAME.get(name)

    async def get_many(_session: object, ids: list[str]) -> list[SimpleNamespace]:
        return [agent for agent in _BY_NAME.values() if agent.id in ids]

    async def get_agent_ids(_session: object, _room_id: str) -> list[str]:
        return list(already_in_room or [])

    async def admin_message(
        _channel_id: str,
        content: str,
        _thread_root_id: str | None = None,
        **_kw: object,
    ) -> str:
        notices.append(content)
        return "ref"

    async def resolve_agents(_channel_id: str, _channel_type: str) -> list[str]:
        return list(in_channel or [])

    async def adopt_existing(channel_id: str) -> tuple[str, str] | None:
        return bridge._channel_to_room.get(channel_id)

    def add_room_mapping(
        room_id: str, transport_room_id: str, channel_id: str, _tenant_id: str
    ) -> None:
        bridge._channel_to_room[channel_id] = (room_id, transport_room_id)

    bridge = SimpleNamespace(
        _session_factory=session_factory,
        _agent_store=SimpleNamespace(get_by_name=get_by_name, get_many=get_many),
        _room_store=SimpleNamespace(get_agent_ids=get_agent_ids),
        _external_user_store=SimpleNamespace(get_by_user=get_by_user),
        _room_service=_RoomService(refused_ids or set()),
        _adapter=SimpleNamespace(
            admin_message=admin_message, slash_invite_hint=lambda: None
        ),
        _resolve_agents_for_channel=resolve_agents,
        _adopt_existing_room=adopt_existing,
        add_room_mapping=add_room_mapping,
        _provisioning_channels=set(),
        _channel_to_room=(
            {"chan-1": ("room-1", "!room:switch.local")} if mapped else {}
        ),
        _room_tenants={},
        _bridge_display_name="Slack",
        _bridge_id="bridge-1",
        notices=notices,
    )
    bridge._disclose_unverified_joins = partial(
        CollaborationCore._disclose_unverified_joins, bridge
    )
    bridge._owner_handle = partial(CollaborationCore._owner_handle, bridge)
    bridge._create_room_for_channel = partial(
        CollaborationCore._create_room_for_channel, bridge
    )
    return bridge


async def _joined(bridge: SimpleNamespace, join: InboundAgentJoin) -> None:
    await CollaborationCore._handle_agent_joined_channel_locked(bridge, join)


async def test_a_join_into_a_room_is_judged_as_the_person_who_added_the_bot() -> None:
    bridge = _bridge(mapped=True)

    await _joined(bridge, _join("helper", "U1"))

    assert bridge._room_service.added == [
        ("helper", Inviter.chat_account("bridge-1", "U1"))
    ]
    assert bridge.notices == []


async def test_a_refused_join_says_why_in_the_channel_and_adds_nobody() -> None:
    bridge = _bridge(mapped=True, refused_ids={"a1"})

    await _joined(bridge, _join("helper", "U-stranger"))

    assert bridge._room_service.added == []
    assert len(bridge.notices) == 1
    assert "only takes instructions" in bridge.notices[0]
    assert "link this chat account" in bridge.notices[0]


async def test_the_platform_echoing_switch_s_own_add_is_not_reported() -> None:
    bridge = _bridge(mapped=True, already_in_room=["a1"])

    await _joined(bridge, _join("helper", None))

    assert bridge._room_service.added == []
    assert bridge.notices == []


async def test_an_unknown_adder_is_let_in_and_disclosed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = _bridge(mapped=True)

    with caplog.at_level(logging.WARNING):
        await _joined(bridge, _join("helper", None))

    assert bridge._room_service.added == [("helper", Inviter.unknown_adder())]
    assert len(bridge.notices) == 1
    assert "didn't say who added" in bridge.notices[0]
    assert "did not report who added it" in caplog.text


async def test_an_owner_with_an_account_here_is_mentioned_in_the_channel() -> None:
    bridge = _bridge(
        mapped=True,
        owner_accounts=[
            SimpleNamespace(bridge_id="elsewhere", external_username="aaa"),
            SimpleNamespace(bridge_id="bridge-1", external_username="zoe"),
            SimpleNamespace(bridge_id="bridge-1", external_username="sam"),
        ],
    )

    await _joined(bridge, _join("helper", None))

    assert "its owner (@sam)" in bridge.notices[0]
    assert bridge._room_service.told_owner == []


async def test_an_owner_with_no_account_here_is_told_privately() -> None:
    bridge = _bridge(mapped=True)

    await _joined(bridge, _join("helper", None))

    ((agent_id, body),) = bridge._room_service.told_owner
    assert agent_id == "a1"
    assert "war-room on Slack" in body
    assert "didn't say who added it" in body


async def test_an_agent_open_to_everyone_is_disclosed_too() -> None:
    # The rule is about not knowing who asked, whatever the agent's policy.
    bridge = _bridge(mapped=True)

    await _joined(bridge, _join("friendly", None))

    assert bridge._room_service.added == [("friendly", Inviter.unknown_adder())]
    assert len(bridge.notices) == 1
    assert "didn't say who added" in bridge.notices[0]
    assert [agent_id for agent_id, _ in bridge._room_service.told_owner] == ["a2"]


async def test_a_failed_notice_does_not_undo_the_join(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = _bridge(mapped=True)

    async def broken(*_args: object, **_kw: object) -> str:
        raise RuntimeError("the platform is down")

    bridge._adapter.admin_message = broken

    await _joined(bridge, _join("helper", None))

    assert bridge._room_service.added == [("helper", Inviter.unknown_adder())]
    assert "Could not disclose the unverified join" in caplog.text
    assert len(bridge._room_service.told_owner) == 1


async def test_a_failed_lookup_does_not_undo_the_join(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = _bridge(mapped=True)

    async def broken(*_args: object, **_kw: object) -> list[SimpleNamespace]:
        raise RuntimeError("the database is down")

    bridge._agent_store.get_many = broken

    await _joined(bridge, _join("helper", None))

    assert bridge._room_service.added == [("helper", Inviter.unknown_adder())]
    assert "Could not look up who to tell" in caplog.text


async def test_a_refused_join_makes_the_room_without_that_agent() -> None:
    bridge = _bridge(mapped=False, in_channel=["a1", "a2"], refused_ids={"a1"})

    await _joined(bridge, _join("helper", "U-stranger"))

    assert [ids for ids, _ in bridge._room_service.created] == [["a2"]]
    assert any("only takes instructions" in notice for notice in bridge.notices)


async def test_a_channel_switch_is_making_is_not_refused_as_a_stranger_s_join() -> None:
    bridge = _bridge(mapped=False, in_channel=["a1"], refused_ids={"a1"})
    bridge._provisioning_channels.add("chan-1")

    await _joined(bridge, _join("helper", "U-switch-app"))

    assert bridge.notices == []


async def test_an_ownerless_agent_has_nobody_to_tell_but_the_channel(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = _bridge(mapped=True)
    ownerless = SimpleNamespace(**{**vars(_RESTRICTED), "owner_id": None})

    async def get_many(_session: object, _ids: list[str]) -> list[SimpleNamespace]:
        return [ownerless]

    bridge._agent_store.get_many = get_many

    await _joined(bridge, _join("helper", None))

    assert len(bridge.notices) == 1
    assert bridge._room_service.told_owner == []
    assert "Could not disclose" not in caplog.text


async def test_a_refused_agent_does_not_return_with_the_next_message() -> None:
    bridge = _bridge(mapped=False, in_channel=["a1"], refused_ids={"a1"})
    await _joined(bridge, _join("helper", "U-stranger"))

    # What a message in the channel does when it looks for the channel's room.
    await bridge._create_room_for_channel(
        channel_id="chan-1", channel_type="channel_public"
    )

    assert [ids for ids, _ in bridge._room_service.created] == [[]]


async def test_a_judged_adder_leaves_nothing_to_disclose_about_their_agent() -> None:
    bridge = _bridge(mapped=False, in_channel=["a1"])

    await _joined(bridge, _join("helper", "U1"))

    assert [ids for ids, _ in bridge._room_service.created] == [["a1"]]
    assert bridge.notices == []


async def test_a_bot_already_in_a_newly_seen_channel_is_disclosed() -> None:
    bridge = _bridge(mapped=False, in_channel=["a1"])

    await bridge._create_room_for_channel(
        channel_id="chan-1", channel_type="channel_public", sender_name="someone"
    )

    assert bridge._room_service.created == [(["a1"], Inviter.unknown_adder())]
    assert len(bridge.notices) == 1


@pytest.mark.parametrize("channel_type", ["direct", "lobby"])
async def test_a_direct_chat_is_not_an_invite(channel_type: str) -> None:
    bridge = _bridge(mapped=False, in_channel=["a1"])

    await bridge._create_room_for_channel(
        channel_id="chan-1", channel_type=channel_type, sender_name="stranger"
    )

    ((agent_ids, inviter),) = bridge._room_service.created
    assert agent_ids == ["a1"]
    assert inviter.kind == "switch"
    assert bridge.notices == []


async def test_a_bot_arriving_as_a_user_keeps_who_added_it() -> None:
    joins: list[InboundAgentJoin] = []

    async def is_registered(_name: str) -> bool:
        return True

    async def handle(join: InboundAgentJoin) -> None:
        joins.append(join)

    bridge = SimpleNamespace(
        _is_registered_agent=is_registered, _handle_agent_joined_channel=handle
    )

    await CollaborationCore._handle_user_joined_channel(
        bridge,
        InboundUserJoin(
            channel_id="chan-1",
            channel_type="channel_public",
            external_user_id="ext",
            external_username="helper",
            channel_name="war-room",
            added_by_external_user_id="U1",
        ),
    )

    assert joins[0].added_by_external_user_id == "U1"

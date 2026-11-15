"""An agent's `create_room` with `include_owner`: an internal-only room its
owner is in, listed among their Console chats and routed as a group chat —
against real Postgres, through the shared harness."""

from __future__ import annotations

from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.chats.service import ChatError
from switch_core.db.models import Agent, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_service import RoomCreateResult
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_groups import _addressed
from tests.switch_core.gateway.test_chats_routes import _listed


def _protocol(chats: _Harness) -> SimpleNamespace:
    """The parts of `AgentCore` that `create_moderation_room` uses, over the
    harness's real room and chat services, wired as `main` wires them."""
    protocol = SimpleNamespace(
        session_factory=chats.factory,
        agent_store=AgentStore(),
        user_store=UserStore(),
        room_store=RoomStore(),
        external_user_store=ExternalUserStore(),
        room_group_store=RoomGroupStore(),
        room_service=chats.room_service,
        client_lifecycle=chats.lifecycle,
        _member_adder=chats.service.add_member,
        _member_join_check=chats.service.require_can_join,
    )
    for name in ("run_service", "_resolve_acting_identity", "_resolve_group_name"):
        setattr(protocol, name, partial(getattr(AgentCore, name), protocol))
    return protocol


async def _create(chats: _Harness, agent: Agent, **overrides: Any) -> RoomCreateResult:
    args: dict[str, Any] = {
        "agent_id": agent.id,
        "name": "Onboarding",
        "description": "",
        "agent_names": [agent.name],
        "user_names": None,
        "channel_type": None,
        "bridge_id": None,
        "internal_only": True,
        "include_owner": True,
    }
    args.update(overrides)
    return await AgentCore.create_moderation_room(_protocol(chats), **args)  # type: ignore[arg-type]


async def test_the_owner_gets_a_group_chat_with_the_agent(chats: _Harness) -> None:
    agent = await chats.agent("buddy", owner=chats.alice)
    woken: list[list[str] | None] = []
    chats.service.watch_memberships(
        "00000000-0000-0000-0000-000000000000", chats.alice.id, woken.append
    )

    room = (await _create(chats, agent)).room

    assert [room.id] in woken
    listed = await _listed(chats, chats.alice)
    assert listed[room.id]["channelType"] != "direct"
    assert room.id not in await _listed(chats, chats.bob)
    assert await _addressed(chats, room.id, agent, "unnamed") is False
    assert await _addressed(chats, room.id, agent, "@buddy named") is True


async def test_without_include_owner_the_owner_is_not_in_it(chats: _Harness) -> None:
    agent = await chats.agent("buddy", owner=chats.alice)
    room = (await _create(chats, agent, include_owner=False)).room
    assert room.id not in await _listed(chats, chats.alice)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"internal_only": False}, "internal_only=True"),
        ({"bridge_id": "some-bridge"}, "internal_only=True"),
        ({"channel_type": "direct"}, "direct"),
    ],
)
async def test_refused_where_it_makes_no_sense(
    chats: _Harness, overrides: dict[str, Any], message: str
) -> None:
    agent = await chats.agent("buddy", owner=chats.alice)
    with pytest.raises(ValueError, match=message):
        await _create(chats, agent, **overrides)


async def test_an_owner_outside_the_workspace_is_refused_before_the_room(
    chats: _Harness,
) -> None:
    agent = await chats.agent("buddy", owner=chats.carol)

    with pytest.raises(ValueError, match="not a member of this workspace"):
        await _create(chats, agent)

    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0


async def test_an_owner_refused_after_the_room_is_made_takes_the_room_with_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("buddy", owner=chats.alice)

    async def refusing(*args: Any) -> None:
        raise ChatError(422, "NOT_A_TENANT_MEMBER", "Left the workspace.")

    monkeypatch.setattr(chats.service, "add_member", refusing)
    with pytest.raises(ValueError, match="Left the workspace"):
        await _create(chats, agent)

    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0


async def test_any_failure_adding_the_owner_takes_the_room_with_it_and_surfaces(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("buddy", owner=chats.alice)

    async def crashing(*args: Any) -> None:
        raise RuntimeError("join failed")

    monkeypatch.setattr(chats.service, "add_member", crashing)
    with pytest.raises(RuntimeError, match="^join failed$"):
        await _create(chats, agent)

    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0

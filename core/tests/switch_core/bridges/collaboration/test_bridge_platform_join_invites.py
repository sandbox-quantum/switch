"""Agents added to a channel on the platform are judged by who added them.

Someone putting an agent's bot into a channel, or adding the app to a channel
its agents are in, brings those agents into the room the same as an invite
does, so `room_invites` judges it the same way: as the account the platform
says did it, answered as a message from that account would be. An account
Switch does not know, or one nobody claimed, is never trusted. When the
platform does not say who it was, the agent is let in, and the channel and
the agent's owner are told. Agents already in the room are not judged again.

Run on the real `CollaborationCore` methods against Postgres, with a
recording chat adapter and room service.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.db.models import (
    TENANT_ZERO_ID,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_public_room,
    _register,
    _service,
)
from tests.switch_core.test_room_invites_platform_join import (
    _set_policy,
    _World,
    _world,
)


class _Adapter:
    platform_name = "Slack"

    def __init__(self, private_notice_delivery: str = "direct_message") -> None:
        self.private_notice_delivery = private_notice_delivery
        self.notices: list[tuple[str, str, str | None]] = []
        self.private: list[dict[str, Any]] = []

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str:
        self.notices.append((channel_id, content, message_type))
        return "C1:1.1"

    async def notify_privately(self, **kwargs: Any) -> None:
        self.private.append(kwargs)


class _RoomService:
    def __init__(self) -> None:
        self.added: list[str] = []
        self.created: list[Any] = []

    async def add_agents_to_room(
        self, room_id: str, *, agent_names: list[str], **_: object
    ) -> None:
        self.added.extend(agent_names)

    async def create_room(self, config: Any) -> SimpleNamespace:
        self.created.append(config)
        return SimpleNamespace(
            room=SimpleNamespace(
                id="new-room", transport_room_id="!new:test", tenant_id=TENANT_ZERO_ID
            )
        )


def _core(
    session_factory: async_sessionmaker[AsyncSession],
    world: _World,
    adapter: _Adapter,
    *,
    channel_agents: list[str] | None = None,
) -> tuple[CollaborationCore, _RoomService]:
    rooms = _RoomService()
    core = object.__new__(CollaborationCore)
    core._session_factory = session_factory  # type: ignore[assignment]
    core._agent_store = AgentStore()
    core._room_store = RoomStore()
    core._external_user_store = ExternalUserStore()
    core._bridge_id = world.bridge_id
    core._bridge_tenant_id = TENANT_ZERO_ID
    core._bridge_display_name = "Slack"
    core._adapter = adapter  # type: ignore[assignment]
    core._room_service = rooms  # type: ignore[assignment]
    core._channel_to_room = {}
    core._room_to_channel = {}
    core._room_tenants = {}
    core._provisioning_channels = set()
    no_agents: list[str] = []

    async def _resolve_agents_for_channel(
        channel_id: str, channel_type: str
    ) -> list[str]:
        return list(channel_agents or [])

    async def _adopt_existing_room(channel_id: str) -> None:
        return None

    async def _post_no_agents_notice(channel_id: str) -> None:
        no_agents.append(channel_id)

    core._resolve_agents_for_channel = _resolve_agents_for_channel  # type: ignore[method-assign]
    core._adopt_existing_room = _adopt_existing_room  # type: ignore[method-assign]
    core._post_no_agents_notice = _post_no_agents_notice  # type: ignore[method-assign]
    core._sync_members_soon = lambda channel_ids: None  # type: ignore[method-assign]
    core.no_agents = no_agents  # type: ignore[attr-defined]
    return core, rooms


async def _join(
    core: CollaborationCore, added_by: str | None, channel_type: str = "channel_public"
) -> None:
    await core._handle_agent_joined_channel_locked(
        InboundAgentJoin(
            channel_id="C1",
            channel_type=channel_type,  # type: ignore[arg-type]
            agent_name="helper",
            channel_name="general",
            added_by_external_user_id=added_by,
        )
    )


class TestAnAgentAddedToABridgedChannel:
    async def _bridged(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        world: _World,
        core: CollaborationCore,
        seated: bool,
    ) -> None:
        room_id = await _make_public_room(
            session_factory,
            owner_id=world.olivia,
            member_agent_ids=[world.agent_id] if seated else [],
        )
        core._channel_to_room["C1"] = (room_id, "!secret:test")

    async def test_a_stranger_cannot_bring_it_in_and_the_channel_is_told(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=False)

        await _join(core, "USTRANGER")

        assert rooms.added == []
        assert [(c, t) for c, _, t in adapter.notices] == [("C1", "invite_refused")]
        assert "doesn't take requests from you" in adapter.notices[0][1]
        assert "isn't linked" not in adapter.notices[0][1]

    async def test_an_unclaimed_adder_is_told_to_link_their_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=False)

        await _join(core, "UNOBODY")

        assert rooms.added == []
        assert "isn't linked to your Switch user" in adapter.notices[0][1]

    async def test_the_owner_brings_it_in_quietly(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=False)

        await _join(core, "UOLIVIA")

        assert rooms.added == ["helper"]
        assert adapter.notices == [] and adapter.private == []

    async def test_an_unknown_adder_lets_it_in_and_tells_channel_and_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=False)

        await _join(core, None)

        assert rooms.added == ["helper"]
        assert [(c, t) for c, _, t in adapter.notices] == [("C1", "invite_unverified")]
        assert "couldn't verify who added" in adapter.notices[0][1]
        assert [p["user_id"] for p in adapter.private] == ["UOLIVIA"]
        assert adapter.private[0]["channel_id"] == "C1"

    async def test_without_a_private_route_the_channel_notice_is_all(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter(private_notice_delivery="in_channel")
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=False)

        await _join(core, None)

        assert rooms.added == ["helper"]
        assert len(adapter.notices) == 1 and adapter.private == []

    async def test_an_agent_already_in_the_room_is_not_judged_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(session_factory, world, adapter)
        await self._bridged(session_factory, world, core, seated=True)

        await _join(core, "USTRANGER")
        await _join(core, None)

        assert rooms.added == ["helper", "helper"]
        assert adapter.notices == [] and adapter.private == []


class TestARoomMadeForAChannel:
    async def test_a_refused_agent_is_left_out_of_the_new_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        open_agent = await _register(_service(session_factory), "open", world.olivia)
        await _set_policy(session_factory, open_agent, None)
        adapter = _Adapter()
        core, rooms = _core(
            session_factory, world, adapter, channel_agents=[world.agent_id, open_agent]
        )

        await core._create_room_for_channel(
            channel_id="C1",
            channel_type="channel_public",
            channel_name="general",
            added_by_external_user_id="USTRANGER",
            app_joined=True,
        )

        assert rooms.created[0].agent_ids == [open_agent]
        assert [t for _, _, t in adapter.notices] == ["invite_refused"]

    async def test_no_no_agents_notice_beside_a_refusal(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(
            session_factory, world, adapter, channel_agents=[world.agent_id]
        )

        await core._create_room_for_channel(
            channel_id="C1",
            channel_type="channel_public",
            channel_name="general",
            added_by_external_user_id="USTRANGER",
        )

        assert rooms.created[0].agent_ids == []
        assert core.no_agents == []  # type: ignore[attr-defined]

    async def test_a_lobby_is_left_to_its_own_rules(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        adapter = _Adapter()
        core, rooms = _core(
            session_factory, world, adapter, channel_agents=[world.agent_id]
        )

        await core._create_room_for_channel(
            channel_id="D1",
            channel_type="lobby",
            channel_name=None,
            added_by_external_user_id="USTRANGER",
        )

        assert rooms.created[0].agent_ids == [world.agent_id]
        assert adapter.notices == []

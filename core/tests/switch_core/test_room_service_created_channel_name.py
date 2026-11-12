"""A room whose channel Switch makes from the room's name remembers that it was
named in Switch and what the platform called the channel, so the room follows
the channel's renames; a room adopted from a channel stays "named after the
channel". Against real Postgres, with only the live bridge faked."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    CreatedChannel,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import (
    LINKED_CHANNEL_NAME_KEY,
    NAME_SOURCE_KEY,
    RoomStore,
)
from switch_core.room_service import RoomCreateConfig, RoomService


class _Provisioning:
    def __init__(self) -> None:
        self._n = 0

    async def create_room(self, name: str, topic: str) -> str:
        self._n += 1
        return f"!room-{self._n}:switch.local"

    async def record_join(
        self, session: object, room_id: str, user_id: str
    ) -> Callable[[], None]:
        raise NotImplementedError

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        return None


class _Adapter:
    """Makes a channel the platform names differently from what it was asked:
    the name was taken, so it carries a suffix."""

    adds_creator_to_public_channel = False

    def __init__(self) -> None:
        self.asked: list[str] = []

    async def create_channel(
        self, name: str, topic: str, *, channel_type: str = "channel_public"
    ) -> CreatedChannel:
        self.asked.append(name)
        return CreatedChannel(id=f"chan-{len(self.asked)}", name="payments-team-1a2b")

    async def require_bindable_channel(self, channel_id: str) -> None:
        return None

    async def check_channel_usable(self, channel_id: str) -> None:
        return None

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        return None


class _Bridge:
    def __init__(self) -> None:
        self._workspace_consumer_transport_user_id = "@bot:switch.local"
        self.adapter = _Adapter()

    def begin_provisioning(self, external_channel_id: str) -> None:
        return None

    def end_provisioning(self, external_channel_id: str) -> None:
        return None

    def add_room_mapping(self, *args: Any) -> None:
        return None


class _Lifecycle:
    def __init__(self, bridges: dict[str, _Bridge]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)

    def rooms_changed(self, bridge_id: str) -> None:
        return None


class _NoClients:
    def get_by_agent_id(self, agent_id: str) -> Any:
        return None

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


async def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[RoomService, str]:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.local",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=client.id,
            status="active",
        )
        session.add(bridge)
        await session.commit()
        bridge_id = bridge.id
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._client_lifecycle = _NoClients()  # type: ignore[assignment]
    svc._collab_lifecycle = _Lifecycle({bridge_id: _Bridge()})  # type: ignore[assignment]
    svc._collab_bridge_store = CollaborationBridgeStore()  # type: ignore[assignment]
    svc._provisioning = _Provisioning()  # type: ignore[assignment]
    return svc, bridge_id


async def _naming(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> tuple[str, str | None, str | None]:
    async with session_factory() as session:
        room = await RoomStore().get(session, room_id)
    assert room is not None
    metadata = room.metadata_ or {}
    return (
        room.name,
        metadata.get(NAME_SOURCE_KEY),
        metadata.get(LINKED_CHANNEL_NAME_KEY),
    )


async def test_a_room_created_with_a_new_channel_records_the_channels_real_name(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, bridge_id = await _service(session_factory)
    result = await svc.create_room(
        RoomCreateConfig(name="Payments Team", description="d", bridge_id=bridge_id)
    )
    assert await _naming(session_factory, result.room.id) == (
        "Payments Team",
        "created",
        "payments-team-1a2b",
    )


async def test_an_adopted_room_is_still_named_after_its_channel(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, bridge_id = await _service(session_factory)
    result = await svc.create_room(
        RoomCreateConfig(
            name="Slack: payments",
            description="d",
            bridge_id=bridge_id,
            external_channel_id="C-EXISTING",
            channel_type="channel_public",
            created_by_kind="system",
            named_after_channel="payments",
        )
    )
    assert await _naming(session_factory, result.room.id) == (
        "Slack: payments",
        "channel",
        "payments",
    )


async def test_attaching_a_bridge_that_makes_a_channel_records_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, bridge_id = await _service(session_factory)
    async with session_factory() as session:
        room = await RoomStore().create(
            session,
            Room(
                transport_room_id="!unbridged:switch.local",
                name="Payments Team",
                description="d",
                metadata_={"created_by_kind": "user"},
            ),
        )
        await session.commit()
        room_id = room.id
    await svc.link_bridge_to_room(room_id, bridge_id, "channel_public")
    assert await _naming(session_factory, room_id) == (
        "Payments Team",
        "created",
        "payments-team-1a2b",
    )


async def test_attaching_an_existing_channel_records_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, bridge_id = await _service(session_factory)
    async with session_factory() as session:
        room = await RoomStore().create(
            session,
            Room(
                transport_room_id="!unbridged:switch.local",
                name="Payments Team",
                description="d",
                metadata_={"created_by_kind": "user"},
            ),
        )
        await session.commit()
        room_id = room.id
    await svc.link_bridge_to_room(
        room_id, bridge_id, "channel_public", external_channel_id="C-EXISTING"
    )
    assert await _naming(session_factory, room_id) == ("Payments Team", None, None)


class _SlackWithoutScope:
    def __init__(self) -> None:
        self.creates = 0

    async def conversations_create(self, **kwargs: Any) -> Any:
        self.creates += 1
        body = {"ok": False, "error": "missing_scope", "needed": "channels:manage"}
        raise SlackApiError("missing_scope", response=body)


async def test_a_channel_slack_refuses_fails_the_room_with_slacks_reason(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, bridge_id = await _service(session_factory)
    slack = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    web = _SlackWithoutScope()
    slack._web_client = web  # type: ignore[assignment]
    svc._collab_lifecycle.get(bridge_id).adapter = slack  # type: ignore[attr-defined]
    name = f"Refused {uuid.uuid4().hex[:8]}"

    with pytest.raises(BridgeOperationError, match="channels:manage"):
        await svc.create_room(
            RoomCreateConfig(name=name, description="d", bridge_id=bridge_id)
        )

    assert web.creates == 1
    async with session_factory() as session:
        rooms = await session.execute(select(Room).where(Room.name == name))
        assert rooms.scalars().all() == []

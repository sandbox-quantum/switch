"""A new room starts with auto-route as its creator said, else as the
workspace's "auto-route new rooms" says (never a direct room), and only where
a decision service can act; its triage agent is set with it, and one that is
not among the room's agents is refused before anything is made. Against real
Postgres, with provisioning and clients faked."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    Room,
    Tenant,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.room_store import (
    RoomStore,
    auto_route_fallback_in,
    auto_route_on_in,
)
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.room_service import RoomCreateConfig, RoomService

AVAILABLE = DecisionAvailability(
    enabled=True,
    server=ServerDefault(
        endpoint_url="http://decisions.example.invalid",
        api_key=None,
        bedrock_enabled=False,
    ),
    store=DecisionSettingsStore(),
)


class _Provisioning:
    def __init__(self) -> None:
        self.created = 0

    async def create_room(self, name: str, topic: str) -> str:
        self.created += 1
        return f"!room-{uuid.uuid4().hex[:8]}:switch.local"

    async def record_join(
        self, session: object, room_id: str, user_id: str
    ) -> Callable[[], None]:
        raise NotImplementedError

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        return None


# Each agent's client id, by agent id, as `_agents` makes them.
_CLIENT_OF: dict[str, str] = {}


class _Clients:
    """Every agent made by `_agents` is running; there are no system clients."""

    def get_by_agent_id(self, agent_id: str) -> Any:
        return SimpleNamespace(
            client_id=_CLIENT_OF[agent_id], transport_user_id=f"@{agent_id}:test"
        )

    def get(self, client_id: str) -> Any:
        return None

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    decisions: DecisionAvailability = AVAILABLE,
) -> tuple[RoomService, _Provisioning]:
    provisioning = _Provisioning()
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._client_lifecycle = _Clients()  # type: ignore[assignment]
    svc._collab_lifecycle = _Clients()  # type: ignore[assignment]
    svc._provisioning = provisioning  # type: ignore[assignment]
    svc._decisions = decisions
    return svc, provisioning


async def _agents(
    session_factory: async_sessionmaker[AsyncSession], *names: str
) -> dict[str, str]:
    async with session_factory() as session:
        user = User(
            name=f"o-{uuid.uuid4().hex[:6]}",
            email=f"o-{uuid.uuid4().hex[:6]}@example.invalid",
            role="user",
        )
        session.add(user)
        await session.flush()
        ids: dict[str, str] = {}
        for name in names:
            key = ApiKey(
                user_id=user.id,
                key_hash=f"hash-{name}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=f"@{name}:test", display_name=name, type="agent"
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
            )
            session.add(agent)
            await session.flush()
            ids[name] = agent.id
            _CLIENT_OF[agent.id] = client.id
        await session.commit()
        return ids


async def _default(session_factory: async_sessionmaker[AsyncSession], on: bool) -> None:
    async with session_factory() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == TENANT_ZERO_ID)
            .values(auto_route_new_rooms=on)
        )
        await session.commit()


async def _state(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> tuple[bool, str | None]:
    async with session_factory() as session:
        room = await session.get(Room, room_id)
    assert room is not None
    return auto_route_on_in(room.metadata_), auto_route_fallback_in(room.metadata_)


def _config(**fields: Any) -> RoomCreateConfig:
    return RoomCreateConfig(name="room", description="d", internal_only=True, **fields)


@pytest.mark.parametrize("default", [True, False])
async def test_a_room_follows_the_workspace_default(
    session_factory: async_sessionmaker[AsyncSession], default: bool
) -> None:
    await _default(session_factory, default)
    svc, _ = _service(session_factory)
    result = await svc.create_room(_config())
    assert await _state(session_factory, result.room.id) == (default, None)
    assert result.auto_route_refused is None


@pytest.mark.parametrize("default", [True, False])
@pytest.mark.parametrize("explicit", [True, False])
async def test_an_explicit_value_overrides_the_default(
    session_factory: async_sessionmaker[AsyncSession], default: bool, explicit: bool
) -> None:
    await _default(session_factory, default)
    svc, _ = _service(session_factory)
    result = await svc.create_room(_config(auto_route=explicit))
    assert await _state(session_factory, result.room.id) == (explicit, None)


async def test_a_direct_room_is_left_off_by_the_default(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _default(session_factory, True)
    svc, _ = _service(session_factory)
    result = await svc.create_room(_config(channel_type="direct"))
    assert await _state(session_factory, result.room.id) == (False, None)


async def test_without_a_decision_service_the_default_is_skipped_quietly(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _default(session_factory, True)
    svc, _ = _service(session_factory, DecisionAvailability.off())
    result = await svc.create_room(_config())
    assert await _state(session_factory, result.room.id) == (False, None)
    assert result.auto_route_refused is None


async def test_without_a_decision_service_an_explicit_on_is_refused_with_a_reason(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, _ = _service(session_factory, DecisionAvailability.off())
    result = await svc.create_room(_config(auto_route=True))
    assert await _state(session_factory, result.room.id) == (False, None)
    assert result.auto_route_refused


async def test_where_the_workspace_chose_none_an_explicit_on_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        await DecisionSettingsStore().save(
            session,
            TENANT_ZERO_ID,
            backend="none",
            endpoint=None,
            api_key_encrypted=None,
            threshold=None,
        )
        await session.commit()
    svc, _ = _service(session_factory)
    result = await svc.create_room(_config(auto_route=True))
    assert await _state(session_factory, result.room.id) == (False, None)
    assert result.auto_route_refused


async def test_the_triage_agent_is_set_by_name_even_with_auto_route_off(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ids = await _agents(session_factory, "ops", "billing")
    svc, _ = _service(session_factory)
    result = await svc.create_room(
        _config(agent_names=["ops", "billing"], triage_agent="billing")
    )
    assert await _state(session_factory, result.room.id) == (False, ids["billing"])


async def test_the_triage_agent_is_set_with_auto_route_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ids = await _agents(session_factory, "ops", "billing")
    svc, _ = _service(session_factory)
    result = await svc.create_room(
        _config(agent_ids=list(ids.values()), triage_agent=ids["ops"], auto_route=True)
    )
    assert await _state(session_factory, result.room.id) == (True, ids["ops"])


@pytest.mark.parametrize("triage", ["billing", "nobody"])
async def test_a_triage_agent_not_in_the_room_is_refused_before_anything_is_made(
    session_factory: async_sessionmaker[AsyncSession], triage: str
) -> None:
    await _agents(session_factory, "ops", "billing")
    svc, provisioning = _service(session_factory)
    with pytest.raises(ValueError, match=f"triage agent {triage} is not one"):
        await svc.create_room(
            _config(agent_names=["ops"], triage_agent=triage, auto_route=True)
        )
    assert provisioning.created == 0
    async with session_factory() as session:
        assert (await session.execute(select(Room))).scalars().all() == []


class _Adapter:
    async def require_bindable_channel(self, channel_id: str) -> None:
        return None

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        return None


class _LiveBridge:
    """The running bridge as room creation sees it."""

    def __init__(self) -> None:
        self._workspace_consumer_transport_user_id = "@bot:switch.local"
        self.adapter = _Adapter()

    def begin_provisioning(self, external_channel_id: str) -> None:
        return None

    def end_provisioning(self, external_channel_id: str) -> None:
        return None

    def add_room_mapping(self, *args: Any) -> None:
        return None


class _Lifecycle(_Clients):
    def __init__(self, bridge_id: str) -> None:
        self._bridge_id = bridge_id

    def get(self, bridge_id: str) -> Any:
        return _LiveBridge() if bridge_id == self._bridge_id else None

    def rooms_changed(self, bridge_id: str) -> None:
        return None


async def _adopting_bridge(
    session_factory: async_sessionmaker[AsyncSession], agent_ids: list[str]
) -> CollaborationCore:
    """A bridge whose channel the bot was just added to, with only what
    adopting it touches, creating its room through a real `RoomService`."""
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.local",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        row = CollaborationBridge(
            type="mattermost",
            display_name="Mattermost",
            client_id=client.id,
            status="active",
        )
        session.add(row)
        await session.commit()
        bridge_id = row.id
    svc, _ = _service(session_factory)
    svc._collab_lifecycle = _Lifecycle(bridge_id)  # type: ignore[assignment]
    svc._collab_bridge_store = CollaborationBridgeStore()  # type: ignore[assignment]

    async def resolve_agents(channel_id: str, channel_type: str) -> list[str]:
        return agent_ids

    async def nothing_to_adopt(channel_id: str) -> None:
        return None

    bridge = CollaborationCore.__new__(CollaborationCore)
    bridge._provisioning_channels = set()
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._room_tenants = {}
    bridge._bridge_id = bridge_id
    bridge._bridge_display_name = "Mattermost"
    bridge._room_service = svc
    bridge._resolve_agents_for_channel = resolve_agents  # type: ignore[method-assign]
    bridge._adopt_existing_room = nothing_to_adopt  # type: ignore[method-assign]
    return bridge


@pytest.mark.parametrize(
    ("channel_type", "on"), [("channel_public", True), ("direct", False)]
)
async def test_a_channel_the_bridge_adopts_follows_the_default(
    session_factory: async_sessionmaker[AsyncSession], channel_type: str, on: bool
) -> None:
    """Nothing in the bridge asks for auto-route: room creation applies the
    default to the channel it adopts, and leaves a direct message off."""
    await _default(session_factory, True)
    ids = await _agents(session_factory, "ops")
    bridge = await _adopting_bridge(session_factory, list(ids.values()))
    adopted = await bridge._create_room_for_channel(
        channel_id=f"chan-{uuid.uuid4().hex[:6]}",
        channel_type=channel_type,  # type: ignore[arg-type]
        channel_name="support",
        sender_name="alice",
        agent_name="ops",
    )
    assert adopted is not None
    assert await _state(session_factory, adopted[0]) == (on, None)

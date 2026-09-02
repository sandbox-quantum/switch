from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.bridges.resource.tracker import ResourceRequestTracker
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.task_store import TaskStore
from switch_core.room_service import RoomService

_state: dict[str, Any] = {}


def init_dependencies(
    *,
    agent_store: AgentStore,
    agent_session_store: AgentSessionStore,
    room_store: RoomStore,
    room_service: RoomService,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    event_buffer: EventBuffer,
    connections: ConnectionRegistry,
    task_store: TaskStore,
    request_tracker: RequestTracker,
    resource_request_tracker: ResourceRequestTracker,
    resource_service: ResourceService,
    api_key_store: ApiKeyStore,
    api_key_cache: ApiKeyCache,
    external_user_store: ExternalUserStore,
    bridge_store: CollaborationBridgeStore,
    session_factory: Any,
    config: Any,
) -> None:
    _state["agent_store"] = agent_store
    _state["agent_session_store"] = agent_session_store
    _state["room_store"] = room_store
    _state["room_service"] = room_service
    _state["client_lifecycle"] = client_lifecycle
    _state["collab_lifecycle"] = collab_lifecycle
    _state["event_buffer"] = event_buffer
    _state["connections"] = connections
    _state["task_store"] = task_store
    _state["request_tracker"] = request_tracker
    _state["resource_request_tracker"] = resource_request_tracker
    _state["resource_service"] = resource_service
    _state["api_key_store"] = api_key_store
    _state["api_key_cache"] = api_key_cache
    _state["external_user_store"] = external_user_store
    _state["bridge_store"] = bridge_store
    _state["session_factory"] = session_factory
    _state["config"] = config

    _state["protocol"] = ProtocolService(
        agent_store=agent_store,
        agent_session_store=agent_session_store,
        room_store=room_store,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        event_buffer=event_buffer,
        connections=connections,
        task_store=task_store,
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        resource_service=resource_service,
        api_key_store=api_key_store,
        api_key_cache=api_key_cache,
        external_user_store=external_user_store,
        bridge_store=bridge_store,
        session_factory=session_factory,
        config=config,
    )


async def get_session() -> AsyncIterator[AsyncSession]:
    async with _state["session_factory"]() as session:
        yield session


def get_agent_store() -> AgentStore:
    return _state["agent_store"]  # type: ignore[no-any-return]


def get_room_store() -> RoomStore:
    return _state["room_store"]  # type: ignore[no-any-return]


def get_room_service() -> RoomService:
    return _state["room_service"]  # type: ignore[no-any-return]


def get_client_lifecycle() -> ClientLifecycleService:
    return _state["client_lifecycle"]  # type: ignore[no-any-return]


def get_event_buffer() -> EventBuffer:
    return _state["event_buffer"]  # type: ignore[no-any-return]


def get_task_store() -> TaskStore:
    return _state["task_store"]  # type: ignore[no-any-return]


def get_request_tracker() -> RequestTracker:
    return _state["request_tracker"]  # type: ignore[no-any-return]


def get_resource_request_tracker() -> ResourceRequestTracker:
    return _state["resource_request_tracker"]  # type: ignore[no-any-return]


def get_resource_service() -> ResourceService:
    return _state["resource_service"]  # type: ignore[no-any-return]


def get_collab_lifecycle() -> CollaborationBridgeLifecycleService:
    return _state["collab_lifecycle"]  # type: ignore[no-any-return]


def get_api_key_store() -> ApiKeyStore:
    return _state["api_key_store"]  # type: ignore[no-any-return]


def get_api_key_cache() -> ApiKeyCache:
    return _state["api_key_cache"]  # type: ignore[no-any-return]


def get_config() -> SwitchConfig:
    return _state["config"]  # type: ignore[no-any-return]


def get_protocol() -> ProtocolService:
    return _state["protocol"]  # type: ignore[no-any-return]

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.user_store import UserStore
from switch_core.engagements_yaml import EngagementYamlService
from switch_core.room_service import RoomService
from switch_core.rooms_yaml import RoomYamlService

_state: dict[str, Any] = {}


def init_dependencies(
    *,
    agent_store: AgentStore,
    room_store: RoomStore,
    room_group_store: RoomGroupStore,
    room_service: RoomService,
    bridge_store: CollaborationBridgeStore,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    connector_lifecycle: ServerSideConnectorLifecycleService,
    connector_store: ServerConnectorStore,
    event_buffer: EventBuffer,
    session_factory: Any,
    user_store: UserStore,
    external_user_store: ExternalUserStore,
    api_key_store: ApiKeyStore,
    resource_service: ResourceService,
    protocol: ProtocolService,
    config: SwitchConfig,
) -> None:
    _state["agent_store"] = agent_store
    _state["room_store"] = room_store
    _state["room_group_store"] = room_group_store
    _state["room_service"] = room_service
    _state["bridge_store"] = bridge_store
    _state["client_lifecycle"] = client_lifecycle
    _state["collab_lifecycle"] = collab_lifecycle
    _state["connector_lifecycle"] = connector_lifecycle
    _state["connector_store"] = connector_store
    _state["event_buffer"] = event_buffer
    _state["session_factory"] = session_factory
    _state["user_store"] = user_store
    _state["external_user_store"] = external_user_store
    _state["api_key_store"] = api_key_store
    _state["resource_service"] = resource_service
    _state["protocol"] = protocol
    _state["config"] = config


async def get_session() -> AsyncIterator[AsyncSession]:
    async with _state["session_factory"]() as session:
        yield session


def get_session_factory() -> Any:
    return _state["session_factory"]


def get_room_yaml_service() -> RoomYamlService:
    protocol: ProtocolService = _state["protocol"]
    return RoomYamlService(
        room_service=_state["room_service"],
        resource_service=_state["resource_service"],
        room_store=_state["room_store"],
        agent_store=_state["agent_store"],
        bridge_store=_state["bridge_store"],
        external_user_store=_state["external_user_store"],
        room_role_store=protocol.room_role_store,
        session_factory=_state["session_factory"],
    )


def get_engagement_yaml_service() -> EngagementYamlService:
    return EngagementYamlService(
        room_yaml=get_room_yaml_service(),
        room_group_store=_state["room_group_store"],
        resource_service=_state["resource_service"],
        agent_store=_state["agent_store"],
        bridge_store=_state["bridge_store"],
        session_factory=_state["session_factory"],
    )


def get_agent_store() -> AgentStore:
    return _state["agent_store"]  # type: ignore[no-any-return]


def get_room_store() -> RoomStore:
    return _state["room_store"]  # type: ignore[no-any-return]


def get_room_group_store() -> RoomGroupStore:
    return _state["room_group_store"]  # type: ignore[no-any-return]


def get_room_service() -> RoomService:
    return _state["room_service"]  # type: ignore[no-any-return]


def get_bridge_store() -> CollaborationBridgeStore:
    return _state["bridge_store"]  # type: ignore[no-any-return]


def get_client_lifecycle() -> ClientLifecycleService:
    return _state["client_lifecycle"]  # type: ignore[no-any-return]


def get_collab_lifecycle() -> CollaborationBridgeLifecycleService:
    return _state["collab_lifecycle"]  # type: ignore[no-any-return]


def get_event_buffer() -> EventBuffer:
    return _state["event_buffer"]  # type: ignore[no-any-return]


def get_user_store() -> UserStore:
    return _state["user_store"]  # type: ignore[no-any-return]


def get_external_user_store() -> ExternalUserStore:
    return _state["external_user_store"]  # type: ignore[no-any-return]


def get_api_key_store() -> ApiKeyStore:
    return _state["api_key_store"]  # type: ignore[no-any-return]


def get_connector_lifecycle() -> ServerSideConnectorLifecycleService:
    return _state["connector_lifecycle"]  # type: ignore[no-any-return]


def get_connector_store() -> ServerConnectorStore:
    return _state["connector_store"]  # type: ignore[no-any-return]


def get_config() -> SwitchConfig:
    return _state["config"]  # type: ignore[no-any-return]


def get_protocol() -> ProtocolService:
    return _state["protocol"]  # type: ignore[no-any-return]


def get_resource_service() -> ResourceService:
    return _state["resource_service"]  # type: ignore[no-any-return]

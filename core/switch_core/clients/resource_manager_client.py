from __future__ import annotations

import logging
from typing import Unpack

from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.resource.events import (
    ResourceLoadRequest,
    ResourceLoadResponse,
    RoomDocumentCreateRequest,
    RoomDocumentCreateResponse,
    RoomDocumentDeleteRequest,
    RoomDocumentDeleteResponse,
    RoomDocumentUpdateRequest,
    RoomDocumentUpdateResponse,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_base import (
    ClientBase,
    ClientBaseKwargs,
    ClientConfig,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.events import (
    MediationLlmRequest,
    MediationResult,
    MediationToolRequest,
)
from switch_core.transport import RoomRef

logger = logging.getLogger(__name__)


class ResourceManagerClient(ClientBase[ClientConfig]):
    def __init__(
        self,
        *,
        agent_store: AgentStore,
        room_store: RoomStore,
        resource_service: ResourceService,
        request_tracker: RequestTracker,
        **kwargs: Unpack[ClientBaseKwargs[ClientConfig]],
    ) -> None:
        super().__init__(**kwargs)
        self._agent_store = agent_store
        self._room_store = room_store
        self._resource_service = resource_service
        self._request_tracker = request_tracker

    async def on_mediation_tool_request(
        self, room: RoomRef, event: MediationToolRequest
    ) -> None:
        verdict, reason = await self._check_tool_access(event.agent_id, event.tool_id)
        result = MediationResult(verdict=verdict, reason=reason)
        self._request_tracker.resolve(event.request_id, result)

    async def on_mediation_llm_request(
        self, room: RoomRef, event: MediationLlmRequest
    ) -> None:
        verdict, reason = await self._check_model_access(event.agent_id, event.model_id)
        result = MediationResult(verdict=verdict, reason=reason)
        self._request_tracker.resolve(event.request_id, result)

    async def on_resource_load_request(
        self, room: RoomRef, event: ResourceLoadRequest
    ) -> None:
        """Fetch the requested documents and reply with a load_response.

        The agent's membership in the room is implicit (the request was sent
        in this room) and the service validates that each requested doc is
        actually attached here — preventing cross-room access.
        """
        response: ResourceLoadResponse
        if self.transport is None:
            logger.error(
                "Resource manager not connected; cannot send load response %s",
                event.request_id,
            )
            return
        try:
            async with self.session_factory() as session:
                switch_room = await self._room_store.get_by_matrix_room_id(
                    session, room.room_id
                )
                if switch_room is None:
                    raise ValueError(
                        f"No Switch room maps to matrix room {room.room_id}"
                    )
                entries = await self._resource_service.load_documents(
                    session, switch_room.id, event.document_ids
                )
            response = ResourceLoadResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="ok",
                documents=entries,
            )
        except Exception as exc:
            logger.exception(
                "Failed to load documents for request %s", event.request_id
            )
            response = ResourceLoadResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="error",
                error=str(exc),
            )

        await self.send_event(
            room.room_id,
            "com.switch.resource.load_response",
            response.model_dump(mode="json"),
        )

    async def on_room_document_create_request(
        self, room: RoomRef, event: RoomDocumentCreateRequest
    ) -> None:
        if self.transport is None:
            logger.error(
                "Resource manager not connected; cannot reply to %s", event.request_id
            )
            return
        response: RoomDocumentCreateResponse
        try:
            async with self.session_factory() as session:
                switch_room = await self._room_store.get_by_matrix_room_id(
                    session, room.room_id
                )
                if switch_room is None:
                    raise ValueError(
                        f"No Switch room maps to matrix room {room.room_id}"
                    )
                agent = await self._agent_store.get(session, event.agent_id)
                doc = await self._resource_service.create_room_document(
                    session,
                    room_id=switch_room.id,
                    agent_id=event.agent_id,
                    owner_id=agent.owner_id if agent is not None else None,
                    name=event.name,
                    description=event.description,
                    instructions=event.instructions,
                    content=event.content,
                )
                await session.commit()
            response = RoomDocumentCreateResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="ok",
                document_id=doc.id,
                document_name=doc.name,
            )
        except Exception as exc:
            logger.exception(
                "Failed to create room document for request %s", event.request_id
            )
            response = RoomDocumentCreateResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="error",
                error=str(exc),
            )

        await self.send_event(
            room.room_id,
            "com.switch.resource.room_document_create_response",
            response.model_dump(mode="json"),
        )

    async def on_room_document_update_request(
        self, room: RoomRef, event: RoomDocumentUpdateRequest
    ) -> None:
        if self.transport is None:
            logger.error(
                "Resource manager not connected; cannot reply to %s", event.request_id
            )
            return
        response: RoomDocumentUpdateResponse
        try:
            async with self.session_factory() as session:
                switch_room = await self._room_store.get_by_matrix_room_id(
                    session, room.room_id
                )
                if switch_room is None:
                    raise ValueError(
                        f"No Switch room maps to matrix room {room.room_id}"
                    )
                doc = await self._resource_service.update_room_document(
                    session,
                    room_id=switch_room.id,
                    agent_id=event.agent_id,
                    document_id=event.document_id,
                    name=event.name,
                    description=event.description,
                    instructions=event.instructions,
                    content=event.content,
                )
                await session.commit()
            response = RoomDocumentUpdateResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="ok",
                document_name=doc.name,
            )
        except Exception as exc:
            logger.exception(
                "Failed to update room document for request %s", event.request_id
            )
            response = RoomDocumentUpdateResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="error",
                error=str(exc),
            )

        await self.send_event(
            room.room_id,
            "com.switch.resource.room_document_update_response",
            response.model_dump(mode="json"),
        )

    async def on_room_document_delete_request(
        self, room: RoomRef, event: RoomDocumentDeleteRequest
    ) -> None:
        if self.transport is None:
            logger.error(
                "Resource manager not connected; cannot reply to %s", event.request_id
            )
            return
        response: RoomDocumentDeleteResponse
        deleted_name: str | None = None
        try:
            async with self.session_factory() as session:
                switch_room = await self._room_store.get_by_matrix_room_id(
                    session, room.room_id
                )
                if switch_room is None:
                    raise ValueError(
                        f"No Switch room maps to matrix room {room.room_id}"
                    )
                doc = await self._resource_service.get_room_scoped_document(
                    session, switch_room.id, event.document_id
                )
                deleted_name = doc.name
                await self._resource_service.delete_room_document(
                    session,
                    room_id=switch_room.id,
                    agent_id=event.agent_id,
                    document_id=event.document_id,
                )
                await session.commit()
            response = RoomDocumentDeleteResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="ok",
                document_name=deleted_name,
            )
        except Exception as exc:
            logger.exception(
                "Failed to delete room document for request %s", event.request_id
            )
            response = RoomDocumentDeleteResponse(
                request_id=event.request_id,
                agent_id=event.agent_id,
                status="error",
                error=str(exc),
            )

        await self.send_event(
            room.room_id,
            "com.switch.resource.room_document_delete_response",
            response.model_dump(mode="json"),
        )

    async def _check_tool_access(
        self, agent_id: str, tool_name: str
    ) -> tuple[str, str | None]:
        async with self.session_factory() as session:
            tools = await self._agent_store.get_tools(session, agent_id)

        if any(t.name == tool_name for t in tools):
            return "proceed", None

        return "blocked", f"Agent {agent_id} does not have tool '{tool_name}' attached"

    async def _check_model_access(
        self, agent_id: str, model_name: str
    ) -> tuple[str, str | None]:
        async with self.session_factory() as session:
            models = await self._agent_store.get_models(session, agent_id)

        if any(m.name == model_name for m in models):
            return "proceed", None

        return (
            "blocked",
            f"Agent {agent_id} does not have model '{model_name}' attached",
        )

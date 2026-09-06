from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.config import SwitchConfig
from switch_core.db.models import Client
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages.notify import MessageListener
from switch_core.transport import MessageTransport
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.postgres import PostgresTransport

logger = logging.getLogger(__name__)


class ClientFactory:
    def __init__(
        self,
        *,
        client_store: ClientStore,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        room_store: RoomStore,
        message_store: MessageStore,
        media_store: MediaStore,
        listener: MessageListener,
        invites: InviteBus,
        ephemeral: EphemeralBus,
    ) -> None:
        self._client_store = client_store
        self._session_factory = session_factory
        self._config = config
        self._room_store = room_store
        self._message_store = message_store
        self._media_store = media_store
        self._listener = listener
        self._invites = invites
        self._ephemeral = ephemeral
        self._registry: dict[
            str, tuple[type[ClientBase[ClientConfig]], dict[str, object]]
        ] = {}

    def register(
        self,
        client_type: str,
        cls: type[ClientBase[ClientConfig]],
        **extra_kwargs: object,
    ) -> None:
        self._registry[client_type] = (cls, extra_kwargs)

    def create(self, record: Client) -> ClientBase[ClientConfig]:
        entry = self._registry.get(record.type)
        if entry is None:
            raise ValueError(f"Unknown client type: {record.type!r}")
        cls, extra_kwargs = entry
        config = cls.config_class.model_validate(record.config or {})
        return cls(
            client_id=record.id,
            matrix_user_id=record.matrix_user_id,
            display_name=record.display_name,
            session_factory=self._session_factory,
            client_store=self._client_store,
            config=config,
            transport_factory=self.transport_for,
            **extra_kwargs,
        )

    def transport_for(self, client: ClientBase[Any]) -> MessageTransport:
        """The transport every client in the process runs on.

        Public because not every client is built by `create`: a collaboration
        bridge's client is constructed by its own lifecycle service, which
        carries per-bridge state the registry cannot hold. It goes through here
        so that every client in the process is built the same way.
        """
        return PostgresTransport(
            user_id=client.matrix_user_id,
            client_id=client.client_id,
            display_name=client.display_name,
            session_factory=self._session_factory,
            room_store=self._room_store,
            message_store=self._message_store,
            media_store=self._media_store,
            listener=self._listener,
            invites=self._invites,
            ephemeral=self._ephemeral,
        )

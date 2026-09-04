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
from switch_core.messages import MessageRecorder
from switch_core.messages.notify import MessageListener
from switch_core.messages.recording import MessageRecording, NoRecording
from switch_core.transport import MessageTransport
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.matrix import MatrixTransport
from switch_core.transport.postgres import PostgresTransport

logger = logging.getLogger(__name__)


def matrix_transport_for(client: ClientBase[Any]) -> MessageTransport:
    """Build the transport a client runs on.

    Choosing the implementation is the factory's job, so a client never names
    one.

    The config type is `Any` because nothing here reads the config: a factory
    that works for every client would otherwise have to be re-typed for each
    subclass, since `ClientBase` is invariant in it.
    """
    return MatrixTransport(
        server_url=client.server_url,
        user_id=client.matrix_user_id,
        password=client.password,
        device_id=client.session_state.get("device_id"),
        access_token=client.session_state.get("access_token"),
    )


class ClientFactory:
    def __init__(
        self,
        *,
        client_store: ClientStore,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        message_recorder: MessageRecorder,
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
        self._message_recorder = message_recorder
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
            password=record.password,
            server_url=self._config.matrix_server,
            session_factory=self._session_factory,
            client_store=self._client_store,
            config=config,
            transport_factory=self.transport_for,
            message_recorder=self.recorder(),
            session_state={
                "access_token": record.access_token,
                "device_id": record.device_id,
            },
            next_batch_token=record.next_batch_token,
            **extra_kwargs,
        )

    def transport_for(self, client: ClientBase[Any]) -> MessageTransport:
        """The transport every client in the process runs on.

        Public because not every client is built by `create`: a collaboration
        bridge's client is constructed by its own lifecycle service, which
        carries per-bridge state the registry cannot hold. It still has to make
        the same choice, and a caller that named an implementation directly
        would put its clients on a different bus from everyone else's — agents
        talking in rows while bridges talk to a homeserver, each side healthy
        and neither reaching the other.
        """
        if self._config.message_transport == "matrix":
            return matrix_transport_for(client)
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

    def recorder(self) -> MessageRecording:
        """The recorder that goes with the transport.

        Paired here rather than configured separately: a transport that stores
        what it carries needs no recorder, and one that does not needs one.
        Splitting the decision would let a deployment pick both and write every
        message twice.
        """
        if self._config.message_transport == "matrix":
            return self._message_recorder
        return NoRecording()

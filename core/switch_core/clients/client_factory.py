from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import Actor, ClientConfig
from switch_core.clients.consumer import Consumer
from switch_core.config import SwitchConfig
from switch_core.db.models import Client
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.messages.notify import MessageListener
from switch_core.transport import MessageTransport
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.observer import ParticipantMessageObserver
from switch_core.transport.postgres import PostgresTransport
from switch_core.transport.room_cache import RoomDeliveryCache

if TYPE_CHECKING:
    from switch_core.delivery.router import MessageRouter

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
        usage_store: UsageStore,
        media_store: MediaStore,
        listener: MessageListener,
        invites: InviteBus,
        ephemeral: EphemeralBus,
        room_cache: RoomDeliveryCache,
        message_observer: ParticipantMessageObserver,
        router: MessageRouter,
    ) -> None:
        self._client_store = client_store
        self._session_factory = session_factory
        self._config = config
        self._room_store = room_store
        self._message_store = message_store
        self._usage_store = usage_store
        self._media_store = media_store
        self._listener = listener
        self._invites = invites
        self._ephemeral = ephemeral
        # One for the process, so every member of a room shares it.
        self._room_cache = room_cache
        self._message_observer = message_observer
        # Every transport writes through it, and it posts agents' replies
        # through transports built here, so it is handed how to build one.
        self._router = router
        router.use_transports(self.transport_for)
        self._registry: dict[
            str,
            tuple[
                type[Actor[ClientConfig]],
                type[Consumer[Any]] | None,
                dict[str, object],
            ],
        ] = {}

    def register(
        self,
        client_type: str,
        actor_cls: type[Actor[ClientConfig]],
        consumer_cls: type[Consumer[Any]] | None = None,
        **consumer_kwargs: object,
    ) -> None:
        """What a `clients` row of `client_type` becomes when it runs.

        Every row is an actor. A type that reads rooms also names a consumer,
        built around that actor with `consumer_kwargs`; a type that only
        writes (a person on another platform, a bridge's own identity) names
        none, and runs no read loop.
        """
        self._registry[client_type] = (actor_cls, consumer_cls, consumer_kwargs)

    def has_consumer(self, client_type: str) -> bool:
        """Whether a client of this type has a consumer, which runs in one
        process only, the one that owns the client (`ownership.py`)."""
        entry = self._registry.get(client_type)
        if entry is None:
            raise ValueError(f"Unknown client type: {client_type!r}")
        return entry[1] is not None

    def create_actor(self, record: Client) -> Actor[ClientConfig]:
        """The actor a `clients` row becomes."""
        entry = self._registry.get(record.type)
        if entry is None:
            raise ValueError(f"Unknown client type: {record.type!r}")
        actor_cls = entry[0]
        config = actor_cls.config_class.model_validate(record.config or {})
        return actor_cls(
            client_id=record.id,
            # Straight off the row this client *is*. `create_client` writes
            # that row inside a session with the tenant bound and the factory
            # does not expire on commit, so a record that has just been
            # flushed carries its tenant here as surely as one read back at
            # boot does.
            tenant_id=record.tenant_id,
            transport_user_id=record.transport_user_id,
            display_name=record.display_name,
            session_factory=self._session_factory,
            client_store=self._client_store,
            config=config,
            transport_factory=self.transport_for,
        )

    def create_consumer(
        self, client_type: str, actor: Actor[ClientConfig]
    ) -> Consumer[Any] | None:
        """A fresh consumer around `actor`, or None for a type that reads
        nothing."""
        entry = self._registry.get(client_type)
        if entry is None:
            raise ValueError(f"Unknown client type: {client_type!r}")
        _, consumer_cls, consumer_kwargs = entry
        if consumer_cls is None:
            return None
        return consumer_cls(actor=actor, **consumer_kwargs)

    def transport_for(self, client: Actor[Any]) -> MessageTransport:
        """The transport every client in the process runs on.

        Public because not every client is built by `create`: a collaboration
        bridge's client is constructed by its own lifecycle service, which
        carries per-bridge state the registry cannot hold. It goes through here
        so that every client in the process is built the same way.
        """
        return PostgresTransport(
            user_id=client.transport_user_id,
            client_id=client.client_id,
            tenant_id=client.tenant_id,
            display_name=client.display_name,
            actor_role=client.role,
            session_factory=self._session_factory,
            room_store=self._room_store,
            message_store=self._message_store,
            usage_store=self._usage_store,
            media_store=self._media_store,
            listener=self._listener,
            invites=self._invites,
            ephemeral=self._ephemeral,
            room_cache=self._room_cache,
            message_observer=self._message_observer,
            router=self._router,
        )

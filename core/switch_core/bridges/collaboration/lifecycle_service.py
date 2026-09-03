from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import BridgeConnectionConfig
from switch_core.clients.bridge_client import BridgeClient, BridgeClientConfig
from switch_core.clients.client_factory import matrix_transport_for
from switch_core.config import SwitchConfig
from switch_core.db.models import CollaborationBridge
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.matrix_admin import MatrixAdmin
from switch_core.messages import MessageRecorder

if TYPE_CHECKING:
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)


def _bridge_client_localpart(bridge_type: str, display_name: str) -> str:
    """The Matrix localpart for a messaging app's own client.

    The random tail is what makes disconnecting and reconnecting work. The
    readable part is derived from the app's type and name, which an operator is
    free to reuse — and the homeserver has no API for removing an account, so
    the old one is still there when they do. Reusing the name meant either
    colliding with it, or adopting an account whose password Switch no longer
    holds: shared-secret registration reports an existing user as success
    without applying the new one, so the second reads as a working connection
    that can never log in.

    A fresh name each time costs an abandoned account on the homeserver, which
    is already the case and is logged on removal.
    """
    safe_name = re.sub(r"[^a-z0-9._=-]", "-", display_name.lower())[:16]
    return f"switch-bridge-{bridge_type}-{safe_name}-{uuid4().hex[:8]}"


class CollaborationBridgeLifecycleService:
    def __init__(
        self,
        *,
        bridge_store: CollaborationBridgeStore,
        external_user_store: ExternalUserStore,
        bridge_message_map_store: BridgeMessageMapStore,
        room_store: RoomStore,
        agent_store: AgentStore,
        client_store: ClientStore,
        client_lifecycle: ClientLifecycleService,
        room_service: RoomService,
        matrix_admin: MatrixAdmin,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        message_recorder: MessageRecorder,
    ) -> None:
        self._bridge_store = bridge_store
        self._external_user_store = external_user_store
        self._bridge_message_map_store = bridge_message_map_store
        self._room_store = room_store
        self._agent_store = agent_store
        self._client_store = client_store
        self._client_lifecycle = client_lifecycle
        self._room_service = room_service
        self._matrix_admin = matrix_admin
        self._session_factory = session_factory
        self._config = config
        self._message_recorder = message_recorder

        self._adapter_registry: dict[str, type[CollaborationAdapter]] = {}
        self._config_registry: dict[str, type[BridgeConnectionConfig]] = {}
        self._bridges: dict[str, BridgeCore] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        # bridge_id -> the host resource it holds exclusively while running
        # (see CollaborationAdapter.exclusive_resource). Lets a second
        # claimant be refused by name instead of failing on the resource.
        self._held_resources: dict[str, str] = {}
        # Serialises registration. The exclusivity check reads the stored
        # bridges and the winner is not written until several awaits later,
        # so two concurrent registrations would both see a free resource and
        # both take it — the very collision the check exists to refuse.
        #
        # A process-wide lock is sufficient *because* switch-core is a
        # singleton: the chart fails the render for replicaCount != 1, since
        # it holds live Matrix sessions in memory. If that ever changes, this
        # has to become a database constraint — the way the single-default
        # bridge invariant already is — because a lock in one process would
        # then be guarding nothing.
        self._register_lock = asyncio.Lock()

    def register_adapter(
        self,
        bridge_type: str,
        adapter_cls: type[CollaborationAdapter],
        config_cls: type[BridgeConnectionConfig],
    ) -> None:
        self._adapter_registry[bridge_type] = adapter_cls
        self._config_registry[bridge_type] = config_cls

    def get_registered_types(self) -> list[str]:
        return list(self._adapter_registry.keys())

    def get_adapter(self, bridge_id: str) -> CollaborationAdapter | None:
        """The live adapter for a running bridge, or None if it isn't running.

        Used to ask a platform for a channel deeplink without the caller having
        to know the platform specifics."""
        bridge = self._bridges.get(bridge_id)
        return bridge.adapter if bridge is not None else None

    def supports_channel_creation(self, bridge_type: str) -> bool:
        """Whether this platform can create a channel from Switch at all.

        Answered from the registered adapter *class*, so it holds for a bridge
        that is stopped and for a type nobody has registered a connection for
        yet — both moments where an operator needs the answer. An unknown type
        is reported as capable: the registration that follows rejects it by
        name, which is a better error than a capability claim about a platform
        Switch does not have."""
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.supports_channel_creation

    def supports_directory_search(self, bridge_type: str) -> bool:
        """Whether this platform has a user directory Switch can search.

        Read from the adapter class for the same reason as
        `supports_channel_creation`: the answer decides whether to even offer
        someone the "which account is you" step while connecting, which is
        before any connection exists. An unknown type is reported as
        searchable — registration rejects it by name a moment later, which is a
        better error than a capability claim about a platform Switch does not
        have.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.supports_directory_search

    def renders_custom_url_schemes(self, bridge_type: str) -> bool:
        """Whether this platform makes a `switchdash://` link clickable.

        Decides whether the "Open in Switch Console" deeplink is rewritten to
        the gateway's https redirect. The redirect exists for platforms that
        linkify only http(s) — a hop through the browser that lands in the same
        place, but a hop. A platform that renders the scheme should be handed
        the real link.

        Read from the adapter class for the same reason as
        `supports_channel_creation`. An unknown type is reported as rendering
        it, matching the base class default.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.renders_custom_url_schemes

    def get_config_schema(self, bridge_type: str) -> dict[str, object]:
        config_cls = self._config_registry.get(bridge_type)
        if config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")
        return config_cls.model_json_schema()

    def validate_connection_config(
        self, bridge_type: str, connection_config: dict[str, object]
    ) -> None:
        """Raise unless `connection_config` is valid for this bridge type.

        Editing a connection has to be checked before it is stored: a config
        the adapter cannot parse would take the bridge down on its next start,
        long after the request that caused it."""
        config_cls = self._config_registry.get(bridge_type)
        if config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")
        config_cls.model_validate(connection_config)

    async def start_all(self) -> None:
        async with self._session_factory() as session:
            bridges = await self._bridge_store.get_active(session)

        logger.info("Starting %d collaboration bridges", len(bridges))
        for bridge in bridges:
            try:
                await self.start(bridge.id)
            except Exception:
                logger.exception("Failed to start bridge %s", bridge.id)

    async def _reject_resource_conflict(
        self,
        bridge_type: str,
        connection_config: dict[str, object],
        *,
        exclude_bridge_id: str | None = None,
    ) -> None:
        """Refuse a bridge that would contend for a resource another one holds.

        Checked against every stored bridge rather than the running set, so the
        answer does not depend on whether the incumbent happens to be up.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return
        wanted = adapter_cls.exclusive_resource(connection_config)
        if wanted is None:
            return

        async with self._session_factory() as session:
            existing = await self._bridge_store.get_all(session)
        for other in existing:
            # Guard the None case explicitly: an unflushed row has no id yet, and
            # `other.id == exclude_bridge_id` would then be None == None and skip
            # a bridge that genuinely holds the resource.
            if exclude_bridge_id is not None and other.id == exclude_bridge_id:
                continue
            if other.type != bridge_type:
                continue
            other_cls = self._adapter_registry.get(other.type)
            if other_cls is None:
                continue
            try:
                held = other_cls.exclusive_resource(other.connection_config or {})
            except Exception:
                # A stored config we can no longer parse should not block a new
                # bridge — it is its own problem, and it is already logged when
                # that bridge tries to start.
                logger.warning(
                    "Could not read the exclusive resource of bridge %s (%s)",
                    other.id,
                    other.type,
                    exc_info=True,
                )
                continue
            if held == wanted:
                raise ValueError(
                    f"'{other.display_name}' already uses {wanted} on this "
                    f"instance, and two {bridge_type} bridges cannot share it. "
                    "Delete that bridge first, or give this one a different "
                    "listen_port in its connection_config — noting the Helm "
                    "chart publishes only one Teams port, so a second one needs "
                    "its own Service port and route."
                )

    async def register(
        self,
        *,
        bridge_type: str,
        display_name: str,
        connection_config: dict[str, object],
        channel_creation_enabled: bool,
    ) -> CollaborationBridge:
        async with self._register_lock:
            return await self._register_locked(
                bridge_type=bridge_type,
                display_name=display_name,
                connection_config=connection_config,
                channel_creation_enabled=channel_creation_enabled,
            )

    async def _register_locked(
        self,
        *,
        bridge_type: str,
        display_name: str,
        connection_config: dict[str, object],
        channel_creation_enabled: bool,
    ) -> CollaborationBridge:
        adapter_cls = self._adapter_registry.get(bridge_type)
        config_cls = self._config_registry.get(bridge_type)
        if adapter_cls is None or config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")

        if channel_creation_enabled and not adapter_cls.supports_channel_creation:
            raise ValueError(
                f"{bridge_type} cannot create channels from Switch, so this "
                "connection cannot be allowed to. Create the chat on the "
                "platform and add the bot to it; Switch adopts it as a room."
            )

        # Fill in what the adapter generates, validate the result, and persist
        # the validated form — not the raw request — so a value minted here is
        # stored once and never re-derived.
        connection_config = await adapter_cls.prepare_config(connection_config)
        validated = config_cls.model_validate(connection_config)
        connection_config = validated.model_dump(mode="json")

        await self._reject_resource_conflict(bridge_type, connection_config)

        # Before anything is written. The adapter runs in a background task
        # whose failures are logged and swallowed, so credentials that are wrong
        # would otherwise be stored, reported as success, and only surface later
        # as an unrelated-looking error. Failing here also avoids leaving an
        # orphan Matrix identity behind for a bridge that was never viable.
        await adapter_cls.verify_credentials(connection_config)

        bridge_client_record = await self._client_lifecycle.create_client(
            client_type="bridge",
            display_name=f"bridge-{bridge_type}-{display_name}",
            localpart=_bridge_client_localpart(bridge_type, display_name),
        )

        bridge = CollaborationBridge(
            type=bridge_type,
            display_name=display_name,
            connection_config=connection_config,  # type: ignore[arg-type]
            client_id=bridge_client_record.id,
            status="active",
            channel_creation_enabled=channel_creation_enabled,
        )
        async with self._session_factory() as session:
            await self._bridge_store.create(session, bridge)
            await session.commit()

        await self.start(bridge.id)

        logger.info(
            "Registered collaboration bridge %s (%s): %s",
            bridge.id,
            bridge_type,
            display_name,
        )
        return bridge

    async def start(self, bridge_id: str) -> None:
        async with self._session_factory() as session:
            bridge = await self._bridge_store.get(session, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")

        adapter_cls = self._adapter_registry.get(bridge.type)
        config_cls = self._config_registry.get(bridge.type)
        if adapter_cls is None or config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge.type}")

        # Registration refuses a conflicting bridge, but rows predating that
        # check still exist, and start_all would otherwise walk into the bind
        # error one of them causes. Say which bridge holds it instead.
        wanted = adapter_cls.exclusive_resource(bridge.connection_config or {})
        if wanted is not None:
            for other_id, held in self._held_resources.items():
                if held == wanted and other_id != bridge_id:
                    raise ValueError(
                        f"Cannot start bridge {bridge_id} ({bridge.type}): "
                        f"{wanted} is already held by bridge {other_id}. Only "
                        "one of them can run; delete one, or give it a "
                        "different listen_port."
                    )

        typed_config = config_cls.model_validate(bridge.connection_config or {})
        adapter = adapter_cls(config=typed_config)  # type: ignore[call-arg]
        adapter.set_service_url_persister(
            lambda service_url: self._persist_service_url(bridge_id, service_url)
        )
        adapter.set_channel_team_persister(
            lambda channel_id, team_id: self._persist_channel_team(
                bridge_id, channel_id, team_id
            )
        )
        adapter.set_max_attachment_bytes(self._config.agent_media_max_bytes)

        if (
            not adapter_cls.renders_custom_url_schemes
            and not self._config.gateway_public_url
        ):
            logger.warning(
                "GATEWAY_PUBLIC_URL is not set and %s only renders http(s) links, "
                "so the 'Open in Switch Console' deeplink cannot be clickable on "
                "bridge %s — it is posted as copyable text instead. Set "
                "GATEWAY_PUBLIC_URL to the Switch API's public origin (scheme + "
                "host, no path) to turn it into a real link",
                bridge.type,
                bridge_id,
            )

        async with self._session_factory() as session:
            bridge_client_record = await self._client_store.get(
                session, bridge.client_id
            )
        if bridge_client_record is None:
            raise ValueError(f"Bridge client not found: {bridge.client_id}")

        bridge_core = BridgeCore(
            bridge_id=bridge_id,
            bridge_type=bridge.type,
            bridge_display_name=bridge.display_name,
            adapter=adapter,
            room_store=self._room_store,
            external_user_store=self._external_user_store,
            bridge_message_map_store=self._bridge_message_map_store,
            agent_store=self._agent_store,
            client_store=self._client_store,
            room_service=self._room_service,
            client_lifecycle=self._client_lifecycle,
            matrix_admin=self._matrix_admin,
            session_factory=self._session_factory,
            matrix_server_name=self._config.matrix_server_name,
            bridge_client_matrix_user_id=bridge_client_record.matrix_user_id,
            max_attachment_bytes=self._config.agent_media_max_bytes,
        )

        bridge_client = BridgeClient(
            bridge_core=bridge_core,
            client_id=bridge_client_record.id,
            matrix_user_id=bridge_client_record.matrix_user_id,
            display_name=bridge_client_record.display_name,
            password=bridge_client_record.password,
            server_url=self._config.matrix_server,
            session_factory=self._session_factory,
            client_store=self._client_store,
            config=BridgeClientConfig(bridge_id=bridge_id),
            transport_factory=matrix_transport_for,
            message_recorder=self._message_recorder,
            session_state={
                "access_token": bridge_client_record.access_token,
                "device_id": bridge_client_record.device_id,
            },
            next_batch_token=bridge_client_record.next_batch_token,
        )

        task = asyncio.create_task(
            self._run_bridge(bridge_id, bridge_core, bridge_client)
        )
        self._bridges[bridge_id] = bridge_core
        self._tasks[bridge_id] = task
        if wanted is not None:
            self._held_resources[bridge_id] = wanted

        logger.info("Started collaboration bridge %s (%s)", bridge_id, bridge.type)

    async def _persist_service_url(self, bridge_id: str, service_url: str) -> None:
        """Persist an outbound serviceUrl an adapter learned from inbound traffic
        so outbound survives a restart (used by the Teams adapter)."""
        async with self._session_factory() as session:
            await self._bridge_store.set_service_url(session, bridge_id, service_url)
            await session.commit()

    async def _persist_channel_team(
        self, bridge_id: str, channel_id: str, team_id: str
    ) -> None:
        """Persist the team an adapter learned a channel belongs to, so channel
        capture survives a restart (used by the Teams adapter)."""
        async with self._session_factory() as session:
            await self._bridge_store.set_channel_team(
                session, bridge_id, channel_id, team_id
            )
            await session.commit()

    async def _run_bridge(
        self,
        bridge_id: str,
        bridge_core: BridgeCore,
        bridge_client: BridgeClient,
    ) -> None:
        try:
            await bridge_core.start()
            await bridge_client.start()
        except Exception:
            logger.exception("Bridge %s crashed", bridge_id)
            self._bridges.pop(bridge_id, None)
            self._tasks.pop(bridge_id, None)
            self._held_resources.pop(bridge_id, None)

    async def stop(self, bridge_id: str) -> None:
        bridge_core = self._bridges.get(bridge_id)
        if bridge_core:
            await bridge_core.stop()

        task = self._tasks.pop(bridge_id, None)
        if task and not task.done():
            task.cancel()

        self._bridges.pop(bridge_id, None)
        self._held_resources.pop(bridge_id, None)
        logger.info("Stopped collaboration bridge %s", bridge_id)

    async def restart(self, bridge_id: str) -> None:
        """Stop and start a bridge so it picks up its stored config.

        An adapter is built from the config it was given at start, so an edit
        is inert until the bridge is rebuilt."""
        await self.stop(bridge_id)
        await self.start(bridge_id)
        logger.info("Restarted collaboration bridge %s", bridge_id)

    async def stop_all(self) -> None:
        logger.info("Stopping all %d collaboration bridges", len(self._bridges))
        for bridge_id in list(self._bridges):
            await self.stop(bridge_id)

    async def remove(self, bridge_id: str) -> None:
        """Disconnect a messaging app and take its identities with it.

        Everything Switch created to talk to this platform goes: the bridge's
        own Matrix client, and the puppet client behind every person Switch saw
        on it. Leaving those behind is not a tidiness problem — the bridge
        client's Matrix name is derived from the app's type and display name,
        so an operator who disconnects an app and reconnects one named the same
        collided with the row left by the last one.

        Order matters: the clients are children of nothing but the bridge and
        external-user rows point at them, so those go first or the foreign keys
        refuse.
        """
        await self.stop(bridge_id)
        async with self._session_factory() as session:
            bridge = await self._bridge_store.get(session, bridge_id)
            dependent_rooms = await self._room_store.get_by_bridge(session, bridge_id)
            if dependent_rooms:
                logger.warning(
                    "Detaching %d room(s) from collaboration bridge %s before removal; "
                    "they will become internal-only rooms: %s",
                    len(dependent_rooms),
                    bridge_id,
                    ", ".join(room.id for room in dependent_rooms),
                )
                for room in dependent_rooms:
                    await self._room_store.clear_bridge(session, room.id)
            puppets = await self._external_user_store.get_by_bridge(session, bridge_id)
            puppet_client_ids = [u.client_id for u in puppets if u.client_id]
            await self._external_user_store.delete_by_bridge(session, bridge_id)
            await self._bridge_store.delete(session, bridge_id)
            await session.commit()

        removed = list(puppet_client_ids)
        if bridge is not None:
            removed.append(bridge.client_id)
        for client_id in removed:
            await self._client_lifecycle.remove(client_id)

        # The Matrix accounts themselves outlive this: the homeserver offers no
        # deprovisioning call Switch can make. Said out loud because it is the
        # reason a reconnection cannot reuse the old name — see
        # `_bridge_client_localpart`.
        logger.info(
            "Removed collaboration bridge %s and %d client identities; their "
            "Matrix accounts remain on the homeserver, which has no API to "
            "remove them",
            bridge_id,
            len(removed),
        )

    def get(self, bridge_id: str) -> BridgeCore | None:
        return self._bridges.get(bridge_id)

    def all_bridges(self) -> list[BridgeCore]:
        return list(self._bridges.values())

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.aliases import validate_alias_map
from switch_core.authz import Principal, can, validate_visibility_pair
from switch_core.bridges.collaboration.models import (
    ChannelCreationUnsupported,
    ChannelType,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Room, RoomGroup, RoomRole
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.matrix_admin import MatrixAdmin

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.bridge_core import BridgeCore
    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )

logger = logging.getLogger(__name__)

SYSTEM_CLIENT_TYPES = ("resource_manager", "observe", "admin")


class LinkedRoomSpec(BaseModel):
    target_room_id: str
    label: str


class RoleSpec(BaseModel):
    name: str
    instructions: str
    exclusive: bool = False


class RoomCreateConfig(BaseModel):
    name: str
    description: str
    agent_ids: list[str] | None = None
    agent_names: list[str] | None = None
    # Per-agent opt-in: the identifiers (same space as agent_ids/agent_names)
    # of selected agents whose subagents (child agents) should also be added.
    # A subset of the selection — only these parents are expanded, not all.
    include_subagents_for: list[str] | None = None
    # Per-agent opt-in: the identifiers (same space as agent_ids/agent_names)
    # of selected agents that should receive `room_join` events in this room.
    # Agents not listed keep the default (off).
    join_event_listeners: list[str] | None = None
    user_names: list[str] | None = None
    channel_type: ChannelType | None = None
    bridge_id: str | None = None
    # Opt out of the instance default bridge and create a room with no external
    # channel. Only meaningful when ``bridge_id`` is unset: omitting the bridge
    # now means "use the default", so making a room agent-only has to be said
    # rather than implied.
    internal_only: bool = False
    external_channel_id: str | None = None
    instructions: str | None = None
    protection_config: dict[str, object] | None = None
    observe_config: dict[str, object] | None = None
    admin_mode: bool = False
    created_by: str | None = None
    # Optional group to file the room under at creation (navigation layer).
    group_id: str | None = None
    # Authorization owner (the acting user, or an agent's owner for MCP-created
    # rooms). `created_by` is immutable audit; `owner_id` is what `can()` reads.
    owner_id: str | None = None
    # Rooms are collaborative by default — public read & write. Set private to
    # lock a room down to its owner (and admins).
    read_visibility: str = "public"
    write_visibility: str = "public"
    # Attachments applied after the room is provisioned. Reference/package
    # access is checked against ``acting_user_id`` using the same predicates
    # the gateway uses; ``acting_user_id`` is required when any of these are
    # set. Linked rooms have no access check (matching the existing
    # attach_linked_room behaviour).
    reference_ids: list[str] | None = None
    package_ids: list[str] | None = None
    linked_rooms: list[LinkedRoomSpec] | None = None
    # Room-roles to define at creation (assumable instruction bundles).
    roles: list[RoleSpec] | None = None
    # Per-room agent aliases to seed at creation, keyed by agent name → alias.
    # `@<alias>` then addresses that agent in the room like its real name.
    aliases: dict[str, str] | None = None
    acting_user_id: str | None = None
    acting_is_admin: bool = False


class RoomCreateResult(BaseModel):
    """Result of create_room. ``failed_attachments`` collects post-creation
    attachment failures that did not abort room creation (validate-upfront
    catches predictable errors; this list captures races and other
    surprises). Each entry is ``{"kind": ..., "id": ..., "error": ...}``.
    """

    model_config = {"arbitrary_types_allowed": True}

    room: Room
    failed_attachments: list[dict[str, Any]] = []


class RoomService:
    def __init__(
        self,
        *,
        matrix_admin: MatrixAdmin,
        room_store: RoomStore,
        agent_store: AgentStore,
        client_lifecycle: ClientLifecycleService,
        collab_lifecycle: CollaborationBridgeLifecycleService,
        collab_bridge_store: CollaborationBridgeStore,
        resource_service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._matrix_admin = matrix_admin
        self._room_store = room_store
        self._agent_store = agent_store
        self._client_lifecycle = client_lifecycle
        self._collab_lifecycle = collab_lifecycle
        self._collab_bridge_store = collab_bridge_store
        self._resource_service = resource_service
        self._session_factory = session_factory

    async def _resolve_agent_ids(self, config: RoomCreateConfig) -> list[str]:
        if config.agent_ids is not None:
            agent_ids = list(config.agent_ids)
            expand_parent_ids = list(config.include_subagents_for or [])
        elif config.agent_names is not None:
            agent_ids = await self._resolve_names_to_ids(config.agent_names)
            expand_parent_ids = (
                await self._resolve_names_to_ids(config.include_subagents_for)
                if config.include_subagents_for
                else []
            )
        else:
            # Neither provided → an agentless room. Still valid: system clients
            # are added below.
            agent_ids = []
            expand_parent_ids = []
        if expand_parent_ids:
            agent_ids = await self._expand_with_children(agent_ids, expand_parent_ids)
        return agent_ids

    async def _resolve_join_event_listeners(self, config: RoomCreateConfig) -> set[str]:
        """Resolve `config.join_event_listeners` to a set of agent ids, in the
        same identifier space (ids or names) the agent selection used."""
        listeners = config.join_event_listeners
        if not listeners:
            return set()
        if config.agent_ids is not None:
            return set(listeners)
        return set(await self._resolve_names_to_ids(listeners))

    async def _expand_with_children(
        self, agent_ids: list[str], parent_ids: list[str]
    ) -> list[str]:
        """Append the subagents of `parent_ids` to `agent_ids`, de-duplicated.

        Order-preserving: the original ids come first, then any children not
        already present. One level deep — subagents cannot themselves have
        subagents.
        """
        async with self._session_factory() as session:
            children = await self._agent_store.get_children(session, parent_ids)
        result = list(agent_ids)
        seen = set(agent_ids)
        for child in children:
            if child.id not in seen:
                seen.add(child.id)
                result.append(child.id)
        return result

    async def _resolve_ids_to_names(self, agent_ids: list[str]) -> list[str]:
        async with self._session_factory() as session:
            names = []
            for agent_id in agent_ids:
                agent = await self._agent_store.get(session, agent_id)
                if agent is None:
                    raise ValueError(f"Unknown agent ID: {agent_id}")
                names.append(agent.name)
            return names

    def _validate_dm_room(self, config: RoomCreateConfig, agent_ids: list[str]) -> None:
        """A DM room (channel_type="direct", outbound-created) is strictly 1:1 —
        exactly one agent and exactly one user."""
        if len(agent_ids) != 1:
            raise ValueError(
                f"A DM room requires exactly one agent; got {len(agent_ids)}."
            )
        n_users = len(config.user_names or [])
        if n_users != 1:
            raise ValueError(f"A DM room requires exactly one user; got {n_users}.")

    async def _validate_attachments(self, config: RoomCreateConfig) -> None:
        """Resolve existence + access for refs/packages/linked-rooms before
        touching Matrix. Race-time failures during attach are caught later
        and surfaced via failed_attachments; this catches the common cases
        (bad ids, no access) cheaply.
        """
        has_attachments = bool(
            config.reference_ids or config.package_ids or config.linked_rooms
        )
        if not has_attachments:
            return
        if config.reference_ids or config.package_ids:
            if config.acting_user_id is None:
                raise ValueError(
                    "acting_user_id is required to attach references or packages"
                )
        async with self._session_factory() as session:
            principal = Principal(config.acting_user_id, config.acting_is_admin)
            for ref_id in config.reference_ids or []:
                ref = await self._resource_service._references.get(session, ref_id)
                if ref is None:
                    raise ValueError(f"Reference not found: {ref_id}")
                if not can(principal, "read", ref):
                    raise PermissionError(
                        f"User {config.acting_user_id} cannot attach reference {ref_id}"
                    )
            for pkg_id in config.package_ids or []:
                pkg = await self._resource_service._packages.get(session, pkg_id)
                if pkg is None:
                    raise ValueError(f"Package not found: {pkg_id}")
                if not can(principal, "read", pkg):
                    raise PermissionError(
                        f"User {config.acting_user_id} cannot attach package {pkg_id}"
                    )
            for link in config.linked_rooms or []:
                target = await self._room_store.get(session, link.target_room_id)
                if target is None:
                    raise ValueError(f"Linked room not found: {link.target_room_id}")
                if not link.label.strip():
                    raise ValueError("Linked room label must not be empty")

    async def _attach_after_creation(
        self, room_id: str, config: RoomCreateConfig
    ) -> list[dict[str, Any]]:
        """Attach references, packages, and linked rooms to a freshly
        created room. Returns a list of failures (empty on full success).
        """
        failures: list[dict[str, Any]] = []
        async with self._session_factory() as session:
            for ref_id in config.reference_ids or []:
                try:
                    await self._resource_service.attach_reference_to_room(
                        session,
                        room_id,
                        ref_id,
                        user_id=config.acting_user_id,  # type: ignore[arg-type]
                        is_admin=config.acting_is_admin,
                    )
                except Exception as e:
                    failures.append(
                        {"kind": "reference", "id": ref_id, "error": str(e)}
                    )
            for pkg_id in config.package_ids or []:
                try:
                    await self._resource_service.attach_package_to_room(
                        session,
                        room_id,
                        pkg_id,
                        user_id=config.acting_user_id,  # type: ignore[arg-type]
                        is_admin=config.acting_is_admin,
                    )
                except Exception as e:
                    failures.append({"kind": "package", "id": pkg_id, "error": str(e)})
            for link in config.linked_rooms or []:
                try:
                    await self._resource_service.attach_linked_room(
                        session,
                        source_room_id=room_id,
                        target_room_id=link.target_room_id,
                        label=link.label,
                    )
                except Exception as e:
                    failures.append(
                        {
                            "kind": "linked_room",
                            "id": link.target_room_id,
                            "error": str(e),
                        }
                    )
            await session.commit()
        return failures

    async def _resolve_bridge_id(self, config: RoomCreateConfig) -> str | None:
        """Pick the bridge for a new room: the one named, else the instance
        default, else none.

        A standalone Switch always ships a bridge (the bundled Mattermost), so
        defaulting to it means every room has somewhere humans can read it
        without the caller having to know the deployment's topology. Callers
        that genuinely want an agent-only room pass ``internal_only``.

        A default that is configured but not currently running is reported
        rather than skipped — silently creating an unbridged room would look
        identical to success and only surface much later as a room nobody can
        see.
        """
        if config.bridge_id:
            return config.bridge_id
        if config.internal_only:
            return None

        async with self._session_factory() as session:
            default = await self._collab_bridge_store.get_default(session)
        if default is None:
            return None

        if self._collab_lifecycle.get(default.id) is None:
            raise ValueError(
                f"Default bridge '{default.display_name}' ({default.id}) is not "
                "running, so the room cannot be bridged. Start the bridge, name "
                "a different bridge_id, or pass internal_only to create an "
                "agent-only room."
            )
        return default.id

    async def _require_channel_creation(self, bridge_id: str) -> None:
        """Refuse to make a channel on a connection an operator has withheld it
        from, before anything is provisioned.

        Only the operator's switch is checked here. A platform that cannot
        create channels at all is caught by its own adapter raising, which says
        so in the platform's terms — naming the bot, the link, the step to take
        — and that is a better error than anything this layer could compose.
        """
        async with self._session_factory() as session:
            bridge = await self._collab_bridge_store.get(session, bridge_id)
        if bridge is None or bridge.channel_creation_enabled:
            return
        raise ChannelCreationUnsupported(
            f"Creating channels is turned off for the '{bridge.display_name}' "
            "connection. Create the channel on the platform and add the Switch "
            "app to it — Switch adopts it as a room — or ask an administrator to "
            "allow channel creation for this connection."
        )

    @staticmethod
    async def _ensure_channel_capture(
        bridge_core: BridgeCore,
        external_channel_id: str,
        channel_type: ChannelType,
    ) -> None:
        """Establish server-side message capture for a channel bound to a room.

        Provisioning a channel subscribes to it on the way past, but binding one
        that already exists does not — and on a bridge whose capture is a
        per-channel subscription (Teams, via Graph) that leaves the room
        receiving only what @mentions the bot, until the bridge next restarts
        and its startup reconciliation notices. A no-op for adapters whose
        capture is a single bridge-wide stream, and idempotent for those where
        it is not.
        """
        await bridge_core.adapter.ensure_channel_subscriptions(
            [(external_channel_id, channel_type)]
        )

    async def create_room(self, config: RoomCreateConfig) -> RoomCreateResult:
        await self._validate_attachments(config)
        # Validate the group up front so a bad id fails before we provision a
        # Matrix room / external channel.
        if config.group_id is not None:
            async with self._session_factory() as session:
                if await session.get(RoomGroup, config.group_id) is None:
                    raise ValueError(f"Room group not found: {config.group_id}")
        agent_ids = await self._resolve_agent_ids(config)
        join_event_listeners = await self._resolve_join_event_listeners(config)
        channel_type = config.channel_type
        external_channel_id = config.external_channel_id
        bridge_id = await self._resolve_bridge_id(config)
        bridge_core = None
        if bridge_id:
            bridge_core = self._collab_lifecycle.get(bridge_id)
            if bridge_core is None:
                raise ValueError(f"Bridge not running: {bridge_id}")

        if bridge_core and external_channel_id is not None and channel_type is None:
            channel_type = await bridge_core.adapter.get_channel_type(
                external_channel_id
            )

        if channel_type is None:
            channel_type = "channel_public"

        is_dm = (
            channel_type == "direct"
            and bridge_core is not None
            and external_channel_id is None
        )
        if is_dm:
            self._validate_dm_room(config, agent_ids)

        if bridge_core and external_channel_id is None:
            await self._require_channel_creation(bridge_id)  # type: ignore[arg-type]
            if is_dm:
                user_name = (config.user_names or [])[0]
                agent_name = (await self._resolve_ids_to_names(agent_ids))[0]
                ext_id_map = await bridge_core.resolve_external_user_id_map([user_name])
                user_external_id = ext_id_map.get(user_name)
                if user_external_id is None:
                    raise ValueError(
                        f"Cannot create DM room: no user '{user_name}' is known on "
                        "this bridge. The user must have interacted with Switch on "
                        "the platform before a DM can be opened with them."
                    )
                external_channel_id = await bridge_core.adapter.create_dm_channel(
                    agent_name=agent_name,
                    user_name=user_name,
                    user_external_id=user_external_id,
                )
            else:
                external_channel_id = await bridge_core.adapter.create_channel(
                    config.name,
                    config.description,
                    channel_type=channel_type,
                )

        # Guard the channel from the moment it exists until the room↔channel
        # mapping is registered. Creating the channel makes the bot auto-join
        # it, which fires an inbound join; without this guard that join would
        # not see the not-yet-committed mapping and would auto-create a second
        # room for the same channel (CHOO-1660).
        if bridge_core and external_channel_id:
            bridge_core.begin_provisioning(external_channel_id)
        try:
            matrix_room_id = await self._matrix_admin.create_room(
                config.name, config.description
            )

            room = Room(
                matrix_room_id=matrix_room_id,
                name=config.name,
                description=config.description,
                channel_type=channel_type,
                bridge_id=bridge_id,
                external_channel_id=external_channel_id,
                admin_mode=config.admin_mode,
                instructions=config.instructions,
                protection_config=config.protection_config,
                observe_config=config.observe_config,
                created_by=config.created_by,
                owner_id=config.owner_id,
                read_visibility=config.read_visibility,
                write_visibility=config.write_visibility,
            )

            async with self._session_factory() as session:
                await self._room_store.create(session, room)
                if config.group_id is not None:
                    await self._room_store.set_group(session, room.id, config.group_id)
                if agent_ids:
                    await self._room_store.add_agents(
                        session,
                        room.id,
                        agent_ids,
                        join_event_listeners=join_event_listeners,
                    )
                for spec in config.roles or []:
                    session.add(
                        RoomRole(
                            room_id=room.id,
                            name=spec.name,
                            instructions=spec.instructions,
                            exclusive=spec.exclusive,
                        )
                    )
                if config.aliases:
                    await self._seed_aliases(session, room.id, agent_ids, config)
                await session.commit()

            if bridge_core and external_channel_id:
                bridge_core.add_room_mapping(
                    room.id, matrix_room_id, external_channel_id
                )
        finally:
            if bridge_core and external_channel_id:
                bridge_core.end_provisioning(external_channel_id)

        if bridge_core and external_channel_id:
            await self._ensure_channel_capture(
                bridge_core, external_channel_id, channel_type
            )

        # Invite the bridge client before the agent clients so it is joined (and
        # thus replicating) before any agent can post — otherwise messages sent
        # in the gap predate the bridge's join and are dropped by _should_ignore,
        # never reaching the external channel. Mirrors change_bridge's ordering.
        if bridge_core:
            await self._matrix_admin.invite_to_room(
                matrix_room_id, bridge_core._bridge_client_matrix_user_id
            )

        if (
            bridge_core
            and external_channel_id
            and channel_type not in ("direct", "group")
        ):
            agent_names = await self._resolve_ids_to_names(agent_ids)
            await bridge_core.adapter.add_agents_to_channel(
                external_channel_id, agent_names
            )
            if config.user_names:
                ext_ids = await bridge_core.resolve_external_user_ids(config.user_names)
                await bridge_core.adapter.add_users_to_channel(
                    external_channel_id, config.user_names, ext_ids
                )
                await bridge_core.ensure_users_in_room(
                    room.id, matrix_room_id, config.user_names
                )

        if bridge_core and external_channel_id and is_dm and config.user_names:
            await bridge_core.ensure_users_in_room(
                room.id, matrix_room_id, config.user_names
            )

        agent_clients = self._resolve_agent_clients(agent_ids)
        system_clients = self._resolve_system_clients()
        all_clients = {**agent_clients, **system_clients}

        await self._invite_clients(matrix_room_id, all_clients)

        async with self._session_factory() as session:
            for client_id in all_clients:
                await self._room_store.add_client(session, client_id, room.id)
            await session.commit()

        logger.info(
            "Created room %s (%s) with %d agents and %d system clients",
            config.name,
            matrix_room_id,
            len(agent_clients),
            len(system_clients),
        )

        failed_attachments = await self._attach_after_creation(room.id, config)
        if failed_attachments:
            logger.warning(
                "Room %s created with %d attachment failure(s): %s",
                room.id,
                len(failed_attachments),
                failed_attachments,
            )

        return RoomCreateResult(room=room, failed_attachments=failed_attachments)

    async def _seed_aliases(
        self,
        session: AsyncSession,
        room_id: str,
        agent_ids: list[str],
        config: RoomCreateConfig,
    ) -> None:
        """Validate and persist the config's per-room aliases at creation time."""
        agents = []
        for aid in agent_ids:
            agent = await self._agent_store.get(session, aid)
            if agent is not None:
                agents.append(agent)
        agent_names = [a.name for a in agents]
        role_names = [spec.name for spec in config.roles or []]
        validate_alias_map(
            config.aliases or {},
            agent_names=agent_names,
            role_names=role_names,
        )
        id_by_name = {a.name.lower(): a.id for a in agents}
        for agent_name, alias in (config.aliases or {}).items():
            await self._room_store.set_alias(
                session, room_id, id_by_name[agent_name.lower()], alias
            )

    async def delete_room(self, room_id: str) -> None:
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            bridge_id = room.bridge_id

            client_ids = await self._room_store.get_client_ids(session, room_id)

            for client_id in client_ids:
                client = self._client_lifecycle.get(client_id)
                if client:
                    await self._matrix_admin.kick_user(
                        room.matrix_room_id, client.matrix_user_id
                    )

            await self._matrix_admin.delete_room(room.matrix_room_id)

            await self._room_store.delete(session, room_id)
            await session.commit()

        if bridge_id:
            bridge_core = self._collab_lifecycle.get(bridge_id)
            if bridge_core:
                bridge_core.remove_room_mapping(room.id, room.matrix_room_id)

        logger.info("Deleted room %s", room_id)

    async def _resolve_names_to_ids(self, agent_names: list[str]) -> list[str]:
        async with self._session_factory() as session:
            agents = await self._agent_store.get_by_names(session, agent_names)
        name_to_id = {a.name: a.id for a in agents}
        missing = [n for n in agent_names if n not in name_to_id]
        if missing:
            raise ValueError(f"Unknown agents: {', '.join(missing)}")
        return [name_to_id[n] for n in agent_names]

    async def add_agents_to_room(
        self,
        room_id: str,
        agent_ids: list[str] | None = None,
        agent_names: list[str] | None = None,
        include_subagents_for: list[str] | None = None,
        join_event_listeners: list[str] | None = None,
    ) -> None:
        by_name = agent_ids is None and agent_names is not None
        if by_name:
            assert agent_names is not None
            agent_ids = await self._resolve_names_to_ids(agent_names)
        if agent_ids is None:
            raise ValueError("Either agent_ids or agent_names must be provided")
        if include_subagents_for:
            agent_ids = await self._expand_with_children(
                agent_ids, include_subagents_for
            )
        listeners: set[str] = set()
        if join_event_listeners:
            listeners = (
                set(await self._resolve_names_to_ids(join_event_listeners))
                if by_name
                else set(join_event_listeners)
            )
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            existing = await self._room_store.get_agent_ids(session, room.id)
            new_agent_ids = [aid for aid in agent_ids if aid not in existing]
            if not new_agent_ids:
                logger.debug(
                    "All agents are already part of the room, existing %s, new agent ids %s, agent ids %s",
                    existing,
                    new_agent_ids,
                    agent_ids,
                )
                return

            agent_clients = self._resolve_agent_clients(new_agent_ids)

            await self._invite_clients(room.matrix_room_id, agent_clients)

            await self._room_store.add_agents(
                session,
                room.id,
                new_agent_ids,
                join_event_listeners={aid for aid in new_agent_ids if aid in listeners},
            )
            for client_id in agent_clients:
                await self._room_store.add_client(session, client_id, room.id)

            await session.commit()

        if room.bridge_id and room.external_channel_id:
            bridge_core = self._collab_lifecycle.get(room.bridge_id)
            if bridge_core:
                agent_names_resolved = await self._resolve_ids_to_names(new_agent_ids)
                await bridge_core.adapter.add_agents_to_channel(
                    room.external_channel_id, agent_names_resolved
                )

        logger.info("Added %d agents to room %s", len(agent_ids), room_id)

    async def remove_agents_from_room(self, room_id: str, agent_ids: list[str]) -> None:
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            agent_clients = self._resolve_agent_clients(agent_ids)

            for client_id, matrix_user_id in agent_clients.items():
                await self._matrix_admin.kick_user(room.matrix_room_id, matrix_user_id)
                await self._room_store.remove_client(session, client_id, room_id)

            await self._room_store.remove_agents(session, room_id, agent_ids)
            await session.commit()

        logger.info("Removed %d agents from room %s", len(agent_ids), room_id)

    async def update_room(
        self,
        room_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        admin_mode: bool | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> None:
        async with self._session_factory() as session:
            if read_visibility is not None or write_visibility is not None:
                room = await self._room_store.get(session, room_id)
                if room is None:
                    raise ValueError(f"Room not found: {room_id}")
                validate_visibility_pair(
                    read_visibility
                    if read_visibility is not None
                    else room.read_visibility,
                    write_visibility
                    if write_visibility is not None
                    else room.write_visibility,
                )
            await self._room_store.update_fields(
                session,
                room_id,
                name=name,
                description=description,
                instructions=instructions,
                admin_mode=admin_mode,
                read_visibility=read_visibility,
                write_visibility=write_visibility,
            )
            await session.commit()

    async def set_join_event_listeners(
        self, room_id: str, settings: dict[str, bool]
    ) -> None:
        """Set, per agent id, whether it receives `room_join` events in the
        room. `settings` maps agent id → on/off. Raises ValueError if the room
        does not exist or an agent is not a member of it."""
        if not settings:
            return
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")
            for agent_id, value in settings.items():
                await self._room_store.set_receives_join_events(
                    session, room_id, agent_id, value
                )
            await session.commit()

    async def update_protection_config(
        self, room_id: str, config: dict[str, object]
    ) -> None:
        async with self._session_factory() as session:
            await self._room_store.update_protection_config(session, room_id, config)
            await session.commit()

    async def update_observe_config(
        self, room_id: str, config: dict[str, object]
    ) -> None:
        async with self._session_factory() as session:
            await self._room_store.update_observe_config(session, room_id, config)
            await session.commit()

    async def set_room_archived(self, room_id: str, archived: bool) -> None:
        """Archive or unarchive a room (metadata-only, reversible).

        Raises ValueError if the room does not exist.
        """
        async with self._session_factory() as session:
            await self._room_store.set_archived(session, room_id, archived)
            await session.commit()

    async def add_users_to_room(self, room_id: str, user_names: list[str]) -> list[str]:
        """Add users to a bridged room; returns the names that could not be
        resolved on the room's bridge (added users are omitted from the
        result). A name is unresolvable when the bridge has no external user
        for it — e.g. the person has not yet signed into that workspace."""
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")
        if not room.bridge_id or not room.external_channel_id:
            raise ValueError(f"Room {room_id} is not bridged")
        bridge_core = self._collab_lifecycle.get(room.bridge_id)
        if bridge_core is None:
            raise ValueError(f"Bridge not running: {room.bridge_id}")
        resolved = await bridge_core.resolve_external_user_id_map(user_names)
        unresolved = [name for name in user_names if name not in resolved]
        resolved_names = list(resolved.keys())
        await bridge_core.adapter.add_users_to_channel(
            room.external_channel_id, resolved_names, list(resolved.values())
        )
        await bridge_core.ensure_users_in_room(
            room.id, room.matrix_room_id, resolved_names
        )
        logger.info("Added %d users to room %s", len(resolved_names), room_id)
        if unresolved:
            logger.warning(
                "Could not resolve %d user(s) on bridge %s for room %s: %s",
                len(unresolved),
                room.bridge_id,
                room_id,
                unresolved,
            )
        return unresolved

    async def link_bridge_to_room(
        self,
        room_id: str,
        bridge_id: str,
        channel_type: ChannelType,
        external_channel_id: str | None = None,
    ) -> None:
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

        bridge_core = self._collab_lifecycle.get(bridge_id)

        if external_channel_id is None and bridge_core is not None:
            await self._require_channel_creation(bridge_id)
            external_channel_id = await bridge_core.adapter.create_channel(
                room.name, room.description
            )

        async with self._session_factory() as session:
            await self._room_store.update_bridge(
                session,
                room_id,
                bridge_id=bridge_id,
                channel_type=channel_type,
                external_channel_id=external_channel_id,
            )
            await session.commit()

        if bridge_core and external_channel_id:
            bridge_core.add_room_mapping(
                room.id, room.matrix_room_id, external_channel_id
            )
            await self._ensure_channel_capture(
                bridge_core, external_channel_id, channel_type
            )

        logger.info("Linked bridge %s to room %s", bridge_id, room_id)

    async def unlink_bridge_from_room(self, room_id: str) -> None:
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            bridge_id = room.bridge_id

            await self._room_store.clear_bridge(session, room_id)
            await session.commit()

        if bridge_id:
            bridge_core = self._collab_lifecycle.get(bridge_id)
            if bridge_core:
                bridge_core.remove_room_mapping(room.id, room.matrix_room_id)

        logger.info("Unlinked bridge from room %s", room_id)

    async def change_bridge(
        self,
        room_id: str,
        *,
        bridge_id: str,
        channel_type: ChannelType | None = None,
        external_channel_id: str | None = None,
    ) -> None:
        """Move a room onto a different collaboration bridge.

        Provisions a fresh external channel on the target bridge and re-adds
        the room's current agents to it, then joins the target bridge's Matrix
        client so events route to the new channel.

        Pass ``external_channel_id`` to bind to an **existing** channel on the
        target bridge instead of provisioning a new one — e.g. to move a room
        back onto a channel it previously used (channels are left in place on
        bridge change, so the old one still exists). The caller is responsible
        for the id being a real channel on that bridge whose bridge bot is a
        member; agents are still (re-)added to it.

        Human users are **not** carried over. A user's identity is
        bridge-specific (a Mattermost account is not the same as a Slack
        account), so there is no reliable cross-bridge mapping — they must be
        re-invited to the new channel manually. A warning is logged saying so.

        The old bridge is then detached: its in-memory room mapping is removed
        (so it stops syncing) and its Matrix client is kicked from the room.
        The old external channel itself is **left in place** on its platform —
        the adapter has no teardown primitive — so it lingers as an orphan that
        is no longer synced. A warning is logged disclosing this; archive or
        delete it manually on the old platform if you care.

        Also serves to bridge a previously internal-only room (``bridge_id``
        was None): the teardown step is simply skipped.
        """
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")
            agent_ids = await self._room_store.get_agent_ids(session, room_id)

        old_bridge_id = room.bridge_id
        old_external_channel_id = room.external_channel_id
        matrix_room_id = room.matrix_room_id

        if old_bridge_id == bridge_id:
            raise ValueError(f"Room {room_id} is already bound to bridge {bridge_id}")

        new_bridge = self._collab_lifecycle.get(bridge_id)
        if new_bridge is None:
            raise ValueError(f"Bridge not running: {bridge_id}")

        # Keep the room's existing privacy when not told otherwise; fall back to
        # a public channel for a room that had no bridge.
        resolved_channel_type: ChannelType = (
            channel_type or room.channel_type or "channel_public"  # type: ignore[assignment]
        )

        if external_channel_id is None:
            await self._require_channel_creation(bridge_id)
            external_channel_id = await new_bridge.adapter.create_channel(
                room.name,
                room.description,
                channel_type=resolved_channel_type,
            )

        # Guard the new channel until its mapping is registered, so the bot's
        # auto-join does not spawn a duplicate room (CHOO-1660).
        new_bridge.begin_provisioning(external_channel_id)
        try:
            async with self._session_factory() as session:
                await self._room_store.update_bridge(
                    session,
                    room_id,
                    bridge_id=bridge_id,
                    channel_type=resolved_channel_type,
                    external_channel_id=external_channel_id,
                )
                await session.commit()

            new_bridge.add_room_mapping(room_id, matrix_room_id, external_channel_id)
        finally:
            new_bridge.end_provisioning(external_channel_id)

        await self._ensure_channel_capture(
            new_bridge, external_channel_id, resolved_channel_type
        )
        await self._matrix_admin.invite_to_room(
            matrix_room_id, new_bridge._bridge_client_matrix_user_id
        )

        if resolved_channel_type not in ("direct", "group"):
            agent_names = await self._resolve_ids_to_names(agent_ids)
            await new_bridge.adapter.add_agents_to_channel(
                external_channel_id, agent_names
            )
            logger.warning(
                "Room %s moved to bridge %s: re-added %d agent(s) to channel "
                "%s, but human users were NOT carried over (identities are "
                "bridge-specific) — re-invite them to the new channel manually.",
                room_id,
                bridge_id,
                len(agent_names),
                external_channel_id,
            )

        if old_bridge_id:
            old_bridge = self._collab_lifecycle.get(old_bridge_id)
            if old_bridge is not None:
                old_bridge.remove_room_mapping(room_id, matrix_room_id)
                await self._matrix_admin.kick_user(
                    matrix_room_id, old_bridge._bridge_client_matrix_user_id
                )
            logger.warning(
                "Room %s moved from bridge %s to %s; old external channel %s "
                "left in place on its platform (no adapter teardown) and is no "
                "longer synced — archive or delete it manually if desired.",
                room_id,
                old_bridge_id,
                bridge_id,
                old_external_channel_id,
            )

        logger.info(
            "Changed bridge for room %s: %s -> %s (new channel %s)",
            room_id,
            old_bridge_id,
            bridge_id,
            external_channel_id,
        )

    def _resolve_agent_clients(self, agent_ids: list[str]) -> dict[str, str]:
        """Returns {client_id: matrix_user_id} for the given agent IDs."""
        result: dict[str, str] = {}
        for agent_id in agent_ids:
            client = self._client_lifecycle.get_by_agent_id(agent_id)
            if client is None:
                raise ValueError(f"No running client for agent: {agent_id}")
            result[client.client_id] = client.matrix_user_id
        return result

    def _resolve_system_clients(self) -> dict[str, str]:
        """Returns {client_id: matrix_user_id} for all system clients."""
        result: dict[str, str] = {}
        for client_type in SYSTEM_CLIENT_TYPES:
            for client in self._client_lifecycle.get_by_type(client_type):
                result[client.client_id] = client.matrix_user_id
        return result

    async def _invite_clients(
        self, matrix_room_id: str, client_ids: dict[str, str]
    ) -> None:
        """Invites all clients to the Matrix room; each client auto-accepts."""
        for matrix_user_id in client_ids.values():
            await self._matrix_admin.invite_to_room(matrix_room_id, matrix_user_id)

    async def reconcile_system_clients(self) -> None:
        """Ensure every running system client is a member of every room.

        Rooms created before a system-client type existed (e.g. the admin
        client) have no membership for it. Run once at startup, after the
        clients are running so they auto-accept the invites. Idempotent:
        `invite_to_room` is a no-op for an already-joined user, and DB
        membership is only recorded where it is missing.
        """
        system_clients = self._resolve_system_clients()
        if not system_clients:
            return
        async with self._session_factory() as session:
            rooms = await self._room_store.get_all(session, include_archived=True)
        for room in rooms:
            async with self._session_factory() as session:
                existing = set(await self._room_store.get_client_ids(session, room.id))
            missing = {
                cid: uid for cid, uid in system_clients.items() if cid not in existing
            }
            if not missing:
                continue
            await self._invite_clients(room.matrix_room_id, missing)
            async with self._session_factory() as session:
                for client_id in missing:
                    await self._room_store.add_client(session, client_id, room.id)
                await session.commit()
            logger.info(
                "Reconciled %d system client(s) into room %s", len(missing), room.id
            )

    async def ensure_client_in_room(self, room_id: str, client_id: str) -> None:
        """Invite a single running client to the room (it auto-joins) and record
        its membership. Idempotent — safe to call repeatedly, e.g. on every
        bridged message from an external user's puppet."""
        async with self._session_factory() as session:
            room = await self._room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")
            already_member = client_id in await self._room_store.get_client_ids(
                session, room_id
            )

        client = self._client_lifecycle.get(client_id)
        if client is None:
            raise ValueError(f"No running client: {client_id}")

        await self._matrix_admin.invite_to_room(
            room.matrix_room_id, client.matrix_user_id
        )

        if not already_member:
            async with self._session_factory() as session:
                await self._room_store.add_client(session, client_id, room_id)
                await session.commit()

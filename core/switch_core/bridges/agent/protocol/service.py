from __future__ import annotations

import hashlib
import logging
import re
import secrets
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from nio import (
    DownloadError,
    RoomContextError,
    RoomGetEventError,
    RoomMemberEvent,
    RoomMessageMedia,
    RoomMessagesError,
)
from sqlalchemy import func, select

from switch_core.addressing import (
    AddressingPolicy,
    can_address,
    owner_only_policy,
    parse_policy,
)
from switch_core.agent_display_name import normalise_display_name
from switch_core.agent_icon import normalise_icon_url, validate_icon_url
from switch_core.aliases import check_alias_collisions, validate_alias_format
from switch_core.authz import Action, Principal, require, require_manage
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.protocol.agent_detail import (
    apply_agent_options,
    assemble_agent_detail,
    list_agent_summaries,
    reparent_agent,
)
from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AgentStatus,
    DelegateTaskResult,
    IntegrationProfile,
    LlmCallReport,
    ModelSpec,
    ParticipantDescriptor,
    RegistrationResult,
    RoomDescriptor,
    RoomDetailDescriptor,
    SendTargetedResult,
    ToolCallReport,
    ToolSpec,
)
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.resource.service import ResourceService
from switch_core.bridges.resource.tracker import ResourceRequestTracker
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    Model,
    Reference,
    RoleLease,
    Room,
    RoomGroup,
    RoomRole,
    Task,
    Tool,
    User,
)
from switch_core.db.stores.agent_runtime_state_store import (
    IDLE as RUNTIME_STATE_IDLE,
)
from switch_core.db.stores.agent_runtime_state_store import (
    AgentRuntimeStateStore,
)
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.user_store import UserStore
from switch_core.deeplinks import deeplink_for_platform
from switch_core.events import (
    LlmCallReport as MatrixLlmCallReport,
)
from switch_core.events import (
    ToolCallReport as MatrixToolCallReport,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )
    from switch_core.clients.client_base import ClientBase
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.config import SwitchConfig
    from switch_core.db.stores.agent_session_store import AgentSessionStore
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.api_key_store import ApiKeyStore
    from switch_core.db.stores.collaboration_bridge_store import (
        CollaborationBridgeStore,
    )
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.task_store import TaskStore
    from switch_core.gateway.schemas import AgentDetail
    from switch_core.room_service import RoomCreateResult, RoomService

logger = logging.getLogger(__name__)

# \A and \Z rather than ^ and $: Python's $ also matches before a single
# trailing newline, which would let an identifier carry a line break.
_VALID_NAME_RE = re.compile(r"\A[a-z0-9][a-z0-9._-]*\Z")

# History pagination. The homeserver caps a /messages page regardless of what
# we ask for, and state events consume it without ever reaching the caller, so
# one page is never a reliable window. The page cap bounds a single read_context
# call; hitting it is reported as `truncated` rather than passed off as the
# whole story.
HISTORY_PAGE_SIZE = 100
HISTORY_MAX_PAGES = 20
# Pages spent walking back to a `before` window, budgeted separately from the
# pages spent reading inside it. Only used when the homeserver cannot answer
# timestamp_to_event; a scan is the slow path, so it gets room to succeed.
HISTORY_MAX_SEEK_PAGES = 100


class AgentExistsError(Exception):
    """Raised when registering an agent whose name is already taken and the
    caller did not opt into re-registration via ``overwrite=True``."""


def _describe_room(room: Room) -> RoomDescriptor:
    return RoomDescriptor(
        id=room.id,
        name=room.name,
        description=room.description,
        matrix_room_id=room.matrix_room_id,
        archived=room.archived_at is not None,
        bridge_id=room.bridge_id,
    )


class ProtocolService:
    def __init__(
        self,
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
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
    ) -> None:
        self.agent_store = agent_store
        self.agent_session_store = agent_session_store
        self.agent_runtime_state_store = AgentRuntimeStateStore()
        self.room_role_store = RoomRoleStore()
        self.room_group_store = RoomGroupStore()
        self.user_store = UserStore()
        self.room_store = room_store
        self.room_service = room_service
        self.client_lifecycle = client_lifecycle
        self.collab_lifecycle = collab_lifecycle
        self.event_buffer = event_buffer
        # Injected, not constructed: more than one ProtocolService exists in a
        # running server, and a connection registered through one must be
        # visible to all of them. Owning a registry here would split the live
        # connection set in two.
        self.connections = connections
        self.task_store = task_store
        self.request_tracker = request_tracker
        self.resource_request_tracker = resource_request_tracker
        self.resource_service = resource_service
        self.api_key_store = api_key_store
        # Shared with the bearer-auth middleware for the same reason as
        # `connections`: a key this service rotates must stop authenticating
        # requests on every door at once.
        self.api_key_cache = api_key_cache
        self.external_user_store = external_user_store
        self.bridge_store = bridge_store
        self.session_factory = session_factory
        self.config = config

    # ── Registration ──────────────────────────────────────────────────────────

    async def register_agent(
        self,
        *,
        name: str,
        description: str,
        icon_url: str | None = None,
        display_name: str | None = None,
        connector_type: str,
        integration_profile: IntegrationProfile,
        tools: list[ToolSpec] | None = None,
        models: list[ModelSpec] | None = None,
        metadata: dict[str, Any] | None = None,
        owner_id: str,
        parent_agent_id: str | None = None,
        oauth_client_id: str | None = None,
        overwrite: bool = False,
        addressable_by_agent_ids: list[str] | None = None,
        owner_only: bool = True,
    ) -> RegistrationResult:
        """Register or re-register an agent.

        Pass ``owner_id`` directly (gateway flow) or use
        ``register_agent_with_token`` to resolve a registration token first.

        ``parent_agent_id`` links this agent as a child of another (a Claude
        Code subagent registered under the user's main agent); None for an
        ordinary top-level agent.

        New agents start **owner-only** (CHOO-2137): only the owner may address
        them, from any room, and no other agent may unless named in
        ``addressable_by_agent_ids`` — which is how a dispatcher (a manager or
        orchestrator agent) is let in. Pass ``owner_only=False`` to create an
        agent anyone may address, the pre-CHOO-2137 default. Re-registration
        leaves an existing agent's policy alone either way.

        If an agent with this name already exists, the call fails with
        ``AgentExistsError`` unless ``overwrite=True`` is passed. Re-registering
        rotates the API key and replaces the integration profile, so callers
        must explicitly opt in.

        ``icon_url`` is the agent's icon as an absolute https URL, or None for
        no icon. On re-registration None leaves any existing icon alone rather
        than clearing it, so re-registering an agent does not silently discard
        a picture the owner chose.

        ``display_name`` is the human-readable label shown beside the machine
        identifier ``name``, or None for none. It behaves like ``icon_url`` on
        re-registration: None keeps whatever the agent already has.

        Raises:
            ValueError: name is invalid (lowercase alphanumeric, dots, hyphens,
                or underscores — no spaces).
            InvalidIconUrl: ``icon_url`` is malformed or points somewhere unsafe.
            InvalidDisplayName: ``display_name`` is over-long or unsafe to render.
            AgentExistsError: agent with this name exists and ``overwrite`` is
                False, or the existing agent is owned by another user (the name
                is global, but re-registration stays within the owner's tenant).
        """
        if not _VALID_NAME_RE.match(name):
            raise ValueError(
                f"Invalid agent name: {name!r}. "
                "Use only lowercase letters, digits, dots, hyphens, and underscores."
            )

        validated_icon_url = normalise_icon_url(icon_url)
        validated_display_name = normalise_display_name(display_name)

        tool_specs = tools or []
        model_specs = models or []
        profile_data = integration_profile.model_dump()
        agent_type = integration_profile.connection_model

        api_key = secrets.token_urlsafe(32)
        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        encrypted_key = encrypt_token(api_key, self.config.jwt_secret_key)

        async with self.session_factory() as session:
            existing = await self.agent_store.get_by_name(session, name)
            if existing and not overwrite:
                raise AgentExistsError(
                    f"Agent already exists: {name!r}. "
                    "Pass overwrite=True to re-register (rotates API key, "
                    "replaces integration profile)."
                )
            if existing and existing.owner_id != owner_id:
                # Agent names are a global namespace, but re-registration must
                # stay inside the caller's own tenant. Overwriting an agent
                # owned by someone else would mint the caller a live API key for
                # that agent (whose owner_id is left unchanged) and delete the
                # real owner's key, i.e. a cross-tenant takeover. Report it as a
                # plain name clash so ownership is never disclosed.
                raise AgentExistsError(
                    f"Agent already exists: {name!r}. "
                    "Pass overwrite=True to re-register (rotates API key, "
                    "replaces integration profile)."
                )
            if existing:
                agent_id = await self._reregister_agent(
                    session=session,
                    existing=existing,
                    api_key_hash=api_key_hash,
                    encrypted_key=encrypted_key,
                    description=description,
                    icon_url=validated_icon_url,
                    display_name=validated_display_name,
                    agent_type=agent_type,
                    connector_type=connector_type,
                    integration_profile=profile_data,
                    metadata=metadata,
                    oauth_client_id=oauth_client_id,
                    owner_id=owner_id,
                    parent_agent_id=parent_agent_id,
                    tools=tool_specs,
                    models=model_specs,
                )
                logger.info("Re-registered agent: %s (%s)", name, agent_id)
            else:
                agent_id = await self._create_agent(
                    session=session,
                    name=name,
                    description=description,
                    icon_url=validated_icon_url,
                    display_name=validated_display_name,
                    agent_type=agent_type,
                    connector_type=connector_type,
                    integration_profile=profile_data,
                    metadata=metadata,
                    oauth_client_id=oauth_client_id,
                    owner_id=owner_id,
                    parent_agent_id=parent_agent_id,
                    api_key_hash=api_key_hash,
                    encrypted_key=encrypted_key,
                    tools=tool_specs,
                    models=model_specs,
                    addressing_policy=(
                        owner_only_policy(addressable_by_agent_ids or [])
                        if owner_only
                        else None
                    ),
                )
                logger.info("Registered agent: %s (%s)", name, agent_id)

        await self._create_bridge_identities(name, description)

        return RegistrationResult(
            agent_id=agent_id,
            api_key=api_key,
            oauth_client_id=oauth_client_id,
        )

    async def register_agent_with_token(
        self,
        *,
        registration_token: str,
        name: str,
        description: str,
        display_name: str | None = None,
        connector_type: str,
        integration_profile: IntegrationProfile,
        tools: list[ToolSpec] | None = None,
        models: list[ModelSpec] | None = None,
        metadata: dict[str, Any] | None = None,
        overwrite: bool = False,
        addressable_by_agent_ids: list[str] | None = None,
        owner_only: bool = True,
    ) -> RegistrationResult:
        """Resolve a registration token to its owner, then register the agent.

        Raises PermissionError if the token does not match a stored ApiKey.
        Raises AgentExistsError if the name is taken and ``overwrite`` is False.
        """
        token_hash = hashlib.sha256(registration_token.encode()).hexdigest()
        async with self.session_factory() as session:
            key = await self.api_key_store.get_by_hash(session, token_hash)
        if key is None:
            raise PermissionError("Invalid registration token")

        return await self.register_agent(
            name=name,
            description=description,
            display_name=display_name,
            connector_type=connector_type,
            integration_profile=integration_profile,
            tools=tools,
            models=models,
            metadata=metadata,
            owner_id=key.user_id,
            overwrite=overwrite,
            addressable_by_agent_ids=addressable_by_agent_ids,
            owner_only=owner_only,
        )

    async def _create_agent(
        self,
        *,
        session: AsyncSession,
        name: str,
        description: str,
        icon_url: str | None,
        display_name: str | None,
        agent_type: str,
        connector_type: str,
        integration_profile: dict[str, Any],
        metadata: dict[str, Any] | None,
        oauth_client_id: str | None,
        owner_id: str,
        parent_agent_id: str | None,
        api_key_hash: str,
        encrypted_key: str,
        tools: list[ToolSpec],
        models: list[ModelSpec],
        addressing_policy: AddressingPolicy | None,
    ) -> str:
        api_key_record = ApiKey(
            type="agent",
            key_hash=api_key_hash,
            encrypted_key=encrypted_key,
            label=name,
            user_id=owner_id,
        )
        await self.api_key_store.create(session, api_key_record)

        # The Matrix client's display name is the agent's identifier, never its
        # human display name: it is stamped on every event as `sender_name`, and
        # the collaboration bridges match on it to recognise an agent's own echo
        # coming back from a platform. A human name here would make an agent
        # re-import its own messages as a stranger.
        client_record = await self.client_lifecycle.create_client(
            client_type="agent",
            display_name=name,
        )

        agent = Agent(
            name=name,
            description=description,
            icon_url=icon_url,
            display_name=display_name,
            agent_type=agent_type,
            connector_type=connector_type,
            integration_profile=integration_profile,
            client_id=client_record.id,
            api_key_id=api_key_record.id,
            owner_id=owner_id,
            parent_agent_id=parent_agent_id,
            oauth_client_id=oauth_client_id,
            metadata_=metadata,
            addressing_policy=(
                addressing_policy.model_dump()
                if addressing_policy is not None
                else None
            ),
        )
        await self.agent_store.create(session, agent)

        for tool_spec in tools:
            await self.agent_store.add_tool(
                session,
                Tool(
                    name=tool_spec.name,
                    description=tool_spec.description,
                    agent_id=agent.id,
                    args_schema=tool_spec.parameters,
                ),
            )
        for model_spec in models:
            await self.agent_store.add_model(
                session,
                Model(
                    name=model_spec.name,
                    description=model_spec.description,
                    agent_id=agent.id,
                ),
            )

        await session.commit()
        self.client_lifecycle.start_client(client_record)
        return agent.id

    async def _reregister_agent(
        self,
        *,
        session: AsyncSession,
        existing: Agent,
        api_key_hash: str,
        encrypted_key: str,
        description: str,
        icon_url: str | None,
        display_name: str | None,
        agent_type: str,
        connector_type: str,
        integration_profile: dict[str, Any],
        metadata: dict[str, Any] | None,
        oauth_client_id: str | None,
        owner_id: str,
        parent_agent_id: str | None,
        tools: list[ToolSpec],
        models: list[ModelSpec],
    ) -> str:
        new_api_key_record = ApiKey(
            type="agent",
            key_hash=api_key_hash,
            encrypted_key=encrypted_key,
            label=existing.name,
            user_id=owner_id or existing.owner_id or "",
        )
        await self.api_key_store.create(session, new_api_key_record)

        old_api_key_id = existing.api_key_id
        # An omitted icon keeps whatever the agent already has: re-registration
        # rotates credentials and rebuilds the profile, and callers that know
        # nothing about icons must not wipe one the owner chose.
        icon_fields = {} if icon_url is None else {"icon_url": icon_url}
        # Same for the display name: a connector re-registers on every startup
        # and knows nothing about it.
        display_name_fields = (
            {} if display_name is None else {"display_name": display_name}
        )
        await self.agent_store.update(
            session,
            existing.id,
            api_key_id=new_api_key_record.id,
            description=description,
            agent_type=agent_type,
            connector_type=connector_type,
            integration_profile=integration_profile,
            metadata_=metadata,
            oauth_client_id=oauth_client_id,
            parent_agent_id=parent_agent_id,
            **icon_fields,
            **display_name_fields,
        )
        await self.api_key_store.delete(session, old_api_key_id)

        for tool in await self.agent_store.get_tools(session, existing.id):
            await self.agent_store.remove_tool(session, tool.id)
        for tool_spec in tools:
            await self.agent_store.add_tool(
                session,
                Tool(
                    name=tool_spec.name,
                    description=tool_spec.description,
                    agent_id=existing.id,
                    args_schema=tool_spec.parameters,
                ),
            )

        for model in await self.agent_store.get_models(session, existing.id):
            await self.agent_store.remove_model(session, model.id)
        for model_spec in models:
            await self.agent_store.add_model(
                session,
                Model(
                    name=model_spec.name,
                    description=model_spec.description,
                    agent_id=existing.id,
                ),
            )

        await session.commit()
        self.api_key_cache.invalidate_agent(existing.id)
        return existing.id

    async def _create_bridge_identities(
        self, agent_name: str, description: str
    ) -> None:
        for bridge_core in self.collab_lifecycle.all_bridges():
            try:
                await bridge_core.adapter.create_agent_identity(agent_name, description)
            except Exception:
                logger.warning(
                    "Failed to create bridge identity for %s",
                    agent_name,
                    exc_info=True,
                )

    async def record_client_declaration(
        self, agent_id: str, connection_id: str, declaration: ClientDeclaration
    ) -> None:
        """Persist what a client last said about itself (CHOO-1865).

        Connections live in memory, so what is running right now dies with the
        process. This is the durable half, and the reason it belongs in Part 1
        at all: raising an `accepts` floor is a decision made offline, and it
        can only be made safely against a record of what is actually deployed.
        Without it the question "what would this break?" has no answer but a
        guess.

        One record per agent, last write wins, stamped with the connection it
        came from. The connection id is what makes it interpretable: an agent
        may hold many connections at once, so without it a second connection
        declaring less looks like the first client having forgotten what it is,
        rather than a different client answering.

        A failure here is logged and swallowed: this is bookkeeping about a
        connection, and losing a version record must never stop an agent
        connecting. It is logged at warning because a persistently silent
        recorder would leave the same blind spot as a client that never
        declared, and that must not pass unnoticed.
        """
        if not declaration.declares_protocol and declaration.version is None:
            return

        record = declaration.as_dict()
        record["connection_id"] = connection_id
        record["recorded_at"] = datetime.now(UTC).isoformat()
        try:
            async with self.session_factory() as session:
                agent = await self.agent_store.get(session, agent_id)
                if agent is None:
                    return
                metadata = (
                    dict(agent.metadata_) if isinstance(agent.metadata_, dict) else {}
                )
                metadata["client_declaration"] = record
                await self.agent_store.update(session, agent_id, metadata_=metadata)
                await session.commit()
        except Exception:
            logger.warning(
                "Could not record the client declaration for agent %s; it will "
                "read as unknown until the next connect",
                agent_id,
                exc_info=True,
            )

    async def update_agent(
        self,
        agent_id: str,
        description: str | None = None,
        integration_profile: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Update agent fields."""
        async with self.session_factory() as session:
            updates: dict[str, object] = {}
            if description is not None:
                updates["description"] = description
            if integration_profile is not None:
                updates["integration_profile"] = integration_profile
            if metadata is not None:
                updates["metadata_"] = metadata

            if updates:
                await self.agent_store.update(session, agent_id, **updates)
                await session.commit()

    async def set_agent_icon(self, agent_id: str, icon_url: str | None) -> None:
        """Set, change, or clear an agent's icon.

        A URL replaces whatever the agent has; ``None`` clears it, leaving the
        agent with no icon so callers fall back to their own default. This is
        deliberately a separate operation from ``update_agent`` rather than
        another optional field on it: there, ``None`` means "leave alone", and
        an icon needs "remove it" to be sayable.

        Raises:
            InvalidIconUrl: the URL is malformed or points somewhere unsafe.
            ValueError: no agent with this id exists.
        """
        validated = validate_icon_url(icon_url) if icon_url is not None else None

        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, agent_id)
            if agent is None:
                raise ValueError(f"No such agent: {agent_id}")
            await self.agent_store.update(session, agent_id, icon_url=validated)
            await session.commit()

    async def _remove_bridge_identities(self, agent_name: str) -> None:
        for bridge_core in self.collab_lifecycle.all_bridges():
            try:
                await bridge_core.adapter.remove_agent_identity(agent_name)
            except Exception:
                logger.warning(
                    "Failed to remove bridge identity for %s",
                    agent_name,
                    exc_info=True,
                )

    async def delete_agent(
        self,
        *,
        agent_id: str | None = None,
        agent_name: str | None = None,
    ) -> None:
        """Delete an agent and clean up all associated state.

        Provide exactly one of ``agent_id`` or ``agent_name``.
        """
        if (agent_id is None) == (agent_name is None):
            raise ValueError(
                "delete_agent requires exactly one of agent_id or agent_name"
            )

        async with self.session_factory() as session:
            if agent_id is not None:
                agent = await self.agent_store.get(session, agent_id)
            else:
                assert agent_name is not None
                agent = await self.agent_store.get_by_name(session, agent_name)
        if agent is None:
            ident = agent_id if agent_id is not None else agent_name
            raise ValueError(f"Agent not found: {ident}")

        client_id = agent.client_id
        resolved_id = agent.id
        resolved_name = agent.name
        await self.client_lifecycle.stop(client_id)
        self.event_buffer.remove(resolved_id)

        await self._remove_bridge_identities(resolved_name)

        async with self.session_factory() as session:
            await self.agent_store.delete(session, resolved_id)
            await session.commit()
        self.api_key_cache.invalidate_agent(resolved_id)

        await self.client_lifecycle.remove(client_id)

    # ── Rooms ──────────────────────────────────────────────────────────────────

    async def get_room(self, room_id: str) -> RoomDescriptor:
        """Get room info. Raises ValueError if not found."""
        async with self.session_factory() as session:
            room = await self.room_store.get(session, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        return _describe_room(room)

    async def require_room_member(self, agent_id: str, room_id: str) -> RoomDescriptor:
        """Get room and verify agent is a member. Raises PermissionError if not."""
        async with self.session_factory() as session:
            found = await self.room_store.get_with_membership(
                session, room_id, agent_id
            )
        if found is None:
            raise ValueError(f"Room not found: {room_id}")
        room, is_member = found
        if not is_member:
            raise PermissionError("Agent is not a member of this room")
        return _describe_room(room)

    async def list_rooms(
        self, agent_id: str, *, include_archived: bool = False
    ) -> list[RoomDescriptor]:
        """List all rooms the agent is a member of.

        Archived rooms are excluded unless `include_archived` is set.
        """
        async with self.session_factory() as session:
            rooms = await self.room_store.get_rooms_for_agent(
                session, agent_id, include_archived=include_archived
            )
        return [_describe_room(r) for r in rooms]

    async def list_participants(self, room_id: str) -> list[ParticipantDescriptor]:
        """List all agents and users in a room."""
        async with self.session_factory() as session:
            agent_ids = await self.room_store.get_agent_ids(session, room_id)
            agents: list[Agent] = []
            for aid in agent_ids:
                agent = await self.agent_store.get(session, aid)
                if agent is not None:
                    agents.append(agent)
            statuses = await self._compute_statuses(session, agents, room_id)
            external_users = await self.external_user_store.get_by_room(
                session, room_id
            )
            # role_id -> live holder agent_ids, plus role_id -> name. Each agent
            # holds at most one role (unique agent_id), so the inverse map is
            # well-defined even for shared roles with several holders.
            live_holders = await self.room_role_store.live_holders_for_room(
                session, room_id, self.connections.live_agent_ids()
            )
            roles = await self.room_role_store.list_roles(session, room_id)
            role_name_by_id = {r.id: r.name for r in roles}
            room_role_by_agent: dict[str, str] = {
                holder: role_name_by_id[rid]
                for rid, holder_ids in live_holders.items()
                if rid in role_name_by_id
                for holder in holder_ids
            }
            alias_by_agent = await self.room_store.list_aliases(session, room_id)
        result: list[ParticipantDescriptor] = []
        for agent in agents:
            profile = agent.integration_profile or {}
            task_protocol = profile.get("task_protocol", {})
            result.append(
                ParticipantDescriptor(
                    id=agent.id,
                    name=agent.name,
                    type="agent",
                    agent_type=agent.agent_type,
                    display_name=agent.display_name,
                    can_delegate=bool(task_protocol.get("can_delegate", False)),
                    can_accept=bool(task_protocol.get("can_accept", False)),
                    status=statuses[agent.id],
                    room_role=room_role_by_agent.get(agent.id),
                    alias=alias_by_agent.get(agent.id),
                )
            )
        for user in external_users:
            result.append(
                ParticipantDescriptor(
                    id=user.id,
                    name=user.external_username,
                    type="user",
                )
            )
        return result

    async def _compute_statuses(
        self,
        session: AsyncSession,
        agents: list[Agent],
        room_id: str,
    ) -> dict[str, AgentStatus]:
        return await compute_agent_statuses(
            session, agents, room_id, self.agent_session_store, self.connections
        )

    async def get_agent_statuses_by_name(
        self,
        room_id: str,
        agent_names: list[str],
    ) -> dict[str, AgentStatus]:
        """Return status keyed by agent name. Unknown names are omitted."""
        async with self.session_factory() as session:
            agents = await self.agent_store.get_by_names(session, agent_names)
            statuses = await self._compute_statuses(session, agents, room_id)
        return {a.name: statuses[a.id] for a in agents}

    async def get_agent_statuses_by_ids(
        self,
        room_id: str,
        agent_ids: list[str],
    ) -> dict[str, AgentStatus]:
        """Return status keyed by agent id. Unknown ids are omitted."""
        if not agent_ids:
            return {}
        async with self.session_factory() as session:
            return await self.get_agent_statuses_by_ids_in_session(
                session, room_id, agent_ids
            )

    async def get_agent_statuses_by_ids_in_session(
        self,
        session: AsyncSession,
        room_id: str,
        agent_ids: list[str],
    ) -> dict[str, AgentStatus]:
        """`get_agent_statuses_by_ids` for a caller that already holds a session.

        A request handler with its own open transaction must use this: taking a
        second checkout while holding the first makes the request queue against
        the pool for a slot it is itself occupying.
        """
        if not agent_ids:
            return {}
        result = await session.execute(select(Agent).where(Agent.id.in_(agent_ids)))
        agents = list(result.scalars().all())
        return await self._compute_statuses(session, agents, room_id)

    async def get_agent_status(self, agent_id: str, room_id: str) -> AgentStatus:
        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, agent_id)
            if agent is None:
                raise ValueError(f"Agent {agent_id} not found")
            statuses = await self._compute_statuses(session, [agent], room_id)
        return statuses[agent_id]

    # ── Messaging ──────────────────────────────────────────────────────────────

    async def _post_agent_notice(
        self, client: Any, matrix_room_id: str, body: str
    ) -> None:
        """Best-effort post of an activity notice from the agent's own Matrix
        identity. Used to announce resource-manager-driven side effects (e.g.
        room-document mutations) in a way that flows through collaboration
        bridges — the resource manager isn't a bridge participant, so its own
        notices wouldn't reach Slack/Mattermost."""
        try:
            await client.send_message(matrix_room_id, body)
        except Exception:
            logger.exception(
                "Failed to post agent activity notice to %s", matrix_room_id
            )

    async def _post_role_change_notice(
        self, agent_id: str, matrix_room_id: str, action: str
    ) -> None:
        """Announce a role assume/release from the acting agent's own Matrix
        identity, so the notice reaches collaboration bridges (Slack/Mattermost)."""
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            return
        await self._post_agent_notice(client, matrix_room_id, f"🎭 {action}.")

    async def _resolve_thread_root(
        self, client: ClientBase[Any], matrix_room_id: str, thread_id: str
    ) -> str:
        """Resolve a caller-supplied thread_id to the actual thread root.

        Matrix threads are flat: every reply relates to a single root. Agents
        may pass any message id in a thread (including a mid-thread reply), so
        we look the event up and, if it is itself an m.thread reply, return its
        root. If the event does not exist in the room we fail loud rather than
        post into a non-existent thread.
        """
        if client.nio_client is None:
            raise ValueError("Agent client not connected to Matrix")
        resp = await client.nio_client.room_get_event(matrix_room_id, thread_id)
        if isinstance(resp, RoomGetEventError):
            raise ValueError(f"thread_id not found in room: {thread_id}")
        relates = resp.event.source.get("content", {}).get("m.relates_to") or {}
        if relates.get("rel_type") == "m.thread":
            root = relates.get("event_id")
            if root:
                return str(root)
        return thread_id

    async def send_message(
        self,
        agent_id: str,
        room_id: str,
        content: str,
        thread_id: str | None = None,
    ) -> str:
        """Send a message to a room. Returns event_id.

        When thread_id is set the message is posted as a reply in that thread
        (the id is normalised to the thread root). Raises ValueError if the
        agent is not a room member, the client is not running, or thread_id
        does not resolve to an event in the room.
        Raises PermissionError if auth fails (should not happen in same-process).
        """
        logger.debug(
            "[AGENT-MSG] agent=%s room=%s content=%s", agent_id, room_id, content[:80]
        )
        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        thread_root_id: str | None = None
        if thread_id is not None:
            thread_root_id = await self._resolve_thread_root(
                client, room.matrix_room_id, thread_id
            )
        event_id = await client.send_message(
            room.matrix_room_id, content, thread_root_id=thread_root_id
        )
        if event_id is None:
            raise ValueError("Failed to send message")
        logger.debug(
            "[AGENT-MSG] sent event_id=%s to matrix room=%s",
            event_id,
            room.matrix_room_id,
        )
        # The agent has replied, so clear any typing indicator raised when the
        # inbound message arrived. The message itself is already delivered, so a
        # failure here is degraded-but-functional, not a reason to fail the send.
        try:
            await self._set_typing(agent_id, room, False)
        except Exception:
            logger.warning(
                "Failed to clear typing indicator for room %s", room_id, exc_info=True
            )
        return event_id

    async def send_media(
        self,
        agent_id: str,
        room_id: str,
        files: list[tuple[bytes, str, str]],
        caption: str | None = None,
        thread_id: str | None = None,
    ) -> dict[str, object]:
        """Upload one or more files to the Matrix media repository and post them
        to a room as m.image / m.file events. `files` is a list of
        (data, filename, mimetype). Returns
        {"event_id": <first>, "mxc": <first>, "attachments": [{event_id, mxc,
        filename}, ...]}.

        Membership in `room_id` is required, mirroring download_media. Every
        file is validated (non-empty, within config.agent_media_max_bytes)
        BEFORE anything is sent, so a bad file in the batch fails the whole call
        rather than leaving a half-posted message in the room. When `caption` is
        set it becomes the body of the first event (the filename rides in the
        `filename` field, per the caption convention the bridges already use
        inbound). When `thread_id` is set the events are posted into that thread
        (normalised to its root).

        With more than one file the events share an attachment-group marker so
        receivers can coalesce them into one logical message — Matrix itself has
        no multi-attachment event.
        """
        if not files:
            raise ValueError("no attachments provided")
        max_bytes = self.config.agent_media_max_bytes
        for data, filename, _mimetype in files:
            if not data:
                raise ValueError(f"attachment '{filename}' is empty")
            if len(data) > max_bytes:
                raise ValueError(
                    f"attachment '{filename}' is {len(data)} bytes, over the "
                    f"{max_bytes}-byte limit (AGENT_MEDIA_MAX_BYTES)"
                )
        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        thread_root_id: str | None = None
        if thread_id is not None:
            thread_root_id = await self._resolve_thread_root(
                client, room.matrix_room_id, thread_id
            )

        total = len(files)
        group_id = str(uuid.uuid4()) if total > 1 else None
        posted: list[dict[str, str]] = []
        for index, (data, filename, mimetype) in enumerate(files):
            mxc = await client.upload_media(data, mimetype, filename)
            msgtype = "m.image" if mimetype.startswith("image/") else "m.file"
            event_id = await client.send_media(
                room.matrix_room_id,
                mxc,
                filename,
                mimetype,
                len(data),
                msgtype=msgtype,
                caption=(
                    caption if index == 0 and caption and caption.strip() else None
                ),
                thread_root_id=thread_root_id,
                group=(
                    {"id": group_id, "index": index, "total": total}
                    if group_id is not None
                    else None
                ),
            )
            if event_id is None:
                raise ValueError(f"Failed to send media message for '{filename}'")
            posted.append({"event_id": event_id, "mxc": mxc, "filename": filename})
        try:
            await self._set_typing(agent_id, room, False)
        except Exception:
            logger.warning(
                "Failed to clear typing indicator for room %s", room_id, exc_info=True
            )
        return {
            "event_id": posted[0]["event_id"],
            "mxc": posted[0]["mxc"],
            "attachments": posted,
        }

    async def _require_can_address(
        self,
        session: AsyncSession,
        target: Agent,
        *,
        room_id: str,
        group_id: str | None,
        sender_agent_id: str,
    ) -> None:
        """Raise unless `sender_agent_id` may address `target` in this room.

        For delegation, which creates a row someone is expected to work. A
        message the target can decline in the room is checked with
        :meth:`_can_address` and reported instead.
        """
        if await self._can_address(
            session,
            target,
            room_id=room_id,
            group_id=group_id,
            sender_agent_id=sender_agent_id,
        ):
            return
        raise PermissionError(
            f"Agent {sender_agent_id} is not permitted to address "
            f"{target.name} in this room."
        )

    async def _can_address(
        self,
        session: AsyncSession,
        target: Agent,
        *,
        room_id: str,
        group_id: str | None,
        sender_agent_id: str,
    ) -> bool:
        """Whether `sender_agent_id` may address `target` in this room.

        An agent sender is never the target's *owner* — owner rules admit the
        human, not the programs acting for them — so an agent gets in through
        the `agents` dimension, or through an `owner_agents` rule when both are
        owned by the same person. The sender is looked up only once the target
        is actually restricted, so the open case stays a single read.

        Reads through the caller's `session`: every caller already holds one,
        and taking a second while the first is open queues a request behind
        the pool for its own slot.
        """
        policy = parse_policy(target.addressing_policy)
        if policy.is_open():
            return True
        sender = await self.agent_store.get(session, sender_agent_id)
        return can_address(
            policy,
            room_id=room_id,
            group_id=group_id,
            sender_kind="agent",
            sender_id=sender_agent_id,
            sender_user_ids=[],
            sender_owner_user_id=sender.owner_id if sender is not None else None,
            owner_user_id=target.owner_id,
        )

    async def send_targeted_message(
        self,
        agent_id: str,
        room_id: str,
        target_names: list[str],
        content: str,
        thread_id: str | None = None,
        target_roles: list[str] | None = None,
    ) -> SendTargetedResult:
        """Send a message addressed to specific agents/users and/or roles.

        Prepends `@name` for each name target and `@role` for each role target
        so they receive it as an *addressed* event. A role mention fans out to
        every live holder of that role (the single holder for an exclusive
        role); others still see the message as room context. When thread_id is
        set the message is posted into that thread.

        Returns the posted event_id plus the reachability status of each
        addressed agent at send time — for role targets this is each live
        holder. User targets are omitted from target_statuses — their
        reachability is the bridge's concern.

        Raises ValueError if no targets are given, if a name does not match a
        room participant, or if a role does not exist in the room.
        """
        roles = target_roles or []
        if not target_names and not roles:
            raise ValueError("at least one of target_names / target_roles is required")

        participants = await self.list_participants(room_id)
        participant_by_name = {p.name: p for p in participants}
        # Allow addressing an agent by its room alias: resolve any target that
        # isn't a known participant name through the room's aliases. The alias
        # token is still what gets `@`-mentioned in the body — alias routing
        # delivers it to the agent exactly like its real name.
        unknown = [n for n in target_names if n not in participant_by_name]
        if unknown:
            async with self.session_factory() as session:
                aliases = await self.room_store.list_aliases(session, room_id)
            agent_id_by_alias = {a.lower(): aid for aid, a in aliases.items()}
            participant_by_id = {p.id: p for p in participants}
            for name in unknown:
                resolved_id = agent_id_by_alias.get(name.lower())
                if resolved_id is not None and resolved_id in participant_by_id:
                    participant_by_name[name] = participant_by_id[resolved_id]
            unknown = [n for n in target_names if n not in participant_by_name]
        if unknown:
            raise ValueError(
                f"Targets not in room: {', '.join(unknown)}. "
                f"Room participants: {', '.join(sorted(participant_by_name))}"
            )

        # Validate role targets and resolve their live holders (for statuses).
        role_holder_names: set[str] = set()
        if roles:
            async with self.session_factory() as session:
                defined_roles = await self.room_role_store.list_roles(session, room_id)
                defined = {role.name for role in defined_roles}
                missing = [r for r in roles if r not in defined]
                if missing:
                    raise ValueError(
                        f"Roles not defined in room: {', '.join(missing)}. "
                        f"Room roles: {', '.join(sorted(defined)) or '(none)'}"
                    )
                role_by_id = {role.id: role.name for role in defined_roles}
                holders = await self.room_role_store.live_holders_for_room(
                    session, room_id, self.connections.live_agent_ids()
                )
                for role_id, agent_ids in holders.items():
                    if role_by_id.get(role_id) not in roles:
                        continue
                    for holder_id in agent_ids:
                        holder = await self.agent_store.get(session, holder_id)
                        if holder is not None:
                            role_holder_names.add(holder.name)

        # A target whose policy does not admit this sender is reported, not
        # refused. The message goes to the room either way and the target
        # declines it there, in the open, where whoever is reading can see that
        # it was asked and why it will not act — which is the same thing that
        # happens to an `@name` in a plain message. Refusing here would make
        # the same request succeed or fail depending on which tool sent it, and
        # would leave the sender's account of it the only one on record.
        # Delegation is the exception, and raises: a task is a row someone is
        # expected to work, not something a room can decline.
        async with self.session_factory() as session:
            room_row = await self.room_store.get(session, room_id)
        group_id = room_row.group_id if room_row is not None else None
        addressed_agent_names = {
            name for name in target_names if participant_by_name[name].type == "agent"
        } | role_holder_names
        refused: set[str] = set()
        async with self.session_factory() as session:
            for name in sorted(addressed_agent_names):
                participant = participant_by_name.get(name)
                if participant is None:
                    continue
                target_agent = await self.agent_store.get(session, participant.id)
                if target_agent is None:
                    continue
                if not await self._can_address(
                    session,
                    target_agent,
                    room_id=room_id,
                    group_id=group_id,
                    sender_agent_id=agent_id,
                ):
                    refused.add(name)

        mention_tokens = [f"@{name}" for name in target_names]
        mention_tokens += [f"@{role}" for role in roles]
        body = f"{' '.join(mention_tokens)} {content}"
        event_id = await self.send_message(agent_id, room_id, body, thread_id=thread_id)

        # Reachability: direct agent name targets plus each role's live holders.
        status_names = {
            name
            for name in target_names
            if participant_by_name.get(name) is not None
            and participant_by_name[name].type == "agent"
        }
        status_names |= role_holder_names
        # A refused target reports why rather than how reachable it is. Both
        # matter to the sender, but only one of them explains a reply that says
        # no — and "live" for an agent that will decline is the reading that
        # sends someone looking for a bug.
        target_statuses = {
            name: (
                AgentStatus.NOT_PERMITTED
                if name in refused
                else participant_by_name[name].status
            )
            for name in status_names
            if name in participant_by_name
            and (name in refused or participant_by_name[name].status is not None)
        }
        return SendTargetedResult(event_id=event_id, target_statuses=target_statuses)

    async def set_typing(
        self,
        agent_id: str,
        room_id: str,
        is_typing: bool,
    ) -> None:
        """Set the typing indicator for an agent in a room.

        Resolves the room's collaboration bridge itself, so callers don't
        need to know which bridge backs the room. Internal-only rooms (no
        bridge) are a no-op — there is no external channel to surface the
        indicator to.
        """
        room = await self.require_room_member(agent_id, room_id)
        await self._set_typing(agent_id, room, is_typing)

    async def _set_typing(
        self, agent_id: str, room: RoomDescriptor, is_typing: bool
    ) -> None:
        """Surface a typing indicator for a room the caller already resolved.

        Membership is the caller's to establish; an internal-only room costs
        no query at all, since the bridge is already known to be absent.
        """
        if room.bridge_id is None:
            logger.debug(
                "Room %s has no collaboration bridge; skipping typing indicator",
                room.id,
            )
            return

        bridge_core = self.collab_lifecycle.get(room.bridge_id)
        if bridge_core is None:
            raise ValueError(
                f"Collaboration bridge {room.bridge_id} for room {room.id} "
                "is not running"
            )
        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, agent_id)
        if agent is None:
            raise ValueError(f"Agent not found: {agent_id}")
        await bridge_core.handle_outbound_typing(room.id, agent.name, is_typing)

    async def update_status(self, agent_id: str, room_id: str, detail: str) -> None:
        """Send a status message to a room."""
        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        await client.send_message(room.matrix_room_id, f"*{detail}*", format="markdown")

    async def set_runtime_state(
        self,
        agent_id: str,
        room_id: str,
        state: str,
        *,
        thread_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        control_capabilities: dict[str, bool] | None = None,
        anchor_event_id: str | None = None,
    ) -> None:
        """Record and broadcast an agent's runtime state in a room.

        Persists the latest state (so it is queryable via `!status`) and emits
        a `com.switch.agent.runtime_state` room event the collaboration bridge
        picks up to surface the state on the bridged channel. Reported by the
        Switch Console connector as its managed session transitions.

        `thread_id` (the triggering message's thread, when it was in one) rides
        the event so the bridge can surface the state in that thread. It is
        transient routing only — it is never persisted as part of the state.

        `detail` is a short activity line for the running turn (e.g. "Editing
        foo.py"); like `thread_id` it is transient and rides the event only —
        the bridge surfaces it in place on the live working message.

        `anchor_event_id` is the latest message the reporting connector has
        actually handed to the agent's session. The bridge repositions the
        indicator when it changes, so position follows what the agent has
        genuinely been given rather than what merely arrived in the room. Also
        transient routing — reported on every refresh, and only a change moves
        anything.

        The `switchdash://` deeplink is rewritten to a gateway HTTP redirect for
        platforms that linkify only http(s) (Discord, Telegram), so the "Open in
        Switch Console" link is clickable there. It takes both a configured
        `GATEWAY_PUBLIC_URL` and a room whose bridge needs the hop: the redirect
        lands in the same place the deeplink already points, so handing it to a
        platform that renders the scheme — Mattermost, Slack — sends the reader
        through the browser for nothing. A room on no bridge keeps the raw link
        for the same reason. When `GATEWAY_PUBLIC_URL` is unset the raw deeplink
        is left untouched whatever the platform.

        The result is what gets persisted and emitted, so the bridged status
        message and the `!status` command surface the same link.
        """
        room = await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, agent_id)
            if agent is None:
                raise ValueError(f"Agent not found: {agent_id}")
            room_row = await self.room_store.get(session, room.id)
            bridge_type: str | None = None
            if room_row is not None and room_row.bridge_id is not None:
                bridge = await self.bridge_store.get(session, room_row.bridge_id)
                bridge_type = bridge.type if bridge is not None else None
            deeplink_url = deeplink_for_platform(
                deeplink_url,
                self.config.gateway_public_url,
                # A room on no bridge has no platform to accommodate, so it
                # keeps the link Switch Console built.
                bridge_type is None
                or self.collab_lifecycle.renders_custom_url_schemes(bridge_type),
            )
            await self.agent_runtime_state_store.upsert(
                session,
                agent_id,
                room.id,
                state,
                deeplink_url=deeplink_url,
                control_capabilities=control_capabilities,
            )
            await session.commit()

        await self._emit_runtime_state(
            agent_id=agent_id,
            agent_name=agent.name,
            matrix_room_id=room.matrix_room_id,
            room_id=room.id,
            state=state,
            mention_handle=await self._mention_handle_for(
                agent, room_row.bridge_id if room_row is not None else None
            ),
            thread_id=thread_id,
            deeplink_url=deeplink_url,
            detail=detail,
            anchor_event_id=anchor_event_id,
        )

    async def _emit_runtime_state(
        self,
        *,
        agent_id: str,
        agent_name: str,
        matrix_room_id: str,
        room_id: str,
        state: str,
        mention_handle: str | None,
        thread_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        anchor_event_id: str | None = None,
    ) -> None:
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None or client.nio_client is None:
            logger.debug(
                "No live client for agent %s; skipping runtime-state emit", agent_id
            )
            return
        await client.nio_client.room_send(
            matrix_room_id,
            "com.switch.agent.runtime_state",
            {
                "agent_id": agent_id,
                "agent_name": agent_name,
                "room_id": room_id,
                "state": state,
                "mention_handle": mention_handle,
                "thread_id": thread_id,
                "deeplink_url": deeplink_url,
                "detail": detail,
                "anchor_event_id": anchor_event_id,
            },
        )

    async def sweep_runtime_states(self) -> None:
        """Reset to idle any runtime state whose session heartbeat has lapsed.

        There is no reliable session-close signal, so a session that crashes or
        drops while `working`/`awaiting-input` would otherwise leave its surface
        stuck on the bridge. Each non-idle row is checked against the same
        liveness window `!status` uses; stale ones are collapsed to idle and a
        clear event is emitted.

        Liveness is the same union every other reader takes (CHOO-1857): the
        heartbeat rows for clients still polling, the live connections for
        clients on the push transport. Checking only the rows made this sweep
        clear the state of a perfectly live session on every pass — and because
        the bridge deletes the "working on it…" message on idle and posts a new
        one on the next update, the visible effect was the status message being
        deleted and recreated on every refresh rather than edited in place.
        """
        async with self.session_factory() as session:
            rows = await self.agent_runtime_state_store.get_active(session)
        for row in rows:
            if self.connections.has_session_in(row.agent_id, row.room_id):
                continue
            async with self.session_factory() as session:
                live = await self.agent_session_store.get_live_agent_ids(
                    session, [row.agent_id], row.room_id
                )
            if row.agent_id in live:
                continue
            async with self.session_factory() as session:
                agent = await self.agent_store.get(session, row.agent_id)
                room = await self.room_store.get(session, row.room_id)
                if agent is None or room is None:
                    continue
                await self.agent_runtime_state_store.upsert(
                    session, row.agent_id, row.room_id, RUNTIME_STATE_IDLE
                )
                await session.commit()
            await self._emit_runtime_state(
                agent_id=agent.id,
                agent_name=agent.name,
                matrix_room_id=room.matrix_room_id,
                room_id=room.id,
                state=RUNTIME_STATE_IDLE,
                mention_handle=await self._mention_handle_for(agent, room.bridge_id),
                thread_id=None,
            )

    async def _mention_handle_for(
        self, agent: Agent, bridge_id: str | None
    ) -> str | None:
        """The handle to @-mention when this agent needs its operator, on the
        platform the room is bridged to.

        Resolved from the agent's owner and the messaging account that owner
        has claimed on this bridge (CHOO-2137), rather than from a handle typed
        into the agent's config. A handle is per-platform — the same person is
        one name on Slack and another on Telegram — so a single configured
        string could only ever be right on one of them, and was silently plain
        text everywhere else.

        None when the agent has no owner, the room has no bridge, or the owner
        has claimed nothing here. Callers disclose that rather than dropping
        the notification quietly.
        """
        if agent.owner_id is None or bridge_id is None:
            return None
        async with self.session_factory() as session:
            claimed = await self.external_user_store.get_by_user(
                session, agent.owner_id
            )
        # Claiming is not exclusive and one person may hold several accounts on
        # a bridge. Sorted so a second account cannot change who gets pinged
        # from one call to the next.
        here = sorted(u.external_username for u in claimed if u.bridge_id == bridge_id)
        return here[0] if here else None

    @staticmethod
    def _message_dict(event: Any) -> dict[str, Any]:
        """Build the agent-facing message dict from a nio event."""
        content = event.source.get("content", {}) if hasattr(event, "source") else {}
        sender_name = content.get("sender_name")
        if not sender_name:
            sender_name = event.sender
        body = getattr(event, "body", None)

        attachments: list[dict[str, Any]] = []
        if isinstance(event, RoomMessageMedia):
            info = content.get("info", {}) or {}
            attachments.append(
                {
                    "filename": content.get("filename") or body,
                    "mimetype": str(info.get("mimetype", "")),
                    "size": int(info.get("size", 0) or 0),
                    "mxc": str(event.url),
                    "msgtype": str(content.get("msgtype", "")),
                }
            )

        return {
            "id": event.event_id,
            "kind": "message",
            "sender": event.sender,
            "sender_name": sender_name,
            "body": body,
            "timestamp": getattr(event, "server_timestamp", None),
            "attachments": attachments,
        }

    @staticmethod
    def _join_dict(event: RoomMemberEvent) -> dict[str, Any] | None:
        """Build a timeline entry for someone joining the room.

        Only a transition *into* join counts: a display-name change or avatar
        update is also an m.room.member event with membership "join", and
        replaying those as arrivals would be a lie.
        """
        if event.membership != "join" or event.prev_membership == "join":
            return None
        content = event.content or {}
        name = content.get("displayname") or event.state_key
        return {
            "id": event.event_id,
            "kind": "room_join",
            "sender": event.state_key,
            "sender_name": name,
            "body": f"{name} joined the room",
            "timestamp": getattr(event, "server_timestamp", None),
            "attachments": [],
        }

    def _timeline_entry(self, event: Any) -> dict[str, Any] | None:
        """Map a nio timeline event to an agent-facing entry, or None to skip.

        Messages and joins are the timeline; every other state event (leaves,
        topic changes, power levels) is noise an agent cannot act on.
        """
        if isinstance(event, RoomMemberEvent):
            return self._join_dict(event)
        if getattr(event, "body", None):
            return self._message_dict(event)
        return None

    @staticmethod
    def _thread_root_id(event: Any) -> str:
        """Return the thread root id for an event.

        A message that carries an m.thread relation belongs to that root;
        anything else is its own root (a top-level message).
        """
        if hasattr(event, "source"):
            relates = event.source.get("content", {}).get("m.relates_to") or {}
            if relates.get("rel_type") == "m.thread":
                root = relates.get("event_id")
                if root:
                    return str(root)
        return str(event.event_id)

    async def read_context(
        self,
        agent_id: str,
        room_id: str,
        limit: int = 50,
        since_ms: int | None = None,
        before_ms: int | None = None,
    ) -> dict[str, Any]:
        """Fetch room history grouped into threads.

        Returns::

            {"threads": [...], "truncated": bool, "oldest_timestamp": int|None}

        where each thread group is ordered by latest activity (most-recently-
        active last, so the tail is the freshest) and shaped as::

            {"root": <entry>, "replies": [<entry>, ...]}

        An <entry> is {"id", "kind", "sender", "sender_name", "body",
        "timestamp", "attachments"}. `kind` is "message" for something someone
        said and "room_join" for an arrival. Top-level entries are roots with
        an empty replies list; replies are ordered oldest-first within a
        thread. A root that falls outside the fetched window but has a reply
        inside it is fetched on demand; if it cannot be fetched it is returned
        as an elided stub so the reply is not lost.

        `truncated` is True when older history exists that this call did not
        reach — the caller asked for more than it got. It is deliberately
        conservative: a window that ends exactly on `limit` reports truncated
        even if nothing older happens to exist. A short history must never be
        mistaken for a complete one.
        """
        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected to Matrix")

        # Walk backwards page by page until the window is satisfied. A single
        # page is not enough: the homeserver caps its size, and state events
        # that never reach the caller still consume it.
        #
        # Reaching a `before` window and reading inside it are budgeted
        # separately. Matrix has no timestamp cursor, so a `before` deep in a
        # busy room can only be reached by paging over everything newer — and
        # if those pages came out of the read budget, a far-enough-back window
        # would return empty no matter how small a `limit` the caller asked
        # for. Seeking is the cost of getting there, not part of the answer.
        groups: dict[str, dict[str, Any]] = {}
        collected = 0
        oldest_ts: int | None = None
        read_pages = 0
        seek_pages = 0
        exhausted = False

        start: str | None = None
        if before_ms is not None:
            start = await self._seek_before_token(
                client, room.matrix_room_id, before_ms
            )

        while collected < limit and read_pages < HISTORY_MAX_PAGES:
            if seek_pages >= HISTORY_MAX_SEEK_PAGES:
                logger.warning(
                    "read_context gave up seeking back to %s in %s after "
                    "%d pages; the window was never reached",
                    before_ms,
                    room.matrix_room_id,
                    seek_pages,
                )
                break
            resp = await client.nio_client.room_messages(
                room.matrix_room_id, start=start, limit=HISTORY_PAGE_SIZE
            )
            if isinstance(resp, RoomMessagesError):
                raise ValueError(f"Failed to fetch room history: {resp.message}")

            chunk = list(resp.chunk)
            end = getattr(resp, "end", None)
            # A page that contributes nothing because everything on it is
            # newer than `before` is a seek, not a read.
            reached_window = before_ms is None or any(
                getattr(e, "server_timestamp", None) is not None
                and getattr(e, "server_timestamp") < before_ms
                for e in chunk
            )
            if reached_window:
                read_pages += 1
            else:
                seek_pages += 1

            for event in chunk:
                ts = getattr(event, "server_timestamp", None)
                # Newer than the window: keep walking back towards it.
                if before_ms is not None and ts is not None and ts >= before_ms:
                    continue
                # Older than the window: pagination runs newest-first, so
                # everything beyond this point is older too.
                if since_ms is not None and ts is not None and ts < since_ms:
                    exhausted = True
                    break

                entry = self._timeline_entry(event)
                if entry is None:
                    continue

                root_id = self._thread_root_id(event)
                group = groups.setdefault(
                    root_id, {"root": None, "replies": [], "latest": 0}
                )
                if entry["id"] == root_id:
                    group["root"] = entry
                else:
                    group["replies"].append(entry)
                if ts is not None and ts > group["latest"]:
                    group["latest"] = ts
                if ts is not None and (oldest_ts is None or ts < oldest_ts):
                    oldest_ts = ts

                collected += 1
                if collected >= limit:
                    break

            if exhausted:
                break
            # No continuation token, or the server stopped moving: this is the
            # start of the room.
            if not end or end == start:
                exhausted = True
                break
            start = end

        # Resolve roots that fall outside the fetched window (orphan replies).
        for root_id, group in groups.items():
            if group["root"] is None:
                group["root"] = await self._fetch_root(
                    client, room.matrix_room_id, root_id
                )

        ordered = sorted(groups.values(), key=lambda g: g["latest"])
        threads: list[dict[str, Any]] = []
        for group in ordered:
            group["replies"].reverse()  # chunk was newest-first → oldest-first
            threads.append({"root": group["root"], "replies": group["replies"]})

        if not exhausted:
            logger.warning(
                "read_context truncated in %s: %d entries over %d read pages "
                "(%d spent seeking), older history not reached",
                room.matrix_room_id,
                collected,
                read_pages,
                seek_pages,
            )

        return {
            "threads": threads,
            "truncated": not exhausted,
            "oldest_timestamp": oldest_ts,
        }

    async def _seek_before_token(
        self, client: ClientBase[Any], matrix_room_id: str, before_ms: int
    ) -> str | None:
        """Get a pagination token positioned at `before_ms`, if the server can.

        `/messages` takes a token, not a timestamp, so reaching a `before` deep
        in a busy room otherwise means paging over everything newer just to
        arrive. `timestamp_to_event` (Matrix 1.6) jumps straight there.

        Returns None when the homeserver cannot answer — the caller then walks
        back the slow way. A failure here costs speed, not correctness, so it
        is logged and swallowed rather than raised.
        """
        nio_client = client.nio_client
        if nio_client is None:
            return None
        path = (
            f"/_matrix/client/v1/rooms/{quote(matrix_room_id, safe='')}"
            f"/timestamp_to_event?ts={before_ms}&dir=b"
        )
        try:
            resp = await nio_client.send(
                "GET",
                path,
                headers={"Authorization": f"Bearer {nio_client.access_token}"},
            )
            if resp.status != 200:
                logger.info(
                    "timestamp_to_event unavailable in %s (HTTP %d); "
                    "falling back to scanning back to the window",
                    matrix_room_id,
                    resp.status,
                )
                return None
            event_id = (await resp.json()).get("event_id")
        except Exception:
            logger.warning(
                "timestamp_to_event failed in %s; falling back to scanning",
                matrix_room_id,
                exc_info=True,
            )
            return None
        if not event_id:
            return None

        context = await nio_client.room_context(matrix_room_id, event_id, limit=1)
        if isinstance(context, RoomContextError):
            logger.info(
                "Could not anchor pagination at %s in %s; scanning instead",
                event_id,
                matrix_room_id,
            )
            return None
        start_token = context.start
        return str(start_token) if start_token else None

    async def _fetch_root(
        self, client: ClientBase[Any], matrix_room_id: str, root_id: str
    ) -> dict[str, Any]:
        """Fetch a thread-root event that fell outside the read window.

        Failure is degraded-but-functional: we return an elided stub (keeping
        the replies attached to a known id) rather than dropping the thread.
        """
        if client.nio_client is None:
            raise ValueError("Agent client not connected to Matrix")
        resp = await client.nio_client.room_get_event(matrix_room_id, root_id)
        if isinstance(resp, RoomGetEventError):
            logger.warning(
                "Could not fetch thread root %s in %s; returning elided stub",
                root_id,
                matrix_room_id,
            )
            return {
                "id": root_id,
                "kind": "message",
                "sender": None,
                "sender_name": None,
                "body": None,
                "timestamp": None,
                "elided": True,
            }
        return self._message_dict(resp.event)

    async def download_media(
        self, agent_id: str, room_id: str, mxc: str
    ) -> tuple[bytes, str, str | None]:
        """Download an attachment's bytes from the Matrix media repository.

        Membership in `room_id` is required as authorization. Returns
        (bytes, content_type, filename).
        """
        await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected to Matrix")

        resp = await client.nio_client.download(mxc=mxc)
        if isinstance(resp, DownloadError):
            raise ValueError(f"Failed to download media {mxc}: {resp.message}")
        return resp.body, resp.content_type, resp.filename

    # ── Events ───────────────────────────────────────────────────────────────

    async def poll_events(self, agent_id: str, timeout: float = 10) -> list[AgentEvent]:
        """Poll for events across all rooms the agent is in."""
        async with self.session_factory() as session:
            await self.agent_session_store.touch_heartbeat(session, agent_id, None)
            await session.commit()
        return await self.event_buffer.poll(agent_id, timeout=timeout)

    async def poll_notifications(
        self, agent_id: str, timeout: float = 10
    ) -> list[AgentEvent]:
        """Long-poll the agent's notification stream across all its rooms.

        Returns only notifiable events (addressed messages, task events, and
        room_join events the agent listens for) — see EventBuffer. Unlike
        `poll_events`, this does NOT touch any heartbeat: an auto_session
        connector maintains its "watching" presence via the dedicated
        `touch_watch_heartbeat` path, decoupled from this long-poll. Consuming
        this stream never drains the per-room queues, so live session pollers
        are unaffected.
        """
        return await self.event_buffer.poll_notifications(agent_id, timeout=timeout)

    async def touch_watch_heartbeat(self, agent_id: str) -> None:
        """Refresh an auto_session connector's global "watching" heartbeat.

        Pinged on a cadence (well under ALWAYS_ON_TTL) by the connector
        (Switch Console) while it is watching this agent's rooms. Makes the agent
        report DORMANT (rather than DISCONNECTED) in rooms where it has no live
        session, which licenses the "Starting a session…" reply when addressed.
        Uses the room-agnostic (room_id=None) heartbeat slot.
        """
        async with self.session_factory() as session:
            await self.agent_session_store.touch_heartbeat(session, agent_id, None)
            await session.commit()

    async def poll_room_events(
        self, agent_id: str, room_id: str, timeout: float = 10
    ) -> list[AgentEvent]:
        """Poll for events in a specific room.

        Polling no longer refreshes the room-scoped liveness heartbeat —
        session_addressable agents keep it fresh via the dedicated
        `touch_connection` renew path (POST /connection/renew), decoupled from
        the long-poll cadence so the TTL can stay short.
        """
        await self.require_room_member(agent_id, room_id)
        return await self.event_buffer.poll_room(agent_id, room_id, timeout=timeout)

    async def report_events(
        self,
        agent_id: str,
        room_id: str,
        events: Sequence[ToolCallReport | LlmCallReport],
    ) -> None:
        """Report tool call and LLM call events to a room."""
        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected to Matrix")

        for event in events:
            if isinstance(event, ToolCallReport):
                tool_event = MatrixToolCallReport(
                    agent_id=agent_id,
                    tool_id=event.tool_name,
                    args=event.arguments,
                    result=event.result,
                    duration_ms=event.duration_ms,
                    cost=event.cost,
                )
                await client.nio_client.room_send(
                    room.matrix_room_id,
                    "com.switch.report.tool_call",
                    tool_event.model_dump(exclude_none=True),
                )
            elif isinstance(event, LlmCallReport):
                llm_event = MatrixLlmCallReport(
                    agent_id=agent_id,
                    model_id=event.model,
                    messages=event.messages,
                    response=event.response,
                    usage=event.usage,
                    duration_ms=event.duration_ms,
                    cost=event.cost,
                )
                await client.nio_client.room_send(
                    room.matrix_room_id,
                    "com.switch.report.llm_call",
                    llm_event.model_dump(exclude_none=True),
                )

    # ── Tasks ──────────────────────────────────────────────────────────────────

    async def delegate_task(
        self,
        requester_id: str,
        room_id: str,
        performer_id: str,
        summary: str,
        description: str,
    ) -> DelegateTaskResult:
        """Delegate a task from one agent to another.

        Returns task_id and the performer's reachability status at delegation time.
        Raises ValueError if agents or room not found, or agents not in room.
        """
        room = await self.require_room_member(requester_id, room_id)

        async with self.session_factory() as session:
            performer = await self.agent_store.get(session, performer_id)
            room_row = await self.room_store.get(session, room.id)
        if performer is None:
            raise ValueError(f"Performer agent not found: {performer_id}")

        await self.require_room_member(performer_id, room_id)

        # Scoped addressing policy: delegating a task addresses the performer,
        # so it is subject to the same allow-list as a message. Unlike the
        # message path (which demotes to unaddressed) a task is explicit, so a
        # denied delegation fails loud rather than silently vanishing.
        async with self.session_factory() as session:
            await self._require_can_address(
                session,
                performer,
                room_id=room.id,
                group_id=room_row.group_id if room_row is not None else None,
                sender_agent_id=requester_id,
            )

        async with self.session_factory() as session:
            task = Task(
                room_id=room.id,
                requester_agent_id=requester_id,
                performer_agent_id=performer_id,
                summary=summary,
                description=description,
                status="pending",
                updates=[],
            )
            await self.task_store.create(session, task)
            await session.commit()
            task_id = task.id

        client = self.client_lifecycle.get_by_agent_id(requester_id)
        if client and client.nio_client:
            await client.nio_client.room_send(
                room.matrix_room_id,
                "com.switch.task.delegate",
                {
                    "task_id": task_id,
                    "requester_agent_id": requester_id,
                    "performer_agent_id": performer_id,
                    "summary": summary,
                    "description": description,
                },
            )

        target_status = await self.get_agent_status(performer_id, room_id)
        return DelegateTaskResult(task_id=task_id, target_status=target_status)

    async def accept_task(self, agent_id: str, task_id: str) -> None:
        """Accept a pending task (performer only)."""
        async with self.session_factory() as session:
            task = await self.task_store.get(session, task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        if task.performer_agent_id != agent_id:
            raise PermissionError("Only the performer can accept the task")
        if task.status != "pending":
            raise ValueError(f"Task not in pending state: {task.status}")

        room = await self.get_room(task.room_id)
        await self.require_room_member(agent_id, task.room_id)

        async with self.session_factory() as session:
            await self.task_store.accept(session, task_id)
            await session.commit()

        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client and client.nio_client:
            await client.nio_client.room_send(
                room.matrix_room_id,
                "com.switch.task.accept",
                {
                    "task_id": task_id,
                    "requester_agent_id": task.requester_agent_id,
                    "performer_agent_id": agent_id,
                },
            )

    async def update_task(
        self,
        agent_id: str,
        task_id: str,
        update: str,
    ) -> None:
        """Append a progress update to a task (performer only)."""
        async with self.session_factory() as session:
            task = await self.task_store.get(session, task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        if task.performer_agent_id != agent_id:
            raise PermissionError("Only the performer can update the task")

        room = await self.get_room(task.room_id)
        await self.require_room_member(agent_id, task.room_id)

        async with self.session_factory() as session:
            await self.task_store.append_update(session, task_id, update)
            await session.commit()

        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client and client.nio_client:
            await client.nio_client.room_send(
                room.matrix_room_id,
                "com.switch.task.update",
                {
                    "task_id": task_id,
                    "requester_agent_id": task.requester_agent_id,
                    "performer_agent_id": agent_id,
                    "update": update,
                },
            )

    async def finalise_task(
        self,
        agent_id: str,
        task_id: str,
        outcome: str,
    ) -> None:
        """Finalise a task with an outcome (performer only)."""
        async with self.session_factory() as session:
            task = await self.task_store.get(session, task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        if task.performer_agent_id != agent_id:
            raise PermissionError("Only the performer can finalise the task")

        room = await self.get_room(task.room_id)
        await self.require_room_member(agent_id, task.room_id)

        async with self.session_factory() as session:
            await self.task_store.finalise(session, task_id, outcome)
            await session.commit()

        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client and client.nio_client:
            await client.nio_client.room_send(
                room.matrix_room_id,
                "com.switch.task.finalise",
                {
                    "task_id": task_id,
                    "requester_agent_id": task.requester_agent_id,
                    "performer_agent_id": agent_id,
                    "outcome": outcome,
                },
            )
            await client.send_message(room.matrix_room_id, outcome, format="markdown")

    async def cancel_task(self, agent_id: str, task_id: str, reason: str) -> None:
        """Cancel a task (requester only)."""
        async with self.session_factory() as session:
            task = await self.task_store.get(session, task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        if task.requester_agent_id != agent_id:
            raise PermissionError("Only the requester can cancel the task")

        room = await self.get_room(task.room_id)
        await self.require_room_member(agent_id, task.room_id)

        async with self.session_factory() as session:
            await self.task_store.cancel(session, task_id, reason)
            await session.commit()

        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client and client.nio_client:
            await client.nio_client.room_send(
                room.matrix_room_id,
                "com.switch.task.cancel",
                {
                    "task_id": task_id,
                    "requester_agent_id": agent_id,
                    "performer_agent_id": task.performer_agent_id,
                    "reason": reason,
                },
            )

    async def get_task(self, agent_id: str, task_id: str) -> Task:
        """Get a task (requester or performer only)."""
        async with self.session_factory() as session:
            task = await self.task_store.get(session, task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        if task.requester_agent_id != agent_id and task.performer_agent_id != agent_id:
            raise PermissionError("Only the requester or performer can view the task")
        return task

    async def list_tasks(
        self,
        agent_id: str,
        room_id: str | None = None,
        role: str | None = None,
        status: str | None = None,
    ) -> list[Task]:
        """List tasks for an agent. role: 'delegated' (requester) or 'assigned' (performer)."""
        async with self.session_factory() as session:
            if role == "delegated":
                # Tasks the agent requested
                query = await session.execute(
                    select(Task).where(Task.requester_agent_id == agent_id)
                )
                tasks = list(query.scalars().all())
            elif role == "assigned":
                # Tasks assigned to the agent
                query = await session.execute(
                    select(Task).where(Task.performer_agent_id == agent_id)
                )
                tasks = list(query.scalars().all())
            else:
                # Both
                tasks = await self.task_store.get_by_agent(session, agent_id)

            if room_id:
                tasks = [t for t in tasks if t.room_id == room_id]
            if status:
                tasks = [t for t in tasks if t.status == status]
        return tasks

    async def list_delegatable_agents(
        self, agent_id: str, room_id: str
    ) -> list[ParticipantDescriptor]:
        """List the agents in a room (the candidates for task delegation)."""
        await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            agent_ids = await self.room_store.get_agent_ids(session, room_id)
            agents: list[Agent] = []
            for aid in agent_ids:
                agent = await self.agent_store.get(session, aid)
                if agent is not None:
                    agents.append(agent)
            statuses = await self._compute_statuses(session, agents, room_id)
        result = []
        for agent in agents:
            profile = agent.integration_profile or {}
            task_protocol = profile.get("task_protocol", {})
            result.append(
                ParticipantDescriptor(
                    id=agent.id,
                    name=agent.name,
                    type="agent",
                    agent_type=agent.agent_type,
                    display_name=agent.display_name,
                    can_delegate=bool(task_protocol.get("can_delegate", False)),
                    can_accept=bool(task_protocol.get("can_accept", False)),
                    status=statuses[agent.id],
                )
            )
        return result

    # ── Moderation ────────────────────────────────────────────────────────────

    async def list_bridges(self) -> list[dict[str, Any]]:
        """List collaboration bridges configured on this instance. Returns
        only the fields an agent needs to make a choice — not the raw
        connection_config."""
        async with self.session_factory() as session:
            bridges = await self.bridge_store.get_all(session)
        return [
            {
                "id": b.id,
                "type": b.type,
                "display_name": b.display_name,
                "status": b.status,
                "is_default": b.is_default,
                # The platform's ceiling and the operator's switch, ANDed: an
                # agent asking "can I make a room here?" wants one answer, and
                # gets it before spending a create_room call to find out.
                "can_create_channels": (
                    b.channel_creation_enabled
                    and self.collab_lifecycle.supports_channel_creation(b.type)
                ),
            }
            for b in bridges
        ]

    async def create_moderation_room(
        self,
        agent_id: str,
        name: str,
        description: str,
        agent_names: list[str],
        user_names: list[str] | None,
        channel_type: str | None,
        bridge_id: str | None,
        internal_only: bool = False,
        admin_mode: bool = False,
        security_config: dict[str, Any] | None = None,
        instructions: str | None = None,
        reference_ids: list[str] | None = None,
        package_ids: list[str] | None = None,
        linked_rooms: list[dict[str, str]] | None = None,
        read_visibility: str = "public",
        write_visibility: str = "public",
        group_name: str | None = None,
        roles: list[dict[str, Any]] | None = None,
        include_subagents_for: list[str] | None = None,
        join_event_listeners: list[str] | None = None,
        aliases: dict[str, str] | None = None,
    ) -> RoomCreateResult:
        """Create a room. The caller agent's owner_id is used as the acting
        user for attachment authorization and as the new room's owner.

        `group_name`, when given, files the room under an existing room group;
        it is resolved to a group id here (agents work in names, not ids)."""
        from switch_core.room_service import (
            LinkedRoomSpec,
            RoleSpec,
            RoomCreateConfig,
        )

        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, agent_id)
            if agent is None:
                raise ValueError(f"Unknown agent: {agent_id}")
            owner_is_admin = False
            if agent.owner_id is not None:
                owner = await session.get(User, agent.owner_id)
                owner_is_admin = owner is not None and owner.role == "admin"
            group_id = await self._resolve_group_name(session, group_name)
        if (reference_ids or package_ids) and agent.owner_id is None:
            raise ValueError(
                f"Agent {agent_id} has no owner_id and cannot attach references "
                "or packages on creation"
            )

        config = RoomCreateConfig(
            name=name,
            description=description,
            agent_names=agent_names,
            include_subagents_for=include_subagents_for,
            join_event_listeners=join_event_listeners,
            user_names=user_names,
            channel_type=channel_type,  # type: ignore[arg-type]
            bridge_id=bridge_id,
            internal_only=internal_only,
            admin_mode=admin_mode,
            protection_config=security_config,
            instructions=instructions,
            created_by=agent.owner_id,
            owner_id=agent.owner_id,
            group_id=group_id,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            reference_ids=reference_ids,
            package_ids=package_ids,
            linked_rooms=(
                [LinkedRoomSpec(**lr) for lr in linked_rooms] if linked_rooms else None
            ),
            roles=([RoleSpec(**r) for r in roles] if roles else None),
            aliases=aliases,
            acting_user_id=agent.owner_id,
            acting_is_admin=owner_is_admin,
        )
        try:
            result = await self.room_service.create_room(config)
        except ValueError as e:
            raise ValueError(f"Failed to create room: {str(e)}") from e
        except PermissionError as e:
            raise PermissionError(str(e)) from e
        except RuntimeError as e:
            raise RuntimeError(f"Room service error: {str(e)}") from e
        return result

    async def _resolve_group_name(
        self, session: AsyncSession, group_name: str | None
    ) -> str | None:
        """Resolve a room-group name to its id. Returns None for no group.

        Raises ValueError if the name is unknown or ambiguous (group names are
        not unique across the tree)."""
        if group_name is None:
            return None
        result = await session.execute(
            select(RoomGroup).where(RoomGroup.name == group_name)
        )
        matches = result.scalars().all()
        if not matches:
            raise ValueError(f"No room group named '{group_name}'")
        if len(matches) > 1:
            raise ValueError(
                f"Multiple room groups named '{group_name}'; ask the user which "
                "one to use"
            )
        return matches[0].id

    async def _group_labels(
        self, session: AsyncSession, group_id: str | None
    ) -> tuple[str | None, str | None]:
        """Return ``(group_name, group_path)`` for a room's group.

        `group_name` is the immediate group; `group_path` is the root-first
        ancestry joined with " / " (e.g. "Parent / Child"). Both None when the
        room is standalone. Guards against cycles.
        """
        if group_id is None:
            return None, None
        names: list[str] = []
        cursor: str | None = group_id
        seen: set[str] = set()
        while cursor is not None and cursor not in seen:
            seen.add(cursor)
            group = await session.get(RoomGroup, cursor)
            if group is None:
                break
            names.append(group.name)
            cursor = group.parent_group_id
        if not names:
            return None, None
        return names[0], " / ".join(reversed(names))

    async def invite_agent_to_room(
        self,
        agent_id: str,
        room_id: str,
        agent_name: str,
        include_subagents: bool = False,
    ) -> None:
        """Invite an agent to a room. Requires write access to the room.

        When ``include_subagents`` is set, the invited agent's subagents
        (child agents) are added alongside it.
        """
        include_for: list[str] | None = None
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            if include_subagents:
                target = await self.agent_store.get_by_name(session, agent_name)
                if target is None:
                    raise ValueError(
                        f"Failed to invite agent: unknown agent {agent_name}"
                    )
                include_for = [target.id]
        try:
            await self.room_service.add_agents_to_room(
                room_id, agent_names=[agent_name], include_subagents_for=include_for
            )
        except ValueError as e:
            raise ValueError(f"Failed to invite agent: {str(e)}") from e

    async def add_users_to_room(
        self,
        agent_id: str,
        room_id: str,
        user_names: list[str],
    ) -> list[str]:
        """Add human users to an existing bridged room. Requires write access.

        The room must already be bridged; each name is resolved against the
        room's bridge, added to its external channel, and joined to the Matrix
        room. Returns the names that could not be resolved on the bridge (these
        were skipped); an empty list means every requested user was added.
        """
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
        try:
            return await self.room_service.add_users_to_room(room_id, user_names)
        except ValueError as e:
            raise ValueError(f"Failed to add users: {str(e)}") from e

    async def _resolve_acting_identity(
        self, session: AsyncSession, agent_id: str
    ) -> tuple[Agent, str | None, bool]:
        """Look up the calling agent + its owner's admin status.

        Returns ``(agent, owner_id, owner_is_admin)``. Used by moderation
        methods that perform resource-access checks on the agent's behalf.
        """
        agent = await self.agent_store.get(session, agent_id)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_id}")
        owner_is_admin = False
        if agent.owner_id is not None:
            owner = await session.get(User, agent.owner_id)
            owner_is_admin = owner is not None and owner.role == "admin"
        return agent, agent.owner_id, owner_is_admin

    async def _require_room_action(
        self, session: AsyncSession, agent_id: str, room_id: str, action: Action
    ) -> Room:
        """Authorize a room mutation on the calling agent's behalf.

        The agent acts as its owner; the room is loaded and checked via
        ``authz.require``. Raises ValueError if the room is missing and
        PermissionError if the owner lacks the right.
        """
        _agent, owner_id, owner_is_admin = await self._resolve_acting_identity(
            session, agent_id
        )
        room = await self.room_store.get(session, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        require(Principal(owner_id, owner_is_admin), action, room)
        return room

    # ── Room roles ──────────────────────────────────────────────────────────

    async def define_room_role(
        self,
        agent_id: str,
        room_id: str,
        name: str,
        instructions: str,
        exclusive: bool,
    ) -> None:
        """Define a new role in a room. Requires write access to the room."""
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.room_role_store.define_role(
                session, room_id, name, instructions, exclusive
            )
            await session.commit()

    async def edit_room_role(
        self,
        agent_id: str,
        room_id: str,
        name: str,
        instructions: str | None,
        exclusive: bool | None,
    ) -> None:
        """Edit a role's instructions/exclusivity. Requires write access.

        Edits take effect on the next assume; current holders keep what they
        already received.
        """
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.room_role_store.edit_role(
                session, room_id, name, instructions, exclusive
            )
            await session.commit()

    async def delete_room_role(self, agent_id: str, room_id: str, name: str) -> None:
        """Delete a role (and any lease on it). Requires write access."""
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.room_role_store.delete_role(session, room_id, name)
            await session.commit()

    async def _build_role_entries(
        self,
        session: AsyncSession,
        room_id: str,
        agent_id: str,
        roles: list[RoomRole],
        *,
        truncate: bool,
    ) -> list[dict[str, Any]]:
        """Build role descriptors with live holders and per-caller assumability.

        Shared by `list_room_roles` (`truncate=True`, yields a 200-char
        `instructions_preview`) and `get_room_role` (`truncate=False`, yields
        the full `instructions`). `held_by` is a list of holder objects (empty
        if free; a shared role may have several), each shaped as::

            {"name": <agent name>,
             "present_here": <bool>,
             "session_room": <room name> | null}

        `present_here` is True when the holder's assuming session is currently
        connected to *this* room; otherwise `session_room` names the room that
        session is looking at right now (a role lease survives room hops, so a
        holder can be live yet attending another room), or is null when no
        bound session can be located. `assumable_by_me` is True when the caller
        could `assume_role` it right now: the caller holds no other live lease,
        and the role is either non-exclusive or not live-held by someone else.
        """
        alive = self.connections.live_agent_ids()
        leases = await self.room_role_store.live_leases_for_room(
            session, room_id, alive
        )
        my_lease = await self.room_role_store.get_agent_live_lease(
            session, agent_id, alive
        )
        # Resolve holder agent ids → names.
        holder_names: dict[str, str] = {}
        for lease_list in leases.values():
            for lease in lease_list:
                if lease.agent_id in holder_names:
                    continue
                holder = await self.agent_store.get(session, lease.agent_id)
                if holder is not None:
                    holder_names[lease.agent_id] = holder.name
        # Locate each holder's assuming session (cache room id → name).
        room_name_cache: dict[str, str] = {}

        async def _locate(lease: RoleLease) -> tuple[bool, str | None]:
            """Return (present_here, session_room_name) for a lease."""
            if lease.transport_session_id is None:
                return False, None
            # A live connection knows its own rooms and has no binding row; the
            # row is only there for callers that predate connections.
            connection = self.connections.get(lease.transport_session_id)
            if connection is not None:
                if len(connection.rooms) != 1:
                    return False, None
                conn_room_id = next(iter(connection.rooms))
            else:
                conn = await self.agent_session_store.get_connected_room(
                    session, lease.transport_session_id
                )
                if conn is None:
                    return False, None
                conn_room_id = conn[1]
            if conn_room_id == room_id:
                return True, None
            if conn_room_id not in room_name_cache:
                room = await self.room_store.get(session, conn_room_id)
                room_name_cache[conn_room_id] = (
                    room.name if room is not None else conn_room_id
                )
            return False, room_name_cache[conn_room_id]

        holders_by_role: dict[str, list[dict[str, Any]]] = {}
        for role_id, lease_list in leases.items():
            entries: list[dict[str, Any]] = []
            for lease in lease_list:
                name = holder_names.get(lease.agent_id)
                if name is None:
                    continue
                present_here, session_room = await _locate(lease)
                entries.append(
                    {
                        "name": name,
                        "present_here": present_here,
                        "session_room": session_room,
                    }
                )
            holders_by_role[role_id] = entries

        result: list[dict[str, Any]] = []
        for role in roles:
            held_entries = holders_by_role.get(role.id, [])
            held_by_ids = [lease.agent_id for lease in leases.get(role.id, [])]
            held_by_me = my_lease is not None and my_lease.role_id == role.id
            holds_other = my_lease is not None and not held_by_me
            blocked_exclusive = role.exclusive and any(
                hid != agent_id for hid in held_by_ids
            )
            entry: dict[str, Any] = {
                "name": role.name,
                "exclusive": role.exclusive,
                "held_by": held_entries,
                "assumable_by_me": not holds_other and not blocked_exclusive,
            }
            if truncate:
                entry["instructions_preview"] = role.instructions[:200]
            else:
                entry["instructions"] = role.instructions
            result.append(entry)
        return result

    async def list_room_roles(
        self, agent_id: str, room_id: str
    ) -> list[dict[str, Any]]:
        """List a room's roles with live holders and per-caller assumability.

        Each entry carries a 200-char `instructions_preview`; use
        `get_room_role` for a single role's full untruncated instructions. See
        `_build_role_entries` for the `held_by` / `assumable_by_me` semantics.
        """
        async with self.session_factory() as session:
            roles = await self.room_role_store.list_roles(session, room_id)
            return await self._build_role_entries(
                session, room_id, agent_id, roles, truncate=True
            )

    async def get_room_role(
        self, agent_id: str, room_id: str, role_name: str
    ) -> dict[str, Any]:
        """Get one role's FULL untruncated instructions plus live holders.

        Unlike `list_room_roles` (and the role entries in `get_room_detail`),
        which truncate to a 200-char `instructions_preview`, this returns the
        complete `instructions`. Requires the caller to be a member of the
        room. Raises ValueError if no role with `role_name` exists in the room.
        See `_build_role_entries` for the `held_by` / `assumable_by_me`
        semantics.
        """
        await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            role = await self.room_role_store.get_role(session, room_id, role_name)
            if role is None:
                raise ValueError(f"Role '{role_name}' not found in this room")
            entries = await self._build_role_entries(
                session, room_id, agent_id, [role], truncate=False
            )
            return entries[0]

    async def assume_room_role(
        self,
        agent_id: str,
        room_id: str,
        role_name: str,
        transport_session_id: str | None,
    ) -> dict[str, Any]:
        """Assume a role, acquiring its lease. Returns the role instruction delta.

        Requires room membership. Rejects if the caller already holds a lease,
        or if the role is exclusive and live-held by another agent.
        """
        async with self.session_factory() as session:
            # Membership check (assume is open to any member; exclusivity is the
            # only gate beyond that).
            room = await self.require_room_member(agent_id, room_id)
            role = await self.room_role_store.get_role(session, room_id, role_name)
            if role is None:
                raise ValueError(f"Role '{role_name}' not found in this room")
            alive = self.connections.live_agent_ids()
            prior = await self.room_role_store.get_agent_live_lease(
                session, agent_id, alive
            )
            already_held = prior is not None and prior.role_id == role.id
            await self.room_role_store.acquire_lease(
                session, role, agent_id, transport_session_id, alive
            )
            await session.commit()
            result = {"role": role.name, "instructions": role.instructions}
            resolved_name = role.name
        if not already_held:
            await self._post_role_change_notice(
                agent_id, room.matrix_room_id, f"assumed the `{resolved_name}` role"
            )
        return result

    async def release_room_role(self, agent_id: str) -> None:
        """Release the caller's role lease, if any. Idempotent.

        If a live lease is dropped, announce the release in its room.
        """
        async with self.session_factory() as session:
            live = await self.room_role_store.get_agent_live_lease(
                session, agent_id, self.connections.live_agent_ids()
            )
            released_role: str | None = None
            matrix_room_id: str | None = None
            if live is not None:
                released_role = await self.room_role_store.agent_room_role(
                    session, live.room_id, agent_id, self.connections.live_agent_ids()
                )
                room = await self.room_store.get(session, live.room_id)
                matrix_room_id = room.matrix_room_id if room is not None else None
            await self.room_role_store.release_lease(session, agent_id)
            await session.commit()
        if released_role is not None and matrix_room_id is not None:
            await self._post_role_change_notice(
                agent_id, matrix_room_id, f"released the `{released_role}` role"
            )

    async def touch_role_lease(self, agent_id: str) -> bool:
        """Refresh the caller's role-lease heartbeat. Returns False if none held."""
        async with self.session_factory() as session:
            refreshed = await self.room_role_store.touch_lease(session, agent_id)
            await session.commit()
            return refreshed

    async def touch_connection(self, agent_id: str, room_id: str) -> None:
        """Refresh a session_addressable agent's room-scoped liveness heartbeat.

        Called on a fast cadence (every ~2s) by the channel process for the
        room it is currently connected to, decoupled from the long-poll. This
        is the authoritative liveness signal for session_addressable agents,
        letting AgentSessionStore.SESSION_TTL stay short so a closed/crashed
        session drops to "no session" within seconds.
        """
        await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            await self.agent_session_store.touch_heartbeat(session, agent_id, room_id)
            await session.commit()

    async def list_reference_types(self, agent_id: str) -> list[dict[str, Any]]:
        """Enumerate the Reference types the calling agent may pick from.

        The set is per-caller: every built-in, plus every user-defined type
        the agent's owner can read. Each entry carries `type`,
        `display_name`, `instructions`, `value_schema`, `value_hint` and
        `origin`. Used by agents preparing a `create_reference` call.

        An ownerless agent resolves as an anonymous principal and sees the
        built-ins plus the public types; reading the list needs no owner.
        """
        async with self.session_factory() as session:
            _agent, owner_id, is_admin = await self._resolve_acting_identity(
                session, agent_id
            )
            views = await self.resource_service.list_reference_types_for_principal(
                session, user_id=owner_id, is_admin=is_admin
            )
        return [
            view.spec.to_public_dict(origin="builtin" if view.is_builtin else "user")
            for view in views
        ]

    async def create_reference(
        self,
        agent_id: str,
        *,
        type: str,
        name: str,
        description: str,
        instructions: str,
        value: dict[str, Any],
        read_visibility: str = "private",
        write_visibility: str = "private",
    ) -> Reference:
        """Create a Reference owned by the calling agent's user.

        Raises ValueError on validation failure or if the agent has no
        owner (anonymous agents cannot own resources).
        """
        async with self.session_factory() as session:
            _agent, owner_id, is_admin = await self._resolve_acting_identity(
                session, agent_id
            )
            if owner_id is None:
                raise ValueError(
                    f"Agent {agent_id} has no owner_id and cannot own a reference"
                )
            ref = await self.resource_service.create_reference(
                session,
                owner_id=owner_id,
                is_admin=is_admin,
                read_visibility=read_visibility,
                write_visibility=write_visibility,
                type=type,
                name=name,
                description=description,
                instructions=instructions,
                value=value,
            )
            await session.commit()
        return ref

    async def attach_reference_to_room_as_agent(
        self, agent_id: str, room_id: str, reference_id: str
    ) -> None:
        """Attach an existing Reference to a room on the agent's behalf.

        This is the ``attach = read(reference) AND write(room)`` composition:
        the agent's owner must be able to read the reference *and* write the
        room.
        """
        async with self.session_factory() as session:
            _agent, owner_id, is_admin = await self._resolve_acting_identity(
                session, agent_id
            )
            if owner_id is None:
                raise ValueError(
                    f"Agent {agent_id} has no owner_id and cannot attach references"
                )
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.resource_service.attach_reference_to_room(
                session,
                room_id,
                reference_id,
                user_id=owner_id,
                is_admin=is_admin,
            )
            await session.commit()

    async def list_all_references(
        self,
        agent_id: str,
        name_contains: str | None,
        type: str | None,
        owner_name: str | None,
        current_room_id: str | None,
    ) -> list[dict[str, Any]]:
        """List the references the agent's owner may read, across the instance.

        Filters are ANDed; a None filter is ignored. `owner_name` is matched
        against the resolved owner name exactly, like `list_agents`, so a name
        no user carries yields an empty list. Rows carry no `value`: this is
        discovery, and the value arrives via `list_references` once attached.

        When `current_room_id` is given, each row reports whether it is already
        attached to that room; when it is None the key is left out entirely, so
        an absent key never reads as "not attached".
        """
        async with self.session_factory() as session:
            _agent, owner_id, owner_is_admin = await self._resolve_acting_identity(
                session, agent_id
            )
            if owner_id is None:
                raise ValueError(
                    f"Agent {agent_id} has no owner_id and cannot list references"
                )
            pairs = await self.resource_service.list_references_with_owner_names(
                session,
                owner_id,
                is_admin=owner_is_admin,
                name_contains=name_contains,
                type=type,
                owner_name=owner_name,
            )
            attached_ids: set[str] | None = None
            if current_room_id is not None:
                attached_ids = await self.resource_service.list_room_reference_ids(
                    session, current_room_id
                )
            return [
                self.resource_service.reference_to_summary(
                    ref,
                    name,
                    attached_to_current_room=None
                    if attached_ids is None
                    else ref.id in attached_ids,
                )
                for ref, name in pairs
            ]

    async def link_rooms(
        self,
        agent_id: str,
        source_room_id: str,
        target_room_id: str,
        label: str,
    ) -> dict[str, Any]:
        """Create a directed link from source_room_id → target_room_id.

        Requires write access to the source room.
        """
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, source_room_id, "write")
            result = await self.resource_service.attach_linked_room(
                session,
                source_room_id=source_room_id,
                target_room_id=target_room_id,
                label=label,
            )
            await session.commit()
        return result

    async def unlink_rooms(
        self,
        agent_id: str,
        source_room_id: str,
        target_room_id: str,
    ) -> None:
        """Remove the directed link from source_room_id → target_room_id.

        The inverse of ``link_rooms``. Raises LookupError if no such link
        exists, so the caller gets a clear error rather than a silent no-op.

        Requires write access to the source room.
        """
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, source_room_id, "write")
            removed = await self.resource_service.detach_linked_room(
                session,
                source_room_id=source_room_id,
                target_room_id=target_room_id,
            )
            if not removed:
                raise LookupError(f"No link from {source_room_id} to {target_room_id}")
            await session.commit()

    async def list_all_rooms(
        self, agent_id: str, *, include_archived: bool = False
    ) -> list[Room]:
        """List all rooms (moderation only).

        Archived rooms are excluded unless `include_archived` is set.
        """
        async with self.session_factory() as session:
            rooms = await self.room_store.get_all(
                session, include_archived=include_archived
            )
        return rooms

    async def list_room_groups(self, agent_id: str) -> list[dict[str, Any]]:
        """List every room group on the instance, with room counts and paths.

        Returns dicts of ``{id, name, description, parent_group_id, room_count,
        path}`` where `path` is the root-first ancestry (e.g. "Parent / Child")
        and `room_count` is the number of rooms directly in that group.
        """
        async with self.session_factory() as session:
            result = await session.execute(select(RoomGroup))
            groups = list(result.scalars().all())
            count_rows = await session.execute(
                select(Room.group_id, func.count(Room.id))
                .where(Room.group_id.is_not(None))
                .group_by(Room.group_id)
            )
            counts = {gid: c for gid, c in count_rows.all() if gid is not None}

        by_id = {g.id: g for g in groups}

        def path_of(group_id: str) -> str:
            names: list[str] = []
            cursor: str | None = group_id
            seen: set[str] = set()
            while cursor is not None and cursor not in seen:
                seen.add(cursor)
                g = by_id.get(cursor)
                if g is None:
                    break
                names.append(g.name)
                cursor = g.parent_group_id
            return " / ".join(reversed(names))

        out = [
            {
                "id": g.id,
                "name": g.name,
                "description": g.description,
                "parent_group_id": g.parent_group_id,
                "room_count": counts.get(g.id, 0),
                "path": path_of(g.id),
            }
            for g in groups
        ]
        out.sort(key=lambda d: str(d["path"]))
        return out

    async def _room_group_path(self, session: AsyncSession, group: RoomGroup) -> str:
        """Root-first ancestry path for a single group (e.g. "Parent / Child")."""
        names: list[str] = []
        cursor: RoomGroup | None = group
        seen: set[str] = set()
        while cursor is not None and cursor.id not in seen:
            seen.add(cursor.id)
            names.append(cursor.name)
            parent_id = cursor.parent_group_id
            cursor = (
                await self.room_group_store.get(session, parent_id)
                if parent_id is not None
                else None
            )
        return " / ".join(reversed(names))

    async def create_room_group(
        self,
        agent_id: str,
        name: str,
        description: str | None,
        color: str | None,
        parent_group_name: str | None,
    ) -> dict[str, Any]:
        """Create a room group, optionally nested under an existing parent
        (resolved by name). Returns the new group's detail dict.

        Raises ValueError if `parent_group_name` is unknown or ambiguous.
        """
        async with self.session_factory() as session:
            parent_group_id = await self._resolve_group_name(session, parent_group_name)
            group = await self.room_group_store.create(
                session,
                name=name,
                description=description,
                color=color,
                parent_group_id=parent_group_id,
            )
            result: dict[str, Any] = {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "color": group.color,
                "parent_group_id": group.parent_group_id,
                "room_count": 0,
                "path": await self._room_group_path(session, group),
                "member_rooms": [],
                "child_groups": [],
            }
            await session.commit()
        return result

    async def get_room_group_detail(
        self, agent_id: str, group_id: str
    ) -> dict[str, Any]:
        """Return one room group's detail: its fields, ancestry path, the rooms
        directly in it, and its immediate child groups.

        Raises ValueError if the group does not exist.
        """
        async with self.session_factory() as session:
            group = await self.room_group_store.get(session, group_id)
            if group is None:
                raise ValueError(f"Room group not found: {group_id}")

            member_room_rows = await session.execute(
                select(Room.id, Room.name).where(Room.group_id == group_id)
            )
            member_rooms = [
                {"id": rid, "name": rname} for rid, rname in member_room_rows.all()
            ]

            child_rows = await session.execute(
                select(RoomGroup.id, RoomGroup.name).where(
                    RoomGroup.parent_group_id == group_id
                )
            )
            child_groups = [
                {"id": cid, "name": cname} for cid, cname in child_rows.all()
            ]

            return {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "color": group.color,
                "parent_group_id": group.parent_group_id,
                "room_count": len(member_rooms),
                "path": await self._room_group_path(session, group),
                "member_rooms": member_rooms,
                "child_groups": child_groups,
            }

    async def list_agents(
        self,
        agent_id: str,
        name_contains: str | None,
        owner_name: str | None,
        known_agent_type: str | None,
    ) -> list[dict[str, Any]]:
        """List agents on the instance as summary dicts, optionally filtered.

        Filters are ANDed; a None filter is ignored. `name_contains` is a
        case-insensitive substring on the agent name; `owner_name` and
        `known_agent_type` are exact matches. Sorted by name.
        """
        async with self.session_factory() as session:
            summaries = await list_agent_summaries(
                session,
                self.agent_store,
                self.user_store,
                name_contains=name_contains,
                owner_name=owner_name,
                known_agent_type=known_agent_type,
            )
        return [s.model_dump() for s in summaries]

    async def get_agent_detail(
        self, agent_id: str, target_agent_id: str
    ) -> AgentDetail:
        """Return full detail for `target_agent_id`, mirroring the gateway
        GET /agents/{id}. Readable by any authenticated agent.

        Raises ValueError if the target agent does not exist.
        """
        async with self.session_factory() as session:
            agent = await self.agent_store.get(session, target_agent_id)
            if agent is None:
                raise ValueError(f"Agent not found: {target_agent_id}")
            return await assemble_agent_detail(
                session,
                agent=agent,
                agent_store=self.agent_store,
                room_store=self.room_store,
                user_store=self.user_store,
                agent_session_store=self.agent_session_store,
                room_role_store=self.room_role_store,
                connections=self.connections,
            )

    async def update_agent_detail(
        self,
        agent_id: str,
        target_agent_id: str,
        options: dict[str, Any] | None,
        parent_agent_id: str | None,
        clear_parent: bool,
    ) -> AgentDetail:
        """Update a known-agent's editable fields and return its fresh detail.

        Mirrors the gateway PATCH /agents/{id}/options, with two differences:
        `options` is a PARTIAL payload merged over the agent's current options
        (only the keys provided are changed), and the agent's parent can be
        changed (`parent_agent_id`) or cleared (`clear_parent`).

        Authorization is owner-only: the calling agent's owner must match the
        target agent's owner. Raises ValueError if either agent is missing or
        for an invalid reparent; PermissionError if not the owner;
        AgentOptionsNotEditable if the agent has no known-agent type; and
        pydantic ValidationError if the merged options fail schema validation.
        """
        async with self.session_factory() as session:
            requester = await self.agent_store.get(session, agent_id)
            if requester is None:
                raise ValueError(f"Agent not found: {agent_id}")
            target = await self.agent_store.get(session, target_agent_id)
            if target is None:
                raise ValueError(f"Agent not found: {target_agent_id}")

            require_manage(Principal(requester.owner_id, False), target.owner_id)

            if options is not None:
                await apply_agent_options(
                    session, self.agent_store, target, options, merge=True
                )
            if clear_parent:
                await reparent_agent(session, self.agent_store, target, None)
            elif parent_agent_id is not None:
                await reparent_agent(session, self.agent_store, target, parent_agent_id)

            await session.commit()

            refreshed = await self.agent_store.get(session, target_agent_id)
            assert refreshed is not None
            return await assemble_agent_detail(
                session,
                agent=refreshed,
                agent_store=self.agent_store,
                room_store=self.room_store,
                user_store=self.user_store,
                agent_session_store=self.agent_session_store,
                room_role_store=self.room_role_store,
                connections=self.connections,
            )

    async def get_room_detail(
        self, agent_id: str, room_id: str
    ) -> RoomDetailDescriptor:
        """Get full detail for a room the agent is a member of.

        Raises PermissionError if the agent is not a member of the room.
        Membership is the only gate today; the broader capability/ACL model
        is the separate authorization rework.
        """
        await self.require_room_member(agent_id, room_id)

        async with self.session_factory() as session:
            room = await self.room_store.get(session, room_id)
            if room is None:
                raise ValueError(f"Room not found: {room_id}")

            agent_ids = await self.room_store.get_agent_ids(session, room_id)
            client_ids = await self.room_store.get_client_ids(session, room_id)

            id_to_name: dict[str, str] = {}
            for aid in agent_ids:
                agent = await self.agent_store.get(session, aid)
                if agent:
                    id_to_name[aid] = agent.name

            bridge_display_name: str | None = None
            connected_user_names: list[str] = []
            if room.bridge_id:
                bridge = await self.bridge_store.get(session, room.bridge_id)
                if bridge:
                    bridge_display_name = bridge.display_name
                ext_users = await self.external_user_store.get_by_bridge(
                    session, room.bridge_id
                )
                ext_client_to_name = {
                    eu.client_id: eu.external_username for eu in ext_users
                }
                connected_user_names = sorted(
                    ext_client_to_name[cid]
                    for cid in client_ids
                    if cid in ext_client_to_name
                )

            group_name, group_path = await self._group_labels(session, room.group_id)
            join_listener_ids = await self.room_store.get_join_event_listeners(
                session, room_id
            )
            alias_by_agent_id = await self.room_store.list_aliases(session, room_id)

        statuses = await self.get_agent_statuses_by_ids(room_id, agent_ids)
        roles = await self.list_room_roles(agent_id, room_id)
        agent_names = [id_to_name[aid] for aid in agent_ids if aid in id_to_name]
        aliases = {
            id_to_name[aid]: alias
            for aid, alias in alias_by_agent_id.items()
            if aid in id_to_name
        }
        agent_statuses = {
            id_to_name[aid]: statuses[aid].value
            for aid in agent_ids
            if aid in id_to_name and aid in statuses
        }

        return RoomDetailDescriptor(
            id=room.id,
            name=room.name,
            description=room.description,
            channel_type=room.channel_type,
            admin_mode=room.admin_mode,
            instructions=room.instructions,
            matrix_room_id=room.matrix_room_id,
            created_at=str(room.created_at),
            bridge_id=room.bridge_id,
            bridge_display_name=bridge_display_name,
            external_channel_id=room.external_channel_id,
            group_id=room.group_id,
            group_name=group_name,
            group_path=group_path,
            agent_names=agent_names,
            agent_statuses=agent_statuses,
            connected_user_names=connected_user_names,
            join_event_listeners=[
                id_to_name[aid] for aid in join_listener_ids if aid in id_to_name
            ],
            aliases=aliases,
            roles=roles,
            archived=room.archived_at is not None,
        )

    async def _set_room_alias(
        self,
        session: AsyncSession,
        room_id: str,
        agent_name: str,
        alias: str,
    ) -> None:
        """Set (or clear, with alias="") one agent's room alias, within an open
        session. Validates format + collisions against the room's current state;
        each call re-reads aliases so a batch sees prior sets in the same call.
        Raises ValueError for an unknown / non-member agent, AliasError on a bad
        or colliding alias.
        """
        agent = await self.agent_store.get_by_name(session, agent_name)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_name}")
        member_ids = await self.room_store.get_agent_ids(session, room_id)
        if agent.id not in member_ids:
            raise ValueError(f"Agent {agent_name} is not a member of this room")
        if alias == "":
            await self.room_store.set_alias(session, room_id, agent.id, None)
            return
        validate_alias_format(alias)
        agents = [
            a
            for aid in member_ids
            if (a := await self.agent_store.get(session, aid)) is not None
        ]
        roles = await self.room_role_store.list_roles(session, room_id)
        aliases_by_agent = await self.room_store.list_aliases(session, room_id)
        check_alias_collisions(
            alias,
            target_agent_id=agent.id,
            agent_names=[a.name for a in agents],
            role_names=[r.name for r in roles],
            aliases_by_agent=aliases_by_agent,
        )
        await self.room_store.set_alias(session, room_id, agent.id, alias)

    async def update_room(
        self,
        agent_id: str,
        room_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        admin_mode: bool | None = None,
        join_event_listeners: dict[str, bool] | None = None,
        bridge_id: str | None = None,
        channel_type: str | None = None,
        external_channel_id: str | None = None,
        aliases: dict[str, str] | None = None,
    ) -> RoomDetailDescriptor:
        """Update room attributes for a room the agent is a member of.

        Only fields passed as non-None are changed. Returns the full,
        updated room detail. Requires the agent to be a member of the room
        (to read the detail back) and to have write access to it.

        `join_event_listeners` is a partial map of agent name → whether that
        agent receives `room_join` events in this room; only named agents are
        changed, and each must already be a member.
        Passing ``bridge_id`` moves the room onto that collaboration bridge:
        a fresh external channel is provisioned there and the room's current
        agents are re-added, and the old bridge is detached (its external
        channel is left in place on its platform — see
        ``RoomService.change_bridge``). Human users are NOT carried over —
        their identities are bridge-specific, so they must be re-invited to the
        new channel manually. ``channel_type`` (``"channel_public"`` or
        ``"channel_private"``) sets the new channel's visibility; omit it to
        keep the room's current privacy. Pass ``external_channel_id`` to bind
        to an existing channel on the target bridge instead of provisioning a
        new one (ignored unless ``bridge_id`` is given). ``bridge_id`` is the
        move trigger — there is no way to remove a bridge through this call.
        """
        await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.room_store.update_fields(
                session,
                room_id,
                name=name,
                description=description,
                instructions=instructions,
                admin_mode=admin_mode,
            )
            settings_by_id: dict[str, bool] = {}
            if join_event_listeners:
                names = list(join_event_listeners.keys())
                agents = await self.agent_store.get_by_names(session, names)
                name_to_id = {a.name: a.id for a in agents}
                missing = [n for n in names if n not in name_to_id]
                if missing:
                    raise ValueError(f"Unknown agents: {', '.join(missing)}")
                settings_by_id = {
                    name_to_id[n]: v for n, v in join_event_listeners.items()
                }
            if aliases is not None:
                for agent_name, alias in aliases.items():
                    await self._set_room_alias(session, room_id, agent_name, alias)
            await session.commit()
        if settings_by_id:
            await self.room_service.set_join_event_listeners(room_id, settings_by_id)

        if bridge_id is not None:
            if channel_type is not None and channel_type not in (
                "channel_public",
                "channel_private",
            ):
                raise ValueError(
                    "channel_type must be 'channel_public' or 'channel_private'"
                )
            async with self.session_factory() as session:
                bridge = await self.bridge_store.get(session, bridge_id)
                if bridge is None:
                    raise ValueError(f"Bridge not found: {bridge_id}")
            await self.room_service.change_bridge(
                room_id,
                bridge_id=bridge_id,
                channel_type=channel_type,  # type: ignore[arg-type]
                external_channel_id=external_channel_id,
            )

        return await self.get_room_detail(agent_id, room_id)

    async def set_room_archived(
        self, agent_id: str, room_id: str, archived: bool
    ) -> RoomDetailDescriptor:
        """Archive or unarchive a room on the calling agent's behalf.

        Metadata-only and reversible — the Matrix room, members, and bridge
        channel are untouched; the room just leaves (or rejoins) the default
        active lists. Requires the agent to be a member of the room and to
        have write access to it.
        """
        await self.require_room_member(agent_id, room_id)
        async with self.session_factory() as session:
            await self._require_room_action(session, agent_id, room_id, "write")
            await self.room_store.set_archived(session, room_id, archived)
            await session.commit()
        return await self.get_room_detail(agent_id, room_id)

    async def list_all_agents(self, agent_id: str) -> list[Agent]:
        """List all agents (moderation only)."""
        async with self.session_factory() as session:
            agents = await self.agent_store.get_all(session)
        return agents

    async def pre_tool_call(
        self,
        agent_id: str,
        room_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        request_id: str,
        timeout: float,
    ) -> dict[str, Any]:
        """Request mediation before tool call. Returns verdict and reason."""
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.mediation.tool_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "tool_id": tool_name,
                "args": arguments,
                "status": "pending",
            },
        )

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.request_tracker.cancel(request_id)
            raise ValueError("Mediation verdict timed out")

        return {"verdict": result.verdict, "reason": result.reason}

    async def pre_llm_request(
        self,
        agent_id: str,
        room_id: str,
        model: str,
        messages: list[dict[str, Any]],
        request_id: str,
        timeout: float,
    ) -> dict[str, Any]:
        """Request mediation before LLM request. Returns verdict and reason."""
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.mediation.llm_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "model_id": model,
                "messages": messages,
                "status": "pending",
            },
        )

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.request_tracker.cancel(request_id)
            raise ValueError("Mediation verdict timed out")

        return {"verdict": result.verdict, "reason": result.reason}

    async def post_tool_result(
        self,
        agent_id: str,
        room_id: str,
        tool_name: str,
        result: Any,
        request_id: str,
        timeout: float,
    ) -> dict[str, Any]:
        """Request mediation after tool result. Returns verdict."""
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        rm_clients = self.client_lifecycle.get_by_type("resource_manager")
        if not rm_clients:
            raise ValueError("Resource manager client not running")
        rm = rm_clients[0]
        if rm.nio_client is None:
            raise ValueError("Resource manager client not connected")

        future = self.request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await rm.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.mediation.tool_result",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "tool_id": tool_name,
                "result": result,
                "status": "ok",
            },
        )

        try:
            med_result = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.request_tracker.cancel(request_id)
            raise ValueError("Mediation verdict timed out")

        return {"verdict": med_result.verdict}

    async def list_room_resources(self, room_id: str) -> dict[str, Any]:
        """Return the {reference_types, references, documents} payload for a
        room. Used by ``connect_to_room`` and the ``list_references`` MCP tool.
        Caller is responsible for verifying agent membership first."""
        async with self.session_factory() as session:
            return await self.resource_service.list_room_resources(session, room_id)

    async def request_document_load(
        self,
        agent_id: str,
        room_id: str,
        document_ids: list[str],
        request_id: str,
        timeout: float,
    ) -> list[dict[str, Any]]:
        """Dispatch a com.switch.resource.load_request as the agent and await
        the resource manager's response. Raises on error / timeout."""
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise ValueError("Agent client not running")
        if client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.resource_request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.resource.load_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "document_ids": document_ids,
            },
        )

        from switch_core.bridges.resource.events import ResourceLoadResponse

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.resource_request_tracker.cancel(request_id)
            raise ValueError("Resource load timed out") from None

        if not isinstance(response, ResourceLoadResponse):
            raise ValueError(f"Unexpected response type: {type(response).__name__}")
        if response.status != "ok":
            raise ValueError(response.error or "Resource manager returned an error")
        return [d.model_dump(mode="json") for d in response.documents]

    async def request_room_document_create(
        self,
        *,
        agent_id: str,
        room_id: str,
        name: str,
        description: str,
        instructions: str,
        content: str,
        request_id: str,
        timeout: float,
    ) -> str:
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None or client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.resource_request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.resource.room_document_create_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "name": name,
                "description": description,
                "instructions": instructions,
                "content": content,
            },
        )

        from switch_core.bridges.resource.events import RoomDocumentCreateResponse

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.resource_request_tracker.cancel(request_id)
            raise ValueError("Room document create timed out") from None

        if not isinstance(response, RoomDocumentCreateResponse):
            raise ValueError(f"Unexpected response type: {type(response).__name__}")
        if response.status != "ok" or response.document_id is None:
            raise ValueError(response.error or "Resource manager returned an error")

        await self._post_agent_notice(
            client,
            room.matrix_room_id,
            f"📄 created room document “{response.document_name or name}”.",
        )
        return response.document_id

    async def request_room_document_update(
        self,
        *,
        agent_id: str,
        room_id: str,
        document_id: str,
        name: str | None,
        description: str | None,
        instructions: str | None,
        content: str | None,
        request_id: str,
        timeout: float,
    ) -> None:
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None or client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.resource_request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.resource.room_document_update_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "document_id": document_id,
                "name": name,
                "description": description,
                "instructions": instructions,
                "content": content,
            },
        )

        from switch_core.bridges.resource.events import RoomDocumentUpdateResponse

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.resource_request_tracker.cancel(request_id)
            raise ValueError("Room document update timed out") from None

        if not isinstance(response, RoomDocumentUpdateResponse):
            raise ValueError(f"Unexpected response type: {type(response).__name__}")
        if response.status != "ok":
            raise ValueError(response.error or "Resource manager returned an error")

        await self._post_agent_notice(
            client,
            room.matrix_room_id,
            f"📄 updated room document “{response.document_name or document_id}”.",
        )

    async def request_room_document_delete(
        self,
        *,
        agent_id: str,
        room_id: str,
        document_id: str,
        request_id: str,
        timeout: float,
    ) -> None:
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None or client.nio_client is None:
            raise ValueError("Agent client not connected")

        future = self.resource_request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await client.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.resource.room_document_delete_request",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "document_id": document_id,
            },
        )

        from switch_core.bridges.resource.events import RoomDocumentDeleteResponse

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.resource_request_tracker.cancel(request_id)
            raise ValueError("Room document delete timed out") from None

        if not isinstance(response, RoomDocumentDeleteResponse):
            raise ValueError(f"Unexpected response type: {type(response).__name__}")
        if response.status != "ok":
            raise ValueError(response.error or "Resource manager returned an error")

        await self._post_agent_notice(
            client,
            room.matrix_room_id,
            f"🗑 deleted room document “{response.document_name or document_id}”.",
        )

    async def post_llm_response(
        self,
        agent_id: str,
        room_id: str,
        model: str,
        response: Any,
        request_id: str,
        timeout: float,
    ) -> dict[str, Any]:
        """Request mediation after LLM response. Returns verdict."""
        import asyncio

        room = await self.require_room_member(agent_id, room_id)
        rm_clients = self.client_lifecycle.get_by_type("resource_manager")
        if not rm_clients:
            raise ValueError("Resource manager client not running")
        rm = rm_clients[0]
        if rm.nio_client is None:
            raise ValueError("Resource manager client not connected")

        future = self.request_tracker.register(
            request_id, agent_id, room.matrix_room_id
        )
        await rm.nio_client.room_send(
            room.matrix_room_id,
            "com.switch.mediation.llm_response",
            {
                "request_id": request_id,
                "agent_id": agent_id,
                "model_id": model,
                "response": response,
                "status": "ok",
            },
        )

        try:
            med_result = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self.request_tracker.cancel(request_id)
            raise ValueError("Mediation verdict timed out")

        return {"verdict": med_result.verdict}

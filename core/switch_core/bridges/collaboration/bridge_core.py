from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from nio import (
    DownloadError,
    MatrixRoom,
    RoomMessageMedia,
    RoomMessageText,
    RoomSendError,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.aliases import AliasError, validate_alias_format
from switch_core.attachments import parse_attachment_group
from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.models import (
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.clients.admin_messages import ADMIN_MARKER, AdminMessageType
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.mentions import mention_regex, strip_emphasis
from switch_core.db.models import BridgeMessageMap, ExternalUser
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.events import AgentRuntimeStateEvent
from switch_core.matrix_admin import MatrixAdmin
from switch_core.room_service import RoomCreateConfig

if TYPE_CHECKING:
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

# How long to wait for a freshly-invited external-user puppet to actually join a
# room before giving up on relaying its message.
PUPPET_JOIN_TIMEOUT = 30.0

# How long to hold an incomplete outbound attachment group before relaying the
# parts that arrived, flagged as incomplete (see _schedule_outbound_group_flush).
OUTBOUND_GROUP_TIMEOUT_SECONDS = 5.0


@dataclass
class _PendingOutboundGroup:
    """Files of a multi-attachment message seen so far, keyed by group index."""

    total: int
    parts: dict[int, OutboundAttachment] = field(default_factory=dict)
    caption: str | None = None
    first_event_id: str | None = None


# How long a queued runtime-indicator move waits before it runs, so a burst of
# messages to the same agent costs one move rather than one per message. Short
# enough that the indicator still reads as following the conversation.
_INDICATOR_MOVE_DELAY_SECONDS = 1.0

_LOBBY_DEPRECATION_NOTICE = (
    "👋 This isn't where you talk to agents — direct messages to the Switch "
    "app aren't routed to anyone. Head to a channel and @-mention an agent "
    "there to start collaborating."
)


def _no_agents_notice(slash_hint: str | None) -> str:
    """The agentless-room notice, carrying only the invite forms this bridge has.

    The `!` form works everywhere. The slash form does not — whether it exists
    at all, and how an argument is spelled, are both per-platform — so the
    adapter supplies that line, or none on a platform with no slash commands.
    """
    typed = "• `!invite-agent @agent-name` — type it here in the channel"
    invites = f"{typed}, or\n• {slash_hint}." if slash_hint else f"{typed}."
    return (
        "👋 I've linked this channel to a new Switch room, but there are no agents "
        "in it yet — so no one is here to respond to messages.\n\n"
        "**To add an agent**, invite one by name (swap in the agent you want):\n"
        f"{invites}\n\n"
        "Once an agent is in the room, @-mention it here and it'll pick up the "
        "conversation."
    )


class BridgeCore:
    def __init__(
        self,
        *,
        bridge_id: str,
        bridge_type: str,
        bridge_display_name: str,
        adapter: CollaborationAdapter,
        room_store: RoomStore,
        external_user_store: ExternalUserStore,
        bridge_message_map_store: BridgeMessageMapStore,
        agent_store: AgentStore,
        client_store: ClientStore,
        room_service: RoomService,
        client_lifecycle: ClientLifecycleService,
        matrix_admin: MatrixAdmin,
        session_factory: async_sessionmaker[AsyncSession],
        matrix_server_name: str,
        bridge_client_matrix_user_id: str,
        max_attachment_bytes: int,
    ) -> None:
        self._bridge_id = bridge_id
        self._bridge_type = bridge_type
        self._bridge_display_name = bridge_display_name
        self._adapter = adapter
        self._room_store = room_store
        self._external_user_store = external_user_store
        self._bridge_message_map_store = bridge_message_map_store
        self._agent_store = agent_store
        self._client_store = client_store
        self._room_service = room_service
        self._client_lifecycle = client_lifecycle
        self._matrix_admin = matrix_admin
        self._session_factory = session_factory
        self._matrix_server_name = matrix_server_name
        self._bridge_client_matrix_user_id = bridge_client_matrix_user_id
        self._max_attachment_bytes = max_attachment_bytes

        self._channel_to_room: dict[str, tuple[str, str]] = {}
        self._room_to_channel: dict[tuple[str, str], str] = {}
        self._user_puppets: dict[str, str] = {}
        self._puppet_matrix_ids: set[str] = set()
        self._channel_locks: dict[str, asyncio.Lock] = {}
        self._puppet_locks: dict[str, asyncio.Lock] = {}
        # Channels Switch is itself provisioning right now (outbound room
        # creation / bridge change). The bot auto-joins a channel the instant
        # it is created, which fires an inbound join before the room↔channel
        # mapping is committed — auto-room-creation for such a channel would
        # spawn a duplicate room. Handlers skip adoption while a channel is in
        # this set. See begin_provisioning / end_provisioning.
        self._provisioning_channels: set[str] = set()
        # Outbound multi-attachment messages still assembling, with their
        # safety-net timers. Cleared on completion or timeout so a group that
        # never completes cannot leak.
        self._outbound_groups: dict[str, _PendingOutboundGroup] = {}
        self._outbound_group_timers: dict[str, asyncio.TimerHandle] = {}
        # (channel_id, agent_name) whose runtime indicator is due to be moved
        # below newly-arrived traffic, and the thread each should land in.
        # See _schedule_indicator_move.
        self._indicator_move_timers: dict[tuple[str, str], asyncio.TimerHandle] = {}
        self._indicator_move_targets: dict[tuple[str, str], str | None] = {}
        # (channel_id, agent_name) -> the last message the agent reported having
        # been handed. Cleared when its turn ends. See _follow_reported_anchor.
        self._reported_anchors: dict[tuple[str, str], str] = {}
        # Identity provisioning runs in the background — see _create_agent_identities.
        self._identity_task: asyncio.Task[None] | None = None

    @property
    def adapter(self) -> CollaborationAdapter:
        return self._adapter

    async def start(self) -> None:
        await self._load_channel_map()
        await self._load_existing_puppets()
        self._adapter.set_channel_migration_handler(self._handle_channel_migrated)
        self._adapter.set_agent_icon_resolver(self._agent_icon_url)
        await self._adapter.start(
            on_message=self._handle_inbound_message,
            on_command=self._handle_inbound_command,
            on_agent_joined=self._handle_agent_joined_channel,
            on_user_joined=self._handle_user_joined_channel,
            on_app_joined=self._handle_app_joined_channel,
        )
        await self._ensure_channel_captures()
        # Deliberately not awaited. Provisioning is one call per agent against
        # the platform, and a rate-limited platform makes that minutes of
        # mostly waiting — which would hold up the bridge coming online, and
        # with it every other bridge behind it at startup and any request that
        # restarts one. Messages do not depend on it: an agent is addressable
        # by name whether or not its platform identity exists yet.
        self._identity_task = asyncio.create_task(self._run_agent_identities())

    async def stop(self) -> None:
        if self._identity_task and not self._identity_task.done():
            self._identity_task.cancel()
        self._identity_task = None
        await self._adapter.stop()

    # ── Startup loading ──────────────────────────────────────────────────────

    async def _load_channel_map(self) -> None:
        async with self._session_factory() as session:
            rooms = await self._room_store.get_by_bridge(session, self._bridge_id)
        for room in rooms:
            if room.external_channel_id:
                key = (room.id, room.matrix_room_id)
                self._channel_to_room[room.external_channel_id] = key
                self._room_to_channel[key] = room.external_channel_id

    async def _load_existing_puppets(self) -> None:
        async with self._session_factory() as session:
            users = await self._external_user_store.get_by_bridge(
                session, self._bridge_id
            )
            client_records = {
                user.client_id: await self._client_store.get(session, user.client_id)
                for user in users
            }

        self._adapter.prime_mention_targets(
            {user.external_username: user.external_user_id for user in users}
        )

        for user in users:
            self._user_puppets[user.external_user_id] = user.client_id

            client = self._client_lifecycle.get(user.client_id)
            if client is None:
                record = client_records.get(user.client_id)
                if record:
                    client = self._client_lifecycle.start_client(record)

            if client:
                self._puppet_matrix_ids.add(client.matrix_user_id)

    async def _run_agent_identities(self) -> None:
        """Wrapper for the background provisioning task.

        A bare create_task swallows whatever the coroutine raises, so anything
        escaping the per-agent handling below would vanish without trace.
        Cancellation is ordinary shutdown and says so quietly."""
        try:
            await self._create_agent_identities()
        except asyncio.CancelledError:
            logger.info(
                "%s identity provisioning cancelled before finishing",
                self._bridge_type,
            )
            raise
        except Exception:
            logger.exception(
                "%s identity provisioning stopped unexpectedly", self._bridge_type
            )

    async def _create_agent_identities(self) -> None:
        async with self._session_factory() as session:
            agents = await self._agent_store.get_all(session)

        failed = 0
        for agent in agents:
            try:
                await self._adapter.create_agent_identity(agent.name, agent.description)
            except Exception:
                failed += 1
                logger.exception(
                    "Failed to create %s identity for agent %s",
                    self._bridge_type,
                    agent.name,
                )

        # Counts calls that returned, not identities that now exist: an adapter
        # that cannot provision at all reports that itself. Reporting the agent
        # count regardless of failures would read as success on a run where
        # every one of them failed.
        if failed:
            logger.warning(
                "Provisioned %s identities for %d of %d agents; %d failed",
                self._bridge_type,
                len(agents) - failed,
                len(agents),
                failed,
            )
        else:
            logger.info(
                "Provisioned %s identities for %d agents",
                self._bridge_type,
                len(agents),
            )

    async def _ensure_channel_captures(self) -> None:
        """Ask the adapter to (re)establish server-side message capture for this
        bridge's channels. Runs on startup so capture self-heals after a restart
        or a notification-URL change (e.g. a rotated tunnel). A no-op for
        adapters that don't use expiring subscriptions."""
        async with self._session_factory() as session:
            rooms = await self._room_store.get_by_bridge(session, self._bridge_id)
        channels: list[tuple[str, str]] = []
        for room in rooms:
            if room.external_channel_id and room.channel_type:
                channels.append((room.external_channel_id, room.channel_type))
        if channels:
            await self._adapter.ensure_channel_subscriptions(channels)

    # ── Inbound (platform → room) ───────────────────────────────────────────

    async def _agent_icon_url(self, agent_name: str) -> str | None:
        """An agent's own icon URL, or None if it has not been given one.

        Installed on the adapter as its icon resolver; None sends the adapter
        to its existing default. A name matching no agent — an alias, or a bot
        the platform reports that Switch does not own — also yields None rather
        than an error, since the caller only wants to know whether to override.
        """
        async with self._session_factory() as session:
            agent = await self._agent_store.get_by_name(session, agent_name)
        return agent.icon_url if agent else None

    async def _is_registered_agent(self, name: str) -> bool:
        """Whether `name` is a registered Switch agent. Switch creates each
        bridge bot with username == agent name, so a bridged agent's bot
        account resolves here — letting us keep it out of the external-user
        path while leaving third-party bots and humans alone."""
        async with self._session_factory() as session:
            agent = await self._agent_store.get_by_name(session, name)
        return agent is not None

    async def _maybe_guide_self_mention(
        self, msg: InboundMessage, room_id: str
    ) -> None:
        """When a user tags the bridge bot itself but the bot is not an alias
        for any agent in this room, post guidance instead of letting the
        mention fall through silently. A bot mention that IS an alias routes to
        the aliased agent via the normal path, so it is left alone."""
        token = msg.self_mention_token
        if token is None:
            return
        async with self._session_factory() as session:
            if await self._room_store.get_agent_id_by_alias(session, room_id, token):
                return
            agent_ids = await self._room_store.get_agent_ids(session, room_id)
            agents: list[tuple[str, str]] = []
            for aid in agent_ids:
                agent = await self._agent_store.get(session, aid)
                if agent is not None:
                    agents.append((agent.name, agent.description))

        app_mention = self._adapter.render_app_mention(token)
        if agents:
            agent_list = "\n".join(
                f"• @{name} — {description}" for name, description in agents
            )
        else:
            agent_list = "_No agents are in this channel yet._"
        content = (
            f"👋 You tagged {app_mention} directly — I'm not linked to an agent "
            "in this channel yet.\n\n"
            f"**Agents you can tag directly:**\n{agent_list}"
        )
        # The `!set-alias` shortcut only makes sense when the bot handle is a
        # valid alias token. Some platforms (e.g. Teams) use a bot id containing
        # characters an alias can't hold (a `:`), so we omit the line there —
        # tagging an agent by name (above) works regardless.
        try:
            validate_alias_format(token)
        except AliasError:
            pass
        else:
            content += (
                "\n\n**To make me an agent's entry point**, copy the line below and "
                "swap in the agent's name — after that, tagging me here routes to "
                f"that agent:\n!set-alias @agent_name {app_mention}"
            )
        thread_root_id = msg.root_id or msg.message_ref
        await self._adapter.admin_message(
            msg.channel_id,
            content,
            thread_root_id,
            message_type=AdminMessageType.SELF_MENTION_UNALIASED.value,
        )

    async def _resolve_self_mention_target(
        self, msg: InboundMessage, room_id: str
    ) -> str | None:
        """The agent a bot @mention should address, or None.

        A bot mention resolves to an agent when the bot handle is that agent's
        room alias (matching Slack's behaviour), or — the common single-agent
        case — when the room holds exactly one agent. Zero or several unaliased
        agents are ambiguous, so we return None and let the caller post guidance.
        """
        token = msg.self_mention_token
        if token is None:
            return None
        async with self._session_factory() as session:
            agent_id = await self._room_store.get_agent_id_by_alias(
                session, room_id, token
            )
            if agent_id is None:
                agent_ids = await self._room_store.get_agent_ids(session, room_id)
                if len(agent_ids) == 1:
                    agent_id = agent_ids[0]
            if agent_id is None:
                return None
            agent = await self._agent_store.get(session, agent_id)
        return agent.name if agent is not None else None

    async def _handle_lobby_message(self, msg: InboundMessage) -> None:
        """The Slack app's DM ("lobby") is deprecated for talking to agents.
        Reply with a pointer to the onboarding docs instead of routing."""
        thread_root_id = msg.root_id or msg.message_ref
        await self._adapter.admin_message(
            msg.channel_id, _LOBBY_DEPRECATION_NOTICE, thread_root_id
        )

    async def _handle_inbound_message(self, msg: InboundMessage) -> None:
        logger.debug(
            "[BRIDGE-IN] channel=%s sender=%s content=%s",
            msg.channel_id,
            msg.sender_name,
            msg.content[:80],
        )
        if await self._is_registered_agent(msg.sender_name):
            # A bridged Switch agent's own message echoed back from the platform.
            # The agent posts natively on Matrix (that is where agents see each
            # other), so re-importing the echo would double-post it and spawn a
            # duplicate "user" identity for the agent. Drop it. Note
            # this is by *name*, so genuine third-party bots and humans still
            # bridge in normally.
            logger.debug(
                "[BRIDGE-IN] dropping echo from Switch agent %s", msg.sender_name
            )
            return
        if msg.channel_type == "lobby":
            # The Slack app's DM ("lobby") is deprecated as a place to talk to
            # agents: point the user at the docs instead of auto-creating a room
            # and routing the message. Only Slack im/mpim map to "lobby".
            await self._handle_lobby_message(msg)
            return
        room_ids = self._channel_to_room.get(msg.channel_id)
        if room_ids is None:
            lock = self._channel_locks.setdefault(msg.channel_id, asyncio.Lock())
            async with lock:
                room_ids = self._channel_to_room.get(msg.channel_id)
                if room_ids is None:
                    room_ids = await self._create_room_for_channel(
                        channel_id=msg.channel_id,
                        channel_type=msg.channel_type,
                        agent_name=msg.agent_name,
                        sender_name=msg.sender_name,
                        channel_name=msg.channel_name,
                    )
            if room_ids is None:
                return

        room_id, matrix_room_id = room_ids

        # A bot @mention carries no agent name in its text (the platform tags the
        # bot, not the agent). Resolve which agent it addresses so we can inject
        # an `@<agent>` the addressing layer matches on; if it can't be resolved,
        # fall back to guidance.
        mention_target: str | None = None
        if msg.self_mention_token is not None:
            mention_target = await self._resolve_self_mention_target(msg, room_id)
            if mention_target is None:
                await self._maybe_guide_self_mention(msg, room_id)

        await self._repair_placeholder_username(msg.sender_id, msg.sender_name)
        puppet = await self._ensure_user_in_matrix_room(
            external_user_id=msg.sender_id,
            external_username=msg.sender_name,
            room_id=room_id,
            matrix_room_id=matrix_room_id,
        )
        if puppet is None:
            return

        content = self._adapter.translate_inbound(msg.content)
        if mention_target is not None and (
            mention_regex(mention_target).search(strip_emphasis(content)) is None
        ):
            content = f"@{mention_target} {content}"
        logger.debug(
            "[BRIDGE-IN] sending to matrix room=%s via puppet=%s attachments=%d",
            matrix_room_id,
            puppet.matrix_user_id,
            len(msg.attachments),
        )

        # Bridge threads inbound: if the external post replied into a thread,
        # resolve that external root to the Matrix event we bridged for it.
        thread_root_id: str | None = None
        if msg.root_id is not None:
            thread_root_id = await self._matrix_event_for_external_post(msg.root_id)
            if thread_root_id is None:
                logger.warning(
                    "[BRIDGE-IN] no Matrix event mapped for external root %s; "
                    "posting top-level in room %s",
                    msg.root_id,
                    matrix_room_id,
                )

        # An attachment the platform offered but we could not relay must be
        # visible in the room, not swallowed. Append it to the message body so
        # both the agent and the humans see that a file went missing.
        if msg.attachment_failures:
            notes = "\n".join(
                f"_attachment not relayed: {failure.filename} — {failure.reason}_"
                for failure in msg.attachment_failures
            )
            content = f"{content}\n{notes}" if content.strip() else notes

        if not msg.attachments:
            event_id = await puppet.send_message(
                matrix_room_id,
                content,
                format="markdown",
                thread_root_id=thread_root_id,
            )
            if event_id is None:
                logger.error(
                    "[BRIDGE-IN] failed to relay message from %s into room %s — "
                    "it will not reach the room",
                    msg.sender_name,
                    matrix_room_id,
                )
                return
            # Record the correlation so a later reply (either direction) threads.
            await self._record_message_map(
                external_channel_id=msg.channel_id,
                matrix_event_id=event_id,
                external_post_id=msg.message_ref,
            )
            return

        # Caption convention: the text rides as the caption on the first
        # attachment so "text + one image" reaches the agent as a single event;
        # remaining attachments are sent as bare media events. The first media
        # event stands in for the post for threading / correlation purposes.
        caption = content if content.strip() else None
        first_event_id: str | None = None
        total = len(msg.attachments)
        # A platform post hands us all its files at once, so the group is known
        # up front — no waiting on the receiving side to learn how many to
        # expect. Matrix carries them as `total` events sharing this id.
        group_id = str(uuid.uuid4()) if total > 1 else None
        for index, attachment in enumerate(msg.attachments):
            mxc = await puppet.upload_media(
                attachment.data, attachment.mimetype, attachment.filename
            )
            msgtype = (
                "m.image" if attachment.mimetype.startswith("image/") else "m.file"
            )
            event_id = await puppet.send_media(
                matrix_room_id,
                mxc,
                attachment.filename,
                attachment.mimetype,
                len(attachment.data),
                msgtype=msgtype,
                caption=caption if index == 0 else None,
                thread_root_id=thread_root_id,
                group=(
                    {"id": group_id, "index": index, "total": total}
                    if group_id is not None
                    else None
                ),
            )
            if event_id is None:
                logger.error(
                    "[BRIDGE-IN] failed to relay attachment %s from %s into room %s",
                    attachment.filename,
                    msg.sender_name,
                    matrix_room_id,
                )
            if index == 0:
                first_event_id = event_id

        if first_event_id is not None:
            await self._record_message_map(
                external_channel_id=msg.channel_id,
                matrix_event_id=first_event_id,
                external_post_id=msg.message_ref,
            )

    async def _handle_inbound_command(self, cmd: InboundCommand) -> None:
        room_ids = self._channel_to_room.get(cmd.channel_id)
        if room_ids is None:
            logger.error("No room mapping for channel %s", cmd.channel_id)
            return
        room_id, matrix_room_id = room_ids

        puppet = await self._ensure_user_in_matrix_room(
            external_user_id=cmd.sender_id,
            external_username=cmd.sender_name,
            room_id=room_id,
            matrix_room_id=matrix_room_id,
        )
        if puppet is None:
            return

        # Where the command's result should thread. A command typed inside an
        # existing thread must thread under that thread's ROOT post (root_id) —
        # the command post itself is a mid-thread reply and a reply cannot be a
        # Mattermost RootId. A top-level command starts its own thread, rooted
        # at the command post (message_ref).
        thread_root_post = cmd.root_id or cmd.message_ref
        existing_matrix_root: str | None = None
        if thread_root_post is not None:
            existing_matrix_root = await self._matrix_event_for_external_post(
                thread_root_post
            )

        content: dict[str, object] = {
            "command": cmd.command,
            "args": cmd.args,
            "user_id": puppet.matrix_user_id,
            "user_name": cmd.sender_name,
        }
        # If the thread root is already bridged, relate the command event to it
        # so the result threads onto the existing Matrix root (which resolves
        # back to a valid Mattermost root post). Otherwise the command event
        # itself anchors the thread (mapping recorded below).
        if existing_matrix_root is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": existing_matrix_root,
            }

        resp = await puppet.client.room_send(
            matrix_room_id, "com.switch.command", content
        )

        if isinstance(resp, RoomSendError):
            logger.error(
                "Failed to bridge command %s into %s: %s",
                cmd.command,
                matrix_room_id,
                resp.message,
            )
            return

        # No bridged Matrix event for the thread root yet: map the command event
        # to it so a result threaded under the command resolves back to a valid
        # Mattermost root post (the command post for a top-level command, or the
        # thread root for an in-thread command whose root we hadn't recorded).
        if existing_matrix_root is None and thread_root_post is not None:
            await self._record_message_map(
                external_channel_id=cmd.channel_id,
                matrix_event_id=resp.event_id,
                external_post_id=thread_root_post,
            )

    async def _handle_agent_joined_channel(self, join: InboundAgentJoin) -> None:
        lock = self._channel_locks.setdefault(join.channel_id, asyncio.Lock())
        async with lock:
            await self._handle_agent_joined_channel_locked(join)

    async def _handle_agent_joined_channel_locked(self, join: InboundAgentJoin) -> None:
        logger.debug("Handling agent join to channel %s", join.channel_id)
        async with self._session_factory() as session:
            agent = await self._agent_store.get_by_name(session, join.agent_name)
        if agent is None:
            # Agent joins can arrive for a name we no longer recognise (e.g. a
            # stale bot->agent mapping in the adapter for a deleted agent). Skip
            # it rather than letting room provisioning fail on an unknown agent
            # name downstream.
            logger.warning(
                "Ignoring agent join for unknown agent '%s' on channel %s",
                join.agent_name,
                join.channel_id,
            )
            return
        existing = self._channel_to_room.get(join.channel_id)
        if existing is not None:
            logger.debug("Room already exist, add %s to channel", join.agent_name)
            room_id, _ = existing
            await self._room_service.add_agents_to_room(
                room_id, agent_names=[join.agent_name]
            )
            return

        await self._create_room_for_channel(
            channel_id=join.channel_id,
            channel_type=join.channel_type,
            agent_name=join.agent_name,
            channel_name=join.channel_name,
        )

    async def _handle_app_joined_channel(self, join: InboundAppJoin) -> None:
        """The bridge app itself was added to a channel. Auto-create the room
        immediately so the channel is bridged from the moment of invite — even
        if no agent can be associated (see _create_room_for_channel)."""
        lock = self._channel_locks.setdefault(join.channel_id, asyncio.Lock())
        async with lock:
            if self._channel_to_room.get(join.channel_id) is not None:
                logger.debug(
                    "App joined channel %s but room already exists", join.channel_id
                )
                return
            await self._create_room_for_channel(
                channel_id=join.channel_id,
                channel_type=join.channel_type,
                channel_name=join.channel_name,
            )

    async def _handle_channel_migrated(self, old_id: str, new_id: str) -> None:
        """The platform reissued a channel's id: move the room onto the new one.

        Only the id changes — it is the same conversation, with the same people
        and the same history — so the room follows it rather than a second room
        being created beside it. Without this the room stays bound to an id
        nothing arrives from again, while sends keep working because the
        platform forwards them: the bridge looks alive and is deaf.
        """
        lock = self._channel_locks.setdefault(old_id, asyncio.Lock())
        async with lock:
            async with self._session_factory() as session:
                room = await self._room_store.get_by_external_channel(
                    session, self._bridge_id, old_id
                )
                if room is None:
                    logger.info(
                        "Channel %s migrated to %s but no room is bound to it",
                        old_id,
                        new_id,
                    )
                    return
                occupant = await self._room_store.get_by_external_channel(
                    session, self._bridge_id, new_id
                )
                if occupant is not None:
                    # The unique index would reject the update anyway. Report it
                    # rather than leaving both rooms looking correct: one of them
                    # is bound to an id that is now dead.
                    logger.error(
                        "Channel %s migrated to %s, but room %s is already bound "
                        "to %s. Room %s is left on the old id and will not "
                        "receive anything from the chat",
                        old_id,
                        new_id,
                        occupant.id,
                        new_id,
                        room.id,
                    )
                    return
                await self._room_store.update_external_channel(session, room.id, new_id)
                await session.commit()

            key = (room.id, room.matrix_room_id)
            self._channel_to_room.pop(old_id, None)
            self._channel_to_room[new_id] = key
            self._room_to_channel[key] = new_id
            logger.warning(
                "Re-pointed room %s from channel %s to %s after the platform "
                "reissued the id",
                room.id,
                old_id,
                new_id,
            )

        await self._adapter.admin_message(
            new_id,
            "This chat has been given a new id by the platform. Its Switch room "
            "has been moved onto it, so messages here reach the agents again.",
        )

    # ── Auto-room creation ────────────────────────────────────────────────────

    async def _adopt_existing_room(self, channel_id: str) -> tuple[str, str] | None:
        """If a room already exists in the DB for this channel on this bridge,
        register it in the in-memory map and return its (room_id,
        matrix_room_id). Returns None if no such room exists. Idempotent."""
        async with self._session_factory() as session:
            room = await self._room_store.get_by_external_channel(
                session, self._bridge_id, channel_id
            )
        if room is None:
            return None
        self.add_room_mapping(room.id, room.matrix_room_id, channel_id)
        logger.debug("Adopted existing room %s for channel %s", room.id, channel_id)
        return (room.id, room.matrix_room_id)

    async def _create_room_for_channel(
        self,
        *,
        channel_id: str,
        channel_type: ChannelType,
        agent_name: str | None = None,
        sender_name: str | None = None,
        channel_name: str | None = None,
    ) -> tuple[str, str] | None:
        # Callers hold the per-channel lock. Guard against provisioning a
        # duplicate room for a channel that is already (or is being) bridged:
        #  1. Switch is itself provisioning this channel right now — the mapping
        #     is on its way; do not race it with a second room.
        #  2. A room already exists for this channel in the DB (committed by a
        #     concurrent create_room, or present since a prior run but not yet
        #     loaded into the in-memory map). Adopt it instead of creating.
        if channel_id in self._provisioning_channels:
            logger.debug(
                "Skipping auto-room-creation for channel %s: Switch is provisioning it",
                channel_id,
            )
            return self._channel_to_room.get(channel_id)

        existing = await self._adopt_existing_room(channel_id)
        if existing is not None:
            return existing

        agent_ids = await self._resolve_agents_for_channel(channel_id, channel_type)

        bridge_name = self._bridge_display_name
        if channel_type == "direct":
            parts = [p for p in (sender_name, agent_name) if p]
            label = " / ".join(parts) if parts else channel_id[:16]
            name = f"{bridge_name}: {label}"
            description = f"{bridge_name} DM — {label}"
        else:
            channel_label = channel_name or channel_id[:16]
            name = f"{bridge_name}: {channel_label}"
            description = f"Auto-bridged from {bridge_name} channel {channel_label}"

        config = RoomCreateConfig(
            name=name,
            description=description,
            agent_ids=agent_ids,
            channel_type=channel_type,
            bridge_id=self._bridge_id,
            external_channel_id=channel_id,
        )

        try:
            result = await self._room_service.create_room(config)
        except IntegrityError:
            # Backstop: the (bridge_id, external_channel_id) unique index
            # rejected a concurrent duplicate. Adopt the room that won the race.
            logger.warning(
                "Duplicate room creation for channel %s rejected by unique "
                "constraint; adopting existing room",
                channel_id,
            )
            adopted = await self._adopt_existing_room(channel_id)
            if adopted is None:
                logger.error(
                    "Unique constraint rejected room for channel %s but no "
                    "existing room found to adopt",
                    channel_id,
                )
            return adopted
        except Exception:
            logger.exception("Failed to auto-create room for channel %s", channel_id)
            return None
        room = result.room

        self.add_room_mapping(room.id, room.matrix_room_id, channel_id)
        logger.info(
            "Auto-created %s room %s for %s channel %s",
            channel_type,
            room.matrix_room_id,
            bridge_name,
            channel_id,
        )

        if not agent_ids:
            # create_room invited the bridge client before returning, so posting
            # now cannot predate its join. admin_message goes straight to the
            # channel via the platform API (not through Matrix), so it surfaces
            # regardless — but the ordering keeps the room consistent.
            logger.warning(
                "Auto-created room %s for channel %s has no agents", room.id, channel_id
            )
            await self._adapter.admin_message(
                channel_id,
                _no_agents_notice(self._adapter.slash_invite_hint()),
                message_type=AdminMessageType.NO_AGENTS,
            )

        return (room.id, room.matrix_room_id)

    async def _resolve_agents_for_channel(
        self, channel_id: str, channel_type: ChannelType
    ) -> list[str]:
        agent_names = await self._adapter.get_channel_agent_names(channel_id)

        async with self._session_factory() as session:
            if agent_names:
                agents = await self._agent_store.get_all(session)
                agent_by_name = {a.name: a.id for a in agents}
                return [agent_by_name[n] for n in agent_names if n in agent_by_name]

            agents = await self._agent_store.get_all(session)
            if channel_type == "lobby":
                return [a.id for a in agents]
            return []

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        """Map each requested username to its external user id on this bridge.

        Only resolvable names appear in the returned dict; names with no
        matching external user on this bridge are omitted (and logged), so the
        caller can diff against the input to learn which ones failed.
        """
        async with self._session_factory() as session:
            users = await self._external_user_store.get_by_bridge(
                session, self._bridge_id
            )
        name_to_ext_id = {u.external_username: u.external_user_id for u in users}
        resolved: dict[str, str] = {}
        for name in user_names:
            ext_id = name_to_ext_id.get(name)
            if ext_id:
                resolved[name] = ext_id
            else:
                logger.warning(
                    "No external user found for username '%s' on bridge %s",
                    name,
                    self._bridge_id,
                )
        return resolved

    async def resolve_external_user_ids(self, user_names: list[str]) -> list[str]:
        resolved = await self.resolve_external_user_id_map(user_names)
        return list(resolved.values())

    async def ensure_users_in_room(
        self,
        room_id: str,
        matrix_room_id: str,
        user_names: list[str],
    ) -> None:
        """For each known external user matching one of `user_names` on this
        bridge, ensure a running puppet client exists and is joined to the
        Matrix room. Names without an existing ExternalUser row are skipped
        — they will be picked up by the on_user_joined callback (when the
        adapter sees them join externally) or by the lazy inbound-message
        path."""
        async with self._session_factory() as session:
            users = await self._external_user_store.get_by_bridge_and_names(
                session, self._bridge_id, user_names
            )
        for ext_user in users:
            await self._ensure_user_in_matrix_room(
                external_user_id=ext_user.external_user_id,
                external_username=ext_user.external_username,
                room_id=room_id,
                matrix_room_id=matrix_room_id,
            )

    async def _ensure_user_in_matrix_room(
        self,
        *,
        external_user_id: str,
        external_username: str,
        room_id: str,
        matrix_room_id: str,
    ) -> ClientBase[ClientConfig] | None:
        """Get-or-create the puppet for this external user and ensure it has
        actually joined the room. Returns the running puppet, or None if it
        couldn't be brought up or didn't join in time. Idempotent."""
        client_id = self._user_puppets.get(external_user_id)
        if client_id is None:
            client_id = await self._create_puppet(external_user_id, external_username)
        puppet = self._client_lifecycle.get(client_id)
        if puppet is None:
            logger.error(
                "Puppet client %s not running for external user %s",
                client_id,
                external_user_id,
            )
            return None
        await puppet.wait_ready()
        try:
            await self._room_service.ensure_client_in_room(room_id, client_id)
        except Exception:
            logger.exception(
                "Failed to add puppet client %s to room %s", client_id, room_id
            )
            return None

        # ensure_client_in_room only *invites*; the puppet joins asynchronously
        # from its own sync loop. Sending before that join lands gets rejected by
        # the homeserver, so the message that triggered the provisioning would be
        # lost. Block until the join is observed.
        if not await puppet.wait_joined(matrix_room_id, PUPPET_JOIN_TIMEOUT):
            logger.error(
                "Puppet %s (external user %s) did not join room %s within %ss — "
                "cannot relay its message",
                puppet.matrix_user_id,
                external_user_id,
                matrix_room_id,
                PUPPET_JOIN_TIMEOUT,
            )
            return None
        return puppet

    async def _handle_user_joined_channel(self, join: InboundUserJoin) -> None:
        """Called by the adapter when an external user joins a bridged
        channel (e.g. someone adds louisa to a Mattermost channel via the
        Mattermost UI). Auto-creates the Switch room if the channel isn't
        mapped yet (same as the lazy inbound-message path), then ensures
        the puppet exists and is joined to the Matrix room."""
        if await self._is_registered_agent(join.external_username):
            # The account that joined is actually a bridged Switch agent (its
            # bot account), not an external user. Route it through the agent-join
            # path so it maps to a single agent participant instead of spawning a
            # duplicate "user" identity.
            await self._handle_agent_joined_channel(
                InboundAgentJoin(
                    channel_id=join.channel_id,
                    channel_type=join.channel_type,
                    agent_name=join.external_username,
                    channel_name=join.channel_name,
                )
            )
            return
        room_ids = self._channel_to_room.get(join.channel_id)
        if room_ids is None:
            lock = self._channel_locks.setdefault(join.channel_id, asyncio.Lock())
            async with lock:
                room_ids = self._channel_to_room.get(join.channel_id)
                if room_ids is None:
                    room_ids = await self._create_room_for_channel(
                        channel_id=join.channel_id,
                        channel_type=join.channel_type,
                        sender_name=join.external_username,
                        channel_name=join.channel_name,
                    )
            if room_ids is None:
                return
        room_id, matrix_room_id = room_ids
        await self._ensure_user_in_matrix_room(
            external_user_id=join.external_user_id,
            external_username=join.external_username,
            room_id=room_id,
            matrix_room_id=matrix_room_id,
        )

    # ── Puppet lifecycle ─────────────────────────────────────────────────────

    async def _repair_placeholder_username(
        self, external_user_id: str, resolved_username: str
    ) -> None:
        """Replace a stored name that is really a platform id, now we have one.

        Switch files someone under the name it first saw, and a platform that
        supplied none left its own id there — which then reads as that person's
        name in the room title, on their Matrix account and in every agent
        reply that addresses them. Repairing only on the way past means it costs
        nothing on the overwhelmingly common path where the stored name is fine,
        and needs no migration for the rows already written.

        Deliberately one-way: an id is replaced by a name, never the reverse,
        and a name is never replaced by another name. Renaming someone people
        have been addressing for weeks because a platform changed its mind about
        their display name would be worse than the problem.
        """
        if not resolved_username or not external_user_id:
            return
        if self._adapter.is_placeholder_username(resolved_username):
            return
        async with self._session_factory() as session:
            existing = await self._external_user_store.get_by_external_id(
                session, self._bridge_id, external_user_id
            )
            if existing is None or existing.external_username == resolved_username:
                return
            if not self._adapter.is_placeholder_username(existing.external_username):
                return
            logger.info(
                "Renaming external user %s from its %s id to '%s'",
                external_user_id,
                self._bridge_type,
                resolved_username,
            )
            await self._external_user_store.rename(
                session, existing.id, resolved_username
            )
            await session.commit()
            client_id = existing.client_id
        # The Matrix account keeps its localpart — that is an address, and
        # changing it would orphan the history — but its display name is what
        # people read.
        puppet = self._client_lifecycle.get(client_id)
        if puppet is not None:
            try:
                await puppet.set_display_name(resolved_username)
            except Exception:
                logger.warning(
                    "Renamed external user %s but could not update the display "
                    "name of its Matrix account",
                    external_user_id,
                    exc_info=True,
                )

    async def ensure_external_user(
        self, *, external_user_id: str, external_username: str
    ) -> ExternalUser:
        """Get-or-create the `ExternalUser` record for a platform identity,
        without waiting for that person to speak.

        The inbound path creates these lazily on first message, which leaves
        nobody to claim for a workspace that has only just been connected.
        Claiming an identity (CHOO-2137) needs the record to exist up front, so
        this provisions the same puppet the inbound path would have.
        """
        async with self._session_factory() as session:
            existing = await self._external_user_store.get_by_external_id(
                session, self._bridge_id, external_user_id
            )
        if existing is not None:
            return existing

        client_id = self._user_puppets.get(external_user_id)
        if client_id is None:
            client_id = await self._create_puppet(external_user_id, external_username)

        async with self._session_factory() as session:
            created = await self._external_user_store.get_by_client_id(
                session, client_id
            )
        if created is None:
            raise RuntimeError(
                f"Puppet for external user {external_user_id} on bridge "
                f"{self._bridge_id} was created without an ExternalUser record"
            )
        return created

    async def _create_puppet(
        self, external_user_id: str, external_username: str
    ) -> str:
        lock = self._puppet_locks.setdefault(external_user_id, asyncio.Lock())
        async with lock:
            existing = self._user_puppets.get(external_user_id)
            if existing is not None:
                return existing

            # Defence in depth against agent/user misdetection: a
            # bridged agent must never be puppeted as an external user. If the
            # name collides with a registered Switch agent, refuse loudly rather
            # than create a duplicate "user" identity for it.
            async with self._session_factory() as session:
                agent = await self._agent_store.get_by_name(session, external_username)
            if agent is not None:
                raise ValueError(
                    f"Refusing to create external-user puppet for '{external_username}'"
                    " on bridge "
                    f"{self._bridge_id}: name collides with a registered Switch agent"
                    " (likely a bridged agent bot misclassified as a user)"
                )

            sanitized = re.sub(r"[^a-z0-9_-]", "-", external_username.lower()).strip(
                "-"
            )
            # Scope to the bridge: the same username on two bridges of the same
            # type (e.g. two Slack workspaces) must map to distinct Matrix users,
            # since matrix_user_id is globally unique but usernames are not.
            localpart = f"switch-{self._bridge_type}-{self._bridge_id}-{sanitized}"

            client = await self._client_lifecycle.create_and_start(
                client_type="user",
                display_name=external_username,
                localpart=localpart,
            )

            ext_user = ExternalUser(
                bridge_id=self._bridge_id,
                external_user_id=external_user_id,
                external_username=external_username,
                client_id=client.client_id,
            )
            async with self._session_factory() as session:
                await self._external_user_store.create(session, ext_user)
                await session.commit()

            self._user_puppets[external_user_id] = client.client_id
            self._puppet_matrix_ids.add(client.matrix_user_id)
            self._adapter.prime_mention_targets({external_username: external_user_id})

            logger.info(
                "Created puppet %s for external user %s on bridge %s",
                client.matrix_user_id,
                external_user_id,
                self._bridge_id,
            )
            return client.client_id

    def _find_channel(
        self, room_id: str | None = None, matrix_room_id: str | None = None
    ) -> str | None:
        for (rid, mrid), channel_id in self._room_to_channel.items():
            if room_id and rid == room_id:
                return channel_id
            if matrix_room_id and mrid == matrix_room_id:
                return channel_id
        return None

    # ── Outbound (room → platform) ──────────────────────────────────────────

    async def handle_outbound_message(
        self, room: MatrixRoom, event: RoomMessageText
    ) -> None:
        logger.debug(
            "[BRIDGE-OUT] matrix event from=%s room=%s body=%s",
            event.sender,
            room.room_id,
            event.body[:80] if event.body else "",
        )
        if event.sender in self._puppet_matrix_ids:
            logger.debug("[BRIDGE-OUT] skipping puppet message from %s", event.sender)
            return
        if event.sender == self._bridge_client_matrix_user_id:
            logger.debug("[BRIDGE-OUT] skipping bridge client message")
            return

        channel_id = self._find_channel(matrix_room_id=room.room_id)
        if channel_id is None:
            logger.debug("[BRIDGE-OUT] no channel mapping for room %s", room.room_id)
            return

        event_content = event.source.get("content", {}) or {}
        admin_marker = event_content.get(ADMIN_MARKER)
        sender_name = event_content.get("sender_name")
        # An admin/system message renders natively per bridge (admin_message)
        # rather than on behalf of its Matrix sender, so it needs no sender_name.
        if sender_name is None and admin_marker is None:
            logger.error(
                "No sender_name in event from %s — skipping outbound", event.sender
            )
            return

        logger.debug(
            "[BRIDGE-OUT] sending to channel=%s sender=%s admin=%s",
            channel_id,
            sender_name,
            admin_marker is not None,
        )

        thread_root_ref = await self._outbound_thread_root_ref(
            event_content, channel_id
        )

        if admin_marker is not None:
            message_type = (
                admin_marker.get("type") if isinstance(admin_marker, dict) else None
            )
            # Raw, not translated: `admin_message` renders its own body, the
            # same way the notices posted directly through it do. Translating
            # here as well ran the body through twice, and the second pass
            # escapes the markup the first one produced — a command reply
            # arrived showing its own `<b>` tags.
            message_ref = await self._adapter.admin_message(
                channel_id,
                event.body,
                thread_root_ref,
                message_type=message_type,
            )
        else:
            assert sender_name is not None  # guarded above
            message_ref = await self._adapter.send_message(
                channel_id,
                sender_name,
                self._adapter.translate_outbound(event.body),
                thread_root_id=thread_root_ref,
            )

        if message_ref is not None:
            await self._record_message_map(
                external_channel_id=channel_id,
                matrix_event_id=event.event_id,
                external_post_id=message_ref,
            )

        if sender_name is not None:
            await self._move_indicator_for_sender(
                channel_id, sender_name, thread_root_ref
            )

    async def _outbound_thread_root_ref(
        self, event_content: dict[str, object], channel_id: str
    ) -> str | None:
        """Bridge threads outbound: if this Matrix message is a threaded reply,
        resolve its thread root to the external post that anchors the thread."""
        relates = event_content.get("m.relates_to") or {}
        if not isinstance(relates, dict) or relates.get("rel_type") != "m.thread":
            return None
        root_event_id = relates.get("event_id")
        if not root_event_id:
            return None
        thread_root_ref = await self._external_post_for_matrix_event(str(root_event_id))
        if thread_root_ref is None:
            logger.warning(
                "[BRIDGE-OUT] no external post mapped for thread root %s; "
                "posting top-level in channel %s",
                root_event_id,
                channel_id,
            )
        return thread_root_ref

    async def handle_outbound_media(
        self,
        room: MatrixRoom,
        event: RoomMessageMedia,
        client: ClientBase[Any],
    ) -> None:
        """Relay a Matrix media event (an agent-sent image/file) out to the
        external channel.

        Mirrors handle_outbound_message: puppet media is skipped (it originated
        on the platform), the caption convention is unpacked (a `filename` key
        means the body is a caption), and the relayed post is recorded in the
        message map so replies thread both ways. Any file type relays natively
        via the adapter; a file whose bytes can't be fetched or that exceeds the
        relay cap gets a disclosed text notice rather than a silent drop.

        A message carrying several files arrives as several Matrix events
        sharing a group marker; they are buffered here and relayed as ONE
        platform post. `client` is the bridge's Matrix client, used to fetch the
        media bytes.
        """
        logger.debug(
            "[BRIDGE-OUT] matrix media event from=%s room=%s body=%s",
            event.sender,
            room.room_id,
            event.body[:80] if event.body else "",
        )
        if event.sender in self._puppet_matrix_ids:
            return
        if event.sender == self._bridge_client_matrix_user_id:
            return

        channel_id = self._find_channel(matrix_room_id=room.room_id)
        if channel_id is None:
            logger.debug("[BRIDGE-OUT] no channel mapping for room %s", room.room_id)
            return

        event_content = event.source.get("content", {}) or {}
        sender_name = event_content.get("sender_name")
        if sender_name is None:
            logger.error(
                "No sender_name in media event from %s — skipping outbound",
                event.sender,
            )
            return
        sender_name = str(sender_name)

        thread_root_ref = await self._outbound_thread_root_ref(
            event_content, channel_id
        )

        # Caption convention (mirrors the inbound path): when a `filename` key
        # is present the event body is a caption; otherwise the body IS the
        # filename and there is no caption.
        explicit_filename = event_content.get("filename")
        filename = str(explicit_filename or event.body or "attachment")
        caption = event.body if explicit_filename else None

        info = event_content.get("info") or {}
        mimetype = str(
            (info.get("mimetype") if isinstance(info, dict) else None)
            or "application/octet-stream"
        )

        message_ref: str | None
        data = await self._download_matrix_media(client, event.url, filename)
        if data is None or len(data) > self._max_attachment_bytes:
            if data is not None:
                logger.warning(
                    "[BRIDGE-OUT] attachment %s is %d bytes, over the "
                    "%d-byte relay cap",
                    filename,
                    len(data),
                    self._max_attachment_bytes,
                )
            note = f"_sent an attachment that couldn't be relayed: {filename}_"
            body = f"{caption}\n{note}" if caption else note
            message_ref = await self._adapter.send_message(
                channel_id,
                sender_name,
                self._adapter.translate_outbound(body),
                thread_root_id=thread_root_ref,
            )
        else:
            # Part of a multi-file message? Hold it until the whole group has
            # arrived, then relay all of it as one platform post.
            group = parse_attachment_group(event_content)
            if group is not None:
                group_id, index, total = group
                pending = self._outbound_groups.setdefault(
                    group_id, _PendingOutboundGroup(total=total)
                )
                pending.parts[index] = OutboundAttachment(
                    filename=filename, mimetype=mimetype, data=data
                )
                if index == 0:
                    pending.caption = caption
                    pending.first_event_id = event.event_id
                if len(pending.parts) < total:
                    self._schedule_outbound_group_flush(
                        group_id, channel_id, sender_name, thread_root_ref
                    )
                    return
                self._cancel_outbound_group_flush(group_id)
                self._outbound_groups.pop(group_id, None)
                await self._relay_outbound_group(
                    pending, channel_id, sender_name, thread_root_ref
                )
                return

            message_ref = await self._adapter.send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption=caption,
                thread_root_id=thread_root_ref,
            )

        if message_ref is not None:
            await self._record_message_map(
                external_channel_id=channel_id,
                matrix_event_id=event.event_id,
                external_post_id=message_ref,
            )

        await self._move_indicator_for_sender(channel_id, sender_name, thread_root_ref)

    def _schedule_outbound_group_flush(
        self,
        group_id: str,
        channel_id: str,
        sender_name: str,
        thread_root_ref: str | None,
    ) -> None:
        """Arm the safety net for an incomplete outbound attachment group.

        A group normally completes immediately — the sender posts its events
        back-to-back. This timer guarantees that a batch that never completes
        still reaches the platform, flagged, instead of being held forever.

        Armed once per group, NOT re-armed per part, so the deadline bounds the
        whole group rather than the gap between parts.
        """
        if group_id in self._outbound_group_timers:
            return
        self._outbound_group_timers[group_id] = asyncio.get_running_loop().call_later(
            OUTBOUND_GROUP_TIMEOUT_SECONDS,
            lambda: asyncio.create_task(
                self._flush_incomplete_outbound_group(
                    group_id, channel_id, sender_name, thread_root_ref
                )
            ),
        )

    def _cancel_outbound_group_flush(self, group_id: str) -> None:
        timer = self._outbound_group_timers.pop(group_id, None)
        if timer is not None:
            timer.cancel()

    async def _flush_incomplete_outbound_group(
        self,
        group_id: str,
        channel_id: str,
        sender_name: str,
        thread_root_ref: str | None,
    ) -> None:
        self._outbound_group_timers.pop(group_id, None)
        pending = self._outbound_groups.pop(group_id, None)
        if pending is None:
            return
        received = len(pending.parts)
        logger.error(
            "[BRIDGE-OUT] attachment group %s incomplete: %d of %d parts arrived "
            "within %ss; relaying what arrived",
            group_id,
            received,
            pending.total,
            OUTBOUND_GROUP_TIMEOUT_SECONDS,
        )
        notice = (
            f"_incomplete attachment group: relaying {received} of "
            f"{pending.total} files_"
        )
        pending.caption = f"{pending.caption}\n{notice}" if pending.caption else notice
        await self._relay_outbound_group(
            pending, channel_id, sender_name, thread_root_ref
        )

    async def _relay_outbound_group(
        self,
        pending: _PendingOutboundGroup,
        channel_id: str,
        sender_name: str,
        thread_root_ref: str | None,
    ) -> None:
        message_ref = await self._adapter.send_attachments(
            channel_id,
            sender_name,
            [pending.parts[i] for i in sorted(pending.parts)],
            caption=pending.caption,
            thread_root_id=thread_root_ref,
        )
        if message_ref is not None and pending.first_event_id is not None:
            await self._record_message_map(
                external_channel_id=channel_id,
                matrix_event_id=pending.first_event_id,
                external_post_id=message_ref,
            )

        await self._move_indicator_for_sender(channel_id, sender_name, thread_root_ref)

    async def _download_matrix_media(
        self, client: ClientBase[Any], mxc: str | None, filename: str
    ) -> bytes | None:
        """Fetch an mxc URI's bytes via the bridge client, or None on failure
        (logged — the caller posts a disclosed fallback, never a silent drop)."""
        if not mxc:
            logger.error("[BRIDGE-OUT] media event for %s has no mxc URI", filename)
            return None
        if client.nio_client is None:
            logger.error(
                "[BRIDGE-OUT] bridge client not connected; cannot fetch %s", mxc
            )
            return None
        resp = await client.nio_client.download(mxc=mxc)
        if isinstance(resp, DownloadError):
            logger.error(
                "[BRIDGE-OUT] failed to download media %s: %s", mxc, resp.message
            )
            return None
        return resp.body  # type: ignore[no-any-return]

    async def handle_outbound_typing(
        self, room_id: str, agent_name: str, is_typing: bool
    ) -> None:
        channel_id = self._find_channel(room_id=room_id)
        if channel_id is None:
            logger.error("No channel found for room %s", room_id)
            return

        await self._adapter.send_typing(channel_id, agent_name, is_typing)

    async def handle_agent_runtime_state(
        self, room: MatrixRoom, event: AgentRuntimeStateEvent
    ) -> None:
        """Resolve the channel and let the adapter surface the runtime state.

        Each platform decides how to render it (see
        ``CollaborationAdapter.apply_runtime_state``). When the triggering
        message was in a thread, the state surfaces in that same thread: the
        event's `thread_id` (a Matrix event id) is resolved to the external
        thread root via the same map outbound replies use.

        Addressed at the conversation root there is no `thread_id`, and on an
        adapter that asks for it the reported anchor — the last message the
        agent was handed — stands in, so the status joins the thread the reply
        opens on that message instead of sitting at the channel root beside it.
        """
        channel_id = self._find_channel(matrix_room_id=room.room_id)
        if channel_id is None:
            logger.debug(
                "[BRIDGE-OUT] no channel mapping for runtime-state room %s",
                room.room_id,
            )
            return

        # Where the triggering message itself sits — None when it came from the
        # channel root. This is what a typing indicator follows.
        trigger_thread_ref: str | None = None
        if event.thread_id is not None:
            trigger_thread_ref = await self._external_post_for_matrix_event(
                event.thread_id
            )

        # The message the agent says it is answering. Resolved whichever way
        # the status is positioned, so an adapter can mark that message without
        # also moving the status onto it.
        anchor_message_ref: str | None = None
        if event.anchor_event_id is not None:
            anchor_message_ref = await self._external_post_for_matrix_event(
                event.anchor_event_id
            )

        # Where a persistent status belongs, which on an adapter that asks for
        # it is the thread the reply will open on the message being worked on.
        anchor_ref = event.thread_id
        if anchor_ref is None and self._adapter.runtime_state_follows_anchor:
            anchor_ref = event.anchor_event_id

        thread_root_ref: str | None = trigger_thread_ref
        if anchor_ref is not None and anchor_ref != event.thread_id:
            thread_root_ref = await self._external_post_for_matrix_event(anchor_ref)
        if anchor_ref is not None and thread_root_ref is None:
            logger.debug(
                "[BRIDGE-OUT] no external post mapped for runtime-state thread "
                "%s; surfacing at channel root in %s",
                anchor_ref,
                channel_id,
            )

        await self._adapter.apply_runtime_state(
            channel_id,
            event.agent_name,
            event.state,
            mention_handle=event.mention_handle,
            thread_root_id=thread_root_ref,
            deeplink_url=event.deeplink_url,
            detail=event.detail,
            trigger_thread_root_id=trigger_thread_ref,
            anchor_message_ref=anchor_message_ref,
        )
        await self._follow_reported_anchor(
            channel_id,
            event.agent_name,
            event.state,
            event.anchor_event_id,
            thread_root_ref,
        )

    async def _follow_reported_anchor(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        anchor_event_id: str | None,
        thread_root_ref: str | None,
    ) -> None:
        """Move the indicator when the agent reports it has been handed a
        newer message than the one it was last positioned against.

        Position follows what the agent has actually received, not what merely
        arrived in the room — a message the agent has not been given yet must
        not make the indicator look like the agent has seen it. The periodic
        activity refresh repeats the current anchor, so it never moves anything.
        """
        key = (channel_id, agent_name)
        if state != "working":
            self._reported_anchors.pop(key, None)
            return
        if anchor_event_id is None:
            return

        if self._reported_anchors.get(key) == anchor_event_id:
            return
        previous = self._reported_anchors.get(key)
        self._reported_anchors[key] = anchor_event_id
        if previous is None:
            # First anchor of the turn — the indicator was only just posted
            # against it, so there is nothing to move.
            return

        self._indicator_move_targets[key] = thread_root_ref
        await self._run_indicator_move(key)

    # ── Protection sync ──────────────────────────────────────────────────────

    # TODO: use this when protection setup is done
    async def handle_protection_verdict(
        self, event_id: str, new_content: str | None
    ) -> None:
        async with self._session_factory() as session:
            mapping = await self._bridge_message_map_store.get_by_matrix_event_id(
                session, self._bridge_id, event_id
            )
        if mapping is None:
            return

        channel_id = mapping.external_channel_id
        message_ref = mapping.external_post_id
        if new_content is None:
            await self._adapter.delete_message(channel_id, message_ref)
            # The post is gone; drop the mapping so it can't resolve later.
            async with self._session_factory() as session:
                await self._bridge_message_map_store.delete_by_matrix_event_id(
                    session, self._bridge_id, event_id
                )
                await session.commit()
        else:
            translated = self._adapter.translate_outbound(new_content)
            await self._adapter.update_message(channel_id, message_ref, translated)

    # ── Runtime-indicator positioning ─────────────────────────────────────────

    async def _move_indicator_for_sender(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Follow a message the agent itself just posted."""
        if agent_name in self._adapter.agents_with_live_runtime_state(channel_id):
            self._schedule_indicator_move(channel_id, agent_name, thread_root_id)

    def _schedule_indicator_move(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Queue a move of this agent's runtime indicator, coalescing bursts.

        Messages arriving while a move is already queued are absorbed into it,
        so a rapid exchange costs one delete-and-repost rather than one per
        message. The delay is deliberately not extended by later messages —
        a sustained conversation would otherwise starve the move indefinitely.

        ``thread_root_id`` is the thread the triggering message belongs to, and
        the one the indicator will land in. A coalesced burst keeps the most
        recent one, so the indicator follows the conversation's latest thread
        rather than the one that opened the window.
        """
        key = (channel_id, agent_name)
        self._indicator_move_targets[key] = thread_root_id
        if key in self._indicator_move_timers:
            return

        loop = asyncio.get_running_loop()
        self._indicator_move_timers[key] = loop.call_later(
            _INDICATOR_MOVE_DELAY_SECONDS,
            lambda: asyncio.ensure_future(self._run_indicator_move(key)),
        )

    async def _run_indicator_move(self, key: tuple[str, str]) -> None:
        # An anchor-driven move runs immediately rather than through the timer,
        # so a coalescing window opened by outbound traffic may still be
        # pending; it would otherwise fire a second, redundant move.
        timer = self._indicator_move_timers.pop(key, None)
        if timer is not None:
            timer.cancel()
        thread_root_id = self._indicator_move_targets.pop(key, None)
        channel_id, agent_name = key
        try:
            await self._adapter.reposition_runtime_state(
                channel_id, agent_name, thread_root_id
            )
        except Exception:
            # The indicator is cosmetic; a platform failure here must not take
            # down the bridge callback that happened to trigger it.
            logger.exception(
                "[BRIDGE-OUT] failed to move the runtime indicator for %s in %s",
                agent_name,
                channel_id,
            )

    # ── Message-map helpers ───────────────────────────────────────────────────

    async def _record_message_map(
        self, *, external_channel_id: str, matrix_event_id: str, external_post_id: str
    ) -> None:
        """Persist a Matrix-event ↔ external-post correlation (idempotent)."""
        async with self._session_factory() as session:
            existing = await self._bridge_message_map_store.get_by_matrix_event_id(
                session, self._bridge_id, matrix_event_id
            )
            if existing is not None:
                return
            await self._bridge_message_map_store.create(
                session,
                BridgeMessageMap(
                    bridge_id=self._bridge_id,
                    external_channel_id=external_channel_id,
                    matrix_event_id=matrix_event_id,
                    external_post_id=external_post_id,
                ),
            )
            await session.commit()

    async def _matrix_event_for_external_post(
        self, external_post_id: str
    ) -> str | None:
        async with self._session_factory() as session:
            mapping = await self._bridge_message_map_store.get_by_external_post_id(
                session, self._bridge_id, external_post_id
            )
        return mapping.matrix_event_id if mapping is not None else None

    async def _external_post_for_matrix_event(self, matrix_event_id: str) -> str | None:
        async with self._session_factory() as session:
            mapping = await self._bridge_message_map_store.get_by_matrix_event_id(
                session, self._bridge_id, matrix_event_id
            )
        return mapping.external_post_id if mapping is not None else None

    # ── Room mapping management ──────────────────────────────────────────────

    def begin_provisioning(self, external_channel_id: str) -> None:
        """Mark a channel as being provisioned by Switch itself, so inbound
        join/message handlers do not auto-create a duplicate room for it in the
        window between the channel existing (bot auto-joins → inbound join
        fires) and the room↔channel mapping being committed. The caller must
        record this before awaiting anything after the channel is created, and
        clear it with end_provisioning once the mapping is established."""
        self._provisioning_channels.add(external_channel_id)

    def end_provisioning(self, external_channel_id: str) -> None:
        """Clear the provisioning marker set by begin_provisioning. Idempotent."""
        self._provisioning_channels.discard(external_channel_id)

    def add_room_mapping(
        self, room_id: str, matrix_room_id: str, external_channel_id: str
    ) -> None:
        key = (room_id, matrix_room_id)
        self._channel_to_room[external_channel_id] = key
        self._room_to_channel[key] = external_channel_id

    def remove_room_mapping(self, room_id: str, matrix_room_id: str) -> None:
        key = (room_id, matrix_room_id)
        channel_id = self._room_to_channel.pop(key, None)
        if channel_id is not None:
            self._channel_to_room.pop(channel_id, None)

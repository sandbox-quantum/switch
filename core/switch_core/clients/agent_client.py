from __future__ import annotations

import logging
import random
import re
from typing import Literal

from nio import (
    MatrixRoom,
    RoomMemberEvent,
    RoomMessage,
    RoomMessageMedia,
    RoomMessageText,
)
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import SenderKind, can_address, parse_policy
from switch_core.bridges.agent.commands import (
    AGENT_GREETINGS,
    COMMANDS_BY_NAME,
    _addressed_by_name_or_role,
    dispatch_command,
)
from switch_core.bridges.agent.protocol.event_queue import EventQueue
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    CommandPayload,
    MessagePayload,
    RoomJoinPayload,
    TaskAcceptPayload,
    TaskCancelPayload,
    TaskDelegatePayload,
    TaskFinalisePayload,
    TaskUpdatePayload,
)
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.resource.events import (
    ResourceLoadResponse,
    RoomDocumentCreateResponse,
    RoomDocumentDeleteResponse,
    RoomDocumentUpdateResponse,
)
from switch_core.bridges.resource.tracker import ResourceRequestTracker
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.mentions import (
    NAME_CHAR as _NAME_CHAR,
)
from switch_core.clients.mentions import (
    mention_regex as _mention_regex,
)
from switch_core.clients.mentions import (
    strip_emphasis as _strip_emphasis,
)
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import Agent
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.events import (
    CommandEvent,
    MediationLlmResponse,
    MediationResult,
    MediationToolResult,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
)
from switch_core.gateway.known_agents import known_agent_for

logger = logging.getLogger(__name__)

# Content flag stamped on the no-session / busy-elsewhere auto-reply (see
# on_message). Its only job is to mark a message as itself an auto-reply so that
# another offline agent addressed by it does NOT emit a second auto-reply — two
# session-less agents tagging each other would otherwise ping-pong identical
# "no session" replies forever. Riding as a field on the plain
# m.room.message keeps the reply rendering normally for humans.
AUTO_REPLY_FLAG = "com.switch.auto_reply"

_UNAVAILABLE_MESSAGES = {
    "always_on": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
    "session_addressable": (
        "I'm not in an active session right now. "
        "I'll see this when I next connect to the room."
    ),
    "session_passive": (
        "I read room messages asynchronously, not in real time — my operator "
        "has to trigger me to pull the latest messages, either from a session I "
        "already have open or by starting a new one."
    ),
    # auto_session with no watcher reporting in: same honest "offline" story as
    # always_on — nothing is going to spin a session up right now.
    "auto_session": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
}


# Posted on the agent's behalf when an auto_session agent is addressed in a
# room where it has no live session but its connector is actively watching:
# the connector will spin a session up on demand to handle the message.
_STARTING_SESSION_MESSAGE = "Starting a session to handle this — one moment."


# Fallback (no known-agent connect command) for a session_addressable agent
# that has a session bound to this room but is not reporting as live — the
# usual cause is a session started without the dev-channels flag.
_CONNECTED_NOT_LIVE_MESSAGE = (
    "I have a session connected to this room, but it isn't reporting as live, "
    "so I'm not receiving messages — my operator may need to restart it."
)


# Posted (once, guarded by AUTO_REPLY_FLAG) when a sender tags this agent but
# the agent's scoped addressing policy (CHOO-1585) does not permit that sender
# to address it here. The message is demoted to unaddressed room chatter; this
# reply is the sender's only feedback that the attempt was rejected.
_ADDRESSING_DENIED_MESSAGE = (
    "You're not permitted to direct messages to me in this room — my operator "
    "has restricted who can address me here."
)


# Shown to an agent addressed here while it holds a role in THIS room but the
# session that assumed the role has hopped away to other room(s) (the lease
# still routes here). `room_names` lists where that session is now active.
def _elsewhere_message(room_names: list[str], holds_role_here: bool) -> str:
    where = ", ".join(f"**{name}**" for name in room_names)
    return (
        f"I hold a role in this room, but the session that assumed it is "
        f"active in {where} right now — I'll pick this up when it "
        f"reconnects here."
    )


# Single-room shorthand used by tests and callers that only have one room to
# name.
def _role_elsewhere_message(other_room_name: str) -> str:
    return _elsewhere_message([other_room_name], holds_role_here=True)


class AgentClient(ClientBase[ClientConfig]):
    def __init__(
        self,
        *,
        event_queue: EventQueue,
        agent_store: AgentStore,
        room_store: RoomStore,
        bridge_store: CollaborationBridgeStore,
        document_store: DocumentStore,
        reference_store: ReferenceStore,
        agent_session_store: AgentSessionStore,
        room_role_store: RoomRoleStore,
        external_user_store: ExternalUserStore,
        request_tracker: RequestTracker,
        resource_request_tracker: ResourceRequestTracker,
        frontend_base_url: str | None,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self._event_queue = event_queue
        self._agent_store = agent_store
        self._room_store = room_store
        self._bridge_store = bridge_store
        self._document_store = document_store
        self._reference_store = reference_store
        self._agent_session_store = agent_session_store
        self._room_role_store = room_role_store
        self._external_user_store = external_user_store
        self._request_tracker = request_tracker
        self._resource_request_tracker = resource_request_tracker
        self._frontend_base_url = (
            frontend_base_url.rstrip("/") if frontend_base_url else None
        )
        self._agent: Agent | None = None
        self._room_meta: dict[str, RoomMeta | None] = {}

    @property
    def agent(self) -> Agent:
        if self._agent is None:
            raise RuntimeError("Agent not loaded — call start() first")
        return self._agent

    async def _fresh_agent(self) -> Agent:
        """Re-read the agent row and refresh the cached snapshot.

        `self.agent` is loaded once in `start()`. An operator can edit the
        agent's `integration_profile` (e.g. flip `connection_model` to/from
        `auto_session`) via the gateway while this client runs, so any branch
        on `connection_model` must read fresh rather than trust the boot-time
        snapshot.
        """
        async with self.session_factory() as session:
            fresh = await self._agent_store.get(session, self.agent.id)
        if fresh is not None:
            self._agent = fresh
        return self.agent

    async def start(self) -> None:
        async with self.session_factory() as session:
            agent = await self._agent_store.get_by_client_id(session, self.client_id)
            if agent is None:
                raise RuntimeError(f"No agent found for client: {self.client_id}")
            self._agent = agent
        await super().start()

    # ── Event hooks ───────────────────────────────────────────────────────────

    async def on_self_join(self, room: MatrixRoom, event: RoomMemberEvent) -> None:
        is_direct = await self._is_direct_room(room.room_id)
        name = self.agent.name
        # The per-agent self-join greeting can be switched off per bridge
        # — e.g. on Mattermost, whose native "X joined the
        # channel" notice makes it redundant.
        meta = await self._resolve_room_meta(room.room_id)
        if meta is not None and not meta.agent_greetings_enabled:
            logger.info(
                "Suppressing self-join greeting for %s in %s "
                "(agent greetings disabled on the room's bridge)",
                name,
                room.room_id,
            )
            return
        if is_direct:
            greeting = f"Hi! I'm {name} — how can I help?"
        else:
            greeting = random.choice(AGENT_GREETINGS).format(name=name)
        await self.send_message(room.room_id, greeting, format="markdown")

    async def on_member_event(self, room: MatrixRoom, event: RoomMemberEvent) -> None:
        # Only forward genuine joins. A membership-preserving update (e.g. a
        # display-name or avatar change) re-fires m.room.member with
        # membership == "join" and prev_membership == "join" — exclude those, and
        # all leave/ban/knock transitions. The base handler already routes this
        # agent's own join to on_self_join and drops backfilled/self events, so
        # this fires once per other-member join (humans and agents alike).
        if event.membership != "join" or event.prev_membership == "join":
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        member_name = event.content.get("displayname") or event.state_key.split(":")[
            0
        ].lstrip("@")
        # `listening` tells each connector whether THIS receiving agent is
        # configured to react to join events in this room. The event is always
        # delivered; the connector decides whether to surface it.
        async with self.session_factory() as session:
            listening = await self._room_store.get_receives_join_events(
                session, meta.room_id, self.agent.id
            )
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="room_join",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=RoomJoinPayload(
                    member=event.state_key,
                    member_name=member_name,
                    timestamp=event.server_timestamp,
                    listening=listening,
                ),
            ),
        )

    async def on_message(self, room: MatrixRoom, event: RoomMessageText) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        is_addressed = await self._compute_addressed(event, meta)

        thread_id: str | None = None
        relates = event.source.get("content", {}).get("m.relates_to") or {}
        if relates.get("rel_type") == "m.thread":
            thread_id = relates.get("event_id")

        reply_thread_root = thread_id if thread_id is not None else event.event_id

        is_addressed = await self._gate_addressed(
            room, event, meta, reply_thread_root, is_addressed
        )

        if is_addressed:
            triggered_by_auto_reply = bool(
                event.source.get("content", {}).get(AUTO_REPLY_FLAG)
            )
            if not triggered_by_auto_reply and not await self._is_available(
                meta.room_id
            ):
                msg = await self._reply_when_unavailable_here(meta)
                handle = self._sender_handle(event)
                already_tagged = _mention_regex(handle).search(msg) is not None
                body = msg if already_tagged else f"@{handle} {msg}"
                await self.send_message(
                    room.room_id,
                    body,
                    format="markdown",
                    mentions=[event.sender],
                    thread_root_id=reply_thread_root,
                    extra_content={AUTO_REPLY_FLAG: True},
                )

        text = event.body

        sender_name = event.source.get("content", {}).get("sender_name")
        if not sender_name:
            sender_name = event.sender
            logger.error(
                "Message received without sender name, using matrix name: %s",
                sender_name,
            )

        agent_event = AgentEvent(
            type="message",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=MessagePayload(
                addressed=is_addressed,
                sender=event.sender,
                sender_name=sender_name,
                message_id=event.event_id,
                body=text,
                timestamp=event.server_timestamp,
                thread_id=thread_id,
            ),
        )

        logger.debug("Enqueuing event %s", agent_event.model_dump_json(indent=2))
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            agent_event,
        )

    async def on_media(self, room: MatrixRoom, event: RoomMessageMedia) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        is_addressed = await self._compute_addressed(event, meta)

        content = event.source.get("content", {})
        info = content.get("info", {}) or {}
        # With a caption, body is the caption text and the real filename lives in
        # `filename`; without one, body is the filename itself.
        filename = content.get("filename") or event.body
        attachment = AttachmentRef(
            filename=filename,
            mimetype=str(info.get("mimetype", "")),
            size=int(info.get("size", 0) or 0),
            mxc=str(event.url),
            msgtype=str(content.get("msgtype", "")),
        )

        sender_name = content.get("sender_name")
        if not sender_name:
            sender_name = event.sender
            logger.error(
                "Media received without sender name, using matrix name: %s",
                sender_name,
            )

        # Mirror on_message: surface the thread this media belongs to (if any).
        thread_id: str | None = None
        relates = content.get("m.relates_to") or {}
        if relates.get("rel_type") == "m.thread":
            thread_id = relates.get("event_id")

        reply_thread_root = thread_id if thread_id is not None else event.event_id
        is_addressed = await self._gate_addressed(
            room, event, meta, reply_thread_root, is_addressed
        )

        agent_event = AgentEvent(
            type="message",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=MessagePayload(
                addressed=is_addressed,
                sender=event.sender,
                sender_name=sender_name,
                message_id=event.event_id,
                body=event.body,
                timestamp=event.server_timestamp,
                thread_id=thread_id,
                attachments=[attachment],
            ),
        )

        logger.debug("Enqueuing media event %s", agent_event.model_dump_json(indent=2))
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            agent_event,
        )

    async def on_command(self, room: MatrixRoom, event: CommandEvent) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return

        # Admin-owned commands (room/info/alias) are handled by the admin
        # client, which is in every room; agents ignore them entirely.
        cmd = COMMANDS_BY_NAME.get(event.command)
        if cmd is not None and cmd.admin_owned:
            return

        # Targeting is a per-command policy: each Command decides whether its
        # args address this agent (Command.addressed). The default matches our
        # @name or a role we hold; some commands (e.g. run-cmd) override it.
        addressed = cmd.addressed if cmd is not None else _addressed_by_name_or_role
        if not await addressed(self, event.args, meta.room_id):
            return

        handled = await self._handle_command(room, event)
        if handled:
            return

        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="command",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=CommandPayload(
                    command=event.command,
                    args=event.args,
                    user_id=event.user_id,
                    user_name=event.user_name,
                ),
            ),
        )

    # ── Command handling ──────────────────────────────────────────────────────

    async def _handle_command(self, room: MatrixRoom, event: CommandEvent) -> bool:
        is_direct = await self._is_direct_room(room.room_id)
        return await dispatch_command(self, room, event, is_direct)

    async def reply_command(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "markdown",
        thread_root_id: str | None = None,
    ) -> None:
        """Post a command result as this agent (an agent-owned command like
        `!run-cmd` answers in the agent's own voice, not as a system message)."""
        await self.send_message(
            room_id, body, format=format, thread_root_id=thread_root_id
        )

    async def _resolve_room_meta(self, matrix_room_id: str) -> RoomMeta | None:
        if matrix_room_id in self._room_meta:
            return self._room_meta[matrix_room_id]

        async with self.session_factory() as session:
            room = await self._room_store.get_by_matrix_room_id(session, matrix_room_id)
            if room is None:
                logger.error("Room not found for matrix room ID: %s", matrix_room_id)
                self._room_meta[matrix_room_id] = None
                return None

            agent_greetings_enabled = True
            if room.bridge_id is not None:
                bridge = await self._bridge_store.get(session, room.bridge_id)
                if bridge is not None:
                    agent_greetings_enabled = bridge.agent_greetings_enabled

        meta = RoomMeta(
            room_id=room.id,
            name=room.name,
            bridge_id=room.bridge_id,
            agent_greetings_enabled=agent_greetings_enabled,
            channel_type=room.channel_type,
        )
        self._room_meta[matrix_room_id] = meta
        return meta

    async def _reply_when_unavailable_here(self, meta: RoomMeta) -> str:
        """Message for an agent addressed here but not live in this room.

        If the agent has live session(s) connected to OTHER rooms, name them so
        the asker knows where to find it — a session hops rooms while keeping
        its heartbeat (and any role lease) alive, so the agent is reachable
        there even though it has no session in the room it was addressed from.
        When the agent also holds a role in *this* room, the wording notes that
        the role-assuming session has stepped away. A live session in a
        genuinely different room wins — the asker is pointed there. Sessions in
        rooms that show the SAME name as this one are NOT offered (pointing the
        asker to a room they appear to already be in is confusing and useless).

        session_passive agents have no heartbeat, so the elsewhere/role logic
        never applies — they fall through to the generic reply, whose wording
        already covers pulling from an existing session or starting a new one.
        For a session_addressable agent with a session bound to THIS room but
        not live here (and no live session in a distinct room), the reply says
        so and tells the operator to relaunch with live channels.
        """
        agent = await self._fresh_agent()
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )

        # auto_session: if a connector is actively watching (global heartbeat),
        # it will spin a session up to handle this — promise that rather than
        # the "elsewhere"/offline wording. With no watcher, fall through to the
        # generic offline reply below.
        if connection_model == "auto_session":
            async with self.session_factory() as session:
                watching = await self._agent_session_store.get_live_agent_ids(
                    session, [self.agent.id], None
                )
            if self.agent.id in watching:
                return _STARTING_SESSION_MESSAGE

        async with self.session_factory() as session:
            room_ids = await self._agent_session_store.live_connected_rooms(
                session, self.agent.id
            )
            bound_here = await self._agent_session_store.has_room_binding(
                session, self.agent.id, meta.room_id
            )
            names: list[str] = []
            holds_role_here = False
            other_room_ids = [rid for rid in room_ids if rid != meta.room_id]
            if other_room_ids:
                for rid in other_room_ids:
                    room = await self._room_store.get(session, rid)
                    name = room.name if room is not None else rid
                    if name != meta.name:
                        names.append(name)
                holds_role_here = (
                    await self._room_role_store.agent_room_role(
                        session, meta.room_id, self.agent.id
                    )
                    is not None
                )

        if names:
            if holds_role_here:
                return _elsewhere_message(names, holds_role_here=True)
            # No role lease here, just sessions elsewhere: prefer the
            # known-agent reply so the operator gets the paste-ready
            # connect command alongside the "ask me there" alternative.
            return await self._unavailable_reply(
                meta.name, agent, other_room_names=names
            )

        # No live session in a distinct room. A session_addressable agent bound
        # to THIS room but not live here was most likely launched without live
        # channels: say a session is connected-but-not-live rather than imply
        # there is none.
        if connection_model == "session_addressable" and bound_here:
            return await self._unavailable_reply(
                meta.name, agent, connected_not_live=True
            )
        return await self._unavailable_reply(meta.name, agent)

    async def _unavailable_reply(
        self,
        room_name: str,
        agent: Agent,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str:
        """Build the room-facing message for an addressed-but-offline agent.

        Prefers per-known-agent `start_session_instructions` (e.g. the
        paste-ready terminal command for Claude Code). Falls back to the
        static `_UNAVAILABLE_MESSAGES` text keyed by connection_model when
        the agent has no known-agent spec or the spec returns None;
        `connected_not_live` selects the "bound here but not live" fallback.

        `agent` is the freshly-read row supplied by the caller (via
        `_fresh_agent`), so option edits made through the gateway (e.g.
        `PATCH /agents/{id}/options`, `connection_model`) take effect without
        restarting this client — `self.agent` alone is a boot-time snapshot.
        """
        spec_options = known_agent_for(agent)
        if spec_options is not None:
            spec, options = spec_options
            msg = spec.start_session_instructions(
                options,
                agent,
                room_name,
                other_room_names=other_room_names,
                connected_not_live=connected_not_live,
            )
            if msg is not None:
                return msg
        if connected_not_live:
            return _CONNECTED_NOT_LIVE_MESSAGE
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        return _UNAVAILABLE_MESSAGES.get(
            connection_model, _UNAVAILABLE_MESSAGES["session_passive"]
        )

    async def _is_available(self, room_id: str) -> bool:
        """Return True if this agent has a live session for `room_id`.

        always_on agents heartbeat against `room_id=None`; session_addressable
        agents heartbeat against the specific room; session_passive agents
        have no heartbeat and are never considered live in real time.
        """
        agent = await self._fresh_agent()
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        if connection_model == "session_passive":
            return False
        heartbeat_room = None if connection_model == "always_on" else room_id
        async with self.session_factory() as session:
            live = await self._agent_session_store.get_live_agent_ids(
                session, [self.agent.id], heartbeat_room
            )
        return self.agent.id in live

    async def _is_direct_room(self, matrix_room_id: str) -> bool:
        meta = await self._resolve_room_meta(matrix_room_id)
        return meta is not None and meta.channel_type == "direct"

    # ── Task event forwarding ────────────────────────────────────────────────

    async def on_task_delegate(self, room: MatrixRoom, event: TaskDelegate) -> None:
        if event.performer_agent_id != self.agent.id:
            return
        await self.send_message(room.room_id, "Working on it.", format="markdown")
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_delegate",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskDelegatePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    summary=event.summary,
                    description=event.description,
                ),
            ),
        )

    async def on_task_accept(self, room: MatrixRoom, event: TaskAccept) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_accept",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskAcceptPayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                ),
            ),
        )

    async def on_task_update(self, room: MatrixRoom, event: TaskUpdate) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_update",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskUpdatePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    update=event.update,
                ),
            ),
        )

    async def on_task_finalise(self, room: MatrixRoom, event: TaskFinalise) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_finalise",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskFinalisePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    outcome=event.outcome,
                ),
            ),
        )

    async def on_task_cancel(self, room: MatrixRoom, event: TaskCancel) -> None:
        if event.performer_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_queue.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_cancel",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskCancelPayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    reason=event.reason,
                ),
            ),
        )

    # ── Post-invocation mediation ──────────────────────────────────────────────

    async def on_mediation_tool_result(
        self, room: MatrixRoom, event: MediationToolResult
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        result = MediationResult(verdict=event.status)
        self._request_tracker.resolve(event.request_id, result)

    async def on_mediation_llm_response(
        self, room: MatrixRoom, event: MediationLlmResponse
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        result = MediationResult(verdict=event.status)
        self._request_tracker.resolve(event.request_id, result)

    async def on_resource_load_response(
        self, room: MatrixRoom, event: ResourceLoadResponse
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        self._resource_request_tracker.resolve(event.request_id, event)

    async def on_room_document_create_response(
        self, room: MatrixRoom, event: RoomDocumentCreateResponse
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        self._resource_request_tracker.resolve(event.request_id, event)

    async def on_room_document_update_response(
        self, room: MatrixRoom, event: RoomDocumentUpdateResponse
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        self._resource_request_tracker.resolve(event.request_id, event)

    async def on_room_document_delete_response(
        self, room: MatrixRoom, event: RoomDocumentDeleteResponse
    ) -> None:
        if event.agent_id != self.agent.id:
            return
        self._resource_request_tracker.resolve(event.request_id, event)

    # ── Mention detection ─────────────────────────────────────────────────────

    async def _compute_addressed(self, event: RoomMessage, meta: RoomMeta) -> bool:
        """Whether this message addresses this agent (expects a response).

        Direct rooms always address. Otherwise the agent is addressed by an
        `@name` mention OR by an `@<role>` tag for a room-role it currently
        holds (see `_is_mentioned_via_role`).
        """
        if meta.channel_type == "direct":
            return True
        if self._is_mentioned(event):
            return True
        if await self._is_mentioned_via_alias(event, meta.room_id):
            return True
        return await self._is_mentioned_via_role(event, meta.room_id)

    async def _resolve_sender_principal(
        self, session: AsyncSession, matrix_user_id: str
    ) -> tuple[SenderKind, str] | None:
        """Resolve a Matrix sender to an addressing principal.

        Maps the sender's mxid to its Client, then to either an Agent (an
        agent-to-agent attempt) or an ExternalUser (a human on a bridge).
        Returns ``None`` when the sender has no such record — an
        unresolvable identity that a restricted agent should not trust.
        """
        client = await self.client_store.get_by_matrix_user_id(session, matrix_user_id)
        if client is None:
            return None
        agent = await self._agent_store.get_by_client_id(session, client.id)
        if agent is not None:
            return ("agent", agent.id)
        external_user = await self._external_user_store.get_by_client_id(
            session, client.id
        )
        if external_user is not None:
            return ("user", external_user.id)
        return None

    async def _addressing_allowed(self, event: RoomMessage, meta: RoomMeta) -> bool:
        """Whether the message's sender may address this agent, per the agent's
        scoped addressing policy (CHOO-1585).

        An agent with no policy is open to anyone (today's behaviour), so this
        returns True without a DB round-trip. With a policy set it is
        deny-by-default: an unresolvable sender is rejected (fail-closed).
        """
        agent = await self._fresh_agent()
        policy = parse_policy(agent.addressing_policy)
        if policy.is_open():
            return True
        async with self.session_factory() as session:
            principal = await self._resolve_sender_principal(session, event.sender)
            room = await self._room_store.get(session, meta.room_id)
        if principal is None:
            logger.warning(
                "Addressing denied for %s: unresolvable sender %s in room %s",
                self.agent.name,
                event.sender,
                meta.room_id,
            )
            return False
        sender_kind, sender_id = principal
        group_id = room.group_id if room is not None else None
        allowed = can_address(
            policy,
            room_id=meta.room_id,
            group_id=group_id,
            sender_kind=sender_kind,
            sender_id=sender_id,
        )
        if not allowed:
            logger.warning(
                "Addressing denied for %s: %s %s not permitted in room %s",
                self.agent.name,
                sender_kind,
                sender_id,
                meta.room_id,
            )
        return allowed

    async def _gate_addressed(
        self,
        room: MatrixRoom,
        event: RoomMessage,
        meta: RoomMeta,
        reply_thread_root: str,
        is_addressed: bool,
    ) -> bool:
        """Apply the scoped addressing policy to a would-be-addressed message.

        When the message tags this agent but the sender is not permitted by the
        agent's policy, demote it to unaddressed room chatter and (once, guarded
        by AUTO_REPLY_FLAG so two agents can't ping-pong) reply to the sender
        explaining they can't address it here. Returns the effective addressed
        flag. Zero cost for the common case: only messages that already tag this
        agent are ever checked, and open policies short-circuit.
        """
        if not is_addressed:
            return False
        if await self._addressing_allowed(event, meta):
            return True
        triggered_by_auto_reply = bool(
            event.source.get("content", {}).get(AUTO_REPLY_FLAG)
        )
        if not triggered_by_auto_reply:
            handle = self._sender_handle(event)
            msg = _ADDRESSING_DENIED_MESSAGE
            already_tagged = _mention_regex(handle).search(msg) is not None
            body = msg if already_tagged else f"@{handle} {msg}"
            await self.send_message(
                room.room_id,
                body,
                format="markdown",
                mentions=[event.sender],
                thread_root_id=reply_thread_root,
                extra_content={AUTO_REPLY_FLAG: True},
            )
        return False

    def _args_tag_my_name(self, text: str) -> bool:
        """True when `text` contains our own `@name` at a full-token boundary
        (so a name that is a prefix of a longer one is not falsely matched)."""
        return _mention_regex(self.agent.name).search(_strip_emphasis(text)) is not None

    async def _text_tags_my_alias(self, text: str, room_id: str) -> bool:
        """True when `text` `@`-tags this agent's room alias at a token boundary.

        The alias is looked up live (like a role lease) so a change takes effect
        on the next message without any per-client cache to invalidate.
        """
        if "@" not in text:
            return False
        async with self.session_factory() as session:
            alias = await self._room_store.get_alias(session, room_id, self.agent.id)
        if not alias:
            return False
        return _mention_regex(alias).search(text) is not None

    async def _is_mentioned_via_alias(self, event: RoomMessage, room_id: str) -> bool:
        """True when the message body tags this agent's room alias.

        A room alias addresses the agent exactly like its real name, so an
        `@<alias>` mention routes here just as `@<name>` does.
        """
        return await self._text_tags_my_alias(getattr(event, "body", "") or "", room_id)

    async def _text_tags_my_role(self, text: str, room_id: str) -> bool:
        """True when `text` `@`-tags a room-role this agent LIVE-holds.

        Only a live lease counts, so "held" means the same thing here as in
        `!roles` and the moderator warning: a stale lease (session gone, role
        auto-released → shown free) does NOT route here — the moderator flags
        it as unassigned instead. A holder whose session merely hopped to
        another room still matches, because that lease is kept alive by the
        renewal loop. The moderator holds no role, so this is a no-op for it.
        """
        if "@" not in text:
            return False
        async with self.session_factory() as session:
            role_name = await self._room_role_store.agent_room_role(
                session, room_id, self.agent.id
            )
        if not role_name:
            return False
        return _mention_regex(role_name).search(_strip_emphasis(text)) is not None

    async def _is_mentioned_via_role(self, event: RoomMessage, room_id: str) -> bool:
        """True when the message body tags a room-role this agent holds.

        Tagging `@<role>` addresses whichever agent holds that role, so an
        interchangeable agent can be reached by responsibility rather than by
        name.
        """
        return await self._text_tags_my_role(getattr(event, "body", "") or "", room_id)

    def _sender_handle(self, event: RoomMessage) -> str:
        """The @-handle to tag the message sender with.

        Prefers the bridge-provided `sender_name` (the external username, which
        the collaboration bridge rewrites into a real @mention on Slack /
        Mattermost); falls back to the mxid localpart for a native Matrix user
        (paired with `mentions=[event.sender]` so Matrix renders a pill).
        """
        content = event.source.get("content", {}) or {}
        name = content.get("sender_name")
        if name:
            return str(name)
        return str(event.sender).split(":")[0].lstrip("@")

    def _is_mentioned(self, event: RoomMessage) -> bool:
        # Media events (RoomMessageImage/File) have no formatted_body; fall back
        # to a plain-text mention scan on the body (the caption, for media).
        formatted_body = getattr(event, "formatted_body", None)
        if formatted_body is not None and self.matrix_user_id in formatted_body:
            return True
        return (
            _mention_regex(self.agent.name).search(_strip_emphasis(event.body))
            is not None
        )

    def _strip_mention(self, text: str) -> str:
        pattern = re.compile(
            re.escape(f"@{self.agent.name}") + rf"(?!{_NAME_CHAR}):?",
            re.IGNORECASE,
        )
        return pattern.sub("", text).strip()

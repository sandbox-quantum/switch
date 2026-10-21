from __future__ import annotations

import logging
import random
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, cast

from switch_core.agent_display_name import (
    agent_label,
    agent_label_with_identifier,
    label_after_rename,
)
from switch_core.aliases import (
    AliasError,
    check_alias_collisions,
    validate_alias_format,
)
from switch_core.authz import Principal, require_manage
from switch_core.bridges.agent.protocol.agent_core import (
    AgentExistsError,
    AgentRenameRefused,
)
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AgentStatus,
    CommandPayload,
)
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.clients.mentions import mention_tokens as _mention_tokens
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import CollaborationBridge, Room, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_runtime_state_store import AgentRuntimeStateStore
from switch_core.delivery.addressing import AddressingResolver
from switch_core.events import CommandEvent
from switch_core.transport import RoomRef

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.clients.command_consumer import CommandConsumer
    from switch_core.clients.room_meta import RoomMeta
    from switch_core.db.models import Agent
    from switch_core.delivery.recipient import AgentRecipient

logger = logging.getLogger(__name__)


AGENT_GREETINGS = [
    "Hey there! Tag @{name} if you need me.",
    "Hi! Mention @{name} to get my attention.",
    "Hello! I'm ready — just tag @{name} when you need me.",
    "Hey! Ping @{name} and I'll jump in.",
    "Hi! I'm here to help — mention @{name} anytime.",
    "Hello! Tag @{name} to loop me in.",
    "Hey! I'm on standby — @{name} to get started.",
    "Hi there! Just @{name} me when you're ready.",
]

CommandHandler = Callable[
    ["AgentRecipient", RoomRef, CommandEvent, bool], Awaitable[None]
]
# (client, args, room_id) -> whether THIS agent is addressed by the command.
# Targeting is a per-command policy (see Command.addressed) rather than a fixed
# rule in on_command, so a command like `reset` can interpret its args its
# own way.
CommandTargeting = Callable[["AgentRecipient", str, str], Awaitable[bool]]
# (host, room, event, meta) -> None. An admin-side usage check run by the
# always-present admin client BEFORE agents act on a command. It posts a
# system message when the command is misused (bad/missing target) and does
# nothing when usage is valid; it never executes the command itself.
CommandAdminCheck = Callable[
    ["CommandConsumer", RoomRef, CommandEvent, "RoomMeta"], Awaitable[None]
]
# (client, room, event) -> what a command that queues itself for the agent
# does for this agent, decided as the command's row is written.
CommandDecider = Callable[
    ["AgentRecipient", RoomRef, CommandEvent], Awaitable["ControlDecision"]
]


async def _addressed_by_name_or_role(
    client: AgentRecipient, args: str, room_id: str
) -> bool:
    """Default command targeting.

    No `@` in args → addressed to everyone. Otherwise this agent is addressed
    only when its own `@name` (matched at a full-token boundary), its room
    `@alias`, or an `@role` it currently holds appears in args.
    """
    if "@" not in args:
        return True
    if client._args_tag_my_name(args):
        return True
    async with client.session_factory() as session:
        if await client._text_tags_my_alias(session, args, room_id):
            return True
        return await client._text_tags_my_role(session, args, room_id)


async def _addressed_by_required_first_mention(
    client: AgentRecipient, args: str, room_id: str
) -> bool:
    """Targeting for a command that needs a target: only the FIRST `@token`
    addresses an agent (by name or by a role it holds), and a missing target
    addresses no one. Used by `!reset`, where a bare `!reset` must not
    silently reset every agent in the room — resetting all agents is the
    separate, explicit `!reset-all-agents` command.
    """
    tokens = _mention_tokens(args)
    if not tokens:
        return False
    return await _first_token_is_me(client, tokens[0], room_id)


async def _addressed_everyone(client: AgentRecipient, args: str, room_id: str) -> bool:
    """Targeting for room-wide control commands (`!reset-all-agents`): every
    agent is addressed regardless of args, so the command always fans out to
    the whole room."""
    return True


async def _first_token_is_me(client: AgentRecipient, first: str, room_id: str) -> bool:
    """Whether `@first` names this agent — by name, room alias, or a held role."""
    if client._args_tag_my_name(f"@{first}"):
        return True
    async with client.session_factory() as session:
        if await client._text_tags_my_alias(session, f"@{first}", room_id):
            return True
        return await client._text_tags_my_role(session, f"@{first}", room_id)


async def _check_control_target(
    host: CommandConsumer, room: RoomRef, event: CommandEvent, meta: RoomMeta
) -> None:
    """Admin-side usage feedback for a target-required control command.

    Posts a system message when a control command (`!reset` / `!compact` /
    `!interrupt`) is used with no target, or with a first `@token` that names
    no agent, alias, or role in the room — cases that would otherwise address
    no agent and leave the user with a silent no-op. Valid usage posts nothing;
    the agents themselves handle execution.
    """
    tokens = _mention_tokens(event.args)
    if not tokens:
        await _reply(
            host,
            room,
            event,
            f"`!{event.command}` needs a target — e.g. `!{event.command} @agent-name` "
            f"or `!{event.command} @role`. To act on every agent in the room, use "
            f"`!{event.command}-all-agents`.",
        )
        return

    target = tokens[0]
    async with host.session_factory() as session:
        agent_ids = await host._room_store.get_agent_ids(session, meta.room_id)
        names: list[str] = []
        for aid in agent_ids:
            agent = await host._agent_store.get(session, aid)
            if agent is not None:
                names.append(agent.name)
        aliases = await host._room_store.list_aliases(session, meta.room_id)
        roles = await host._room_role_store.list_roles(session, meta.room_id)

    target_lc = target.lower()
    known = (
        target_lc in {n.lower() for n in names}
        or target_lc in {a.lower() for a in aliases.values()}
        or target_lc in {r.name.lower() for r in roles}
    )
    if known:
        return

    await _reply(
        host,
        room,
        event,
        f"`@{target}` is not an agent or role in this room. Run `!list-agents` "
        "to see the agents here, or `!roles` for the roles.",
    )


@dataclass(frozen=True)
class CommandArg:
    """One positional argument of a command, declared for bridges that need it.

    The `!` path does not read this: it free-text parses `event.args` exactly as
    it always has, and every handler still pulls its arguments out of that
    string via `_mention_tokens`. The spec exists for platforms whose native
    commands are *registered* with a declared signature — Discord application
    commands — so the argument surface is described once, here, instead of
    being restated per bridge and drifting from the handlers.

    Every argument declared today is a mention-style token (`@agent`, `@role`,
    `@alias`) matching `mentions.NAME_CHAR`, so a bridge can round-trip a
    declared value back into the positional `args` string the handlers parse.
    The one exception is `free_text`: the last argument may take the rest of
    the line as written, spaces and all (a display name), and a bridge passes
    it through untouched.

    `name` is what the user sees as the field label on platforms that render
    one, so it must be lowercase and match Discord's `^[-_a-z0-9]{1,32}$`.
    """

    name: str
    description: str
    required: bool
    free_text: bool = False


@dataclass(frozen=True)
class Command:
    name: str
    description: str
    handler: CommandHandler | None = None
    # Declared positional arguments, in the order the handlers parse them out
    # of `args`. Empty for the many commands that take none. Only consumed by
    # bridges that register native commands (see CommandArg).
    args_spec: tuple[CommandArg, ...] = ()
    # (client, args, room_id) -> bool. Whether this agent is addressed. Default:
    # name- or held-role match (or everyone when no `@`).
    addressed: CommandTargeting = field(default=_addressed_by_name_or_role)
    # If True, dispatch_command returns False so the event is also enqueued to the agent.
    forward_to_agent: bool = False
    # If True, omitted from the !help listing.
    hidden: bool = False
    # Optional admin-side usage check. Run by the admin client before agents
    # act, so a misused command (e.g. a control command with an unknown or
    # missing target) gets a system message instead of a silent no-op.
    admin_check: CommandAdminCheck | None = None
    # If True, the always-present admin client owns this command: it parses,
    # executes, and renders the result as an admin/system message. Agents ignore
    # it. If False, the command is handled by the agents themselves (e.g.
    # `!reset`, `!agents-greet`), which answer in their own voice.
    admin_owned: bool = False
    # Set for a command that is queued for the agent (the session controls).
    # The router decides it in the transaction that writes the command and
    # stores what is queued with it, so the agent gets the command before
    # anything written after it; `handler` runs it outside the router.
    decide: CommandDecider | None = None


# ── Handlers ──────────────────────────────────────────────────────────────────


# Room controls name the session's current generation and turn by this rather
# than by id: Switch keeps neither, and the host fills in its own.
CURRENT = "current"

_CONTROL_BODIES: dict[str, dict[str, str]] = {
    "reset": {"type": "session.reset"},
    "compact": {"type": "session.compact"},
    "interrupt": {"type": "turn.interrupt", "turnId": CURRENT},
}


def room_control_frame(
    *,
    agent_id: str,
    session_id: str | None,
    room_id: str,
    action: str,
    actor_id: str,
    message_id: str,
    thread_id: str | None,
    surface: str,
    requester_name: str,
) -> dict[str, object]:
    """The `session_command` frame a room control is relayed as.

    Beside the contract command it names who asked, as the room knows them,
    so the session can answer that person once the control has applied.
    `session_id` is None for a controller-backed agent, whose controller
    picks the session from the room.
    """
    body = _CONTROL_BODIES.get(action)
    if body is None:
        raise ValueError(f"{action} is not a room control")
    frame = _control_frame(
        command_id=str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"sdk-control:{agent_id}:{room_id}:{message_id}:{action}",
            )
        ),
        session_id=session_id,
        room_id=room_id,
        actor_id=actor_id,
        message_id=message_id,
        thread_id=thread_id,
        surface=surface,
        body=body,
    )
    frame["requesterName"] = requester_name
    return frame


def stop_control_frame(
    *,
    agent_id: str,
    session_id: str,
    room_id: str,
    actor_id: str,
    message_ref: str,
    turn_id: str,
    thread_id: str | None,
    surface: str,
) -> dict[str, object]:
    """The frame a press on a platform's Stop control is relayed as: `!interrupt`.

    Keyed by the control pressed — the message it is on and the turn it named
    when drawn — so pressing it twice is one command, while the same message
    offering to stop a later turn is another. No Switch message did the
    asking, so the origin names none.
    """
    return _control_frame(
        command_id=str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"sdk-stop:{agent_id}:{room_id}:{message_ref}:{turn_id}",
            )
        ),
        session_id=session_id,
        room_id=room_id,
        actor_id=actor_id,
        message_id=None,
        thread_id=thread_id,
        surface=surface,
        body=_CONTROL_BODIES["interrupt"],
    )


def _control_frame(
    *,
    command_id: str,
    session_id: str | None,
    room_id: str,
    actor_id: str,
    message_id: str | None,
    thread_id: str | None,
    surface: str,
    body: dict[str, str],
) -> dict[str, object]:
    return {
        "contractVersion": 1,
        "commandId": command_id,
        "sessionId": session_id,
        "epoch": CURRENT,
        "origin": {
            "surface": surface,
            "actorId": actor_id,
            "roomId": room_id,
            "threadId": thread_id,
            "messageId": message_id,
        },
        "body": dict(body),
    }


async def _room_surface(client: AgentRecipient, room_id: str) -> str:
    """The platform a room is bridged to, as a contract surface."""
    async with client.session_factory() as db:
        room = await db.get(Room, room_id)
        bridge = (
            await db.get(CollaborationBridge, room.bridge_id)
            if room is not None and room.bridge_id
            else None
        )
    return bridge.type if bridge is not None else "switch-web"


async def _reply(
    client: AgentRecipient | CommandConsumer,
    room: RoomRef,
    event: CommandEvent,
    body: str,
    *,
    format: Literal["text", "markdown"] = "markdown",
) -> None:
    """Post a command result threaded under the originating command message.

    Every command's output goes through here so it lands as a reply in the
    command's thread (carrying `event.thread_id` as the thread root) rather
    than at the channel root. A None thread_id (synthetic/legacy command
    events) falls back to a top-level message.

    The result is posted via the host's `reply_command`: the admin client
    stamps it as an admin/system message (so it renders natively per bridge),
    while an agent answers in its own voice.
    """
    await client.reply_command(
        room.room_id, body, format=format, thread_root_id=event.thread_id
    )


async def _cmd_help(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    lines = ["**Available commands:**"]
    for cmd in COMMANDS:
        if cmd.hidden:
            continue
        lines.append(f"- `!{cmd.name}` — {cmd.description}")
    await _reply(client, room, event, "\n".join(lines))


@dataclass(frozen=True)
class ControlTexts:
    """What a session-control command says in the room for each outcome."""

    ack: str
    unsupported: str
    # No live session in the room at all.
    no_live_session: str
    # A live session that cannot be controlled from here, e.g. one not
    # started from Switch Console.
    no_session: str


@dataclass(frozen=True)
class ControlDecision:
    """What a session-control command does for one agent.

    `queued` is the command to queue for the agent's controller, None when
    nothing is queued. The router stores it as an own event in the
    transaction that writes the command, so a message written after the
    command reaches the agent after it. `answer` is what is said in the room,
    or relayed to a session, once the command has committed.
    """

    queued: CommandPayload | None
    answer: Callable[[], Awaitable[None]] | None


async def _decide_control_command(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    command: str,
    texts: ControlTexts,
) -> ControlDecision:
    """Shared logic for the session-control commands (reset/compact/interrupt).

    Resolves the agent's declared capability level for `command` from its
    integration profile, then — for `session_dependent` — checks that a live
    session actually reports it can execute the command (via its runtime-state
    control capabilities). When actionable, acknowledges in the room and queues
    a `command` event for the agent's controller (e.g. Switch Console) to execute.

    Everything here is a read; what it decides to say or relay is left to
    `ControlDecision.answer`.
    """

    def say(body: str) -> ControlDecision:
        async def answer() -> None:
            await _reply(client, room, event, body)

        return ControlDecision(queued=None, answer=answer)

    async with client.session_factory() as session:
        agent = await client._fresh_agent(session)
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        return ControlDecision(queued=None, answer=None)
    # A session that connected to this room takes the command itself, over
    # its agent's controller. Nothing is queued: with no controller to relay
    # it to, the room is told so.
    # A controller-backed agent's sessions are placed with its controller,
    # which routes the command to the one working in this room. Switch does not
    # know which session that is, so the frame names none.
    controller_backed = client._connections.controllers.is_bound(agent.id)
    placed = client._connections.session_in_room(agent.id, meta.room_id)
    if placed is not None or controller_backed:
        if not event.message_id:
            return say(
                f"Could not send {command}: the room command has no stable message ID."
            )
        frame = room_control_frame(
            agent_id=agent.id,
            session_id=placed,
            room_id=meta.room_id,
            action=command,
            actor_id=event.user_id,
            message_id=event.message_id,
            thread_id=event.thread_id,
            surface=await _room_surface(client, meta.room_id),
            requester_name=event.user_name,
        )

        async def relay() -> None:
            if client._connections.relay_session_command(agent.id, frame):
                await _reply(client, room, event, texts.ack)
                return
            await _reply(
                client,
                room,
                event,
                f"Could not send {command}: the agent's controller is not connected to Switch.",
            )

        return ControlDecision(queued=None, answer=relay)
    profile = agent.integration_profile or {}
    level = (profile.get("command_capabilities") or {}).get(command, "unsupported")

    if level == "unsupported":
        return say(texts.unsupported)

    deeplink: str | None = None
    role: str | None = None
    if level == "session_dependent":
        async with client.session_factory() as session:
            statuses = await compute_agent_statuses(
                session,
                [agent],
                meta.room_id,
                client._agent_session_store,
                client._connections,
            )
            runtime = await AgentRuntimeStateStore().get(
                session, agent.id, meta.room_id
            )
            # `reset`/`compact` drop or condense the session's context, so the
            # controller reconnects it to this room and re-assumes the role it
            # held. Resolve that role now (the lease survives) and pass it as the
            # command args so the controller can fold it into the reconnect
            # prompt.
            role = await client._room_role_store.agent_room_role(
                session,
                meta.room_id,
                agent.id,
                client._connections.live_connection_ids(),
            )
        live = statuses.get(agent.id) == AgentStatus.LIVE
        caps = (runtime.control_capabilities or {}) if runtime else {}
        if not live:
            return say(texts.no_live_session)
        if not caps.get(command):
            return say(texts.no_session)
        deeplink = runtime.deeplink_url if runtime else None

    args = event.args
    if command in ("reset", "compact"):
        args = role or ""

    # Mirror the runtime "working" surface: link back to the session in
    # Switch Console when we know its deeplink.
    body = (
        f"{texts.ack} ([Open in Switch Console]({deeplink}))" if deeplink else texts.ack
    )
    decision = say(body)
    return ControlDecision(
        queued=CommandPayload(
            command=command,
            args=args,
            user_id=event.user_id,
            user_name=event.user_name,
            thread_id=event.thread_id,
        ),
        answer=decision.answer,
    )


async def _dispatch_control_command(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    command: str,
    texts: ControlTexts,
) -> None:
    """Decide a session-control command and carry it out at once: answer in
    the room, then queue the command for the agent in a transaction of its
    own. For a command run outside the router; the router stores what is
    queued with the command's row instead (`AgentRecipient.decide_command`)."""
    decision = await _decide_control_command(client, room, event, command, texts)
    if decision.answer is not None:
        await decision.answer()
    if decision.queued is None:
        return
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        return
    await client._event_buffer.enqueue(
        client.tenant_id,
        client.agent.id,
        meta.room_id,
        AgentEvent(
            type="command",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=decision.queued,
        ),
        room_seq=event.room_seq,
        message_key=event.message_id,
    )


_RESET = ControlTexts(
    ack="Resetting my session — clearing context, then reconnecting to this room.",
    unsupported="My session can't be reset — this isn't supported for me.",
    no_live_session=(
        "I have no active session in this room, so there's nothing to reset."
    ),
    no_session=(
        "My session can't be reset from here — it wasn't started from "
        "Switch Console, so my operator needs to reset it manually (e.g. by "
        "restarting my session)."
    ),
)
_COMPACT = ControlTexts(
    ack="Compacting my session's context.",
    unsupported="I can't compact my session — this isn't supported for me.",
    no_live_session=(
        "I have no active session in this room, so there's nothing to compact."
    ),
    no_session=(
        "I can't compact from here — my session wasn't started from "
        "Switch Console, so my operator needs to compact it manually."
    ),
)
_INTERRUPT = ControlTexts(
    ack="Interrupted my current turn.",
    unsupported="I can't be interrupted — this isn't supported for me.",
    no_live_session=(
        "I have no active session in this room, so there's nothing to interrupt."
    ),
    no_session=(
        "I can't be interrupted from here — my session wasn't started from "
        "Switch Console, so my operator needs to interrupt it manually."
    ),
)


async def _cmd_reset(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(client, room, event, "reset", _RESET)


async def _decide_reset(
    client: AgentRecipient, room: RoomRef, event: CommandEvent
) -> ControlDecision:
    return await _decide_control_command(client, room, event, "reset", _RESET)


async def _cmd_compact(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(client, room, event, "compact", _COMPACT)


async def _decide_compact(
    client: AgentRecipient, room: RoomRef, event: CommandEvent
) -> ControlDecision:
    return await _decide_control_command(client, room, event, "compact", _COMPACT)


async def _cmd_interrupt(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(client, room, event, "interrupt", _INTERRUPT)


async def _decide_interrupt(
    client: AgentRecipient, room: RoomRef, event: CommandEvent
) -> ControlDecision:
    return await _decide_control_command(client, room, event, "interrupt", _INTERRUPT)


async def _cmd_list_room_agents(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        agent_ids = await client._room_store.get_agent_ids(session, meta.room_id)
        if not agent_ids:
            await _reply(client, room, event, "No agents in this room.")
            return

        lines = ["**Agents in this room:**"]
        for agent_id in agent_ids:
            agent = await client._agent_store.get(session, agent_id)
            if agent:
                desc = f" — {agent.description}" if agent.description else ""
                label = agent_label_with_identifier(agent.display_name, agent.name)
                lines.append(f"- **{label}**{desc}")

    await _reply(client, room, event, "\n".join(lines))


_FOLLOW_THE_CONVERSATION_OFF = (
    "Following the conversation isn't switched on for this Switch server, so "
    "`!follow-ups` and `!assign-agent` have no effect here. Agents only get "
    "messages that mention them."
)


async def _reject_if_following_is_off(
    client: AgentRecipient, room: RoomRef, event: CommandEvent
) -> bool:
    """True, after saying so, when the server has the feature off: a command
    must not claim a change that nothing will act on."""
    host = cast("CommandConsumer", client)
    if host._follow_the_conversation_enabled:
        return False
    await _reply(client, room, event, _FOLLOW_THE_CONVERSATION_OFF)
    return True


_FOLLOW_UPS_ON = (
    "Follow-ups are **on** in this room. A reply in an agent's thread, or your "
    "next message after an agent has just answered you, reaches that agent "
    "without an @. Turn them off with `!follow-ups off`."
)
_FOLLOW_UPS_OFF = (
    "Follow-ups are **off** in this room. Agents only get messages that mention "
    "them. Turn them back on with `!follow-ups on`."
)


async def _cmd_follow_ups(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    if await _reject_if_following_is_off(client, room, event):
        return
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    choice = event.args.strip().lower()
    if choice not in ("", "on", "off"):
        await _reply(
            client,
            room,
            event,
            "Usage: `!follow-ups on`, `!follow-ups off`, or `!follow-ups` to see "
            "which it is.",
        )
        return

    async with client.session_factory() as session:
        if choice:
            await client._room_store.set_follow_ups_enabled(
                session, meta.room_id, choice == "on"
            )
            await session.commit()
        enabled = await client._room_store.follow_ups_enabled(session, meta.room_id)

    await _reply(client, room, event, _FOLLOW_UPS_ON if enabled else _FOLLOW_UPS_OFF)


async def _cmd_assign_agent(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    if await _reject_if_following_is_off(client, room, event):
        return
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    tokens = _mention_tokens(event.args)
    async with client.session_factory() as session:
        current_id = await client._room_store.main_agent_id(session, meta.room_id)
        current = (
            await client._agent_store.get(session, current_id) if current_id else None
        )
        if not tokens:
            body = (
                f"Every message here goes to **{_label(current)}** unless it "
                "mentions someone else. Clear it with `!unassign-agent`."
                if current is not None
                else "No agent is assigned in this room. Assign one with "
                "`!assign-agent @agent-name`."
            )
            await _reply(client, room, event, body)
            return

        token = tokens[0]
        target = await _room_agent_by_name_or_alias(
            client, session, meta.room_id, token
        )
        if target is None:
            await _reply(
                client,
                room,
                event,
                f"No agent named `{token}` in this room. Run `!list-agents`.",
            )
            return
        # Admin-owned: the Switch app's client runs it.
        host = cast("CommandConsumer", client)
        resolver = AddressingResolver(
            room_store=host._room_store,
            room_role_store=host._room_role_store,
            client_store=host.client_store,
            agent_store=host._agent_store,
            external_user_store=host._external_user_store,
            live_connection_ids=host._connections.live_connection_ids,
        )
        decision = await resolver.permitted(
            session, agent=target, room_id=meta.room_id, sender=event.user_id
        )
        if not decision.allowed:
            await _reply(
                client,
                room,
                event,
                f"You can't assign **{_label(target)}**: it doesn't take "
                "instructions from you, so it couldn't act on this room's "
                "messages for you.",
            )
            return
        await client._room_store.set_main_agent(session, meta.room_id, target.id)
        await session.commit()

    replaced = (
        f" (replacing **{_label(current)}**)"
        if current is not None and current.id != target.id
        else ""
    )
    await _reply(
        client,
        room,
        event,
        f"From now on, every message here goes to **{_label(target)}**{replaced} "
        "unless it mentions someone else. Clear it with `!unassign-agent`.",
    )


async def _cmd_unassign_agent(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    if await _reject_if_following_is_off(client, room, event):
        return
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        current_id = await client._room_store.main_agent_id(session, meta.room_id)
        if current_id is None:
            await _reply(client, room, event, "No agent is assigned in this room.")
            return
        current = await client._agent_store.get(session, current_id)
        await client._room_store.set_main_agent(session, meta.room_id, None)
        await session.commit()

    await _reply(
        client,
        room,
        event,
        f"**{_label(current)}** is no longer assigned. Agents here only get "
        "messages that mention them, or follow-ups.",
    )


def _label(agent: Agent | None) -> str:
    # No leading `@`: these notices are posted to the room, and a live mention
    # would address the agent.
    if agent is None:
        return "an agent that no longer exists"
    return agent_label_with_identifier(agent.display_name, agent.name)


async def _room_agent_by_name_or_alias(
    client: AgentRecipient, session: AsyncSession, room_id: str, token: str
) -> Agent | None:
    """The room member `token` names, by its name or its alias in this room."""
    for agent_id in await client._room_store.get_agent_ids(session, room_id):
        agent = await client._agent_store.get(session, agent_id)
        if agent is not None and agent.name.lower() == token.lower():
            return agent
    alias_target = await client._room_store.get_agent_id_by_alias(
        session, room_id, token
    )
    if alias_target is None:
        return None
    return await client._agent_store.get(session, alias_target)


async def _cmd_list_aliases(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        aliases = await client._room_store.list_aliases(session, meta.room_id)
        if not aliases:
            await _reply(client, room, event, "No aliases defined in this room.")
            return
        lines = ["**Aliases in this room:**"]
        for agent_id, alias in aliases.items():
            agent = await client._agent_store.get(session, agent_id)
            label = (
                agent_label_with_identifier(agent.display_name, agent.name)
                if agent
                else agent_id
            )
            # Render the alias WITHOUT a leading `@`: this text is posted as a
            # room message, and a live `@<alias>` would be re-parsed as a mention
            # and address the aliased agent.
            lines.append(f"- `{alias}` → **{label}**")

    await _reply(client, room, event, "\n".join(lines))


async def _cmd_set_alias(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    tokens = _mention_tokens(event.args)
    if len(tokens) < 2:
        await _reply(
            client,
            room,
            event,
            "Usage: `!set-alias @agent-name @alias` — the agent first, then the "
            "alias to give it in this room.",
        )
        return
    agent_token, alias = tokens[0], tokens[1]

    async with client.session_factory() as session:
        agent_ids = await client._room_store.get_agent_ids(session, meta.room_id)
        agents: list[Agent] = []
        for aid in agent_ids:
            agent = await client._agent_store.get(session, aid)
            if agent is not None:
                agents.append(agent)
        target = next(
            (a for a in agents if a.name.lower() == agent_token.lower()), None
        )
        if target is None:
            await _reply(
                client,
                room,
                event,
                f"No agent named `{agent_token}` in this room. Run `!list-agents`.",
            )
            return
        try:
            validate_alias_format(alias)
            roles = await client._room_role_store.list_roles(session, meta.room_id)
            aliases_by_agent = await client._room_store.list_aliases(
                session, meta.room_id
            )
            check_alias_collisions(
                alias,
                target_agent_id=target.id,
                agent_names=[a.name for a in agents],
                role_names=[r.name for r in roles],
                aliases_by_agent=aliases_by_agent,
            )
        except AliasError as exc:
            await _reply(client, room, event, f"⚠️ {exc}")
            return
        await client._room_store.set_alias(session, meta.room_id, target.id, alias)
        await session.commit()

    # No leading `@` on the alias: this reply is posted to the room, and a live
    # `@<alias>` would be re-parsed as a mention addressing the aliased agent.
    await _reply(
        client,
        room,
        event,
        f"Alias set — address **{agent_label_with_identifier(target.display_name, target.name)}** as `{alias}` in this room.",
    )


async def _cmd_remove_alias(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    tokens = _mention_tokens(event.args)
    if not tokens:
        await _reply(
            client,
            room,
            event,
            "Usage: `!remove-alias @alias` (or `@agent-name`).",
        )
        return
    token = tokens[0]

    async with client.session_factory() as session:
        target_id = await client._room_store.get_agent_id_by_alias(
            session, meta.room_id, token
        )
        if target_id is None:
            # Fall back to treating the token as the agent's real name.
            agent = await client._agent_store.get_by_name(session, token)
            if agent is not None:
                room_agent_ids = await client._room_store.get_agent_ids(
                    session, meta.room_id
                )
                has_alias = await client._room_store.get_alias(
                    session, meta.room_id, agent.id
                )
                if agent.id in room_agent_ids and has_alias:
                    target_id = agent.id
        if target_id is None:
            await _reply(
                client,
                room,
                event,
                f"No alias `{token}` in this room. Run `!list-aliases`.",
            )
            return
        await client._room_store.set_alias(session, meta.room_id, target_id, None)
        await session.commit()

    await _reply(client, room, event, f"Removed the `{token}` alias.")


async def _cmd_invite(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    tokens = _mention_tokens(event.args)
    if not tokens:
        await _reply(
            client,
            room,
            event,
            "Usage: `!invite-agent @agent-name` — the agent to add to this room.",
        )
        return
    token = tokens[0]

    async with client.session_factory() as session:
        # Resolve registry-wide (not room-scoped): the agent is being invited, so
        # by definition it is not in the room yet. Case-insensitive, matching how
        # `@name` mentions are routed.
        target = await client._agent_store.get_by_name_insensitive(session, token)
        if target is None:
            await _reply(
                client,
                room,
                event,
                f"No agent named `{token}`. Run `!list-switch-agents` to see "
                "registered agents.",
            )
            return
        room_agent_ids = await client._room_store.get_agent_ids(session, meta.room_id)
        if target.id in room_agent_ids:
            await _reply(
                client,
                room,
                event,
                f"**{agent_label_with_identifier(target.display_name, target.name)}** is already in this room.",
            )
            return

    # `invite-agent` is admin-owned, so only the always-present admin client
    # runs this handler — the `room_service` reference lives on CommandConsumer.
    # Reuse `add_agents_to_room` (the same path as the `invite_agent_to_room`
    # MCP tool) so the agent is invited to the room AND added to any bridged
    # channel.
    await cast("CommandConsumer", client)._room_service.add_agents_to_room(
        meta.room_id, agent_names=[target.name]
    )
    await _reply(
        client,
        room,
        event,
        f"Added **{agent_label_with_identifier(target.display_name, target.name)}** to this room.",
    )


async def _cmd_remove_agent(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    tokens = _mention_tokens(event.args)
    if not tokens:
        await _reply(
            client,
            room,
            event,
            "Usage: `!remove-agent @agent-name` — the agent to remove from this room.",
        )
        return
    token = tokens[0]

    # `remove-agent` is admin-owned, so only the always-present admin client
    # runs this handler.
    host = cast("CommandConsumer", client)
    async with tenant_session(host.session_factory, host.tenant_id) as session:
        target = await _room_agent_by_name_or_alias(
            client, session, meta.room_id, token
        )
        if target is None:
            await _reply(
                client,
                room,
                event,
                f"No agent named `{token}` in this room. Run `!list-agents`.",
            )
            return
        if not await _may_remove_agent(host, session, target, meta.room_id, event):
            await _reply(
                client,
                room,
                event,
                f"You can't remove **{_label(target)}**: it doesn't take "
                "instructions from you. Ask a workspace admin, or whoever it "
                "answers to.",
            )
            return

    await host._room_service.remove_agents_from_room(meta.room_id, [target.id])
    await _reply(client, room, event, f"Removed **{_label(target)}** from this room.")


async def _may_remove_agent(
    host: CommandConsumer,
    session: AsyncSession,
    target: Agent,
    room_id: str,
    event: CommandEvent,
) -> bool:
    """Whether the command's sender may take `target` out of the room.

    Anyone the agent would take instructions from may; so may a workspace
    admin, and an agent that manages agents for the target's owner.
    """
    resolver = AddressingResolver(
        room_store=host._room_store,
        room_role_store=host._room_role_store,
        client_store=host.client_store,
        agent_store=host._agent_store,
        external_user_store=host._external_user_store,
        live_connection_ids=host._connections.live_connection_ids,
    )
    decision = await resolver.permitted(
        session, agent=target, room_id=room_id, sender=event.user_id
    )
    if decision.allowed:
        return True
    principal = await resolver.resolve_sender(session, event.user_id)
    if principal is None:
        return False
    if principal.kind == "user":
        for user_id in principal.user_ids:
            user = await session.get(User, user_id)
            if user is not None and await host._user_store.administers(session, user):
                return True
        return False
    if principal.kind == "agent":
        sender = await host._agent_store.get(session, principal.id)
        return (
            sender is not None
            and sender.can_manage_agents
            and sender.owner_id is not None
            and sender.owner_id == target.owner_id
        )
    return False


# ── Rename and delete ─────────────────────────────────────────────────────────


def _bare_name(token: str) -> str:
    return token.strip().lstrip("@")


def _strip_quotes(text: str) -> str:
    text = text.strip()
    for opening, closing in (('"', '"'), ("'", "'"), ("\u201c", "\u201d")):
        if len(text) >= 2 and text.startswith(opening) and text.endswith(closing):
            return text[1:-1].strip()
    return text


@dataclass(frozen=True)
class _Authority:
    """Whether this command's sender may rename or delete an agent: the Switch
    user they act as when they may, or why not when they may not."""

    user_id: str | None
    refusal: str | None


async def _manage_authority(
    host: CommandConsumer, session: AsyncSession, event: CommandEvent, agent: Agent
) -> _Authority:
    """Whether this command's sender may rename or delete `agent`.

    The same rule as the gateway: the agent's owner, or an admin of the
    workspace. The sender is a person on a chat platform, known to Switch
    through the Switch users who have linked that platform account; an
    account nobody has linked cannot be told apart from anyone else, so it is
    refused with what to do about it.
    """
    client = await host.client_store.get_by_transport_user_id(session, event.user_id)
    external = (
        await host._external_user_store.get_by_client_id(session, client.id)
        if client is not None
        else None
    )
    if external is None:
        return _Authority(
            None,
            "Only a person can rename or delete an agent, from their own chat account.",
        )
    claimants = await host._external_user_store.claimant_ids(session, external.id)
    if not claimants:
        return _Authority(
            None,
            "This chat account isn't linked to a Switch user, so I can't tell "
            "whether you own this agent. Link it to your Switch user in Switch "
            "Console (Messaging apps), then try again.",
        )
    for user_id in claimants:
        user = await host._user_store.get(session, user_id)
        if user is None:
            continue
        try:
            require_manage(
                Principal(user.id, await host._user_store.administers(session, user)),
                agent.owner_id,
            )
            return _Authority(user.id, None)
        except PermissionError:
            continue
    return _Authority(
        None, "Only the agent's owner or a workspace admin can rename or delete it."
    )


async def _cmd_rename_agent(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    host = cast("CommandConsumer", client)
    usage = (
        "Usage: `!rename-agent @agent new-name [Display Name]`. Leave out the "
        "display name to keep it, or to have it follow the new name when it is "
        "just the old name written out."
    )
    parts = (event.args or "").split(maxsplit=2)
    if len(parts) < 2:
        await _reply(host, room, event, usage)
        return
    old, new_name = _bare_name(parts[0]), _bare_name(parts[1])
    given_label = _strip_quotes(parts[2]) if len(parts) == 3 else None

    async with host.session_factory() as session:
        agent = await host._agent_store.get_by_name_insensitive(session, old)
        if agent is None:
            await _reply(
                host,
                room,
                event,
                f"No agent named `{old}`. Run `!list-switch-agents` to see registered agents.",
            )
            return
        refusal = (await _manage_authority(host, session, event, agent)).refusal
        agent_id, old_name, old_label = agent.id, agent.name, agent.display_name
        # Not held across the rename, which opens its own sessions and calls
        # every bridge.
        await session.commit()
    if refusal is not None:
        await _reply(host, room, event, f"⚠️ {refusal}")
        return

    display_name = (
        given_label
        if given_label is not None
        else label_after_rename(old_label, old_name, new_name)
    )
    try:
        result = await host._agent_admin.core.rename_agent(
            agent_id=agent_id, new_name=new_name, display_name=display_name
        )
    except (AgentExistsError, AgentRenameRefused, ValueError) as exc:
        await _reply(host, room, event, f"⚠️ Not renamed: {exc}")
        return

    label = agent_label_with_identifier(result.display_name, result.new_name)
    if result.old_name == result.new_name:
        lines = [f"Updated **{label}**."]
    else:
        lines = [
            f"Renamed `{result.old_name}` to **{label}**. Mention it by its new "
            "name from now on."
        ]
    if result.bridge_failures:
        lines.append(
            "Not yet updated on "
            + "; ".join(result.bridge_failures)
            + ". It catches up when that bridge next starts."
        )
    if result.templates_mentioning_old_name:
        lines.append(
            "Saved templates still naming the old name: "
            + ", ".join(f"`{name}`" for name in result.templates_mentioning_old_name)
            + "."
        )
    logger.info(
        "Renamed agent %s from %s to %s by in-room command from %s",
        agent_id,
        result.old_name,
        result.new_name,
        event.user_id,
    )
    await _reply(host, room, event, "\n".join(lines))


async def _cmd_delete_agent(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, _is_direct: bool
) -> None:
    host = cast("CommandConsumer", client)
    parts = (event.args or "").split()
    if not parts:
        await _reply(
            host,
            room,
            event,
            "Usage: `!delete-agent @agent`, then `!delete-agent @agent confirm` to go ahead.",
        )
        return
    name = _bare_name(parts[0])
    confirming = len(parts) > 1 and _bare_name(parts[1]).lower() == "confirm"

    async with host.session_factory() as session:
        agent = await host._agent_store.get_by_name_insensitive(session, name)
        if agent is None:
            await _reply(
                host,
                room,
                event,
                f"No agent named `{name}`. Run `!list-switch-agents` to see registered agents.",
            )
            return
        authority = await _manage_authority(host, session, event, agent)
        agent_id, agent_name = agent.id, agent.name
        label = agent_label_with_identifier(agent.display_name, agent.name)
        other_rooms = [
            r.transport_room_id
            for r in await host._room_store.get_rooms_for_agent(session, agent.id)
            if r.transport_room_id != room.room_id
        ]
        await session.commit()
    if authority.refusal is not None:
        await _reply(host, room, event, f"⚠️ {authority.refusal}")
        return

    meta = await host._resolve_room_meta(room.room_id)
    agent_request = (
        host._deletion_requests.take(meta.room_id, agent_id)
        if confirming and meta is not None
        else None
    )
    person_request = confirming and host.take_delete_request(
        room.room_id, event.user_id, agent_id
    )
    if not (agent_request or person_request):
        host.request_delete(room.room_id, event.user_id, agent_id)
        await _reply(
            host,
            room,
            event,
            f"This permanently deletes **{label}**: its credentials, its place in "
            "every room, and its handle on connected chat platforms. To go ahead, "
            f"send `!delete-agent {agent_name} confirm` within 2 minutes.",
        )
        return

    try:
        deletion = await host._agent_admin.core.delete_agent(agent_id=agent_id)
    except ValueError as exc:
        await _reply(host, room, event, f"⚠️ Not deleted: {exc}")
        return
    async with host.session_factory() as session:
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=authority.user_id,
            action=AuditAction.AGENT_DELETED,
            target_type="agent",
            target_id=agent_id,
            details={
                "agent_name": agent_name,
                "via": "chat command",
                "requested_by_agent_name": (
                    agent_request.requested_by if agent_request else None
                ),
            },
        )
        await session.commit()
    asked = (
        f", as {agent_request.requested_by} asked" if agent_request is not None else ""
    )
    for other in other_rooms:
        try:
            await host.actor.send_admin(
                other,
                f"🗑️ **{label}** was deleted{asked}. It no longer answers here.",
                message_type=AdminMessageType.AGENT_LIFECYCLE,
                thread_root_id=None,
            )
        except Exception:
            logger.warning(
                "Could not announce the deletion of agent %s in %s",
                agent_id,
                other,
                exc_info=True,
            )
    lines = [f"Deleted **{label}**{asked}."]
    if deletion.bridge_failures:
        lines.append(
            "Clean-up still to finish on "
            + "; ".join(deletion.bridge_failures)
            + ". It finishes when that bridge next starts."
        )
    logger.info(
        "Deleted agent %s (%s) by in-room command from %s",
        agent_id,
        agent_name,
        event.user_id,
    )
    await _reply(host, room, event, "\n".join(lines))


# Emoji + label shown per status by the !status command.
_STATUS_DISPLAY: dict[AgentStatus, tuple[str, str]] = {
    AgentStatus.LIVE: ("🟢", "live"),
    AgentStatus.NO_SESSION: ("⚪", "no session"),
    AgentStatus.DISCONNECTED: ("🔴", "disconnected"),
    AgentStatus.AWAITING_MANUAL_POLL: ("🟡", "awaiting manual poll"),
}

# Runtime-state label appended to the presence line when a live session is
# reporting what it is doing. "idle" is omitted — it carries no extra signal
# over the presence status.
_RUNTIME_STATE_DISPLAY: dict[str, str] = {
    "working": "⚙️ working",
    "awaiting-input": "✋ awaiting input",
}


def _format_status_lines(
    agents: list[Agent],
    statuses: dict[str, AgentStatus],
    runtime_states: dict[str, str],
    deeplinks: dict[str, str],
) -> str:
    """Render the !status summary: one line per agent (sorted by the name it is
    shown under) with its presence emoji + label, runtime state (if any),
    agent_type, and a Switch Console deeplink to its session
    when one is known.

    The deeplink is shown only for an agent whose session is LIVE in this room:
    the stored link is per (agent, room) and survives a room switch, so once the
    session moves away it would point at a session no longer here. Gating on
    LIVE keeps the link from going stale when an agent hops rooms."""
    lines = ["**Agent status in this room:**"]
    for agent in sorted(agents, key=lambda a: (a.display_name or a.name).lower()):
        status = statuses.get(agent.id, AgentStatus.NO_SESSION)
        emoji, label = _STATUS_DISPLAY.get(status, ("", status.value))
        runtime = _RUNTIME_STATE_DISPLAY.get(runtime_states.get(agent.id, ""))
        name = agent_label_with_identifier(agent.display_name, agent.name)
        head = f"{emoji} **{name}** — {label}"
        if runtime is not None:
            head += f" · {runtime}"
        parts = [head, agent.agent_type]
        deeplink = deeplinks.get(agent.id)
        if deeplink and status == AgentStatus.LIVE:
            parts.append(f"[Open in Switch Console]({deeplink})")
        lines.append("- " + " · ".join(parts))
    return "\n".join(lines)


async def _cmd_status(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        agent_ids = await client._room_store.get_agent_ids(session, meta.room_id)
        agents = []
        for agent_id in agent_ids:
            agent = await client._agent_store.get(session, agent_id)
            if agent is not None:
                agents.append(agent)
        if not agents:
            await _reply(client, room, event, "No agents in this room.")
            return
        statuses = await compute_agent_statuses(
            session,
            agents,
            meta.room_id,
            client._agent_session_store,
            client._connections,
        )
        runtime_rows = await AgentRuntimeStateStore().get_by_room(session, meta.room_id)
        runtime_states = {row.agent_id: row.state for row in runtime_rows}
        deeplinks = {
            row.agent_id: row.deeplink_url for row in runtime_rows if row.deeplink_url
        }

    await _reply(
        client,
        room,
        event,
        _format_status_lines(agents, statuses, runtime_states, deeplinks),
    )


async def _cmd_roles(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        roles = await client._room_role_store.list_roles(session, meta.room_id)
        if not roles:
            await _reply(client, room, event, "No roles defined in this room.")
            return
        holders = await client._room_role_store.live_holders_for_room(
            session, meta.room_id, client._connections.live_connection_ids()
        )
        holder_names: dict[str, str] = {}
        for holder_id in {h for ids in holders.values() for h in ids}:
            holder = await client._agent_store.get(session, holder_id)
            if holder is not None:
                holder_names[holder_id] = agent_label(holder.display_name, holder.name)

    lines = ["**Roles in this room:**"]
    for role in roles:
        kind = "exclusive" if role.exclusive else "shared"
        role_holders = holders.get(role.id, [])
        if role_holders:
            names = ", ".join(holder_names.get(h, h) for h in role_holders)
            status = f"🟢 held by {names}"
        else:
            status = "⚪ free"
        lines.append(f"- **{role.name}** _({kind})_ — {status}")
    await _reply(client, room, event, "\n".join(lines))


async def _cmd_list_documents(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        docs = await client._document_store.list_for_room(session, meta.room_id)
        if not docs:
            await _reply(client, room, event, "No internal documents in this room.")
            return

        if client._frontend_base_url is None:
            logger.warning(
                "FRONTEND_BASE_URL is not configured; document listing will omit links"
            )

        lines = ["**Internal documents in this room:**"]
        for d in docs:
            scope = " _(room-scoped)_" if d.room_id is not None else ""
            creator = ""
            if d.created_by_agent_id:
                agent = await client._agent_store.get(session, d.created_by_agent_id)
                if agent:
                    creator = (
                        f" — created by {agent_label(agent.display_name, agent.name)}"
                    )
            desc = f" — {d.description}" if d.description else ""
            if client._frontend_base_url is None:
                name_md = f"**{d.name}**"
            else:
                if d.room_id is not None:
                    url = f"{client._frontend_base_url}/rooms/{d.room_id}/documents/{d.id}"
                else:
                    url = f"{client._frontend_base_url}/resources/documents/{d.id}"
                name_md = f"[{d.name}]({url})"
            lines.append(f"- {name_md}{scope}{desc}{creator}")

    await _reply(client, room, event, "\n".join(lines))


async def _cmd_list_references(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    async with client.session_factory() as session:
        refs = await client._reference_store.list_for_room(session, meta.room_id)

    if not refs:
        await _reply(client, room, event, "No references in this room.")
        return

    if client._frontend_base_url is None:
        logger.warning(
            "FRONTEND_BASE_URL is not configured; reference listing will omit links"
        )

    lines = ["**References in this room:**"]
    for ref in refs:
        desc = f" — {ref.description}" if ref.description else ""
        if client._frontend_base_url is None:
            name_md = f"**{ref.name}**"
        else:
            url = f"{client._frontend_base_url}/resources/references/{ref.id}"
            name_md = f"[{ref.name}]({url})"
        lines.append(f"- {name_md} _({ref.type})_{desc}")

    await _reply(client, room, event, "\n".join(lines))


async def _cmd_room_url(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    if client._frontend_base_url is None:
        logger.warning(
            "FRONTEND_BASE_URL is not configured; cannot respond to room-url"
        )
        await _reply(
            client,
            room,
            event,
            "Frontend URL is not configured on this Switch instance.",
        )
        return

    url = f"{client._frontend_base_url}/rooms/{meta.room_id}"
    await _reply(client, room, event, f"Room URL: {url}")


async def _cmd_list_all_agents(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    async with client.session_factory() as session:
        agents = await client._agent_store.get_all(session)

    if not agents:
        await _reply(client, room, event, "No agents registered.")
        return

    lines = ["**Available agents:**"]
    for agent in agents:
        desc = f" — {agent.description}" if agent.description else ""
        label = agent_label_with_identifier(agent.display_name, agent.name)
        lines.append(f"- **{label}**{desc}")
    await _reply(client, room, event, "\n".join(lines))


async def _cmd_agents_greet(
    client: AgentRecipient,
    room: RoomRef,
    event: CommandEvent,
    is_direct: bool,
) -> None:
    async with client.session_factory() as session:
        agent = await client._fresh_agent(session)
    if is_direct:
        label = agent_label(agent.display_name, agent.name)
        await _reply(client, room, event, f"Hi! I'm {label} — how can I help?")
    else:
        # `@{name}` here is a live mention handle the reader tags back, so it
        # stays the identifier whatever the agent is displayed as.
        greeting = random.choice(AGENT_GREETINGS).format(name=agent.name)
        await _reply(client, room, event, greeting)


# ── Registry ──────────────────────────────────────────────────────────────────


COMMANDS: list[Command] = [
    Command(
        "help",
        "Show this list of commands.",
        _cmd_help,
        admin_owned=True,
    ),
    Command(
        "reset",
        "Reset a targeted agent's session (clears context, then reconnects). "
        "Usage: `!reset @agent-name` or `!reset @role` (the role's holder). "
        "A target is required — use `!reset-all-agents` to reset everyone.",
        _cmd_reset,
        decide=_decide_reset,
        args_spec=(
            CommandArg("target", "Agent name, alias, or role to reset", required=True),
        ),
        # The first @token names the agent to reset (by name or held role). A
        # bare `!reset` (no target) addresses NO ONE, so it can never
        # accidentally reset every agent — that is the explicit
        # `!reset-all-agents` command instead.
        addressed=_addressed_by_required_first_mention,
        admin_check=_check_control_target,
    ),
    Command(
        "reset-all-agents",
        "Reset EVERY agent's session in this room (clears context, then "
        "reconnects each). Usage: `!reset-all-agents`.",
        _cmd_reset,
        decide=_decide_reset,
        addressed=_addressed_everyone,
    ),
    Command(
        "compact",
        "Compact a targeted agent's session context. "
        "Usage: `!compact @agent-name` or `!compact @role` (the role's holder). "
        "A target is required — use `!compact-all-agents` for everyone.",
        _cmd_compact,
        decide=_decide_compact,
        args_spec=(
            CommandArg(
                "target", "Agent name, alias, or role to compact", required=True
            ),
        ),
        # Require an explicit target — see `reset` — so a bare `!compact` never
        # fans out to the whole room by accident.
        addressed=_addressed_by_required_first_mention,
        admin_check=_check_control_target,
    ),
    Command(
        "compact-all-agents",
        "Compact EVERY agent's session context in this room. "
        "Usage: `!compact-all-agents`.",
        _cmd_compact,
        decide=_decide_compact,
        addressed=_addressed_everyone,
    ),
    Command(
        "interrupt",
        "Interrupt a targeted agent's current turn. "
        "Usage: `!interrupt @agent-name` or `!interrupt @role` (the role's holder). "
        "A target is required — use `!interrupt-all-agents` for everyone.",
        _cmd_interrupt,
        decide=_decide_interrupt,
        args_spec=(
            CommandArg(
                "target", "Agent name, alias, or role to interrupt", required=True
            ),
        ),
        addressed=_addressed_by_required_first_mention,
        admin_check=_check_control_target,
    ),
    Command(
        "interrupt-all-agents",
        "Interrupt EVERY agent's current turn in this room. "
        "Usage: `!interrupt-all-agents`.",
        _cmd_interrupt,
        decide=_decide_interrupt,
        addressed=_addressed_everyone,
    ),
    Command(
        "list-agents",
        "List agents in this room.",
        _cmd_list_room_agents,
        admin_owned=True,
    ),
    Command(
        # Named `agents-status` rather than `status`: Slack reserves the
        # `/status` slash command, so it can't be registered.
        "agents-status",
        "Show each agent's presence status and capabilities in this room.",
        _cmd_status,
        admin_owned=True,
    ),
    Command(
        "roles",
        "List this room's roles and who currently holds each.",
        _cmd_roles,
        admin_owned=True,
    ),
    Command(
        "list-documents",
        "List the room's internal documents.",
        _cmd_list_documents,
        admin_owned=True,
    ),
    Command(
        "list-references",
        "List the room's references.",
        _cmd_list_references,
        admin_owned=True,
    ),
    Command(
        "list-aliases",
        "List per-room agent aliases (`@alias` → agent).",
        _cmd_list_aliases,
        admin_owned=True,
    ),
    Command(
        "follow-ups",
        "Turn follow-ups on or off for this room: whether a reply in an agent's "
        "thread, or the next message after an agent's answer, reaches it without "
        "an @. Usage: `!follow-ups on`, `!follow-ups off`, or `!follow-ups`.",
        _cmd_follow_ups,
        args_spec=(CommandArg("state", "on or off", required=False),),
        admin_owned=True,
    ),
    Command(
        "assign-agent",
        "Send every message in this room to one agent, unless it mentions "
        "someone else. Usage: `!assign-agent @agent-name`, or `!assign-agent` "
        "to see who is assigned.",
        _cmd_assign_agent,
        args_spec=(CommandArg("agent", "The agent to assign", required=False),),
        admin_owned=True,
    ),
    Command(
        "unassign-agent",
        "Stop sending every message in this room to the assigned agent. "
        "Usage: `!unassign-agent`.",
        _cmd_unassign_agent,
        admin_owned=True,
    ),
    Command(
        "set-alias",
        "Give an agent a room alias. Usage: `!set-alias @agent-name @alias`.",
        _cmd_set_alias,
        args_spec=(
            CommandArg("agent", "The agent to give an alias to", required=True),
            CommandArg("alias", "The alias to use for it in this room", required=True),
        ),
        admin_owned=True,
    ),
    Command(
        "remove-alias",
        "Remove a room alias. Usage: `!remove-alias @alias` (or `@agent-name`).",
        _cmd_remove_alias,
        args_spec=(
            CommandArg(
                "alias", "The alias to clear (or the agent's name)", required=True
            ),
        ),
        admin_owned=True,
    ),
    Command(
        "invite-agent",
        "Add an existing agent to this room. Usage: `!invite-agent @agent-name`.",
        _cmd_invite,
        args_spec=(
            CommandArg(
                "agent", "The registered agent to add to this room", required=True
            ),
        ),
        admin_owned=True,
    ),
    Command(
        "remove-agent",
        "Remove an agent from this room. Usage: `!remove-agent @agent-name`.",
        _cmd_remove_agent,
        args_spec=(
            CommandArg("agent", "The agent to remove from this room", required=True),
        ),
        admin_owned=True,
    ),
    Command(
        "rename-agent",
        "Rename an agent, and its display name with it. Owner or admin only. "
        "Usage: `!rename-agent @agent new-name [Display Name]`.",
        _cmd_rename_agent,
        args_spec=(
            CommandArg("agent", "The agent to rename", required=True),
            CommandArg(
                "new_name", "Its new name (lowercase, no spaces)", required=True
            ),
            CommandArg(
                "display_name",
                "Its new display name (leave empty to keep it)",
                required=False,
                free_text=True,
            ),
        ),
        admin_owned=True,
    ),
    Command(
        "delete-agent",
        "Delete an agent everywhere, after a confirmation. Owner or admin only. "
        "Usage: `!delete-agent @agent`, then `!delete-agent @agent confirm`.",
        _cmd_delete_agent,
        args_spec=(
            CommandArg("agent", "The agent to delete", required=True),
            CommandArg("confirm", "Type confirm to go ahead", required=False),
        ),
        admin_owned=True,
    ),
    Command(
        "room-url",
        "Show the frontend URL for this room.",
        _cmd_room_url,
        admin_owned=True,
    ),
    Command(
        "list-switch-agents",
        "List all agents registered on the Switch.",
        _cmd_list_all_agents,
        admin_owned=True,
    ),
    Command(
        "agents-greet",
        "Have agents in the room introduce themselves.",
        _cmd_agents_greet,
    ),
]

COMMANDS_BY_NAME: dict[str, Command] = {cmd.name: cmd for cmd in COMMANDS}


async def dispatch_command(
    client: AgentRecipient, room: RoomRef, event: CommandEvent, is_direct: bool
) -> bool:
    """Runs a command.

    Returns True if the command was fully handled and should NOT be forwarded
    to the agent's event queue; False if it should also be enqueued.
    """
    cmd = COMMANDS_BY_NAME.get(event.command)
    if cmd is None:
        # The admin client is the room's command front-door and posts the
        # "unknown command" notice; agents stay silent.
        return True

    # Admin-owned commands are handled by the admin client; agents never run
    # them (on_command already filters, but guard here too).
    if cmd.admin_owned:
        return True

    if cmd.handler is not None:
        await cmd.handler(client, room, event, is_direct)

    return not cmd.forward_to_agent


async def dispatch_admin_command(
    host: CommandConsumer, room: RoomRef, event: CommandEvent
) -> None:
    """Run an admin-owned command on the admin client.

    The admin client is the room's single responder for room/info/alias
    commands, so it runs them unconditionally (no role/availability gating) and
    renders the result as an admin/system message. Commands that exist but are
    agent-owned are left to the agents; a name that matches no command gets an
    "unknown command" notice (the admin is the room's command front-door)."""
    cmd = COMMANDS_BY_NAME.get(event.command)
    if cmd is None:
        await _reply(host, room, event, f"Unknown command: `{event.command}`")
        return
    # Admin-side usage feedback (e.g. control commands with a bad/missing
    # target) runs even for agent-owned commands — the admin is the room's
    # front-door and gives the misuse notice the agents can't.
    if cmd.admin_check is not None:
        meta = await host._resolve_room_meta(room.room_id)
        if meta is not None:
            await cmd.admin_check(host, room, event, meta)
    if not cmd.admin_owned or cmd.handler is None:
        return
    is_direct = await host._is_direct_room(room.room_id)
    # Admin-owned handlers use only the store/reply surface both clients share
    # (never `.agent`), so the admin host satisfies the handler's contract.
    await cmd.handler(cast("AgentRecipient", host), room, event, is_direct)

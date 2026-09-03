from __future__ import annotations

import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, cast

from nio import MatrixRoom

from switch_core.aliases import (
    AliasError,
    check_alias_collisions,
    validate_alias_format,
)
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AgentStatus,
    CommandPayload,
)
from switch_core.clients.mentions import mention_tokens as _mention_tokens
from switch_core.db.stores.agent_runtime_state_store import AgentRuntimeStateStore
from switch_core.events import CommandEvent
from switch_core.gateway.known_agents import known_agent_for

if TYPE_CHECKING:
    from switch_core.clients.admin_client import AdminClient
    from switch_core.clients.agent_client import AgentClient
    from switch_core.clients.room_meta import RoomMeta
    from switch_core.db.models import Agent

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
    ["AgentClient", MatrixRoom, CommandEvent, bool], Awaitable[None]
]
# (client, args, room_id) -> whether THIS agent is addressed by the command.
# Targeting is a per-command policy (see Command.addressed) rather than a fixed
# rule in on_command, so a command like `run-cmd` can interpret its args its
# own way.
CommandTargeting = Callable[["AgentClient", str, str], Awaitable[bool]]
# (host, room, event, meta) -> None. An admin-side usage check run by the
# always-present admin client BEFORE agents act on a command. It posts a
# system message when the command is misused (bad/missing target) and does
# nothing when usage is valid; it never executes the command itself.
CommandAdminCheck = Callable[
    ["AdminClient", MatrixRoom, CommandEvent, "RoomMeta"], Awaitable[None]
]


async def _addressed_by_name_or_role(
    client: AgentClient, args: str, room_id: str
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


async def _addressed_by_first_mention(
    client: AgentClient, args: str, room_id: str
) -> bool:
    """Targeting for `run-cmd`: only the FIRST `@token` addresses an agent (by
    name or by a role it holds). Any further `@token` is data for the handler
    (the role to name in the output), not an addressing token — so
    `!run-cmd @alice @manager` reaches alice, not whoever holds manager.

    No `@token` → addressed to everyone (the command applies room-wide).
    """
    tokens = _mention_tokens(args)
    if not tokens:
        return True
    return await _first_token_is_me(client, tokens[0], room_id)


async def _addressed_by_required_first_mention(
    client: AgentClient, args: str, room_id: str
) -> bool:
    """Like `_addressed_by_first_mention`, but a missing target addresses NO
    ONE. Used by `!reset`, where a bare `!reset` must not silently reset every
    agent in the room — resetting all agents is the separate, explicit
    `!reset-all-agents` command.
    """
    tokens = _mention_tokens(args)
    if not tokens:
        return False
    return await _first_token_is_me(client, tokens[0], room_id)


async def _addressed_everyone(client: AgentClient, args: str, room_id: str) -> bool:
    """Targeting for room-wide control commands (`!reset-all-agents`): every
    agent is addressed regardless of args, so the command always fans out to
    the whole room."""
    return True


async def _first_token_is_me(client: AgentClient, first: str, room_id: str) -> bool:
    """Whether `@first` names this agent — by name, room alias, or a held role."""
    if client._args_tag_my_name(f"@{first}"):
        return True
    async with client.session_factory() as session:
        if await client._text_tags_my_alias(session, f"@{first}", room_id):
            return True
        return await client._text_tags_my_role(session, f"@{first}", room_id)


async def _check_control_target(
    host: AdminClient, room: MatrixRoom, event: CommandEvent, meta: RoomMeta
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
    A command taking genuine free text is not representable here and would need
    a kind/type field adding before it could be declared.

    `name` is what the user sees as the field label on platforms that render
    one, so it must be lowercase and match Discord's `^[-_a-z0-9]{1,32}$`.
    """

    name: str
    description: str
    required: bool


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
    # `!run-cmd`, `!reset`, `!agents-greet`), which answer in their own voice.
    admin_owned: bool = False


# ── Handlers ──────────────────────────────────────────────────────────────────


async def _reply(
    client: AgentClient | AdminClient,
    room: MatrixRoom,
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
    client: AgentClient, room: MatrixRoom, event: CommandEvent, _is_direct: bool
) -> None:
    lines = ["**Available commands:**"]
    for cmd in COMMANDS:
        if cmd.hidden:
            continue
        lines.append(f"- `!{cmd.name}` — {cmd.description}")
    await _reply(client, room, event, "\n".join(lines))


async def _dispatch_control_command(
    client: AgentClient,
    room: MatrixRoom,
    event: CommandEvent,
    command: str,
    *,
    ack: str,
    unsupported_msg: str,
    no_live_session_msg: str,
    no_session_msg: str,
) -> None:
    """Shared logic for the session-control commands (reset/compact/interrupt).

    Resolves the agent's declared capability level for `command` from its
    integration profile, then — for `session_dependent` — checks that a live
    session actually reports it can execute the command (via its runtime-state
    control capabilities). When actionable, acknowledges in the room and queues
    a `command` event for the agent's controller (e.g. Switch Console) to execute.

    Two distinct "can't act" cases are reported separately: no live session in
    the room at all (`no_live_session_msg`) vs. a live session that can't be
    controlled from here — e.g. not started from Switch Console (`no_session_msg`).
    """
    async with client.session_factory() as session:
        agent = await client._fresh_agent(session)
    profile = agent.integration_profile or {}
    level = (profile.get("command_capabilities") or {}).get(command, "unsupported")

    if level == "unsupported":
        await _reply(client, room, event, unsupported_msg)
        return

    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        return

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
                session, meta.room_id, agent.id, client._connections.live_agent_ids()
            )
        live = statuses.get(agent.id) == AgentStatus.LIVE
        caps = (runtime.control_capabilities or {}) if runtime else {}
        if not live:
            await _reply(client, room, event, no_live_session_msg)
            return
        if not caps.get(command):
            await _reply(client, room, event, no_session_msg)
            return
        deeplink = runtime.deeplink_url if runtime else None

    args = event.args
    if command in ("reset", "compact"):
        args = role or ""

    # Mirror the runtime "working" surface: link back to the session in
    # Switch Console when we know its deeplink.
    body = f"{ack} ([Open in Switch Console]({deeplink}))" if deeplink else ack
    await _reply(client, room, event, body)
    client._event_buffer.enqueue(
        client.agent.id,
        meta.room_id,
        AgentEvent(
            type="command",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=CommandPayload(
                command=command,
                args=args,
                user_id=event.user_id,
                user_name=event.user_name,
                thread_id=event.thread_id,
            ),
        ),
    )


async def _cmd_reset(
    client: AgentClient, room: MatrixRoom, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(
        client,
        room,
        event,
        "reset",
        ack="Resetting my session — clearing context, then reconnecting to this room.",
        unsupported_msg="My session can't be reset — this isn't supported for me.",
        no_live_session_msg=(
            "I have no active session in this room, so there's nothing to reset."
        ),
        no_session_msg=(
            "My session can't be reset from here — it wasn't started from "
            "Switch Console, so my operator needs to reset it manually (e.g. by "
            "restarting my session)."
        ),
    )


async def _cmd_compact(
    client: AgentClient, room: MatrixRoom, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(
        client,
        room,
        event,
        "compact",
        ack="Compacting my session's context.",
        unsupported_msg="I can't compact my session — this isn't supported for me.",
        no_live_session_msg=(
            "I have no active session in this room, so there's nothing to compact."
        ),
        no_session_msg=(
            "I can't compact from here — my session wasn't started from "
            "Switch Console, so my operator needs to compact it manually."
        ),
    )


async def _cmd_interrupt(
    client: AgentClient, room: MatrixRoom, event: CommandEvent, _is_direct: bool
) -> None:
    await _dispatch_control_command(
        client,
        room,
        event,
        "interrupt",
        ack="Interrupted my current turn.",
        unsupported_msg="I can't be interrupted — this isn't supported for me.",
        no_live_session_msg=(
            "I have no active session in this room, so there's nothing to interrupt."
        ),
        no_session_msg=(
            "I can't be interrupted from here — my session wasn't started from "
            "Switch Console, so my operator needs to interrupt it manually."
        ),
    )


async def _cmd_list_room_agents(
    client: AgentClient,
    room: MatrixRoom,
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
                lines.append(f"- **{agent.name}**{desc}")

    await _reply(client, room, event, "\n".join(lines))


async def _cmd_list_aliases(
    client: AgentClient,
    room: MatrixRoom,
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
            name = agent.name if agent else agent_id
            # Render the alias WITHOUT a leading `@`: this text is posted as a
            # room message, and a live `@<alias>` would be re-parsed as a mention
            # and address the aliased agent.
            lines.append(f"- `{alias}` → **{name}**")

    await _reply(client, room, event, "\n".join(lines))


async def _cmd_set_alias(
    client: AgentClient,
    room: MatrixRoom,
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
        f"Alias set — address **{target.name}** as `{alias}` in this room.",
    )


async def _cmd_remove_alias(
    client: AgentClient,
    room: MatrixRoom,
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
    client: AgentClient,
    room: MatrixRoom,
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
                client, room, event, f"**{target.name}** is already in this room."
            )
            return

    # `invite-agent` is admin-owned, so only the always-present admin client
    # runs this handler — the `room_service` reference lives on AdminClient.
    # Reuse `add_agents_to_room` (the same path as the `invite_agent_to_room`
    # MCP tool) so the agent is invited to Matrix AND added to any bridged
    # channel.
    await cast("AdminClient", client)._room_service.add_agents_to_room(
        meta.room_id, agent_names=[target.name]
    )
    await _reply(client, room, event, f"Added **{target.name}** to this room.")


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
    """Render the !status summary: one line per agent (sorted by name) with
    its presence emoji + label, runtime state (if any), agent_type, task
    capabilities, and a Switch Console deeplink to its session when one is known.

    The deeplink is shown only for an agent whose session is LIVE in this room:
    the stored link is per (agent, room) and survives a room switch, so once the
    session moves away it would point at a session no longer here. Gating on
    LIVE keeps the link from going stale when an agent hops rooms."""
    lines = ["**Agent status in this room:**"]
    for agent in sorted(agents, key=lambda a: a.name):
        status = statuses.get(agent.id, AgentStatus.NO_SESSION)
        emoji, label = _STATUS_DISPLAY.get(status, ("", status.value))
        runtime = _RUNTIME_STATE_DISPLAY.get(runtime_states.get(agent.id, ""))
        head = f"{emoji} **{agent.name}** — {label}"
        if runtime is not None:
            head += f" · {runtime}"
        parts = [head, agent.agent_type]
        task_protocol = (agent.integration_profile or {}).get("task_protocol", {})
        caps = []
        if task_protocol.get("can_delegate"):
            caps.append("delegate")
        if task_protocol.get("can_accept"):
            caps.append("accept")
        if caps:
            parts.append("+".join(caps))
        deeplink = deeplinks.get(agent.id)
        if deeplink and status == AgentStatus.LIVE:
            parts.append(f"[Open in Switch Console]({deeplink})")
        lines.append("- " + " · ".join(parts))
    return "\n".join(lines)


async def _cmd_status(
    client: AgentClient,
    room: MatrixRoom,
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
    client: AgentClient,
    room: MatrixRoom,
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
            session, meta.room_id, client._connections.live_agent_ids()
        )
        holder_names: dict[str, str] = {}
        for holder_id in {h for ids in holders.values() for h in ids}:
            holder = await client._agent_store.get(session, holder_id)
            if holder is not None:
                holder_names[holder_id] = holder.name

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
    client: AgentClient,
    room: MatrixRoom,
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
                    creator = f" — created by {agent.name}"
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
    client: AgentClient,
    room: MatrixRoom,
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
    client: AgentClient,
    room: MatrixRoom,
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
    client: AgentClient,
    room: MatrixRoom,
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
        lines.append(f"- **{agent.name}**{desc}")
    await _reply(client, room, event, "\n".join(lines))


def _role_arg(args: str) -> str | None:
    """The role to name in the `run-cmd` output, if one was supplied.

    The first `@token` targets the agent (see `_addressed_by_first_mention`);
    the SECOND `@token`, if present, is the role the started session should
    assume (`!run-cmd @agent @role`). Returns that second token, or None.
    """
    tokens = _mention_tokens(args)
    return tokens[1] if len(tokens) >= 2 else None


async def _cmd_run_cmd(
    client: AgentClient,
    room: MatrixRoom,
    event: CommandEvent,
    _is_direct: bool,
) -> None:
    meta = await client._resolve_room_meta(room.room_id)
    if meta is None:
        await _reply(client, room, event, "Room not found.")
        return

    # Re-read the agent so edits to options via the gateway are reflected
    # without restarting this client.
    async with client.session_factory() as session:
        fresh = await client._agent_store.get(session, client.agent.id)
    agent = fresh or client.agent
    spec_options = known_agent_for(agent)
    if spec_options is None:
        await _reply(
            client, room, event, "No onboarding command available for this agent."
        )
        return

    spec, options = spec_options

    # `!run-cmd @agent @role`: fold a real role into the connect prompt so the
    # started session lands in the room AND assumes the role in one command.
    # An unknown role is NOT folded in — we warn instead of silently dropping.
    role = _role_arg(event.args)
    async with client.session_factory() as session:
        role_obj = (
            await client._room_role_store.get_role(session, meta.room_id, role)
            if role is not None
            else None
        )
        owner_handle = await client.owner_handle_in(session, agent, meta.bridge_id)
    role_known = role_obj is not None

    msg = spec.start_session_instructions(
        options,
        agent,
        meta.name,
        owner_handle,
        assume_role=role if role_known else None,
    )
    if msg is None:
        await _reply(
            client, room, event, "No onboarding command available for this agent."
        )
        return

    if role is not None and not role_known:
        msg += (
            f"\n\n⚠️ Note: there is no role named **{role}** in **{meta.name}**, "
            "so I left it out of the command — double-check the role name (see "
            "the room's roles)."
        )

    await _reply(client, room, event, msg)


async def _cmd_agents_greet(
    client: AgentClient,
    room: MatrixRoom,
    event: CommandEvent,
    is_direct: bool,
) -> None:
    name = client.agent.name
    if is_direct:
        await _reply(client, room, event, f"Hi! I'm {name} — how can I help?")
    else:
        greeting = random.choice(AGENT_GREETINGS).format(name=name)
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
        addressed=_addressed_everyone,
    ),
    Command(
        "compact",
        "Compact a targeted agent's session context. "
        "Usage: `!compact @agent-name` or `!compact @role` (the role's holder). "
        "A target is required — use `!compact-all-agents` for everyone.",
        _cmd_compact,
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
        addressed=_addressed_everyone,
    ),
    Command(
        "interrupt",
        "Interrupt a targeted agent's current turn. "
        "Usage: `!interrupt @agent-name` or `!interrupt @role` (the role's holder). "
        "A target is required — use `!interrupt-all-agents` for everyone.",
        _cmd_interrupt,
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
    Command(
        "run-cmd",
        "Show the terminal command to start a session for an agent. "
        "Usage: `!run-cmd @agent-name`, `!run-cmd @role` (the role's holder), "
        "or `!run-cmd @agent-name @role` to also assume that role on connect.",
        _cmd_run_cmd,
        # `role` is second because the handler reads it from the second token,
        # so it cannot be given without `agent` — see the positional-gap check
        # in the Discord adapter, which rejects that combination loudly rather
        # than silently shifting the role into the agent slot.
        args_spec=(
            CommandArg("agent", "Agent to show the start command for", required=False),
            CommandArg(
                "role", "Role for that agent to assume on connect", required=False
            ),
        ),
        # Only the first @token targets; a second @token is the role to assume,
        # not an address — so it doesn't pull in whoever else holds that role.
        addressed=_addressed_by_first_mention,
    ),
    Command("admin", "", handler=None, hidden=True),
]

COMMANDS_BY_NAME: dict[str, Command] = {cmd.name: cmd for cmd in COMMANDS}


async def dispatch_command(
    client: AgentClient, room: MatrixRoom, event: CommandEvent, is_direct: bool
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
    host: AdminClient, room: MatrixRoom, event: CommandEvent
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
    await cmd.handler(cast("AgentClient", host), room, event, is_direct)

from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest

from switch_core.bridges.agent.commands import (
    COMMANDS,
    COMMANDS_BY_NAME,
    Command,
    CommandArg,
)
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.slash import (
    MAX_DESCRIPTION,
    SlashArgError,
    build_app_commands,
    reassemble_args,
    summarise_description,
    truncate_description,
    validate_args_spec,
)
from switch_core.bridges.collaboration.models import InboundCommand

GUILD_ID = 900
CHANNEL_ID = 100
BOT_USER_ID = 42


def _adapter() -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._bot_user_id = BOT_USER_ID
    return adapter


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRole:
    pass


class _FakeGuild:
    def __init__(self) -> None:
        self.id = GUILD_ID
        self.default_role = _FakeRole()


class _FakeOverwrite:
    def __init__(self, view_channel: bool | None) -> None:
        self.view_channel = view_channel


class _FakeChannel:
    def __init__(
        self,
        channel_id: int = CHANNEL_ID,
        *,
        name: str | None = "general",
        everyone_can_view: bool | None = True,
    ) -> None:
        self.id = channel_id
        self.guild = _FakeGuild()
        self.name = name
        self._everyone_can_view = everyone_can_view

    def overwrites_for(self, role: Any) -> _FakeOverwrite:
        return _FakeOverwrite(self._everyone_can_view)


class _FakeThread:
    def __init__(self, parent: _FakeChannel, thread_id: int) -> None:
        self.id = thread_id
        self.parent = parent
        self.parent_id = parent.id
        self.guild = parent.guild
        self.name = "a thread"


class _FakeUser:
    def __init__(self, user_id: int = 7, name: str = "doe.jane") -> None:
        self.id = user_id
        self.name = name


class _FakeOriginalMessage:
    def __init__(self, channel: Any, message_id: int) -> None:
        self.channel = channel
        self.id = message_id


class _FakeInteractionResponse:
    def __init__(self, interaction: _FakeInteraction) -> None:
        self._interaction = interaction

    async def send_message(self, content: str, *, ephemeral: bool = False) -> None:
        self._interaction.responses.append({"content": content, "ephemeral": ephemeral})


class _FakeInteraction:
    """Enough of discord.Interaction for the slash path.

    Records what was sent and when, so a test can assert the acknowledgement
    goes out BEFORE any Switch work — the ~3s interaction deadline depends on
    that ordering, not on how fast the dispatch happens to be.
    """

    def __init__(self, channel: Any, *, original_id: int = 999) -> None:
        self.channel = channel
        self.user = _FakeUser()
        self.responses: list[dict[str, Any]] = []
        self.edits: list[str] = []
        self.response = _FakeInteractionResponse(self)
        self._original_id = original_id

    async def original_response(self) -> _FakeOriginalMessage:
        return _FakeOriginalMessage(self.channel, self._original_id)

    async def edit_original_response(self, *, content: str) -> None:
        self.edits.append(content)


def _capture_commands(adapter: DiscordAdapter) -> list[InboundCommand]:
    captured: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        captured.append(cmd)

    adapter._on_command = on_command
    return captured


def _invoke(
    adapter: DiscordAdapter, interaction: Any, name: str, **values: Any
) -> None:
    _run(adapter._handle_slash_command(interaction, COMMANDS_BY_NAME[name], values))


# ── Registration ─────────────────────────────────────────────────────────────


async def _noop(interaction: Any, command: Any, values: Any) -> None:
    return None


def test_every_visible_registry_command_is_registered() -> None:
    built = {c.name for c in build_app_commands(_noop)}
    expected = {c.name for c in COMMANDS if not c.hidden and c.description}
    # The registry is the single source of truth — a command added there must
    # appear as a slash command without anyone editing a second list.
    assert built == expected


def test_registry_command_names_are_valid_discord_names() -> None:
    # Discord command names share the option-name rules. A registry command
    # that breaks them would only fail when a Discord bridge starts.
    for command in COMMANDS:
        if command.hidden:
            continue
        assert re.match(r"^[-_a-z0-9]{1,32}$", command.name), command.name


def test_every_registry_args_spec_is_declarable() -> None:
    # Guards the whole registry, not just the 7 commands that have arguments
    # today: an 8th added with a bad name or a required-after-optional order
    # fails here rather than inside discord.py at bridge startup.
    for command in COMMANDS:
        validate_args_spec(command)


def test_bad_option_name_is_rejected_with_a_useful_message() -> None:
    bad = Command("x", "d", args_spec=(CommandArg("Agent Name", "d", required=True),))
    with pytest.raises(ValueError, match="Agent Name"):
        validate_args_spec(bad)


def test_required_after_optional_is_rejected() -> None:
    # Reassembly is positional, so this ordering cannot round-trip.
    bad = Command(
        "x",
        "d",
        args_spec=(
            CommandArg("first", "d", required=False),
            CommandArg("second", "d", required=True),
        ),
    )
    with pytest.raises(ValueError, match="second"):
        validate_args_spec(bad)


def test_hidden_command_is_not_registered() -> None:
    # `admin` exists only to absorb Slack's manifest-declared `/admin`; it is
    # hidden and carries an empty description, which Discord would reject.
    assert COMMANDS_BY_NAME["admin"].hidden
    assert "admin" not in {c.name for c in build_app_commands(_noop)}


def test_registered_descriptions_fit_discord_cap() -> None:
    for command in build_app_commands(_noop):
        assert 1 <= len(command.description) <= MAX_DESCRIPTION, command.name
        for param in command.parameters:
            assert 1 <= len(param.description) <= MAX_DESCRIPTION, param.name


def test_declared_options_match_the_registry_spec() -> None:
    built = {c.name: c for c in build_app_commands(_noop)}
    for command in COMMANDS:
        if command.hidden or not command.description:
            continue
        params = built[command.name].parameters
        assert [p.name for p in params] == [a.name for a in command.args_spec]
        assert [p.required for p in params] == [a.required for a in command.args_spec]


def test_long_description_truncated_on_word_boundary() -> None:
    long = COMMANDS_BY_NAME["reset"].description
    assert len(long) > MAX_DESCRIPTION
    out = truncate_description(long)
    assert len(out) <= MAX_DESCRIPTION
    assert out.endswith("…")
    # Cut at a word boundary, not mid-word.
    assert not out[:-1].endswith(" ")
    assert long.startswith(out[:-1].rstrip(" .,;:—-"))


def test_short_description_left_alone() -> None:
    assert truncate_description("Short one.") == "Short one."


def test_registered_descriptions_never_teach_the_bang_form() -> None:
    # These render in Discord's command picker. Registry descriptions are
    # written for `!help` and end in a `Usage:` clause naming the `!` form —
    # telling someone who just typed `/reset` to type `!reset` instead.
    for command in build_app_commands(_noop):
        assert "!" not in command.description, command.name
        assert "Usage:" not in command.description, command.name


def test_usage_clause_dropped_from_registered_description() -> None:
    full = COMMANDS_BY_NAME["set-alias"].description
    assert "Usage:" in full  # the registry still carries it for `!help`
    assert summarise_description(full) == "Give an agent a room alias."


def test_summarise_falls_back_rather_than_registering_nothing() -> None:
    # Discord rejects an empty description, so a pathological all-usage entry
    # keeps its text instead of being silently registered blank.
    assert summarise_description("Usage: `!x`") == "Usage: `!x`"


# ── Argument reassembly ──────────────────────────────────────────────────────


def test_declared_options_reassembled_into_positional_args() -> None:
    spec = COMMANDS_BY_NAME["set-alias"].args_spec
    # The handlers read positionally out of the args string, so declared,
    # named options must come back out in spec order.
    assert reassemble_args(spec, {"agent": "worker", "alias": "w"}) == "@worker @w"


def test_at_prefix_is_optional_and_never_doubled() -> None:
    spec = COMMANDS_BY_NAME["set-alias"].args_spec
    expected = "@worker @w"
    assert reassemble_args(spec, {"agent": "@worker", "alias": "@w"}) == expected
    assert reassemble_args(spec, {"agent": "worker", "alias": "w"}) == expected
    assert reassemble_args(spec, {"agent": " @worker ", "alias": "w "}) == expected


def test_omitted_trailing_optional_is_dropped() -> None:
    spec = COMMANDS_BY_NAME["run-cmd"].args_spec
    assert reassemble_args(spec, {"agent": "worker", "role": None}) == "@worker"
    assert reassemble_args(spec, {"agent": None, "role": None}) == ""


def test_value_after_omitted_optional_is_rejected() -> None:
    # Discord submits options by name and allows role-without-agent, but the
    # positional form cannot express it: `@manager` would land in the agent
    # slot and run-cmd would answer for the wrong target.
    spec = COMMANDS_BY_NAME["run-cmd"].args_spec
    with pytest.raises(SlashArgError) as excinfo:
        reassemble_args(spec, {"agent": None, "role": "manager"})
    assert "agent" in str(excinfo.value)


def test_missing_required_value_is_rejected() -> None:
    spec = COMMANDS_BY_NAME["set-alias"].args_spec
    with pytest.raises(SlashArgError):
        reassemble_args(spec, {"agent": "worker", "alias": ""})


@pytest.mark.parametrize("bad", ["two words", "@a@b", "we!rd", ""])
def test_non_token_value_is_rejected_not_silently_truncated(bad: str) -> None:
    # A value with a space would lose everything after it once tokenised —
    # silently running a different command than the user asked for.
    spec = COMMANDS_BY_NAME["invite-agent"].args_spec
    with pytest.raises(SlashArgError):
        reassemble_args(spec, {"agent": bad})


# ── Dispatch ─────────────────────────────────────────────────────────────────


def test_slash_command_maps_to_in_room_command() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)
    channel = _FakeChannel()
    interaction = _FakeInteraction(channel)

    _invoke(adapter, interaction, "reset", target="@worker")

    assert len(commands) == 1
    cmd = commands[0]
    # The slash name IS the in-room command name, so it reaches the same
    # dispatcher a typed `!reset @worker` reaches.
    assert cmd.command == "reset"
    assert cmd.args == "@worker"
    assert cmd.channel_id == str(CHANNEL_ID)
    assert cmd.channel_type == "channel_public"
    assert cmd.sender_name == "doe.jane"
    assert cmd.root_id is None
    # A visible "Running …" message is posted and its ref routes the result
    # into that message's thread.
    assert len(interaction.responses) == 1
    assert interaction.responses[0]["ephemeral"] is False
    assert "/reset @worker" in interaction.responses[0]["content"]
    assert cmd.message_ref == f"{CHANNEL_ID}:999"


def test_slash_command_acknowledges_before_dispatching() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    interaction = _FakeInteraction(channel)
    acked_first: list[bool] = []

    async def on_command(cmd: InboundCommand) -> None:
        acked_first.append(bool(interaction.responses))

    adapter._on_command = on_command
    _invoke(adapter, interaction, "list-agents")

    # The ~3s interaction deadline is met by ordering, not by speed: nothing
    # touching Switch may run before the acknowledgement.
    assert acked_first == [True]


def test_zero_argument_command_sends_empty_args() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)
    _invoke(adapter, _FakeInteraction(_FakeChannel()), "list-agents")

    assert commands[0].command == "list-agents"
    assert commands[0].args == ""


def test_declared_options_reach_dispatch_as_positional_args() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)

    _invoke(
        adapter,
        _FakeInteraction(_FakeChannel()),
        "set-alias",
        agent="worker",
        alias="w",
    )

    assert commands[0].command == "set-alias"
    assert commands[0].args == "@worker @w"


def test_slash_command_in_thread_bridges_into_parent_channel() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)
    parent = _FakeChannel()
    thread = _FakeThread(parent=parent, thread_id=3000)
    interaction = _FakeInteraction(thread, original_id=3001)

    _invoke(adapter, interaction, "invite-agent", agent="helper")

    cmd = commands[0]
    # Same shape as a typed command inside a thread: bridged into the parent
    # channel's room, with the thread itself as the result's root.
    assert cmd.channel_id == str(CHANNEL_ID)
    assert cmd.root_id == f"{CHANNEL_ID}:3000"
    assert cmd.message_ref == "3000:3001"


def test_private_channel_type_resolved() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)
    channel = _FakeChannel(everyone_can_view=False)

    _invoke(adapter, _FakeInteraction(channel), "roles")

    assert commands[0].channel_type == "channel_private"


# ── Failure is always visible ────────────────────────────────────────────────


def test_bad_arguments_rejected_ephemerally_without_dispatch() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)
    interaction = _FakeInteraction(_FakeChannel())

    _invoke(adapter, interaction, "run-cmd", agent=None, role="manager")

    # Refused before anything is dispatched, and privately: it is the
    # invoker's typo, not something the whole channel needs to watch fail.
    assert commands == []
    assert len(interaction.responses) == 1
    assert interaction.responses[0]["ephemeral"] is True
    assert "Could not run" in interaction.responses[0]["content"]
    assert interaction.edits == []


def test_dispatch_failure_rewrites_running_message_visibly() -> None:
    adapter = _adapter()
    interaction = _FakeInteraction(_FakeChannel())

    async def on_command(cmd: InboundCommand) -> None:
        raise RuntimeError("matrix room is gone")

    adapter._on_command = on_command
    _invoke(adapter, interaction, "reset", target="worker")

    # A slash command that appears to do nothing is worse than one that errors.
    assert len(interaction.edits) == 1
    assert "Failed to run" in interaction.edits[0]
    assert "matrix room is gone" in interaction.edits[0]


def test_dispatch_failure_when_adapter_not_started_is_reported() -> None:
    adapter = _adapter()
    interaction = _FakeInteraction(_FakeChannel())
    # _on_command is None until start() runs — must surface, not pass silently.
    _invoke(adapter, interaction, "list-agents")

    assert len(interaction.edits) == 1
    assert "Failed to run" in interaction.edits[0]

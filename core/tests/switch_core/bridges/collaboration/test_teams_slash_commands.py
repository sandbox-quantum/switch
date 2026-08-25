"""Teams' `/` picker sends a command without the slash it shows.

Picking `/help` from the picker switches the compose box to targeted-message
mode and inserts the *bare* name — Microsoft's own samples declare titles like
`my-reminders` and match them with `lower == "my-reminders"`. So a dispatcher
that keys on a prefix sees an ordinary message and does nothing.

`recipient.isTargeted` is what marks the message as aimed at this bot, and it
is the only thing that makes a bare word safe to read as a command.

The same change closes an older hole in the other direction: any message that
merely *began* with a slash was swallowed as a command, so pasting a path got
you "unknown command" instead of your message.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CHANNEL = "19:abc@thread.tacv2"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _adapter() -> tuple[TeamsAdapter, list[InboundCommand], list[InboundMessage]]:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    adapter._channel_type[_CHANNEL] = "channel_public"
    commands: list[InboundCommand] = []
    messages: list[InboundMessage] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    async def on_message(msg: InboundMessage) -> None:
        messages.append(msg)

    adapter._on_command = on_command  # type: ignore[assignment]
    adapter._on_message = on_message  # type: ignore[assignment]
    return adapter, commands, messages


def _deliver(adapter: TeamsAdapter, text: str, *, targeted: bool = False) -> None:
    _run(
        adapter._deliver(
            channel_id=_CHANNEL,
            channel_type="channel_public",
            sender_id="aad-1",
            sender_name="ada",
            text=text,
            message_ref="m-1",
            root_id=None,
            channel_name="general",
            is_targeted=targeted,
        )
    )


# ── the picker: a bare name on a targeted message ─────────────────────────────


def test_a_bare_command_from_the_picker_is_dispatched() -> None:
    adapter, commands, messages = _adapter()

    _deliver(adapter, "list-agents", targeted=True)

    assert [c.command for c in commands] == ["list-agents"]
    assert messages == []


def test_a_bare_command_keeps_its_arguments() -> None:
    adapter, commands, _ = _adapter()

    _deliver(adapter, "invite-agent @james", targeted=True)

    assert commands[0].command == "invite-agent"
    assert commands[0].args == "@james"


def test_an_ordinary_targeted_message_is_not_a_command() -> None:
    # A user can put the compose box in targeted mode and just talk. Only a
    # name Switch knows is read as a command.
    adapter, commands, messages = _adapter()

    _deliver(adapter, "can you summarise the thread", targeted=True)

    assert commands == []
    assert [m.content for m in messages] == ["can you summarise the thread"]


def test_a_bare_command_word_in_ordinary_chat_is_left_alone() -> None:
    # "help" said in a channel is somebody talking, not a command.
    adapter, commands, messages = _adapter()

    _deliver(adapter, "help", targeted=False)

    assert commands == []
    assert [m.content for m in messages] == ["help"]


# ── prefixes still work, and no longer swallow everything ─────────────────────


def test_a_slash_prefixed_command_still_works() -> None:
    adapter, commands, _ = _adapter()

    _deliver(adapter, "/list-agents")

    assert [c.command for c in commands] == ["list-agents"]


def test_a_bang_prefixed_command_still_works() -> None:
    adapter, commands, _ = _adapter()

    _deliver(adapter, "!list-agents")

    assert [c.command for c in commands] == ["list-agents"]


def test_a_pasted_path_is_a_message_not_an_unknown_command() -> None:
    # The reported hole: anything opening with a slash was taken as a command,
    # so this came back "unknown command" instead of reaching the agent.
    adapter, commands, messages = _adapter()

    _deliver(adapter, "/Users/ada/notes.md is the file")

    assert commands == []
    assert [m.content for m in messages] == ["/Users/ada/notes.md is the file"]


def test_a_misspelled_bang_command_still_gets_the_unknown_command_reply() -> None:
    # `!` is Switch's own prefix and means nothing else, so a name it does not
    # know is a typo worth answering.
    adapter, commands, messages = _adapter()

    _deliver(adapter, "!list-agent")

    assert [c.command for c in commands] == ["list-agent"]
    assert messages == []


def test_an_unknown_slash_word_is_a_message_not_a_command() -> None:
    # `/` is not Switch's prefix — it opens paths, dates and fractions — so an
    # unknown one is read as what it looks like.
    adapter, commands, messages = _adapter()

    _deliver(adapter, "/deploy the thing")

    assert commands == []
    assert [m.content for m in messages] == ["/deploy the thing"]


def test_a_fraction_beginning_with_a_slash_is_left_alone() -> None:
    adapter, commands, messages = _adapter()

    _deliver(adapter, "/2 of the rows are wrong")

    assert commands == []
    assert len(messages) == 1

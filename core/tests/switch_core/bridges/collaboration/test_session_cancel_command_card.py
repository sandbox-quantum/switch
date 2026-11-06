"""The command a queued turn's card offers, as each platform posts it.

`test_session_turn_status.py` covers the line as the neutral renderer draws it
for each spelling of a literal. These cover the other half: that the agent the
publisher names when it posts is the agent the command names, on every
platform that draws the line, and that a drawing with no agent behind it — the
text a failed publication carries — falls back to naming the pieces.
Discord's shared connection is not given message text, so there the card
offers the slash command, and the slash command reads the card back.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import pytest

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    TurnIdPrefix,
    parse_cancel_args,
)
from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.slash import reassemble_args
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.clients.mentions import mention_tokens
from switch_core.sessions.contract import TurnUpsert

from .test_discord_interrupt_control import CHANNEL_ID as DISCORD_CHANNEL
from .test_discord_interrupt_control import THREAD_REF as DISCORD_THREAD
from .test_discord_interrupt_control import _stopper as _discord
from .test_discord_sdk_only import GUILD_ID as DISCORD_GUILD
from .test_discord_sdk_only import _guild_setup as _discord_guild
from .test_discord_slash_commands import _adapter as _discord_slash
from .test_discord_slash_commands import (
    _capture_commands,
    _FakeChannel,
    _FakeInteraction,
    _invoke,
)
from .test_mattermost_interrupt_control import _stopper as _mattermost
from .test_mattermost_press import CHANNEL as MATTERMOST_CHANNEL
from .test_mattermost_sdk_only import _posts
from .test_teams_adapter import _card_text
from .test_teams_card_buttons import _handled as _teams
from .test_teams_sdk_only import CHANNEL as TEAMS_CHANNEL
from .test_teams_sdk_only import ROOT as TEAMS_ROOT
from .test_telegram_adapter import _adapter as _telegram
from .test_telegram_sdk_only import CHANNEL as TELEGRAM_CHANNEL
from .test_telegram_sdk_only import _posted as _telegram_posted

# A turn id as the host mints it for a room message: the id `!cancel` takes.
QUEUED_ID = "3f2b8c1e-5d4a-5b6c-9e7f-0a1b2c3d4e5f"
_SENTENCE = " — the sender can send this to withdraw it."
_PIECES = (
    "Turn ID: {id} — the sender can withdraw it with {cancel}, "
    "the agent's mention and this ID."
)


def _queued() -> TurnActivity:
    turn = TurnUpsert.model_validate(
        {
            "type": "turn.upsert",
            "turnId": QUEUED_ID,
            "status": "queued",
            "commandId": None,
        }
    )
    return TurnActivity([], turn)


def _discord_text(webhook: Any) -> list[str]:
    return str(webhook.sent[0]["content"]).splitlines()


async def test_mattermost_names_the_agent_it_posts_as() -> None:
    adapter, _ = _mattermost()

    await adapter.post_rich(MATTERMOST_CHANNEL, "worker", _queued(), "root-1")

    lines = str(_posts(adapter).created[0]["message"]).splitlines()
    assert f"`!cancel @worker 3f2b8c1e`{_SENTENCE}" in lines


async def test_discord_names_the_agent_it_posts_as() -> None:
    adapter, webhook, _ = _discord()

    await adapter.post_rich(str(DISCORD_CHANNEL), "my-agent", _queued(), DISCORD_THREAD)

    assert f"`!cancel @my-agent 3f2b8c1e`{_SENTENCE}" in _discord_text(webhook)


async def test_telegram_names_the_agent_it_posts_as() -> None:
    adapter: TelegramAdapter = _telegram()

    await adapter.post_rich(TELEGRAM_CHANNEL, "my-agent", _queued(), None)

    lines = str(_telegram_posted(adapter)["text"]).splitlines()
    assert f"<code>!cancel @my-agent 3f2b8c1e</code>{_SENTENCE}" in lines


async def test_teams_names_the_agent_it_posts_as() -> None:
    adapter, connector, _ = _teams()

    await adapter.post_rich(TEAMS_CHANNEL, "my-agent", _queued(), TEAMS_ROOT)

    lines = _card_text(dict(connector.sends[0]["activity"])).splitlines()
    assert f"**!cancel @my-agent 3f2b8c1e**{_SENTENCE}" in lines
    assert not any("\u200b" in line for line in lines if "!cancel" in line)


async def test_teams_names_the_pieces_for_a_name_its_markdown_could_eat() -> None:
    """A TextBlock reads `_` as emphasis, and whether it does inside a bold run
    is the client's to decide. A name with one in it gets the pieces rather than
    a command that might reach the reader without its underscores."""
    adapter, connector, _ = _teams()

    await adapter.post_rich(TEAMS_CHANNEL, "my_agent", _queued(), TEAMS_ROOT)

    lines = _card_text(dict(connector.sends[0]["activity"])).splitlines()
    assert _PIECES.format(id="**3f2b8c1e**", cancel="**!cancel**") in lines
    assert not any("@my_agent" in line for line in lines)


async def test_a_failed_publication_names_the_pieces_on_every_platform() -> None:
    """`rich_fallback_text` is drawn from the content alone, with no agent
    behind it, so it offers no command that names nobody. Discord and Telegram
    put that text in a `RichContentFailed`; Teams and Mattermost put the card
    they drew, with the agent's name in it."""
    teams: TeamsAdapter = _teams()[0]
    mattermost: MattermostAdapter = _mattermost()[0]
    discord: DiscordAdapter = _discord()[0]
    telegram: TelegramAdapter = _telegram()

    texts = {
        "teams": teams.rich_fallback_text(_queued()),
        "mattermost": mattermost.rich_fallback_text(_queued()),
        "discord": discord.rich_fallback_text(_queued()),
        "telegram": telegram.rich_fallback_text(_queued()),
    }

    assert _PIECES.format(id="**3f2b8c1e**", cancel="**!cancel**") in (
        texts["teams"].splitlines()
    )
    for markdown in ("mattermost", "discord"):
        assert _PIECES.format(id="`3f2b8c1e`", cancel="`!cancel`") in (
            texts[markdown].splitlines()
        )
    assert (
        _PIECES.format(id="<code>3f2b8c1e</code>", cancel="<code>!cancel</code>")
        in texts["telegram"].splitlines()
    )
    assert not any("!cancel @" in text for text in texts.values())


# ── Discord's shared connection: the slash command ──────────────────────────

_RUN = " — the sender can run this to withdraw it."


def _shared_discord() -> tuple[DiscordAdapter, Any]:
    """A bridge on the shared connection, attached to one that can post, and
    the publication webhook it posts through."""
    own, _channel, _thread, webhook = _discord_guild()
    assert own._connection is not None
    shared = DiscordAdapter(
        config=DiscordConnectionConfig(
            guild_id=str(DISCORD_GUILD), event_delivery="shared"
        )
    )
    shared.attach_shared_connection(own._connection)
    return shared, webhook


def _slash_literal(lines: list[str]) -> str:
    """The one literal on the card's withdraw line, without its backticks."""
    (line,) = [line for line in lines if line.endswith(_RUN)]
    return line.removesuffix(_RUN).strip("`")


async def test_discord_shared_offers_the_slash_command() -> None:
    adapter, webhook = _shared_discord()

    await adapter.post_rich(str(DISCORD_CHANNEL), "my-agent", _queued(), DISCORD_THREAD)

    lines = _discord_text(webhook)
    assert f"`/cancel target:my-agent turn_id:3f2b8c1e`{_RUN}" in lines
    assert not any("!cancel" in line for line in lines)


def test_discord_shared_failed_publication_asks_for_the_name() -> None:
    adapter, _ = _shared_discord()

    lines = adapter.rich_fallback_text(_queued()).splitlines()

    assert (
        "Turn ID: `3f2b8c1e` — the sender can withdraw it with `/cancel`, "
        "the agent's name and this ID."
    ) in lines
    assert not any("!cancel" in line for line in lines)


async def test_discord_shared_names_the_options_the_command_registers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The option names come from the command's own spec, so a renamed option
    renames the card's."""
    cancel = COMMANDS_BY_NAME["cancel"]
    target, turn_id = cancel.args_spec
    renamed = (replace(target, name="agent"), replace(turn_id, name="id"))
    monkeypatch.setitem(COMMANDS_BY_NAME, "cancel", replace(cancel, args_spec=renamed))
    adapter, webhook = _shared_discord()

    await adapter.post_rich(str(DISCORD_CHANNEL), "my-agent", _queued(), DISCORD_THREAD)

    assert f"`/cancel agent:my-agent id:3f2b8c1e`{_RUN}" in _discord_text(webhook)


def test_the_shared_card_reads_back_through_the_slash_command() -> None:
    """Typed into Discord as the card shows it, the slash command reaches
    `!cancel`'s parser with the agent the card was drawn for and the turn's
    first eight characters."""
    adapter, webhook = _shared_discord()
    asyncio.run(
        adapter.post_rich(str(DISCORD_CHANNEL), "my-agent", _queued(), DISCORD_THREAD)
    )
    command, *options = _slash_literal(_discord_text(webhook)).split()
    values = dict(option.split(":", 1) for option in options)

    assert command == "/cancel"
    args = reassemble_args(COMMANDS_BY_NAME["cancel"].args_spec, values)
    assert parse_cancel_args(args) == TurnIdPrefix("3f2b8c1e")

    slash = _discord_slash()
    commands = _capture_commands(slash)
    _invoke(slash, _FakeInteraction(_FakeChannel()), "cancel", **values)

    assert commands[0].command == "cancel"
    assert parse_cancel_args(commands[0].args) == TurnIdPrefix("3f2b8c1e")
    assert mention_tokens(commands[0].args)[0] == "my-agent"

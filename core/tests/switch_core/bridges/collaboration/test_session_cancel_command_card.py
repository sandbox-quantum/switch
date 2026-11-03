"""The command a queued turn's card offers, as each platform posts it.

`test_session_turn_status.py` covers the line as the neutral renderer draws it
for each spelling of a literal. These cover the other half: that the agent the
publisher names when it posts is the agent the command names, on every
platform that draws the line, and that a drawing with no agent behind it — the
text a failed publication carries — falls back to naming the pieces.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.sessions.contract import TurnUpsert

from .test_discord_interrupt_control import CHANNEL_ID as DISCORD_CHANNEL
from .test_discord_interrupt_control import THREAD_REF as DISCORD_THREAD
from .test_discord_interrupt_control import _stopper as _discord
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
    assert not any("​" in line for line in lines if "!cancel" in line)


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

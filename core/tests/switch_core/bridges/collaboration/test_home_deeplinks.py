"""Workspace-level ("open the messaging app") links, one per adapter.

These are pure functions of the connection config — no client, no network — so
they are tested together rather than scattered across each platform's
provisioning suite.

The property that matters beyond the exact strings: a home link must never
carry a credential. It is derived from a config that also holds bot tokens and
admin passwords, and it is served to any authenticated user by
`GET /gateway/collaborations`, so that is asserted for every platform.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

BOT_TOKEN = "xoxb-do-not-leak-this"
ADMIN_PASSWORD = "do-not-leak-this-either"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _slack() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token=BOT_TOKEN, app_token="xapp-secret", workspace_id="T0ABCDEF"
        )
    )


def _discord() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(bot_token=BOT_TOKEN, guild_id="900")
    )


def _teams() -> TeamsAdapter:
    return TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-1",
            app_password=ADMIN_PASSWORD,
            tenant_id="tenant-9",
            team_id="team-3",
            public_base_url="https://switch.example.com",
            client_state="state",
        )
    )


def _telegram() -> TelegramAdapter:
    return TelegramAdapter(
        config=TelegramConnectionConfig(bot_token=BOT_TOKEN, bot_username="@acme_bot")
    )


def test_slack_home_opens_the_workspace() -> None:
    assert _run(_slack().home_deeplink()) == "slack://open?team=T0ABCDEF"


def test_discord_home_opens_the_guild() -> None:
    assert _run(_discord().home_deeplink()) == "https://discord.com/channels/900"


def test_teams_home_opens_the_tenant() -> None:
    # Deliberately the tenant root, not a team link: the `/l/team/` form needs
    # the General channel's thread id, which this adapter does not hold.
    assert (
        _run(_teams().home_deeplink())
        == "https://teams.microsoft.com/?tenantId=tenant-9"
    )


def test_telegram_home_opens_the_bot_chat() -> None:
    # Telegram has no workspace; the bot's own chat is the nearest equivalent.
    # The configured username is normalised, so a leading @ does not double up.
    assert _run(_telegram().home_deeplink()) == "https://t.me/acme_bot"


def test_base_adapter_offers_no_home_link() -> None:
    # A platform that has not implemented one must return None rather than
    # inherit something wrong — the caller hides the action instead.
    assert _run(PlatformAdapter.home_deeplink(object())) is None  # type: ignore[arg-type]


def test_no_home_link_carries_a_credential() -> None:
    for adapter in (_slack(), _discord(), _teams(), _telegram()):
        link = _run(adapter.home_deeplink())
        assert link is not None
        assert BOT_TOKEN not in link
        assert ADMIN_PASSWORD not in link
        assert "xapp-" not in link


def test_base_adapter_offers_no_install_link() -> None:
    # Most platforms install their app through their own admin UI, and a link
    # invented for them would be a link to nowhere.
    assert _run(PlatformAdapter.install_links(object())) == []  # type: ignore[arg-type]


def test_no_install_link_carries_a_credential() -> None:
    # Same exposure as a home link: built from a config that also holds bot
    # tokens, and served by `GET /gateway/collaborations` — then handed to the
    # operator's browser and on to the platform.
    for adapter in (_slack(), _discord(), _teams(), _telegram()):
        for link in _run(adapter.install_links()):
            assert BOT_TOKEN not in link.url
            assert ADMIN_PASSWORD not in link.url
            assert "xapp-" not in link.url


def test_base_adapter_offers_no_install_note() -> None:
    # Most platforms have nothing to add beyond their links, and an empty
    # panel in the dialog would be worse than none.
    assert _run(PlatformAdapter.install_note(object())) is None  # type: ignore[arg-type]

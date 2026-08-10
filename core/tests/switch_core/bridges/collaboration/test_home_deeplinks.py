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

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
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


def _mattermost(**overrides: Any) -> MattermostAdapter:
    config = {
        "url": "http://mattermost:8065",
        "admin_user": "admin",
        "admin_password": ADMIN_PASSWORD,
        "team_name": "switch",
        **overrides,
    }
    return MattermostAdapter(config=MattermostConnectionConfig(**config))


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


def test_mattermost_home_opens_the_team() -> None:
    assert _run(_mattermost().home_deeplink()) == "mattermost://mattermost:8065/switch"


def test_mattermost_home_prefers_the_public_url() -> None:
    # `url` is the address Switch reaches Mattermost on, which may be private.
    # The link is for the user's machine, so the public one wins when set.
    adapter = _mattermost(public_url="https://chat.example.com/")

    assert _run(adapter.home_deeplink()) == "mattermost://chat.example.com/switch"


def test_base_adapter_offers_no_home_link() -> None:
    # A platform that has not implemented one must return None rather than
    # inherit something wrong — the caller hides the action instead.
    assert _run(CollaborationAdapter.home_deeplink(object())) is None  # type: ignore[arg-type]


def test_no_home_link_carries_a_credential() -> None:
    for adapter in (_slack(), _discord(), _mattermost(), _teams()):
        link = _run(adapter.home_deeplink())
        assert link is not None
        assert BOT_TOKEN not in link
        assert ADMIN_PASSWORD not in link
        assert "xapp-" not in link

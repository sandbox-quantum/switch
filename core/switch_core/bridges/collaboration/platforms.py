"""Every messaging platform this build ships.

Adding a platform is one line in `PLATFORMS`: its key, its adapter and its
connection config. Everything else Switch needs to know about it — its name,
icon, docs page, capabilities and how to read its failures — the adapter
declares itself.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import BridgeConnectionConfig
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

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )


class PlatformRegistration(NamedTuple):
    #: The platform's key: a bridge's `type`, a telemetry value, a surface in
    #: the session contract. See `messaging_platforms.PLATFORM_KEY_PATTERN`.
    key: str
    adapter: type[PlatformAdapter]
    config: type[BridgeConnectionConfig]


PLATFORMS: tuple[PlatformRegistration, ...] = (
    PlatformRegistration("mattermost", MattermostAdapter, MattermostConnectionConfig),
    PlatformRegistration("slack", SlackAdapter, SlackConnectionConfig),
    PlatformRegistration("teams", TeamsAdapter, TeamsConnectionConfig),
    PlatformRegistration("discord", DiscordAdapter, DiscordConnectionConfig),
    PlatformRegistration("telegram", TelegramAdapter, TelegramConnectionConfig),
)


def register_platforms(lifecycle: CollaborationBridgeLifecycleService) -> None:
    """Make every platform in `PLATFORMS` available to `lifecycle`."""
    for platform in PLATFORMS:
        lifecycle.register_adapter(platform.key, platform.adapter, platform.config)

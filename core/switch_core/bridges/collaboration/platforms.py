"""Every messaging platform this build ships.

Adding a platform is one line in `PLATFORMS`: its key, its adapter and its
connection config. Everything else Switch needs to know about it — its name,
icon, docs page, capabilities and how to read its failures — the adapter
declares itself.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, NamedTuple

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.google_chat.adapter import (
    GoogleChatAdapter,
    GoogleChatConnectionConfig,
)
from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import BridgeConnectionConfig
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.sms.adapter import SmsAdapter
from switch_core.bridges.collaboration.sms.config import SmsConnectionConfig
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.feature_flags import ADDITIONAL_MESSAGING_PLATFORMS

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
    #: The feature flag that offers the platform, or None when every
    #: deployment has it.
    flag: str | None


PLATFORMS: tuple[PlatformRegistration, ...] = (
    PlatformRegistration(
        "mattermost", MattermostAdapter, MattermostConnectionConfig, None
    ),
    PlatformRegistration("slack", SlackAdapter, SlackConnectionConfig, None),
    PlatformRegistration("teams", TeamsAdapter, TeamsConnectionConfig, None),
    PlatformRegistration("discord", DiscordAdapter, DiscordConnectionConfig, None),
    PlatformRegistration("telegram", TelegramAdapter, TelegramConnectionConfig, None),
    PlatformRegistration(
        "whatsapp",
        WhatsAppAdapter,
        WhatsAppConnectionConfig,
        ADDITIONAL_MESSAGING_PLATFORMS,
    ),
    PlatformRegistration(
        "google_chat",
        GoogleChatAdapter,
        GoogleChatConnectionConfig,
        ADDITIONAL_MESSAGING_PLATFORMS,
    ),
    PlatformRegistration(
        "zulip", ZulipAdapter, ZulipConnectionConfig, ADDITIONAL_MESSAGING_PLATFORMS
    ),
    PlatformRegistration(
        "signal", SignalAdapter, SignalConnectionConfig, ADDITIONAL_MESSAGING_PLATFORMS
    ),
    PlatformRegistration(
        "matrix", MatrixAdapter, MatrixConnectionConfig, ADDITIONAL_MESSAGING_PLATFORMS
    ),
    PlatformRegistration(
        "rocketchat",
        RocketChatAdapter,
        RocketChatConnectionConfig,
        ADDITIONAL_MESSAGING_PLATFORMS,
    ),
    PlatformRegistration(
        "webex", WebexAdapter, WebexConnectionConfig, ADDITIONAL_MESSAGING_PLATFORMS
    ),
    PlatformRegistration(
        "sms", SmsAdapter, SmsConnectionConfig, ADDITIONAL_MESSAGING_PLATFORMS
    ),
)


def register_platforms(
    lifecycle: CollaborationBridgeLifecycleService, flags: Mapping[str, bool]
) -> None:
    """Make every platform in `PLATFORMS` whose flag is on available to `lifecycle`."""
    for platform in PLATFORMS:
        if platform.flag is None or flags[platform.flag]:
            lifecycle.register_adapter(platform.key, platform.adapter, platform.config)

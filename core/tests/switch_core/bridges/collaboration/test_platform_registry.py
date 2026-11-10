"""Rocket.Chat is registered like every other platform, and the lifecycle is handed it."""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest

from switch_core.bridges.collaboration.lifecycle_service import _failure_reason
from switch_core.bridges.collaboration.platforms import PLATFORMS, register_platforms
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.rocketchat.client import (
    RocketChatAuthError,
    RocketChatRefused,
    RocketChatUnavailable,
)


def test_rocketchat_is_registered_with_its_adapter_and_config() -> None:
    registration = next(p for p in PLATFORMS if p.key == "rocketchat")

    assert registration.adapter is RocketChatAdapter
    assert registration.config is RocketChatConnectionConfig


def test_the_lifecycle_is_handed_every_platform_in_the_registry() -> None:
    lifecycle = MagicMock()

    register_platforms(lifecycle)

    assert [call.args for call in lifecycle.register_adapter.call_args_list] == [
        (platform.key, platform.adapter, platform.config) for platform in PLATFORMS
    ]


def test_rocketchat_describes_itself_by_its_name_and_logo() -> None:
    described = RocketChatAdapter.describe("rocketchat")

    assert described.key == "rocketchat"
    assert described.display_name == "Rocket.Chat"
    assert described.icon_svg is not None
    assert described.icon_svg.startswith("<svg")


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (RocketChatAuthError("rejected"), "auth_failed"),
        (RocketChatRefused("refused", status=400, error_type="x"), "platform_error"),
        (RocketChatUnavailable("down"), "platform_error"),
        (httpx.ConnectError("no route"), "network"),
    ],
)
def test_a_failure_of_rocketchat_is_named_for_what_it_means(
    error: BaseException, reason: str
) -> None:
    assert _failure_reason(error, RocketChatAdapter) == reason

"""The `kind` on `switch.bridge.errors`: what each platform's errors read as.

Built from the exceptions each SDK raises, because what tells a revoked token
from a rate limit is inside them: Slack's error code, Discord's status, the
class Telegram or the Mattermost driver picked.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import aiohttp
import discord
import httpx
import pytest
import requests
from mattermostdriver.exceptions import (
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)
from slack_sdk.errors import SlackApiError
from telegram.error import (
    BadRequest,
    ChatMigrated,
    Forbidden,
    InvalidToken,
    NetworkError,
    RetryAfter,
    TimedOut,
)

from switch_core.bridges.collaboration.adapter import (
    DirectorySearchBusy,
    PlatformAdapter,
    RichContentFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.error_kind import classify_bridge_error
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeErrorKind,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.connector import (
    BotConnectorGone,
    BotConnectorRefused,
    BotConnectorThrottled,
    BotConnectorUnavailable,
)
from switch_core.bridges.collaboration.teams.graph import GraphError
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter

_VOCABULARY = {
    "auth",
    "rate_limited",
    "not_found",
    "network",
    "platform_error",
    "other",
}


class _SlackResponse(dict[str, Any]):
    def __init__(self, status_code: int, **body: Any) -> None:
        super().__init__(ok=False, **body)
        self.status_code = status_code


def _slack(code: str | None, status: int = 200) -> SlackApiError:
    body = {} if code is None else {"error": code}
    return SlackApiError(code or "refused", _SlackResponse(status, **body))


def _discord_response(status: int) -> SimpleNamespace:
    return SimpleNamespace(status=status, reason="refused")


def _httpx_status(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://platform.example.invalid/api")
    return httpx.HTTPStatusError(
        "refused", request=request, response=httpx.Response(status, request=request)
    )


def _requests_status(status: int) -> requests.HTTPError:
    response = requests.Response()
    response.status_code = status
    return requests.HTTPError("refused", response=response)


def _caused_by(cause: BaseException) -> RichContentFailed:
    try:
        raise RichContentFailed("not posted", text="hi") from cause
    except RichContentFailed as error:
        return error


@pytest.mark.parametrize(
    ("adapter", "error", "kind"),
    [
        # Slack: the error code decides, else the status.
        (SlackAdapter, _slack("token_revoked"), "auth"),
        (SlackAdapter, _slack("invalid_auth"), "auth"),
        (SlackAdapter, _slack("ratelimited", 429), "rate_limited"),
        (SlackAdapter, _slack("channel_not_found"), "not_found"),
        (SlackAdapter, _slack("is_archived"), "not_found"),
        (SlackAdapter, _slack("internal_error"), "platform_error"),
        (SlackAdapter, _slack(None, 502), "platform_error"),
        (SlackAdapter, _slack("missing_scope"), "other"),
        (SlackAdapter, _caused_by(_slack("account_inactive")), "auth"),
        (SlackAdapter, aiohttp.ServerDisconnectedError(), "network"),
        # Discord: the status every `HTTPException` carries.
        (DiscordAdapter, discord.LoginFailure("bad token"), "auth"),
        (DiscordAdapter, discord.Forbidden(_discord_response(403), "no"), "auth"),
        (DiscordAdapter, discord.NotFound(_discord_response(404), "gone"), "not_found"),
        (DiscordAdapter, discord.RateLimited(3.0), "rate_limited"),
        (
            DiscordAdapter,
            discord.HTTPException(_discord_response(429), "slow down"),
            "rate_limited",
        ),
        (
            DiscordAdapter,
            discord.DiscordServerError(_discord_response(503), "down"),
            "platform_error",
        ),
        (DiscordAdapter, discord.HTTPException(_discord_response(400), "no"), "other"),
        # Telegram: the class, and for a missing chat what BadRequest says.
        (TelegramAdapter, InvalidToken(), "auth"),
        (TelegramAdapter, Forbidden("bot was kicked from the group chat"), "auth"),
        (TelegramAdapter, RetryAfter(5), "rate_limited"),
        (TelegramAdapter, BadRequest("Chat not found"), "not_found"),
        (TelegramAdapter, ChatMigrated(-100123), "not_found"),
        (TelegramAdapter, BadRequest("Message is too long"), "other"),
        (TelegramAdapter, TimedOut(), "network"),
        (TelegramAdapter, NetworkError("Bad Gateway"), "network"),
        # Mattermost: the driver's named classes, else the requests status.
        (MattermostAdapter, NoAccessTokenProvided("no"), "auth"),
        (MattermostAdapter, NotEnoughPermissions("no"), "auth"),
        (MattermostAdapter, ResourceNotFound("gone"), "not_found"),
        (MattermostAdapter, _requests_status(429), "rate_limited"),
        (MattermostAdapter, _requests_status(502), "platform_error"),
        (MattermostAdapter, requests.ConnectionError("refused"), "network"),
        (MattermostAdapter, requests.Timeout("slow"), "network"),
        (MattermostAdapter, InvalidOrMissingParameters("bad"), "other"),
        # Teams: Bot Connector's and Graph's status.
        (
            TeamsAdapter,
            BotConnectorThrottled("slow", status=429, retry_after=1.0),
            "rate_limited",
        ),
        (
            TeamsAdapter,
            BotConnectorGone("gone", status=404, retry_after=None),
            "not_found",
        ),
        (TeamsAdapter, BotConnectorRefused("no", status=403, retry_after=None), "auth"),
        (
            TeamsAdapter,
            BotConnectorUnavailable("down", status=503, retry_after=None),
            "platform_error",
        ),
        (
            TeamsAdapter,
            BotConnectorUnavailable("no answer", status=None, retry_after=None),
            "network",
        ),
        (TeamsAdapter, GraphError("refused", status=401), "auth"),
        (
            TeamsAdapter,
            BotConnectorRefused("no", status=400, retry_after=None),
            "other",
        ),
        (TeamsAdapter, _httpx_status(429), "rate_limited"),
    ],
)
def test_each_platform_s_errors_read_as_their_kind(
    adapter: type[PlatformAdapter], error: BaseException, kind: BridgeErrorKind
) -> None:
    assert classify_bridge_error(error, adapter) == kind


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (BridgeCredentialError("token rejected"), "auth"),
        (RichContentThrottled(retry_after=2.0, text="hi"), "rate_limited"),
        (DirectorySearchBusy(retry_after=2.0), "rate_limited"),
        (_httpx_status(401), "auth"),
        (_httpx_status(410), "not_found"),
        (_httpx_status(500), "platform_error"),
        (_httpx_status(409), "other"),
        (httpx.ConnectTimeout("slow"), "network"),
        (
            aiohttp.ClientResponseError(
                SimpleNamespace(real_url="https://platform.example.invalid"),  # type: ignore[arg-type]
                (),
                status=429,
            ),
            "rate_limited",
        ),
        (TimeoutError(), "network"),
        (ConnectionResetError(), "network"),
        (BridgeOperationError("a permission not granted"), "other"),
        (ValueError("anything else"), "other"),
    ],
)
def test_the_shared_rules_apply_with_no_adapter(
    error: BaseException, kind: BridgeErrorKind
) -> None:
    assert classify_bridge_error(error, None) == kind


def test_the_outermost_answer_wins() -> None:
    """A throttle raised from a dropped connection is a throttle."""
    try:
        raise RichContentThrottled(retry_after=1.0, text="hi") from TimeoutError()
    except RichContentThrottled as error:
        assert classify_bridge_error(error, SlackAdapter) == "rate_limited"


def test_an_adapter_whose_classifier_raises_falls_back_to_the_shared_rules(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Broken(SlackAdapter):
        @classmethod
        def classify_error(cls, exc: BaseException) -> BridgeErrorKind | None:
            raise RuntimeError("classifier bug")

    assert classify_bridge_error(TimeoutError(), _Broken) == "network"
    assert "classify_error raised" in caplog.text


def test_a_cycle_of_causes_ends() -> None:
    first = ValueError("first")
    second = ValueError("second")
    first.__cause__ = second
    second.__cause__ = first

    assert classify_bridge_error(first, None) == "other"


def test_every_answer_is_in_the_vocabulary() -> None:
    assert set(BridgeErrorKind.__args__) == _VOCABULARY  # type: ignore[attr-defined]

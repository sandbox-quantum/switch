"""Which `BRIDGE_FAILURE_REASON` a bridge failure gets, and why.

`_failure_reason` used to match substrings in an exception's *class name*.
"api" is a substring of "SlackApiError", so a revoked or rotated Slack bot
token — the most common bridge failure in the field — reported as
`platform_error` ("Slack is broken") instead of `auth_failed` ("your
credentials are wrong"). These pin the real exception type each vendor SDK
actually raises (verified against the installed packages, not guessed) to the
value the classifier gives it, so a future rewrite cannot reintroduce that
silently.
"""

from __future__ import annotations

import aiohttp
import httpx
import pytest
from aiohttp.client_reqrep import ConnectionKey
from discord.errors import DiscordException, LoginFailure
from mattermostdriver.exceptions import (
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)
from pydantic import BaseModel, ValidationError
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout as RequestsTimeout
from slack_sdk.errors import SlackApiError
from sqlalchemy.exc import DBAPIError
from telegram.error import (
    BadRequest,
    ChatMigrated,
    Conflict,
    Forbidden,
    InvalidToken,
    NetworkError,
)

from switch_core.bridges.collaboration.lifecycle_service import _failure_reason
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.telemetry.catalogue import BRIDGE_FAILURE_REASON


def _slack_error(code: str) -> SlackApiError:
    """A `SlackApiError` carrying the response Slack actually sends: the whole
    distinction between a rejected token and every other refusal lives in
    `response["error"]`, not in the exception's type."""
    return SlackApiError(f"server responded: {code}", {"ok": False, "error": code})


def _connector_error() -> aiohttp.ClientConnectorError:
    key = ConnectionKey("example.com", 443, True, False, None, None, None, None)
    return aiohttp.ClientConnectorError(
        connection_key=key, os_error=OSError(61, "Connection refused")
    )


class _StoredBridgeConfig(BaseModel):
    """Stands in for a real `BridgeConnectionConfig` subclass — only its shape
    (a pydantic model) matters for producing a genuine `ValidationError`."""

    listen_port: int


def _stale_stored_config_error() -> ValidationError:
    """What `config_cls.model_validate(bridge.connection_config)` raises for a
    row whose stored config no longer matches its adapter's schema."""
    try:
        _StoredBridgeConfig.model_validate({"listen_port": "not-a-port"})
    except ValidationError as exc:
        return exc
    raise AssertionError("expected model_validate to reject this payload")


# (description, exception, expected BRIDGE_FAILURE_REASON)
CASES: list[tuple[str, BaseException, str]] = [
    (
        "an adapter's own signal that the platform rejected its credentials",
        BridgeCredentialError("Microsoft rejected these credentials"),
        "auth_failed",
    ),
    # The regression that matters: slack/adapter.py:442's `auth_test()` raises
    # this on a revoked or rotated bot token, and the substring classifier it
    # replaced read "SlackApiError" as carrying "api" and called it
    # `platform_error`.
    ("Slack invalid_auth", _slack_error("invalid_auth"), "auth_failed"),
    ("Slack not_authed", _slack_error("not_authed"), "auth_failed"),
    ("Slack account_inactive", _slack_error("account_inactive"), "auth_failed"),
    ("Slack token_revoked", _slack_error("token_revoked"), "auth_failed"),
    ("Slack token_expired", _slack_error("token_expired"), "auth_failed"),
    ("Slack rate limited", _slack_error("ratelimited"), "platform_error"),
    (
        "Slack refuses for an unrelated reason",
        _slack_error("internal_error"),
        "platform_error",
    ),
    (
        "Discord rejects the bot token at login",
        LoginFailure("Improper token"),
        "auth_failed",
    ),
    (
        "some other Discord SDK failure",
        DiscordException("the gateway connection dropped"),
        "platform_error",
    ),
    ("Mattermost 401 on admin login", NoAccessTokenProvided("401"), "auth_failed"),
    ("Mattermost 403 on admin login", NotEnoughPermissions("403"), "auth_failed"),
    (
        "Mattermost refuses for an unrelated reason",
        ResourceNotFound("404"),
        "platform_error",
    ),
    (
        "Mattermost's transport (requests) cannot connect",
        RequestsConnectionError("Connection refused"),
        "network",
    ),
    (
        "Mattermost's transport (requests) times out",
        RequestsTimeout("timed out"),
        "network",
    ),
    ("Telegram rejects the bot token", InvalidToken("Invalid token"), "auth_failed"),
    ("Telegram cannot be reached", NetworkError("timed out"), "network"),
    (
        "Telegram BadRequest — a NetworkError subclass that is a definite refusal",
        BadRequest("chat not found"),
        "platform_error",
    ),
    (
        "Telegram Forbidden (bot blocked)",
        Forbidden("bot was blocked by the user"),
        "platform_error",
    ),
    (
        "Telegram ChatMigrated",
        ChatMigrated(new_chat_id=-100123456789),
        "platform_error",
    ),
    (
        "Telegram refuses for an unrelated reason",
        Conflict("terminated by other getUpdates request"),
        "platform_error",
    ),
    ("aiohttp cannot connect", _connector_error(), "network"),
    (
        "aiohttp OS-level failure",
        aiohttp.ClientOSError(61, "Connection refused"),
        "network",
    ),
    (
        "aiohttp's server drops the connection",
        aiohttp.ServerDisconnectedError("Connection closed"),
        "network",
    ),
    (
        "httpx (Teams' token exchange and Graph calls) cannot connect",
        httpx.ConnectError("no route"),
        "network",
    ),
    (
        "Teams/Graph refuses an operation after credentials were accepted",
        BridgeOperationError("permission not granted"),
        "platform_error",
    ),
    (
        "a stored bridge config that no longer validates",
        _stale_stored_config_error(),
        "config_invalid",
    ),
    (
        "lifecycle_service's own invariant checks (ValueError)",
        ValueError("Bridge not found: some-id"),
        "config_invalid",
    ),
    (
        "adapter code reading a platform payload that changed shape",
        KeyError("channel"),
        "unknown",
    ),
    (
        "Switch's own database, not the messaging platform",
        DBAPIError("SELECT 1", {}, Exception("connection to server was lost")),
        "unknown",
    ),
    ("anything the classifier has no rule for", RuntimeError("a mystery"), "unknown"),
]


class TestFailureReasonClassification:
    @pytest.mark.parametrize(
        "description,exc,expected", CASES, ids=[case[0] for case in CASES]
    )
    def test_classification(
        self, description: str, exc: BaseException, expected: str
    ) -> None:
        assert _failure_reason(exc) == expected, description

    def test_every_expected_value_is_one_the_catalogue_accepts(self) -> None:
        """`_failure_reason` and `bridge_connected.failure_reason` share one
        value set; a case above naming a value outside it would mean the
        classifier can produce something telemetry validation would reject."""
        for _, _, expected in CASES:
            assert BRIDGE_FAILURE_REASON.check(expected) is None


class TestSlackAuthCodesAreExhaustiveOverNothingElse:
    """`response["error"]` carries free text from Slack; anything not on the
    known auth-code list must fall back to `platform_error` rather than being
    silently treated as a credentials problem."""

    @pytest.mark.parametrize(
        "code", ["missing_scope", "channel_not_found", "internal_error", "fatal_error"]
    )
    def test_a_non_auth_code_is_platform_error(self, code: str) -> None:
        assert _failure_reason(_slack_error(code)) == "platform_error"

    def test_a_response_with_no_error_key_does_not_crash(self) -> None:
        """Defensive: a malformed or unexpected response body must degrade to
        the safe default rather than raising out of the classifier itself."""
        assert _failure_reason(SlackApiError("boom", {"ok": False})) == "platform_error"

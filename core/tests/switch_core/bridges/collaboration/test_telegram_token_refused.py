"""A token Telegram refuses must not reach the server log.

python-telegram-bot quotes the token in the `InvalidToken` it raises from
`initialize`, and a bridge that fails to start is logged with its traceback.
These run the library's own request path against a canned 401, so they fail
again if its wording or the place it raises from changes.
"""

from __future__ import annotations

import logging
import traceback
from typing import Any

import pytest
import telegram
from telegram.error import InvalidToken
from telegram.request import HTTPXRequest

from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.app_client import TelegramAppClient

TOKEN = "123456789:placeholder-secret-part-of-the-token"
SECRET = "placeholder-secret-part-of-the-token"
UNAUTHORIZED = b'{"ok": false, "error_code": 401, "description": "Unauthorized"}'


@pytest.fixture(autouse=True)
def telegram_refuses_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    async def do_request(self: HTTPXRequest, *args: Any, **kwargs: Any) -> Any:
        return 401, UNAUTHORIZED

    monkeypatch.setattr(HTTPXRequest, "do_request", do_request)


def _everything_logged_about(exc: BaseException) -> str:
    """What `logger.exception` would write: the message and the whole chain."""
    return "".join(traceback.format_exception(exc))


async def _nothing(*_: Any) -> None:
    return None


async def test_the_bridge_start_failure_does_not_carry_the_token(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token=TOKEN, bot_username="switch_bot")
    )

    with pytest.raises(InvalidToken) as caught:
        await adapter.start(_nothing, _nothing, _nothing, _nothing, _nothing)

    assert SECRET not in _everything_logged_about(caught.value)
    assert TelegramAdapter.classify_failure(caught.value) == "auth_failed"
    with caplog.at_level(logging.DEBUG):
        logging.getLogger("test").exception("Bridge crashed", exc_info=caught.value)
    assert SECRET not in caplog.text


async def test_the_shared_app_start_failure_does_not_carry_the_token() -> None:
    client = TelegramAppClient(
        bot=telegram.Bot(TOKEN),
        webhook_url="https://switch.example/messaging/telegram/events",
        webhook_secret="placeholder-webhook-secret",
        on_connected=_nothing,
    )

    with pytest.raises(InvalidToken) as caught:
        await client.start()

    assert SECRET not in _everything_logged_about(caught.value)

"""A platform-wide rate limit has to be visible at both of its edges.

The failure these guard against is not a wrong answer, it is silence. A
cooldown is held for the whole account the bridge connects as — a workspace, a
bot — rather than for the call that earned it, so while one is running every
card the bridge draws stops moving at once. With nothing in the log saying why,
that is indistinguishable from the bridge being dead, and it cost a long
investigation on Slack before anybody thought to look for a limit that was
never reported.

The scope in the line has to be the one the reader sees stop, which is what the
adapter holds back and not necessarily what the platform metered. Naming it
too narrowly is its own kind of silence: it sends the reader to look for a
second fault in the chat that was never throttled.
"""

import logging
from typing import Any

from telegram.error import RetryAfter

from switch_core.bridges.collaboration.cooldown import Cooldown
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)


def _cooldown() -> Cooldown:
    return Cooldown(
        "Slack", "reactions", "workspace", "Marks on messages stop changing until then."
    )


def test_a_cooldown_says_when_the_platform_is_taking_calls_again(
    caplog: Any, monkeypatch: Any
) -> None:
    """The edge that says the bridge is alive again, not merely quiet."""
    clock = [0.0]
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.cooldown.time.monotonic",
        lambda: clock[0],
    )
    cooldown = _cooldown()

    cooldown.start(30.0)
    assert cooldown.remaining() == 30.0

    clock[0] = 31.0
    with caplog.at_level(logging.WARNING):
        assert cooldown.remaining() == 0.0

    assert "taking reactions again" in caplog.text
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        assert cooldown.remaining() == 0.0
    assert caplog.text == "", "the lift is worth saying once, not on every call"


def test_a_cooldown_names_the_platform_the_scope_and_the_cost(caplog: Any) -> None:
    """All three, because a reader meets this line mid-incident and cold.

    Which platform has stopped, how much of it is held back, and what they will
    see while it lasts. Without the last one the line reports a fact about an
    API and leaves the reader to work out that it explains the frozen cards in
    front of them.
    """
    with caplog.at_level(logging.WARNING):
        _cooldown().start(45.0)

    assert "Slack is rate limiting reactions for the whole workspace" in caplog.text
    assert "45s" in caplog.text
    assert "Marks on messages stop changing until then." in caplog.text


def test_telegram_says_a_limit_holds_back_the_whole_bot(caplog: Any) -> None:
    """Telegram had the same silent deadline Slack did, and the same symptom.

    The scope it reports has to be the one the reader sees. Telegram meters a
    single chat and the bot across all of them, and a 429 does not say which
    was hit, so the adapter holds one cooldown for the bot and cards stop in
    chats that were never throttled. A line claiming the chat would send a
    reader looking for a fault in the wrong place — the failure this whole
    class exists to prevent, in a subtler form than saying nothing at all.
    """
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="000:test", bot_username="@acme_bot")
    )

    with caplog.at_level(logging.WARNING):
        failure = adapter._rich_failure(
            RetryAfter(42), description="Telegram refused the edit", text="a card"
        )

    assert isinstance(failure, Exception)
    assert "Telegram is rate limiting message updates for the whole bot" in caplog.text
    assert "in every chat" in caplog.text, (
        "the scope the reader sees, not the metered one"
    )

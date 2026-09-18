"""A platform-wide rate limit has to be visible at both of its edges.

The failure these guard against is not a wrong answer, it is silence. A
cooldown is charged to the workspace or the chat rather than to the call that
earned it, so while one is running every card the bridge draws stops moving at
once. With nothing in the log saying why, that is indistinguishable from the
bridge being dead, and it cost a long investigation on Slack before anybody
thought to look for a limit that was never reported.
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


def test_telegram_says_when_a_chat_wide_limit_freezes_its_cards(caplog: Any) -> None:
    """Telegram had the same silent deadline Slack did, and the same symptom.

    Its 429 is charged to the chat, so one throttled redraw holds back every
    publication in that chat. Nothing reported either edge, which is the defect
    this shares with the Slack one rather than a separate cosmetic gap.
    """
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="000:test", bot_username="@acme_bot")
    )

    with caplog.at_level(logging.WARNING):
        failure = adapter._rich_failure(
            RetryAfter(42), description="Telegram refused the edit", text="a card"
        )

    assert isinstance(failure, Exception)
    assert "Telegram is rate limiting message updates for the whole chat" in caplog.text
    assert "Every card the bridge draws there is frozen" in caplog.text

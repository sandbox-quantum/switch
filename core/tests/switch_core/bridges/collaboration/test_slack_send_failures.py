"""A Slack refusal never drops an agent's message without a trace.

Slack refuses text over its length limit (`msg_too_long`), meters posting
(`ratelimited`), and refuses a channel that is archived or that the app was
taken out of. A long message is split before it is posted, a rate limit is
waited out, and a refusal part way through a split message is said in the
channel and raised as `MessagePartlySent`, as on every platform that splits.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import MessagePartlySent
from switch_core.bridges.collaboration.slack import adapter as slack_adapter
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

from .slack_fakes import FakeResponse


class _StubWebClient:
    """`chat.postMessage` answering from a script: a refusal name or a
    `FakeResponse` refuses that call, None takes it. Calls past the script
    are taken."""

    def __init__(self, script: list[str | FakeResponse | None]) -> None:
        self._script = list(script)
        self.attempts: list[dict[str, Any]] = []
        self.posted: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []

    async def chat_postMessage(self, **kwargs: Any) -> FakeResponse:
        self.attempts.append(kwargs)
        refusal = self._script.pop(0) if self._script else None
        if refusal is not None:
            response = (
                refusal
                if isinstance(refusal, FakeResponse)
                else FakeResponse({"ok": False, "error": refusal})
            )
            raise SlackApiError("refused", response)
        self.posted.append(kwargs)
        return FakeResponse({"ok": True, "ts": f"{len(self.posted)}.0"})

    async def chat_update(self, **kwargs: Any) -> FakeResponse:
        self.attempts.append(kwargs)
        refusal = self._script.pop(0) if self._script else None
        if refusal is not None:
            assert isinstance(refusal, FakeResponse)
            raise SlackApiError("refused", refusal)
        self.updates.append(kwargs)
        return FakeResponse({"ok": True})


def _adapter(client: _StubWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._web_client = client  # type: ignore[assignment]

    async def rendering(name: str) -> Any:
        return SimpleNamespace(field_label=name, icon_url=None)

    adapter.agent_rendering = rendering  # type: ignore[method-assign]
    return adapter


@pytest.fixture
def slept(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    waits: list[float] = []

    async def no_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(slack_adapter.asyncio, "sleep", no_sleep)
    return waits


def _rate_limited(retry_after: str) -> FakeResponse:
    return FakeResponse(
        {"ok": False, "error": "ratelimited"},
        headers={"Retry-After": retry_after},
        status_code=429,
    )


def _long_text(lines: int, width: int) -> str:
    return "\n".join(f"{i:05d} " + "x" * (width - 6) for i in range(lines))


async def test_a_message_over_slacks_limit_goes_as_several() -> None:
    client = _StubWebClient([])
    text = _long_text(lines=1000, width=100)  # about 100,000 characters

    ref = await _adapter(client).send_message("C1", "scout", text)

    assert ref == "C1:1.0"
    assert len(client.posted) == 3
    assert all(len(call["text"]) <= 40_000 for call in client.posted)
    assert "\n".join(call["text"] for call in client.posted) == text
    assert {call["username"] for call in client.posted} == {"scout"}


async def test_a_part_slack_still_calls_too_long_is_split_again() -> None:
    client = _StubWebClient(["msg_too_long"])
    text = _long_text(lines=100, width=100)  # about 10,000 characters

    ref = await _adapter(client).send_message("C1", "scout", text)

    assert ref == "C1:1.0"
    assert len(client.attempts) == 1 + len(client.posted)
    assert len(client.posted) == 3
    assert all(len(call["text"]) <= 4_000 for call in client.posted)
    assert "\n".join(call["text"] for call in client.posted) == text


async def test_a_rate_limit_is_waited_out(slept: list[float]) -> None:
    client = _StubWebClient([_rate_limited("7")])

    ref = await _adapter(client).send_message("C1", "scout", "the answer")

    assert ref == "C1:1.0"
    assert slept == [7.0]
    assert [call["text"] for call in client.posted] == ["the answer"]


async def test_a_rate_limit_that_does_not_lift_is_a_refusal(
    slept: list[float],
) -> None:
    client = _StubWebClient([_rate_limited("2")] * 3)

    with pytest.raises(SlackApiError):
        await _adapter(client).send_message("C1", "scout", "the answer")

    assert len(client.attempts) == 3
    assert slept == [2.0, 2.0]


async def test_an_archived_channel_takes_nothing_and_is_not_retried(
    slept: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    client = _StubWebClient(["is_archived"])

    with pytest.raises(SlackApiError):
        await _adapter(client).send_message("C1", "scout", "the answer")

    assert len(client.attempts) == 1
    assert slept == []
    assert "is_archived" in caplog.text


async def test_a_refusal_part_way_says_so_and_raises() -> None:
    # The second of three parts is refused; the notice after it is taken.
    client = _StubWebClient([None, "is_archived"])
    text = _long_text(lines=1000, width=100)

    with pytest.raises(MessagePartlySent) as raised:
        await _adapter(client).send_message(
            "C1", "scout", text, thread_root_id="C1:100.5"
        )

    partial = raised.value
    assert (partial.first_ref, partial.delivered, partial.total) == ("C1:1.0", 1, 3)
    notice = client.posted[-1]
    assert notice["text"] == (
        "_Only 1 of 3 parts of this message could be delivered; Slack refused "
        "the rest._"
    )
    assert notice["thread_ts"] == "100.5"
    assert notice["username"] == "scout"


async def test_a_long_notice_from_switch_is_split_too() -> None:
    client = _StubWebClient([])
    text = _long_text(lines=500, width=100)

    ref = await _adapter(client).admin_message("C1", text)

    assert ref == "C1:1.0"
    assert len(client.posted) == 2
    assert all("username" not in call for call in client.posted)


async def test_a_card_waits_out_a_rate_limit(slept: list[float]) -> None:
    client = _StubWebClient([_rate_limited("3")])

    ref = await _adapter(client).post_blocks(
        "C1", "scout", "fallback", [{"type": "divider"}], None, reply_broadcast=False
    )

    assert ref == "C1:1.0"
    assert slept == [3.0]


async def test_a_cards_overlong_text_is_cut_to_fit() -> None:
    client = _StubWebClient([])

    await _adapter(client).post_blocks(
        "C1",
        "scout",
        "y" * 50_000,
        [{"type": "divider"}],
        None,
        reply_broadcast=False,
    )

    (call,) = client.posted
    assert len(call["text"]) == 40_000
    assert call["text"].endswith("…")


async def test_an_edit_waits_out_a_rate_limit(slept: list[float]) -> None:
    client = _StubWebClient([_rate_limited("4")])

    await _adapter(client).update_message("C1", "C1:5.0", "edited")

    assert slept == [4.0]
    assert client.updates == [{"channel": "C1", "ts": "5.0", "text": "edited"}]

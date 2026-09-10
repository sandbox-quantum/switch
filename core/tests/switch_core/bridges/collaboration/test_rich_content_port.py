"""`post_rich` / `update_rich` on the base adapter: the fallback every
platform without a card or activity renderer of its own gets for free.

`SlackAdapter`'s own overrides are exercised through the existing turn and
card tests (`test_session_activity.py`, `test_session_card_posting.py`,
`test_session_requests.py`) — they already run real Block Kit through
`post_blocks` / `update_blocks`. This file is the seam itself: what a
platform gets if it implements nothing beyond the port.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.neutral import turn_summary
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

from .test_session_activity import _item, _turn

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"


class _BareAdapter(CollaborationAdapter):
    """Concrete only so it can be instantiated: `post_rich` / `update_rich`
    are what is under test, and nothing else here is called.

    `send_message` / `update_message` are configurable per test, because the
    whole point of this port is that they behave differently across real
    adapters — some return `None` on failure, some raise (Teams does), and
    this base has to turn either into `RichContentFailed`.
    """

    def __init__(
        self,
        *,
        send: Callable[[str], str | None] | None = None,
        update: Callable[[str], None] | None = None,
        translate: Callable[[str], str] | None = None,
    ) -> None:
        super().__init__()
        self._send = send or (lambda _content: "C1:1.0")
        self._update = update or (lambda _content: None)
        self._translate = translate or (lambda content: content)
        self.sent: list[tuple[str, str, str, str | None]] = []
        self.updated: list[tuple[str, str, str]] = []

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        self.sent.append((channel_id, sender_name, content, thread_root_id))
        return self._send(content)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        self.updated.append((channel_id, message_ref, new_content))
        self._update(new_content)

    def translate_outbound(self, content: str) -> str:
        return self._translate(content)

    async def start(self, *a: Any, **k: Any) -> Any: ...
    async def stop(self, *a: Any, **k: Any) -> Any: ...
    async def delete_message(self, *a: Any, **k: Any) -> Any: ...
    async def send_typing(self, *a: Any, **k: Any) -> Any: ...
    async def create_channel(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_type(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any: ...
    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def create_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    def translate_inbound(self, *a: Any, **k: Any) -> Any: ...


def _rich_escape(adapter: _BareAdapter) -> Callable[[str], str]:
    """The same pipeline `rich_fallback_text` composes internally, rebuilt
    from the public methods so a test can predict its output without
    reaching into a private one."""
    return lambda label: adapter.translate_outbound(
        adapter.escape_label_for_body(label)
    )


async def _request_card() -> RequestCard:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, "session-demo")
    request = projection.open_requests()[0]
    return RequestCard(request, RequestReference(token="tok", handle="R1"))


async def test_post_rich_falls_back_to_the_turn_summary() -> None:
    adapter = _BareAdapter()
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    turn = _turn("running")

    ref = await adapter.post_rich("C1", "agent", TurnActivity(items, turn))

    assert ref == "C1:1.0"
    assert len(adapter.sent) == 1
    channel_id, sender_name, content, thread_root_id = adapter.sent[0]
    assert channel_id == "C1"
    assert sender_name == "agent"
    assert thread_root_id is None
    assert content == turn_summary(
        items, turn, escape=_rich_escape(adapter), limit=adapter.rich_fallback_limit()
    )


async def test_post_rich_raises_when_the_platform_returns_none() -> None:
    """Slack's own `send_message` swallows `SlackApiError` this way."""
    adapter = _BareAdapter(send=lambda _content: None)
    items = [_item(kind="assistant-message", title="", text="Looking now.")]

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("C1", "agent", TurnActivity(items, _turn("running")))

    assert "C1" in str(excinfo.value)
    assert excinfo.value.text  # the text it tried to send is still to hand


async def test_post_rich_raises_when_the_platform_raises() -> None:
    """Teams' `send_message` raises rather than returning `None`, on any
    non-2xx status — the base has to turn that into `RichContentFailed` too,
    not just a `None` return."""

    def _explode(_content: str) -> str | None:
        raise RuntimeError("bot_connector_error: 500")

    adapter = _BareAdapter(send=_explode)
    items = [_item(kind="assistant-message", title="", text="Looking now.")]

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("C1", "agent", TurnActivity(items, _turn("running")))

    assert isinstance(excinfo.value.__cause__, RuntimeError)
    assert excinfo.value.text


async def test_update_rich_falls_back_the_same_way() -> None:
    adapter = _BareAdapter()
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    turn = _turn("completed")

    await adapter.update_rich("C1", "C1:1.0", TurnActivity(items, turn))

    assert len(adapter.updated) == 1
    channel_id, message_ref, content = adapter.updated[0]
    assert channel_id == "C1"
    assert message_ref == "C1:1.0"
    assert content == turn_summary(
        items, turn, escape=_rich_escape(adapter), limit=adapter.rich_fallback_limit()
    )


async def test_update_rich_does_not_raise_when_the_platform_only_swallows() -> None:
    """Mattermost, Discord and (mostly) Telegram log their own update failure
    and return normally — there is nothing here for the base to detect or
    raise on, which is the existing runtime-status contract."""
    adapter = _BareAdapter()
    items = [_item(kind="assistant-message", title="", text="Looking now.")]

    await adapter.update_rich("C1", "C1:1.0", TurnActivity(items, _turn("completed")))


async def test_update_rich_raises_when_the_platform_raises() -> None:
    """Teams' `update_message` raises `RuntimeError` / a connector error on
    failure instead of swallowing it — `update_rich` must not let that
    through raw, or the redraw-failure fallback that catches
    `RichContentFailed` never runs."""

    def _explode(_content: str) -> None:
        raise RuntimeError("bot_connector_error: 429")

    adapter = _BareAdapter(update=_explode)
    items = [_item(kind="assistant-message", title="", text="Looking now.")]

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.update_rich(
            "C1", "C1:1.0", TurnActivity(items, _turn("completed"))
        )

    assert isinstance(excinfo.value.__cause__, RuntimeError)
    assert excinfo.value.text


async def test_the_fallback_budget_survives_translate_outbound_expanding_it() -> None:
    """A budget cut before `translate_outbound` can be blown open by it —
    Telegram's turns one `&` into `&amp;`, five characters. The cut has to
    account for the platform's own rendering, not just `escape_label_for_body`.
    """

    def _html_escape(content: str) -> str:
        return content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    adapter = _BareAdapter(translate=_html_escape)
    items = [_item(kind="assistant-message", title="", text="&" * 2000)]

    await adapter.post_rich("C1", "agent", TurnActivity(items, _turn("running")))

    content = adapter.sent[0][2]
    assert len(content) <= adapter.rich_fallback_limit()
    # The expansion actually happened, so this is exercising the real risk
    # rather than a no-op escape.
    assert "&amp;" in content


async def test_a_request_card_has_no_neutral_form_yet() -> None:
    """Stubbed on purpose (CHOO-2621): there is no off-Slack request renderer
    to write one against yet. `NotImplementedError`, not `RichContentFailed`
    — this is a missing implementation, not an ordinary posting failure."""
    adapter = _BareAdapter()
    content = await _request_card()

    with pytest.raises(NotImplementedError):
        await adapter.post_rich("C1", "agent", content)


def test_rich_fallback_limit_defaults_to_discords() -> None:
    assert _BareAdapter().rich_fallback_limit() == 2000

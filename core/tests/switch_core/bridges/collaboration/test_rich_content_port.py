"""`post_rich` / `update_rich` on the base adapter: the fallback every
platform without a card or activity renderer of its own gets for free.

`SlackAdapter`'s own overrides are exercised through the existing turn and
card tests (`test_session_activity.py`, `test_session_card_posting.py`,
`test_session_requests.py`) — they already run real Block Kit through
`post_blocks` / `update_blocks`. This file is the seam itself: what a
platform gets if it implements nothing beyond the port.
"""

from __future__ import annotations

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
    are what is under test, and nothing else here is called."""

    def __init__(self, *, send_ref: str | None = "C1:1.0") -> None:
        super().__init__()
        self._send_ref = send_ref
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
        return self._send_ref

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        self.updated.append((channel_id, message_ref, new_content))

    def translate_outbound(self, content: str) -> str:
        return content

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
        items,
        turn,
        escape=adapter.escape_label_for_body,
        limit=adapter.rich_fallback_limit(),
    )


async def test_post_rich_raises_when_the_platform_refuses() -> None:
    adapter = _BareAdapter(send_ref=None)
    items = [_item(kind="assistant-message", title="", text="Looking now.")]

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("C1", "agent", TurnActivity(items, _turn("running")))

    assert "C1" in str(excinfo.value)
    assert excinfo.value.text  # the text it tried to send is still to hand


async def test_update_rich_falls_back_the_same_way_and_never_raises() -> None:
    """`update_message` swallows its own errors by design, so this base has
    nothing to raise on — only an override with a real failure to report
    (`SlackAdapter`'s) does."""
    adapter = _BareAdapter()
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    turn = _turn("completed")

    await adapter.update_rich("C1", "C1:1.0", TurnActivity(items, turn))

    assert len(adapter.updated) == 1
    channel_id, message_ref, content = adapter.updated[0]
    assert channel_id == "C1"
    assert message_ref == "C1:1.0"
    assert content == turn_summary(
        items,
        turn,
        escape=adapter.escape_label_for_body,
        limit=adapter.rich_fallback_limit(),
    )


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

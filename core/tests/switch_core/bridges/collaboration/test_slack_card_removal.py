"""Taking a Slack card back, and being able to say whether it worked.

Slack restricts deleting a message posted *as a member*; a card posted under
an agent's name and icon through `chat:write.customize` is still the app's own
message and comes back. Probed against a live workspace before this was
written: `chat.delete` on the exact argument shape `post_blocks` sends
succeeded, and the errors below are the ones it actually returned.

The other half is that a caller acting on the result — writing down that a
card is gone — must not be told success where none was established. That is
why this is not `delete_message`, which logs and returns either way.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RemovalFailed,
)
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter

from .slack_fakes import FakeResponse
from .test_slack_adapter import _adapter, _FakeWebClient, _run

CARD = "C123:999.9"


class _RefusingWebClient(_FakeWebClient):
    def __init__(self, error: str) -> None:
        super().__init__()
        self._error = error

    async def chat_delete(self, **kwargs: Any) -> dict[str, bool]:
        self.deletes.append(kwargs)
        raise SlackApiError("no", FakeResponse({"error": self._error}))


def _connected(client: Any) -> SlackAdapter:
    adapter = _adapter()
    adapter._web_client = client
    return adapter


def test_a_card_is_taken_back_at_the_address_slack_gave_us() -> None:
    """`external_post_id` is `"{channel}:{ts}"`, and `chat.delete` wants the
    two apart. Deleting by the whole reference deletes nothing."""
    client = _FakeWebClient()

    _run(_connected(client).remove_publication("C123", CARD))

    assert client.deletes == [{"channel": "C123", "ts": "999.9"}]


def test_a_refusal_is_raised_rather_than_logged() -> None:
    """The caller records that the card is gone. A refusal it never hears
    about is a record saying a card in the channel is not there, and the
    publisher then stops redrawing a card that still offers buttons."""
    client = _RefusingWebClient("cant_delete_message")

    with pytest.raises(RemovalFailed) as raised:
        _run(_connected(client).remove_publication("C123", CARD))

    assert "cant_delete_message" in str(raised.value)
    assert isinstance(raised.value.__cause__, SlackApiError)


def test_a_card_already_gone_is_reported_as_gone_but_said_out_loud(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing remains at the address, which is what the caller asked for, so
    this is not a failure. It is still worth a line: Slack says the same thing
    about an address it has never seen, and the only innocent explanation for
    one it gave us is that someone else deleted the card first.
    """
    client = _RefusingWebClient("message_not_found")

    with caplog.at_level(logging.WARNING):
        _run(_connected(client).remove_publication("C123", CARD))

    assert "already gone" in caplog.text


def test_an_unparseable_reference_never_reaches_slack() -> None:
    """A bare ts would be deleted from whatever channel was passed alongside
    it. Refusing is the only safe reading of an address we cannot split."""
    client = _FakeWebClient()

    with pytest.raises(RemovalFailed):
        _run(_connected(client).remove_publication("C123", "nonsense"))

    assert client.deletes == []


def test_a_disconnected_adapter_does_not_claim_the_card_was_removed() -> None:
    """The one case the old helper got half right — it declined to try — and
    half wrong, because it returned as though it had."""
    with pytest.raises(RemovalFailed):
        _run(_adapter().remove_publication("C123", CARD))


def test_slack_is_the_platform_that_says_it_can_do_this() -> None:
    """The capability is what routes a granted card here at all, and the four
    platforms still to come are the ones that have not claimed it."""
    assert SlackAdapter.removes_approved_cards is True


def test_a_platform_with_no_implementation_refuses_rather_than_pretends() -> None:
    """Inherited by every adapter that has not written one yet. Returning
    would have the caller record the removal of a card still on the screen —
    and then never redraw it, because the row says there is nothing there."""

    class Unimplemented:
        remove_publication = CollaborationAdapter.remove_publication

    assert getattr(Unimplemented(), "removes_approved_cards", False) is False
    with pytest.raises(RemovalFailed):
        _run(Unimplemented().remove_publication("C123", CARD))  # type: ignore[arg-type]

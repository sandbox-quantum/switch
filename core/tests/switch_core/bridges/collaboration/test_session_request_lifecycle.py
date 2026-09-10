"""A request card, as the request behind it moves on.

`test_session_slack_requests.py` posts the card and `test_session_answers.py`
reads a press back off it. This is the third side: the recorded
`answerLifecycle` stream driven through the projection, and what the card says
at each point it stops.

The rule under most of it: a request that was not answered must never read as
though it was.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.session.contract import SnapshotRequest
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_approval,
    render_approval_text,
)
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .test_slack_agent_sessions import FakeWebClient

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

REFERENCE = RequestReference(token="opaque-token", handle="R42")

# Sequences in the recorded `answerLifecycle`: the answer accepted, then in
# flight, then settled.
ACCEPTED, IN_FLIGHT, SETTLED = 11, 12, 13


async def _projection(*, through: int) -> SessionProjection:
    """The demo session with the recorded lifecycle replayed up to `through`."""
    recorded = json.loads(EXAMPLES_PATH.read_text())
    source = FixtureEventSource(
        recorded["initialSnapshot"],
        [e for e in recorded["answerLifecycle"] if e["sequence"] <= through],
        session_id="session-demo",
    )
    return await project(source, "session-demo")


async def _request(*, through: int) -> SnapshotRequest:
    request = (await _projection(through=through)).request("request-demo")
    assert request is not None
    return request


def _settle(request: SnapshotRequest, **outcome: Any) -> SnapshotRequest:
    """The same request settled some other way than the recording settles it."""
    settled = request.result
    assert settled is not None
    return request.model_copy(
        update={
            "state": "resolved" if outcome.get("outcome") == "answered" else "closed",
            "result": settled.model_copy(update=outcome),
            "decided_by": (
                request.decided_by if outcome.get("outcome") == "answered" else None
            ),
        }
    )


def _context(request: SnapshotRequest) -> str:
    blocks = render_approval(request, REFERENCE).blocks
    context = next(block for block in blocks if block["type"] == "context")
    return str(context["elements"][0]["text"])


def _heading(request: SnapshotRequest) -> str:
    section = render_approval(request, REFERENCE).blocks[0]
    return str(section["text"]["text"]).splitlines()[0]


def _has_buttons(request: SnapshotRequest) -> bool:
    blocks = render_approval(request, REFERENCE).blocks
    return any(block["type"] == "actions" for block in blocks)


# ── While an answer is in flight ─────────────────────────────────────────────


async def test_an_answer_in_flight_takes_the_buttons_away() -> None:
    """A second press would either duplicate the first or lose on revision."""
    request = await _request(through=IN_FLIGHT)

    assert request.state == "submitting"
    assert not _has_buttons(request)


async def test_the_card_names_who_is_answering_and_from_where() -> None:
    request = await _request(through=IN_FLIGHT)

    assert _context(request) == "Answering: actor-demo from Mattermost."
    assert _heading(request) == "*Permission needed*"


async def test_an_accepted_command_alone_does_not_move_the_card() -> None:
    """`command.status` says the server has it, not that the host is acting."""
    request = await _request(through=ACCEPTED)

    assert request.state == "open"
    assert _has_buttons(request)


# ── Once it has settled ──────────────────────────────────────────────────────


async def test_the_settled_card_names_the_option_the_actor_and_the_surface() -> None:
    request = await _request(through=SETTLED)

    assert request.state == "resolved"
    assert _heading(request) == "*Permission answered*"
    assert _context(request) == "Allow once — chosen by actor-demo from Mattermost."
    assert not _has_buttons(request)


async def test_the_text_fallback_stops_asking_once_it_is_settled() -> None:
    """It is what a notification carries, so it must not ask for an answer."""
    request = await _request(through=SETTLED)

    text = render_approval_text(request, REFERENCE)

    assert text.startswith("> Request R42: Run project tests")
    assert "1. Allow once" not in text
    assert "Reply with" not in text
    assert text.endswith("Allow once — chosen by actor-demo from Mattermost.")


async def test_a_cancelled_request_never_reads_as_answered() -> None:
    settled = await _request(through=SETTLED)

    cancelled = _settle(settled, outcome="cancelled", result=None, command_id=None)

    assert cancelled.state == "closed"
    assert _heading(cancelled) == "*Permission request closed*"
    assert _context(cancelled) == "Cancelled before it was answered."
    rendered = json.dumps(render_approval(cancelled, REFERENCE).blocks)
    assert "chosen" not in rendered
    assert "actor-demo" not in rendered


async def test_every_way_of_closing_says_it_was_not_answered() -> None:
    settled = await _request(through=SETTLED)

    for outcome in ("cancelled", "expired", "interrupted", "provider-error"):
        closed = _settle(settled, outcome=outcome, result=None, command_id=None)
        assert _context(closed).endswith("before it was answered."), outcome


async def test_accepting_for_the_session_says_the_scope_it_takes() -> None:
    """ "Allow once" and "allow for the session" must not read the same."""
    settled = await _request(through=SETTLED)
    content = settled.content
    for_session = settled.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "options": [
                        option.model_copy(update={"decision": "acceptForSession"})
                        if option.option_id == "allow-once"
                        else option
                        for option in content.options  # type: ignore[union-attr]
                    ]
                }
            )
        }
    )

    assert "applies for the rest of this session" in _context(for_session)


async def test_the_chosen_label_cannot_stretch_the_settled_card() -> None:
    """The footer quotes an agent-supplied label, so it is bounded like the rest."""
    settled = await _request(through=SETTLED)
    content = settled.content
    wordy = settled.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "options": [
                        option.model_copy(update={"label": "label " * 400})
                        for option in content.options  # type: ignore[union-attr]
                    ]
                }
            )
        }
    )

    assert len(_context(wordy)) < 500


async def test_an_option_the_request_never_offered_is_still_named() -> None:
    """Better a bare id than a card that reads as a plain yes to another question."""
    settled = await _request(through=SETTLED)
    answered = settled.result
    assert answered is not None

    surprising = settled.model_copy(
        update={
            "result": answered.model_copy(
                update={
                    "result": answered.result.model_copy(  # type: ignore[union-attr]
                        update={"option_id": "allow-everything-forever"}
                    )
                }
            )
        }
    )

    assert "allow-everything-forever" in _context(surprising)


async def test_an_answer_with_no_result_admits_it_does_not_know() -> None:
    settled = await _request(through=SETTLED)

    vague = _settle(settled, outcome="answered", result=None)

    assert _context(vague) == (
        "Answered by actor-demo from Mattermost, but the host did not say "
        "which option was chosen."
    )


# ── The edit ─────────────────────────────────────────────────────────────────


def _post() -> SessionRequestPost:
    return SessionRequestPost(
        bridge_id="bridge-1",
        token=REFERENCE.token,
        handle=REFERENCE.handle,
        external_channel_id="C1",
        external_post_id="C1:111.0",
        room_id="room-demo",
        thread_id="thread-demo",
        session_id="session-demo",
        epoch="epoch-demo",
        request_id="request-demo",
        revision=1,
    )


def _cards(adapter: SlackAdapter) -> SessionRequestCards:
    """A refresh needs none of the posting half, so it is given none of it."""
    return SessionRequestCards(
        adapter,
        bridge_id="bridge-1",
        posts=SessionRequestPostStore(),
        session_factory=cast(Any, None),
    )


def _adapter() -> tuple[SlackAdapter, FakeWebClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    client = FakeWebClient()
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache["C1"] = "channel"
    return adapter, client


async def test_the_card_is_edited_in_place_rather_than_reposted() -> None:
    """One message per request, not a running commentary in the channel."""
    request = await _request(through=SETTLED)
    adapter, client = _adapter()

    await _cards(adapter).refresh(_post(), request)

    assert len(client.updated) == 1
    edit = client.updated[0]
    assert edit["channel"] == "C1"
    assert edit["ts"] == "111.0"
    expected = render_approval(request, REFERENCE).blocks
    expected[0]["block_id"] = f"switch-request:{_post().token}"
    assert edit["blocks"] == expected
    assert edit["text"] == render_approval_text(request, REFERENCE)
    assert client.posted == []


async def test_a_failed_edit_puts_the_outcome_in_the_thread_instead() -> None:
    """The card is stuck showing buttons. Saying nothing leaves it looking live."""
    request = await _request(through=SETTLED)
    adapter, client = _adapter()
    client.update_error = "message_not_found"

    cards = _cards(adapter)
    for _ in range(2):
        with pytest.raises(SlackApiError):
            await cards.refresh(_post(), request)

    assert client.updated == []
    assert len(client.posted) == 1
    reply = client.posted[0]
    assert reply["thread_ts"] == "111.0"
    assert "R42" in reply["text"]
    assert "could not be updated" in reply["text"]
    assert "Allow once — chosen by actor-demo from Mattermost." in reply["text"]

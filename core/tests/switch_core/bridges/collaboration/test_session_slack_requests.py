"""An approval, from the recorded session fixture to a Slack card.

This is the whole path in one test file: the fixture goes in through the
transport seam, the projection decides the room may see it, the Slack renderer
turns it into Block Kit, and the adapter posts it. Nothing in here reaches
Slack's API, but everything up to the call does.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.session.contract import (
    ApprovalOption,
    parse_snapshot,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    ANSWER_ACTION,
    parse_answer_action,
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

from .test_slack_agent_sessions import FakeWebClient

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

REFERENCE = RequestReference(token="opaque-token", handle="R42")


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _projection() -> SessionProjection:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    return _run(project(source, "session-demo"))


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


# ── The gate ─────────────────────────────────────────────────────────────────


def test_the_fixture_approval_is_addressed_to_its_room() -> None:
    projection = _projection()
    open_here = projection.open_room_requests("room-demo")

    assert [request.request_id for request in open_here] == ["request-demo"]


def test_another_room_is_shown_nothing() -> None:
    assert _projection().open_room_requests("room-elsewhere") == []


def test_a_session_members_request_never_reaches_a_room() -> None:
    """The gate, not a routing choice: Slack has no session-members surface."""
    recorded = json.loads(EXAMPLES_PATH.read_text())
    recorded["initialSnapshot"]["requests"][0]["audience"] = {"kind": "session-members"}
    projection = SessionProjection(parse_snapshot(recorded["initialSnapshot"]))

    assert projection.room_requests("room-demo") == []
    assert projection.request("request-demo") is not None


# ── The card ─────────────────────────────────────────────────────────────────


def test_the_approval_renders_a_button_per_option() -> None:
    request = _projection().open_room_requests("room-demo")[0]

    message = render_approval(request, REFERENCE)
    actions = next(block for block in message.blocks if block["type"] == "actions")

    assert [element["text"]["text"] for element in actions["elements"]] == [
        "Allow once",
        "Deny",
    ]
    assert [element["action_id"] for element in actions["elements"]] == [
        f"{ANSWER_ACTION}:allow-once",
        f"{ANSWER_ACTION}:deny",
    ]
    assert [element.get("style") for element in actions["elements"]] == [
        "primary",
        "danger",
    ]


def test_the_button_payload_carries_only_an_opaque_reference() -> None:
    """A callback payload is not a place to keep anything worth stealing."""
    request = _projection().open_room_requests("room-demo")[0]

    message = render_approval(request, REFERENCE)
    actions = next(block for block in message.blocks if block["type"] == "actions")
    values = {element["value"] for element in actions["elements"]}

    assert values == {"opaque-token"}
    assert "session-demo" not in json.dumps(message.blocks)
    assert "epoch-demo" not in json.dumps(message.blocks)


def test_the_card_says_how_to_answer_in_words() -> None:
    """A card can fail to render, and a person can prefer typing."""
    request = _projection().open_room_requests("room-demo")[0]

    message = render_approval(request, REFERENCE)

    context = next(block for block in message.blocks if block["type"] == "context")
    assert 'Reply with "R42 1"' in context["elements"][0]["text"]
    assert message.text == render_approval_text(request, REFERENCE)
    assert message.text.startswith("> Request R42: Run project tests")
    assert "1. Allow once" in message.text
    assert "2. Deny" in message.text


def test_agent_text_cannot_forge_slack_markup() -> None:
    request = _projection().open_room_requests("room-demo")[0]
    forged = request.model_copy(
        update={
            "content": request.content.model_copy(
                update={"title": "<!channel> & <https://example.test|click>"}
            )
        }
    )

    message = render_approval(forged, REFERENCE)
    section = message.blocks[0]["text"]["text"]

    assert "<!channel>" not in section
    assert "&lt;!channel&gt; &amp; " in section


def test_a_pressed_button_names_the_option_it_chose() -> None:
    assert parse_answer_action(f"{ANSWER_ACTION}:allow-once") == "allow-once"
    assert parse_answer_action(f"{ANSWER_ACTION}:") is None
    assert parse_answer_action("switch:something-else") is None


def test_an_approval_with_more_options_than_slack_renders_is_refused() -> None:
    """Loudly, rather than quietly dropping the option someone needed."""
    request = _projection().open_room_requests("room-demo")[0]
    options = [
        ApprovalOption(
            option_id=f"option-{index}", label=f"Option {index}", decision="accept"
        )
        for index in range(26)
    ]
    crowded = request.model_copy(
        update={"content": request.content.model_copy(update={"options": options})}
    )

    with pytest.raises(ValueError, match="at most 25 buttons"):
        render_approval(crowded, REFERENCE)


# ── The post ─────────────────────────────────────────────────────────────────


def test_the_card_reaches_slack_with_its_blocks_and_a_text_fallback() -> None:
    request = _projection().open_room_requests("room-demo")[0]
    message = render_approval(request, REFERENCE)
    adapter, client = _adapter()

    ref = _run(
        adapter.post_blocks(
            "C1", "flint-tracker", message.text, message.blocks, "C1:111.0"
        )
    )

    assert ref == "C1:1.0"
    assert len(client.posted) == 1
    posted = client.posted[0]
    assert posted["blocks"] == message.blocks
    assert posted["text"] == message.text
    assert posted["thread_ts"] == "111.0"

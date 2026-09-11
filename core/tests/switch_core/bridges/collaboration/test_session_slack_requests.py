"""An approval, from the recorded session fixture to a Slack card.

This is the whole path in one test file: the fixture goes in through the
transport seam, the projection decides the room may see it, the Slack renderer
turns it into Block Kit, and the adapter posts it. Nothing in here reaches
Slack's API, but everything up to the call does.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.session.form import (
    Unanswerable,
    posted_form,
    resolve_text_answer,
)
from switch_core.bridges.collaboration.session.renderers import (
    ANSWER_ACTION,
    RequestReference,
    parse_answer_action,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_approval,
    render_approval_text,
)
from switch_core.bridges.collaboration.session.text import (
    AnswerPart,
    parse_text_answer,
)
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import (
    ApprovalOption,
    parse_snapshot,
)
from switch_core.sessions.projection import SessionProjection

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


# ── What is waiting on someone ───────────────────────────────────────────────


def test_the_fixture_approval_is_open_and_named() -> None:
    projection = _projection()

    assert [request.request_id for request in projection.open_requests()] == [
        "request-demo"
    ]


def test_a_settled_request_is_hidden_without_being_lost() -> None:
    """The only thing filtered here is whether anyone is still being asked.

    The contract used to say which room a request was addressed to, and this is
    where that was applied. It is gone: choosing who sees a session's request
    needs to know the agent and the rooms it is in, which is Switch's to know
    and not something a host can be trusted to decide for it. What a room is
    shown is now decided above this, and the replica still holds everything
    either way.
    """
    recorded = json.loads(EXAMPLES_PATH.read_text())
    recorded["initialSnapshot"]["requests"][0]["state"] = "resolved"
    projection = SessionProjection(parse_snapshot(recorded["initialSnapshot"]))

    assert projection.open_requests() == []
    assert projection.request("request-demo") is not None


# ── The card ─────────────────────────────────────────────────────────────────


def test_the_approval_renders_a_button_per_option() -> None:
    request = _projection().open_requests()[0]

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
    request = _projection().open_requests()[0]

    message = render_approval(request, REFERENCE)
    actions = next(block for block in message.blocks if block["type"] == "actions")
    values = {element["value"] for element in actions["elements"]}

    assert values == {"opaque-token"}
    assert "session-demo" not in json.dumps(message.blocks)
    assert "epoch-demo" not in json.dumps(message.blocks)


def test_the_card_says_how_to_answer_in_words() -> None:
    """A card can fail to render, and a person can prefer typing."""
    request = _projection().open_requests()[0]

    message = render_approval(request, REFERENCE)

    context = next(block for block in message.blocks if block["type"] == "context")
    assert "Reply with `R42 1`" in context["elements"][0]["text"]
    assert message.text == render_approval_text(request, REFERENCE)
    assert message.text.startswith("> Request R42: Run project tests")
    assert "1. Allow once" in message.text
    assert "2. Deny" in message.text


def test_what_the_card_tells_you_to_type_is_what_the_grammar_reads() -> None:
    """The instruction and the parser are one claim, so they are tested as one.

    The card used to quote its own example — `Reply with "R42 1"` — and a reader
    who copied it verbatim got a handle of `"R42`, which resolves to nothing,
    logs nothing and leaves the card unchanged. A code span is what makes the
    example copy back: Slack draws it as one and the grammar strips the marks.
    """
    request = _projection().open_requests()[0]

    footer = _footer_of(render_approval(request, REFERENCE))
    example = re.search(r"`([^`]+)`", footer)

    assert example is not None, f"the card offers no example to copy: {footer}"
    for typed in (example.group(1), f"`{example.group(1)}`", f"_{example.group(1)}_"):
        answer = parse_text_answer(typed)
        assert answer is not None, f"the card's own instruction does not parse: {typed}"
        assert answer.handle == "R42"
        assert answer.parts == (
            AnswerPart(question=None, options=(1,), custom_text=None),
        )


def _footer_of(message: Any) -> str:
    context = next(block for block in message.blocks if block["type"] == "context")
    return str(context["elements"][0]["text"])


FORGERY = "<!channel> & <https://example.test|click>"


def _forged() -> Any:
    request = _projection().open_requests()[0]
    content = request.content
    return request.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "title": FORGERY,
                    "detail": FORGERY,
                    "options": [
                        option.model_copy(update={"label": FORGERY})
                        for option in content.options
                    ],
                }
            )
        }
    )


def test_agent_text_cannot_forge_markup_in_the_card() -> None:
    message = render_approval(_forged(), REFERENCE)
    section = message.blocks[0]["text"]["text"]

    assert "<!channel>" not in section
    assert "&lt;!channel&gt; &amp; " in section


def test_agent_text_cannot_forge_markup_in_the_text_fallback() -> None:
    """Slack reads a message's `text` as mrkdwn, blocks or no blocks."""
    text = render_approval_text(_forged(), REFERENCE)

    assert "<!channel>" not in text
    assert "&lt;!channel&gt; &amp; " in text
    assert text.count("&lt;!channel&gt;") == 4  # title, detail, two labels


def test_a_button_label_is_left_as_the_author_wrote_it() -> None:
    """`plain_text` is not parsed, so an entity would show as an entity."""
    message = render_approval(_forged(), REFERENCE)
    actions = next(block for block in message.blocks if block["type"] == "actions")

    assert all("&amp;" not in e["text"]["text"] for e in actions["elements"])


def test_a_pressed_button_names_the_option_it_chose() -> None:
    assert parse_answer_action(f"{ANSWER_ACTION}:allow-once") == "allow-once"
    assert parse_answer_action(f"{ANSWER_ACTION}:") is None
    assert parse_answer_action("switch:something-else") is None


def test_an_approval_that_offers_no_options_makes_the_card_say_so() -> None:
    """The same defect as a form with no questions in it, one card over.

    `options` has no minimum length in either reader of the contract, so this
    is exactly as legal on paper. There is nothing to press, no number to type
    and no word that names a decision none of the options carry, so an
    instruction here is one the resolver goes on to refuse.

    The empty actions block matters more than the wrong instruction: Slack
    wants at least one element in one, so the whole card is likely rejected and
    the request never appears at all. It is not appended now.
    """
    request = _projection().open_requests()[0]
    empty = request.model_copy(
        update={"content": request.content.model_copy(update={"options": []})}
    )

    message = render_approval(empty, REFERENCE)

    assert _footer_of(message) == "This card cannot be answered: it offers no options."
    assert not [block for block in message.blocks if block["type"] == "actions"]
    assert message.text.endswith("This card cannot be answered: it offers no options.")


def test_no_option_count_makes_the_card_offer_an_answer_it_would_refuse() -> None:
    """The questions card's enumeration, on the shape that has one dimension.

    An approval's footer is a fixed string, so there is little here to vary —
    which is exactly why the empty case got through. Asserting the claim rather
    than the string means the next shape that cannot be answered fails here
    instead of in a workspace.
    """
    request = _projection().open_requests()[0]

    for count in range(4):
        options = [
            ApprovalOption(
                option_id=f"option-{index}",
                label=f"Option {index}",
                decision="accept" if index else "decline",
            )
            for index in range(count)
        ]
        card = request.model_copy(
            update={"content": request.content.model_copy(update={"options": options})}
        )
        footer = _footer_of(render_approval(card, REFERENCE))
        if footer.startswith("This card cannot be answered"):
            continue

        example = re.search(r"`([^`]+)`", footer)
        assert example is not None, f"{count} options: no example in {footer!r}"
        answer = parse_text_answer(example.group(1))
        assert answer is not None, f"{count} options: {footer!r} does not parse"
        resolved = resolve_text_answer(posted_form(card), answer)
        assert not isinstance(resolved, Unanswerable), f"{count} options: {resolved}"


def test_an_approval_with_more_options_than_slack_renders_is_refused() -> None:
    """Loudly, rather than quietly dropping the option someone needed."""
    request = _projection().open_requests()[0]
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


# ── The limits ───────────────────────────────────────────────────────────────

SLACK_SECTION_LIMIT = 3000


def _oversized(title: str, detail: str, *, options: int = 2) -> Any:
    request = _projection().open_requests()[0]
    content = request.content
    return request.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "title": title,
                    "detail": detail,
                    "options": [
                        ApprovalOption(
                            option_id=f"option-{index}",
                            label="label " * 400,
                            decision="accept",
                        )
                        for index in range(options)
                    ],
                }
            )
        }
    )


def _section(message: Any) -> str:
    return str(message.blocks[0]["text"]["text"])


def test_a_long_title_does_not_take_the_whole_post_with_it() -> None:
    """Slack rejects the section, and the post it was in, not just the value."""
    message = render_approval(_oversized("t" * 9000, "d" * 9000), REFERENCE)

    section = _section(message)
    assert len(section) <= SLACK_SECTION_LIMIT
    assert "…" in section


def test_a_title_made_of_entities_is_cut_without_splitting_one() -> None:
    """Escaping lengthens, so a budget spent on the escaped form is not enough."""
    message = render_approval(_oversized("&" * 4000, "<" * 4000), REFERENCE)

    section = _section(message)
    assert len(section) <= SLACK_SECTION_LIMIT
    assert re.sub(r"&(amp|lt|gt);", "", section).count("&") == 0


def test_the_text_fallback_is_bounded_by_the_same_budgets() -> None:
    """It is a message body, and Slack refuses an oversized one just as flatly."""
    text = render_approval_text(
        _oversized("t" * 9000, "d" * 9000, options=25), REFERENCE
    )

    assert len(text) < 10000


# ── The post ─────────────────────────────────────────────────────────────────


def test_the_card_reaches_slack_with_its_blocks_and_a_text_fallback() -> None:
    request = _projection().open_requests()[0]
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


# ── The press ────────────────────────────────────────────────────────────────


class _FakeSocketClient:
    """Records the ack, which Slack expects before anything else happens."""

    def __init__(self) -> None:
        self.acked: list[str] = []

    async def send_socket_mode_response(self, response: Any) -> None:
        self.acked.append(response.envelope_id)


def _block_actions(**overrides: Any) -> dict[str, Any]:
    """A `block_actions` envelope, in the shape Slack sends one."""
    payload: dict[str, Any] = {
        "type": "block_actions",
        "user": {"id": "U1", "username": "someone", "name": "someone"},
        "channel": {"id": "C1", "name": "general"},
        "container": {
            "type": "message",
            "channel_id": "C1",
            "message_ts": "111.0",
        },
        "actions": [
            {
                "type": "button",
                "action_id": f"{ANSWER_ACTION}:allow-once",
                "block_id": f"{ANSWER_ACTION}:request-demo",
                "value": "opaque-token",
            }
        ],
    }
    payload.update(overrides)
    return payload


def _pressed(payload: dict[str, Any]) -> list[Any]:
    """Drive a press all the way from the socket envelope."""
    adapter, _ = _adapter()
    seen: list[Any] = []

    async def record(interaction: Any) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(record)
    socket = _FakeSocketClient()
    _run(
        adapter._handle_socket_event(
            socket,  # type: ignore[arg-type]
            SocketModeRequest(type="interactive", envelope_id="e1", payload=payload),
        )
    )
    assert socket.acked == ["e1"]
    return seen


def test_a_press_is_no_longer_acked_and_dropped() -> None:
    interaction = _pressed(_block_actions())[0]

    assert interaction.channel_id == "C1"
    assert interaction.sender_id == "U1"
    assert interaction.action_id == f"{ANSWER_ACTION}:allow-once"
    assert interaction.value == "opaque-token"
    assert interaction.message_ref == "C1:111.0"


def test_a_control_with_no_value_names_no_request() -> None:
    """A select or an overflow carries its choice elsewhere. Not ours to guess."""
    payload = _block_actions(
        actions=[{"type": "button", "action_id": f"{ANSWER_ACTION}:x", "value": None}]
    )

    assert _pressed(payload) == []


def test_an_interactive_envelope_that_is_not_a_press_is_left_alone() -> None:
    assert _pressed(_block_actions(type="view_submission")) == []


def test_the_card_and_the_press_agree_on_the_option() -> None:
    """The loop: the renderer writes the control, the handler reads it back."""
    request = _projection().open_requests()[0]
    message = render_approval(request, REFERENCE)
    actions = next(block for block in message.blocks if block["type"] == "actions")
    deny = actions["elements"][1]

    interaction = _pressed(
        _block_actions(
            actions=[
                {
                    "type": "button",
                    "action_id": deny["action_id"],
                    "value": deny["value"],
                }
            ]
        )
    )[0]

    assert parse_answer_action(interaction.action_id) == "deny"
    assert interaction.value == REFERENCE.token


# ── The typed reply ──────────────────────────────────────────────────────────


def _said(text: str, **event: Any) -> list[Any]:
    """Drive a human message all the way from the socket envelope."""
    adapter, _ = _adapter()
    seen: list[Any] = []

    async def record(message: Any) -> None:
        seen.append(message)

    adapter._on_message = record
    payload: dict[str, Any] = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "channel": "C1",
            "channel_type": "channel",
            "user": "U1",
            "text": text,
            "ts": "222.0",
        },
    }
    payload["event"].update(event)
    socket = _FakeSocketClient()
    _run(
        adapter._handle_socket_event(
            socket,  # type: ignore[arg-type]
            SocketModeRequest(type="events_api", envelope_id="e2", payload=payload),
        )
    )
    assert socket.acked == ["e2"]
    return seen


def test_a_typed_answer_arrives_with_the_words_intact() -> None:
    """The grammar is read off `content`, so nothing may rewrite it on the way."""
    message = _said("R42 1")[0]

    assert message.content == "R42 1"
    assert message.channel_id == "C1"
    assert message.sender_id == "U1"
    assert message.root_id is None


def test_a_reply_in_a_card_s_thread_says_which_card() -> None:
    """What a bare "yes" is resolved against: the root is the card's own post."""
    message = _said("yes", thread_ts="111.0")[0]

    assert message.content == "yes"
    assert message.root_id == "C1:111.0"


# ── Where in the thread it landed ────────────────────────────────────────────


def _thread(*replies: str) -> tuple[SlackAdapter, FakeWebClient]:
    """A card at 111.0 with `replies` under it, as Slack lays a thread out."""
    adapter, client = _adapter()
    client.thread = [{"ts": "111.0"}] + [{"ts": ts} for ts in replies]
    return adapter, client


def test_the_first_reply_under_a_card_is_recognised_as_the_first() -> None:
    adapter, client = _thread("222.0", "333.0")

    assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:222.0")) is True
    method, params = client.api_calls[0]
    assert method == "conversations.replies"
    assert params == {"channel": "C1", "ts": "111.0", "limit": 2}


def test_a_later_reply_is_not() -> None:
    """The rule someone's bare "yes" turns on: was anything said before it."""
    adapter, _ = _thread("222.0", "333.0")

    assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:333.0")) is False


def test_a_card_nobody_has_replied_to_yet_has_no_first_reply() -> None:
    """The read raced the message it is about. Refusing is the safe direction."""
    adapter, _ = _thread()

    assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:222.0")) is False


def test_slack_refusing_the_read_is_not_a_yes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Fail closed, and out loud: the cost is a retype, but it needs explaining."""
    adapter, client = _thread("222.0")
    client.replies_error = "channel_not_found"

    with caplog.at_level(logging.WARNING):
        assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:222.0")) is False

    assert "channel_not_found" in caplog.text


def test_the_network_failing_mid_read_is_not_a_yes_either(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A reset connection or a timed-out read is not a `SlackApiError`.

    slack_sdk wraps what Slack answers, not what the socket does, so the
    transport failures arrive as themselves. Uncaught, one of them climbs out
    of the answer path — which runs before the relay — and the message is lost
    rather than the answer refused.
    """
    adapter, client = _thread("222.0")

    async def timed_out(**kwargs: Any) -> Any:
        raise TimeoutError("read timed out")

    client.conversations_replies = timed_out  # type: ignore[method-assign]

    with caplog.at_level(logging.WARNING):
        assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:222.0")) is False

    assert "read timed out" in caplog.text


def test_a_disconnected_adapter_answers_nothing_rather_than_raising() -> None:
    """This runs on the inbound path of every message, so it may not throw."""
    adapter, _ = _thread("222.0")
    adapter._web_client = None

    assert _run(adapter.is_first_reply("C1", "C1:111.0", "C1:222.0")) is False

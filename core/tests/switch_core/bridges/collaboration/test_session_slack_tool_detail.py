"""A tool's detail, as Slack shows it.

A tool step's `text` is the host's redacted excerpt of the call — its input and
output, in rooms that opted in — and it is still text an agent and the commands
it ran wrote. So what has to hold here is display safety, not redaction: the
detail is shown as the literal characters it is, inside the card a reader opens,
and nowhere else. It never becomes a broadcast, a mention, a link or styling,
it never reaches a notification, and however many cards carry one, the message
it is in still goes out — the details give way, first by shortening and then by
disappearing, before anything else in the message does.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    _DETAIL_RETREAT,
    _MAX_MESSAGE,
    _MAX_PLAN_TASKS,
    _MAX_POST_BYTES,
    _MAX_SECTION_ITEMS,
    _MAX_STREAM_BYTES,
    _MAX_TOOL_IO_DETAILS,
    _TRUNCATED,
    render_activity,
    render_activity_plan,
    render_activity_stream,
    render_activity_text,
    render_turn_with_request,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn, open_request, recorded_items
from .slack_fakes import FakeWebClient

REFERENCE = RequestReference(token="opaque-token", handle="R1")

HOSTILE = (
    "<!channel> <!here> <!everyone> ping <@U012ABC>\n"
    "see <https://example.com|x> or https://example.org/path?q=1\n"
    "```\nrm -rf build && echo `done`\n```\n"
    "*bold* _it_ ~strike~ `code`"
)

# Element types a rich-text block parses into when it is not literal text.
_PARSED = {"broadcast", "user", "usergroup", "channel", "link", "emoji"}


def _tool(item_id: str, text: str, title: str = "Ran a command") -> Item:
    return _item(itemId=item_id, title=title, text=text)


def _said(item_id: str, text: str) -> Item:
    return _item(itemId=item_id, kind="assistant-message", title="", text=text)


def _tool_cards(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        task
        for block in blocks
        if block.get("type") == "plan"
        for task in block["tasks"]
        if task.get("icon", {}).get("name") == "code"
    ]


def _tool_text(task: dict[str, Any]) -> str:
    """The detail of one tool card, checked to be one preformatted block."""
    details = task["details"]
    assert details["type"] == "rich_text"
    assert len(details["elements"]) == 1
    block = details["elements"][0]
    assert block["type"] == "rich_text_preformatted"
    assert all(set(element) == {"type", "text"} for element in block["elements"])
    assert all(element["type"] == "text" for element in block["elements"])
    return "".join(element["text"] for element in block["elements"])


def _walk(node: object) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(node, dict):
        found.append(node)
        for value in node.values():
            found += _walk(value)
    elif isinstance(node, list):
        for value in node:
            found += _walk(value)
    return found


def _weigh(blocks: list[dict[str, Any]]) -> int:
    return len(json.dumps(blocks).encode())


def _without_text(items: list[Item]) -> list[Item]:
    return [
        item.model_copy(update={"text": ""}) if item.kind == "tool-activity" else item
        for item in items
    ]


def _drawn(items: list[Item]) -> dict[str, tuple[list[dict[str, Any]], str]]:
    """The same turn on every path that draws tool cards: blocks, and the text."""
    turn = _turn("completed")
    stream = render_activity_stream(items, turn, elapsed_seconds=5)
    plan = render_activity_plan(items, turn, elapsed_seconds=5)
    activity = render_activity(items, turn, elapsed_seconds=5)
    combined = render_turn_with_request(
        items, turn, open_request(), REFERENCE, elapsed_seconds=5
    )
    return {
        "activity": (activity.blocks, activity.text),
        "plan": (plan.blocks, plan.text),
        "stream": (stream.blocks, stream.title),
        "combined": (combined.blocks, combined.text),
    }


# ── Safe display ────────────────────────────────────────────────────────────


def test_a_hostile_detail_arrives_as_literal_text_inside_one_code_block() -> None:
    """Mass mentions, a user mention, a mrkdwn link, a bare URL, a fence that
    would close a code block, and emphasis — none of it is parsed. Slack is
    sent one preformatted block of plain `text` elements and the characters are
    exactly the ones the host wrote; `plain_text` would have eaten the
    backticks and asterisks a command line is made of."""
    items = [_tool("call", HOSTILE)]

    for path, (blocks, text) in _drawn(items).items():
        cards = _tool_cards(blocks)
        assert len(cards) == 1, path
        assert _tool_text(cards[0]) == HOSTILE, path
        parsed = [
            node
            for node in _walk(cards[0]["details"])
            if node.get("type") in _PARSED or "style" in node
        ]
        assert parsed == [], path
        # Nothing of the detail outside its block: not the title, not another
        # block, not the notification text.
        payload = json.dumps(blocks)
        assert payload.count("U012ABC") == 1, path
        assert payload.count("example.org") == 1, path
        assert "U012ABC" not in text and "example.org" not in text, path
        assert "<!channel>" not in text, path


def test_a_tool_title_is_still_drawn_as_it_was() -> None:
    """Only the detail changed shape. The title keeps going through
    `plain_text`, which is what the host checks it against."""
    drawn = render_activity([_tool("call", "x", title="Ran `ls` **now**")], _turn())

    assert _tool_cards(drawn.blocks)[0]["title"] == "Ran ls now"


async def test_an_ordinary_post_of_a_detail_asks_slack_not_to_unfurl() -> None:
    """The renderer cannot say whether Slack previews a link; the post can.
    An ordinary Block Kit post turns unfurling off for links and media both."""
    client = FakeWebClient()
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache["C1"] = "channel"

    await adapter.post_rich(
        "C1", "Agent", TurnActivity([_tool("call", HOSTILE)], _turn()), None
    )

    assert len(client.posted) == 1
    posted = client.posted[0]
    assert posted["unfurl_links"] is False
    assert posted["unfurl_media"] is False
    assert _tool_text(_tool_cards(posted["blocks"])[0]) == HOSTILE
    assert "example.org" not in posted["text"]


# ── The final payload's budget ──────────────────────────────────────────────


def test_fifty_full_ascii_details_and_a_request_fit_untouched() -> None:
    """The ordinary worst case of an opted-in room costs nothing: fifty cards
    at the full budget is half of what a post may weigh."""
    items = [_tool(f"t{n}", "x" * _MAX_TOOL_IO_DETAILS) for n in range(50)]

    combined = render_turn_with_request(items, _turn(), open_request(), REFERENCE)

    texts = [_tool_text(task) for task in _tool_cards(combined.blocks)]
    assert len(texts) == 50
    assert texts == ["x" * _MAX_TOOL_IO_DETAILS] * 50
    assert _weigh(combined.blocks) <= _MAX_POST_BYTES


def test_fifty_cjk_details_and_a_request_shrink_to_fit_and_say_so() -> None:
    """Six bytes a character on the wire: fifty full CJK details are three
    times what a post takes. They are pulled back, each saying it was cut, and
    the request card is untouched."""
    items = [_tool(f"t{n}", "漢" * _MAX_TOOL_IO_DETAILS) for n in range(50)]
    request = open_request()

    combined = render_turn_with_request(items, _turn(), request, REFERENCE)

    assert _weigh(combined.blocks) <= _MAX_POST_BYTES
    texts = [_tool_text(task) for task in _tool_cards(combined.blocks)]
    assert len(texts) == 50
    assert all(text.endswith(_TRUNCATED) for text in texts)
    assert all(len(text) <= _DETAIL_RETREAT[0] for text in texts)
    card = render_turn_with_request([], _turn(), request, REFERENCE).blocks[1:]
    assert combined.blocks[-len(card) :] == card


def _crowded(text: str) -> list[Item]:
    """Fifty tool cards behind ten full remarks, part astral and part CJK, so
    each costs about 19.5 KB on the wire: what the remarks leave of the post
    budget is less than even the smallest retreat of fifty details needs."""
    said = [_said(f"s{n}", _REMARK) for n in range(10)]
    return [*said, *(_tool(f"t{n}", text) for n in range(_MAX_PLAN_TASKS))]


_REMARK = "😀" * 850 + "語" * (_MAX_MESSAGE - 850)


def test_details_that_cannot_fit_are_dropped_and_leave_todays_message() -> None:
    """Removed, not raised: once every retreat is spent the details go, and
    what is left is exactly the message a turn with no tool detail draws. The
    prose and the request are not touched."""
    items = _crowded("漢" * _MAX_TOOL_IO_DETAILS)
    request = open_request()

    combined = render_turn_with_request(items, _turn(), request, REFERENCE)
    activity = render_activity(items, _turn())

    assert all("details" not in task for task in _tool_cards(combined.blocks))
    assert _weigh(combined.blocks) <= _MAX_POST_BYTES
    assert combined == render_turn_with_request(
        _without_text(items), _turn(), request, REFERENCE
    )
    assert activity == render_activity(_without_text(items), _turn())
    sections = [block for block in activity.blocks if block["type"] == "section"]
    assert len(sections) == 10
    assert all(block["text"]["text"] == _REMARK for block in sections)
    # Without the drop the message would not have fitted: the smallest retreat
    # still leaves it over the budget.
    smallest = render_activity(_crowded("漢" * _DETAIL_RETREAT[-1]), _turn())
    assert all("details" not in task for task in _tool_cards(smallest.blocks))


def test_the_plan_and_stream_paths_drop_tool_details_before_any_prose() -> None:
    """On the paths that already pull prose back, tool details give way first:
    a remark keeps every word while any tool card still has a detail."""
    remarks = [_said(f"s{n}", "語" * 3000) for n in range(9)]
    calls = [_tool(f"t{n}", "漢" * _MAX_TOOL_IO_DETAILS) for n in range(40)]
    items = [*remarks, *calls]

    plan = render_activity_plan(items, _turn("completed"))
    stream = render_activity_stream(items, _turn("completed"))

    for blocks, limit in (
        (plan.blocks, _MAX_POST_BYTES),
        (stream.blocks, _MAX_STREAM_BYTES),
    ):
        assert _weigh(blocks) <= limit
        cards = [
            task
            for block in blocks
            if block.get("type") == "plan"
            for task in block["tasks"]
        ]
        said = [task for task in cards if task.get("icon", {}).get("name") == "comment"]
        assert len(said) == 9
        assert all(
            task["details"]["elements"][0]["elements"][0]["text"] == "語" * 3000
            for task in said
        )


def test_the_stream_with_a_full_section_of_cjk_details_never_raises() -> None:
    """Two full sections of tool cards in the costliest language: the stream
    budget is met by tool details alone, with no exception."""
    items = [
        _tool(f"t{n}", "漢" * _MAX_TOOL_IO_DETAILS)
        for n in range(2 * _MAX_SECTION_ITEMS)
    ]

    stream = render_activity_stream(items, _turn("completed"))
    plan = render_activity_plan(items, _turn("completed"))

    assert _weigh(stream.blocks) <= _MAX_STREAM_BYTES
    assert _weigh(plan.blocks) <= _MAX_POST_BYTES


def _digest(payload: object) -> str:
    return hashlib.sha256(json.dumps(payload).encode()).hexdigest()


# Taken from this renderer before tool details were drawn as code blocks, over
# the recorded turn with every tool step's text emptied — the shape every room
# that has not opted in still sends.
_TODAY = {
    "running": {
        "activity": "a5fe4063276eaa633211bc741b808aa611a7a881cd52d18ff2492b6a2e24c573",
        "text": "9e0ed597e861c464b71f209ed4ce9eb9de6049c76160516efa336237118c14f8",
        "plan": "2a029d109cc45e94209990dfdf162cf9c6ff7ad4f3eabb372088798f600537bf",
        "stream": "38f327732ea70bafba4adad5c621dbd9d7f72bd443c546f521f864c1ad6c7dbd",
        "combined": "85442d7e7d1e68935040195bd9196649f9057150462ec9dda81cec371eba02fb",
    },
    "completed": {
        "activity": "e7e8476e5dcd9007604a3cf5484e2137d7cae775d786bfb3661ba12a0c02ec67",
        "text": "de00d097e9ccd1313589eba31727ac15a143755f8f057d9a530a790ad923aa00",
        "plan": "913eff0aa89860bc1141af6f8d6df622a856031c2f269458e61bd8c1c3ae8e3c",
        "stream": "61c6e421d682f7d012c666a7cc122c451b563349af89e8a2efdbff9b7f2a4bdb",
        "combined": "d710e191a48b6653321024687b08ad1f7b9747e1268514b2bbc6b0362b02308b",
    },
}


def test_a_turn_without_tool_detail_renders_byte_identical_to_before() -> None:
    items = _without_text(recorded_items())
    assert sum(item.kind == "tool-activity" for item in items) == 9

    for status, expected in _TODAY.items():
        turn = _turn(status)
        drawn = {
            "activity": render_activity(items, turn, elapsed_seconds=5).__dict__,
            "text": render_activity_text(items, turn, elapsed_seconds=5),
            "plan": render_activity_plan(
                items, turn, elapsed_seconds=5, interrupt_turn_id="t"
            ).__dict__,
            "stream": render_activity_stream(
                items, turn, elapsed_seconds=5, interrupt_turn_id="t"
            ).__dict__,
            "combined": render_turn_with_request(
                items, turn, open_request(), REFERENCE, elapsed_seconds=5
            ).__dict__,
        }
        assert {name: _digest(value) for name, value in drawn.items()} == expected


# ── Notifications ───────────────────────────────────────────────────────────


def test_notification_text_carries_tool_titles_and_never_tool_text() -> None:
    """The notification is shown outside any card a reader chose to open, so a
    tool entry there is its title alone. What the agent said is unchanged."""
    secret = "DETAIL-SENTINEL-4711"
    items = [
        _said("s1", "All green, merging now."),
        _tool("t1", f"{secret} output", title="Ran the tests"),
        _tool("t2", f"{secret} again", title="Read conftest.py"),
    ]

    texts = {path: text for path, (_, text) in _drawn(items).items()}
    texts["activity_text"] = render_activity_text(items, _turn("completed"))

    for path, text in texts.items():
        assert secret not in text, path
    lines = texts["activity_text"].split("\n")
    assert "All green, merging now." in lines
    assert "✓ Ran the tests" in lines
    assert "✓ Read conftest.py" in lines


# ── Characters outside the BMP and outside ASCII ────────────────────────────


def test_cjk_and_astral_details_at_the_budget_arrive_whole() -> None:
    """The budget counts code points, which is what the host's 2000 counts:
    a detail at it is not cut, whatever it costs on the wire."""
    cjk = "漢" * (_MAX_TOOL_IO_DETAILS - 1) + "😀"
    astral = "😀𝄞" * (_MAX_TOOL_IO_DETAILS // 2)

    drawn = render_activity([_tool("a", cjk), _tool("b", astral)], _turn())

    assert [_tool_text(task) for task in _tool_cards(drawn.blocks)] == [cjk, astral]


def test_astral_details_over_the_budget_are_cut_on_a_character() -> None:
    """A cut never lands inside a character: what is sent still encodes, and
    says it was cut."""
    over = "😀" * (_MAX_TOOL_IO_DETAILS + 1)
    crowded = [_tool(f"t{n}", over) for n in range(50)]

    single = _tool_text(
        _tool_cards(render_activity([_tool("a", over)], _turn()).blocks)[0]
    )
    many = render_activity(crowded, _turn())

    assert len(single) == _MAX_TOOL_IO_DETAILS
    assert single.endswith(_TRUNCATED)
    assert single[: -len(_TRUNCATED)] == "😀" * (_MAX_TOOL_IO_DETAILS - len(_TRUNCATED))
    assert _weigh(many.blocks) <= _MAX_POST_BYTES
    for task in _tool_cards(many.blocks):
        text = _tool_text(task)
        text.encode("utf-8")
        assert text.endswith(_TRUNCATED)
        assert set(text[: -len(_TRUNCATED)]) == {"😀"}

"""An agent's card (`ui_spec`) drawn as one Telegram HTML message with an
inline keyboard, and its buttons pressed and settled."""

from __future__ import annotations

from typing import Any

import pytest
from telegram.error import BadRequest

from switch_core.bridges.collaboration.adapter import CardRejectedError
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.telegram.adapter import (
    _MAX_CALLBACK_BYTES,
    TelegramAdapter,
)
from switch_core.bridges.collaboration.telegram.chunking import MAX_MESSAGE
from switch_core.ui_spec import UISpec, answerer_name, parse_ui_spec

from .test_telegram_adapter import (
    CHAT_ID,
    SCOUT_MARK,
    _adapter,
    _bot,
    _FakeChat,
    _FakeSentMessage,
    _FakeUser,
)
from .test_telegram_sdk_only import _press

CHANNEL = str(CHAT_ID)
HOSTILE = "<b>x</b> & @here"


def _el(kind: str, children: list[str] | None = None, **props: Any) -> dict[str, Any]:
    return {"type": kind, "props": props, "children": children or []}


def _spec(elements: dict[str, Any], root_children: list[str], **card: Any) -> UISpec:
    return parse_ui_spec(
        {
            "root": "card",
            "elements": {"card": _el("Card", root_children, **card), **elements},
        }
    )


FULL = _spec(
    {
        "intro": _el("Text", content="**All** green"),
        "quiet": _el("Text", content="checked 5m ago", style="muted"),
        "loud": _el("Text", content="Ship it", style="bold"),
        "flds": _el("Fields", ["f1"]),
        "f1": _el("Field", label="Status", value="Passed"),
        "sec": _el("Section", ["div", "img"]),
        "div": _el("Divider"),
        "img": _el("Image", url="https://example.com/a.png?x=1&y=2", alt="graph"),
        "tbl": _el(
            "Table",
            headers=["Service", "p95"],
            rows=[["api", 120], ["web", "80"]],
            align=["left", "right"],
            caption="last hour",
        ),
        "pie": _el(
            "Chart",
            title="Share",
            chart={"type": "pie", "segments": [{"label": "a", "value": 3}]},
        ),
        "bar": _el(
            "Chart",
            title="Load",
            chart={
                "type": "bar",
                "categories": ["Mon", "Tue"],
                "series": [{"name": "req", "values": [1, 2.5]}],
                "xLabel": "Day",
            },
        ),
        "acts": _el("Actions", ["go", "stop", "docs"]),
        "go": _el("Button", id="go", label="Go", style="primary", value="g"),
        "stop": _el("Button", id="stop", label="Stop", style="danger"),
        "docs": _el("LinkButton", label="Docs", url="https://example.com/docs"),
    },
    ["intro", "quiet", "loud", "flds", "sec", "tbl", "pie", "bar", "acts"],
    title="Status",
    subtitle="nightly",
    imageUrl="https://example.com/logo.png",
)


async def _send(adapter: TelegramAdapter, spec: UISpec) -> str | None:
    return await adapter.send_ui_message(
        CHANNEL, "scout", spec, "fallback", None, room_wide_mention=False
    )


def _buttons(message: dict[str, Any]) -> list[list[Any]]:
    markup = message["reply_markup"]
    return [] if markup is None else [list(row) for row in markup.inline_keyboard]


async def test_every_component_draws_as_telegram_html() -> None:
    adapter = _adapter()

    ref = await _send(adapter, FULL)

    [sent] = _bot(adapter).messages
    assert ref == f"{CHAT_ID}:501"
    assert sent["parse_mode"] == "HTML"
    assert sent["text"] == "\n".join(
        [
            f"{SCOUT_MARK} <b>scout</b>",
            "<b>Status</b>",
            "<i>nightly</i>",
            '<a href="https://example.com/logo.png">Image</a>',
            "<b>All</b> green",
            "<i>checked 5m ago</i>",
            "<b>Ship it</b>",
            "<b>Status:</b> Passed",
            "──────────",
            '<a href="https://example.com/a.png?x=1&amp;y=2">graph</a>',
            "<pre>Service | p95\napi     | 120\nweb     |  80</pre>",
            "<i>last hour</i>",
            "<b>Share</b>",
            "<pre>a | 3</pre>",
            "<b>Load</b>",
            "<pre>Day | req\nMon |   1\nTue | 2.5</pre>",
        ]
    )
    [row] = _buttons(sent)
    assert [(b.text, b.callback_data, b.url) for b in row] == [
        ("Go", "su:1", None),
        ("Stop", "su:2", None),
        ("Docs", None, "https://example.com/docs"),
    ]
    assert [b.api_kwargs.get("style") for b in row] == ["primary", "danger", None]


async def test_card_text_is_escaped_and_cannot_add_markup() -> None:
    adapter = _adapter()
    spec = _spec(
        {
            "t": _el("Text", content=HOSTILE),
            "f": _el("Fields", ["f1"]),
            "f1": _el("Field", label=HOSTILE, value=HOSTILE),
            "tbl": _el("Table", headers=[HOSTILE], rows=[]),
            "img": _el("Image", url='https://e.example/"><b>', alt=HOSTILE),
        },
        ["t", "f", "tbl", "img"],
        title=HOSTILE,
    )

    await _send(adapter, spec)

    text = _bot(adapter).messages[0]["text"]
    assert "<b>x</b>" not in text
    assert "&lt;b&gt;x&lt;/b&gt; &amp;" in text
    assert text.count("@here") == 1
    assert "<pre>&lt;b&gt;x&lt;/b&gt; &amp; @here</pre>" in text
    assert 'href="https://e.example/&quot;&gt;&lt;b&gt;"' in text


async def test_a_markdown_link_in_card_text_still_links() -> None:
    adapter = _adapter()
    spec = _spec({"t": _el("Text", content="[docs](https://e.example)")}, ["t"])

    await _send(adapter, spec)

    assert '<a href="https://e.example">docs</a>' in _bot(adapter).messages[0]["text"]


async def test_buttons_wrap_three_to_a_row_and_fit_the_callback_limit() -> None:
    adapter = _adapter()
    ids = [f"b{i}" for i in range(25)]
    spec = _spec(
        {
            "acts": _el("Actions", ids),
            **{i: _el("Button", id=i, label=i, value="v" * 1500) for i in ids},
        },
        ["acts"],
        title="Pick",
    )

    await _send(adapter, spec)

    rows = _buttons(_bot(adapter).messages[0])
    assert [len(r) for r in rows] == [3] * 8 + [1]
    assert all(
        len(b.callback_data.encode()) <= _MAX_CALLBACK_BYTES for r in rows for b in r
    )


async def test_a_card_too_long_for_one_message_raises_before_posting() -> None:
    adapter = _adapter()
    spec = _spec({k: _el("Text", content="x" * 3000) for k in ("a", "b")}, ["a", "b"])

    with pytest.raises(CardRejectedError, match=str(MAX_MESSAGE)):
        await _send(adapter, spec)
    assert _bot(adapter).messages == []


async def test_a_card_telegram_refuses_raises_so_the_text_is_sent() -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("can't parse entities")

    with pytest.raises(CardRejectedError, match="parse entities"):
        await _send(adapter, FULL)


def _press_on(ref: str) -> dict[str, Any]:
    chat_id, message_id = ref.split(":")
    return {
        "message": _FakeSentMessage(_FakeChat(int(chat_id)), int(message_id)),
        "from_user": _FakeUser(user_id=9, username="a<b>&c"),
    }


@pytest.mark.parametrize(
    ("data", "action_id"), [("su:1", "switch.ui:#1"), ("su:x", "switch.ui:#x")]
)
async def test_a_press_names_its_button_by_position_for_core_to_resolve(
    data: str, action_id: str
) -> None:
    """No record of the card is needed, so a card posted before a restart
    still takes presses."""
    adapter = _adapter()
    ref = f"{CHAT_ID}:501"

    seen = await _press(adapter, data, **_press_on(ref))

    assert seen == [
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id="9",
            sender_name="a<b>&c",
            sender_display_name="Alice",
            action_id=action_id,
            value="",
            message_ref=ref,
        )
    ]
    assert _bot(adapter).answers == [
        {"callback_query_id": "cq-1", "text": None, "show_alert": False}
    ]


async def test_a_settled_card_is_redrawn_with_who_chose_and_only_its_links() -> None:
    spec = _spec(
        {
            "a1": _el("Actions", ["go", "docs"]),
            "go": _el("Button", id="go", label="Go"),
            "docs": _el("LinkButton", label="Docs", url="https://example.com/docs"),
            "a2": _el("Actions", ["no"]),
            "no": _el("Button", id="no", label="No"),
        },
        ["a1", "a2"],
        title="Pick",
    )
    sender = _adapter()
    ref = await _send(sender, spec)
    assert ref is not None
    posted = _bot(sender).messages[0]
    adapter = _adapter()

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id="9",
            sender_name="alice",
            sender_display_name="a<b>&c",
            action_id="switch.ui:#1",
            value="",
            message_ref=ref,
        ),
        "Go",
        author="scout",
        spec=spec,
        body="fallback",
    )

    [edit] = _bot(adapter).edits
    assert edit["chat_id"] == CHAT_ID and edit["message_id"] == 501
    assert edit["text"] == posted["text"] + "\n✅ a&lt;b&gt;&amp;c chose Go"
    assert [[b.text for b in r] for r in _buttons(edit)] == [["Docs"]]


async def test_a_card_at_the_length_limit_still_fits_once_answered() -> None:
    def card(n: int) -> UISpec:
        return _spec(
            {
                "a": _el("Text", content="x" * 3000),
                "b": _el("Text", content="y" * n),
                "acts": _el("Actions", ["go"]),
                "go": _el("Button", id="go", label="G&" * 37),
            },
            ["a", "b", "acts"],
            title="Pick",
        )

    async def fits(n: int) -> bool:
        try:
            await _send(_adapter(), card(n))
        except CardRejectedError:
            return False
        return True

    low, high = 0, 3000
    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if await fits(middle) else (low, middle - 1)
    assert 0 < low < 3000
    adapter = _adapter()

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id="9",
            sender_name="alice",
            sender_display_name=answerer_name("&" * 100),
            action_id="switch.ui:#1",
            value="",
            message_ref=f"{CHAT_ID}:501",
        ),
        "G&" * 37,
        author="scout",
        spec=card(low),
        body="fallback",
    )

    [edit] = _bot(adapter).edits
    assert len(edit["text"]) <= MAX_MESSAGE
    assert edit["text"].endswith(" chose " + "G&amp;" * 37)

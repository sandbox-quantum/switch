"""An agent's card (`ui_spec`) drawn as Slack Block Kit, posted with its text
fallback, and its buttons pressed and settled."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.slack.ui_blocks import ui_spec_to_blocks
from switch_core.ui_spec import (
    MAX_BLOCKS,
    UISpec,
    UISpecError,
    estimated_block_count,
    parse_ui_spec,
)

from .slack_fakes import FakeWebClient

HOSTILE = "<!channel> @here <@U123> <https://evil.example|click>"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


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


def _el(kind: str, children: list[str] | None = None, **props: Any) -> dict[str, Any]:
    return {"type": kind, "props": props, "children": children or []}


def _spec(elements: dict[str, Any], root_children: list[str], **card: Any) -> UISpec:
    return parse_ui_spec(
        {
            "root": "card",
            "elements": {"card": _el("Card", root_children, **card), **elements},
        }
    )


def _blocks(spec: UISpec) -> list[dict[str, Any]]:
    adapter, _ = _adapter()
    blocks = ui_spec_to_blocks(spec, adapter._card_mrkdwn)
    assert len(blocks) == estimated_block_count(spec)
    return blocks


FULL = _spec(
    {
        "intro": _el("Text", content="**All** green"),
        "quiet": _el("Text", content="checked 5m ago", style="muted"),
        "loud": _el("Text", content="Ship it", style="bold"),
        "sec": _el("Section", ["div", "img"]),
        "div": _el("Divider"),
        "img": _el("Image", url="https://example.com/a.png", alt="graph"),
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
        "act": _el("Actions", ["go", "stop", "doc"]),
        "go": _el("Button", id="go", label="Go", style="primary", value="g"),
        "stop": _el("Button", id="stop", label="Stop", style="danger"),
        "doc": _el("LinkButton", label="Docs", url="https://example.com/docs"),
    },
    ["intro", "quiet", "loud", "sec", "tbl", "pie", "bar", "act"],
    title="Status <!channel>",
    subtitle="nightly",
    imageUrl="https://example.com/logo.png",
)


def test_every_component_draws_as_its_block() -> None:
    blocks = _blocks(FULL)

    assert [b["type"] for b in blocks] == [
        "header",
        "context",
        "image",
        "section",
        "context",
        "section",
        "divider",
        "image",
        "table",
        "context",
        "data_visualization",
        "data_visualization",
        "actions",
    ]
    assert blocks[0]["text"] == {
        "type": "plain_text",
        "text": "Status <!channel>",
        "emoji": True,
    }
    assert blocks[2] == {
        "type": "image",
        "image_url": "https://example.com/logo.png",
        "alt_text": "Status <!channel>",
    }
    assert blocks[3]["text"] == {"type": "mrkdwn", "text": "*All* green"}
    assert blocks[4]["elements"][0]["text"] == "checked 5m ago"
    assert blocks[5]["text"]["text"] == "*Ship it*"
    assert blocks[7] == {
        "type": "image",
        "image_url": "https://example.com/a.png",
        "alt_text": "graph",
    }
    assert blocks[8] == {
        "type": "table",
        "rows": [
            [
                {"type": "raw_text", "text": "Service"},
                {"type": "raw_text", "text": "p95"},
            ],
            [{"type": "raw_text", "text": "api"}, {"type": "raw_text", "text": "120"}],
            [{"type": "raw_text", "text": "web"}, {"type": "raw_text", "text": "80"}],
        ],
        "column_settings": [{"align": "left"}, {"align": "right"}],
    }
    assert blocks[9]["elements"][0]["text"] == "last hour"
    assert blocks[10] == {
        "type": "data_visualization",
        "title": "Share",
        "chart": {"type": "pie", "segments": [{"label": "a", "value": 3.0}]},
    }
    assert blocks[11] == {
        "type": "data_visualization",
        "title": "Load",
        "chart": {
            "type": "bar",
            "series": [
                {
                    "name": "req",
                    "data": [
                        {"label": "Mon", "value": 1.0},
                        {"label": "Tue", "value": 2.5},
                    ],
                }
            ],
            "axis_config": {"categories": ["Mon", "Tue"], "x_label": "Day"},
        },
    }
    assert blocks[12]["elements"] == [
        {
            "type": "button",
            "text": {"type": "plain_text", "text": "Go", "emoji": True},
            "action_id": "switch.ui:go",
            "value": "g",
            "style": "primary",
        },
        {
            "type": "button",
            "text": {"type": "plain_text", "text": "Stop", "emoji": True},
            "action_id": "switch.ui:stop",
            "value": "stop",
            "style": "danger",
        },
        {
            "type": "button",
            "text": {"type": "plain_text", "text": "Docs", "emoji": True},
            "url": "https://example.com/docs",
        },
    ]


def test_fields_split_into_sections_of_ten() -> None:
    fields = {f"f{i}": _el("Field", label=f"L{i}", value=i) for i in range(23)}
    spec = _spec({**fields, "fs": _el("Fields", list(fields))}, ["fs"])

    blocks = _blocks(spec)

    assert [len(b["fields"]) for b in blocks] == [10, 10, 3]
    assert blocks[0]["fields"][0] == {"type": "mrkdwn", "text": "*L0*\n0"}


def test_card_text_cannot_mention_or_link_by_slack_syntax() -> None:
    spec = _spec(
        {
            "t": _el("Text", content=HOSTILE),
            "fs": _el("Fields", ["f"]),
            "f": _el("Field", label=HOSTILE, value=HOSTILE),
            "tbl": _el("Table", headers=[HOSTILE], rows=[[HOSTILE]], caption=HOSTILE),
        },
        ["t", "fs", "tbl"],
        subtitle=HOSTILE,
    )

    blocks = _blocks(spec)
    mrkdwn = [
        blocks[0]["elements"][0]["text"],
        blocks[1]["text"]["text"],
        blocks[2]["fields"][0]["text"],
        blocks[4]["elements"][0]["text"],
    ]

    for text in mrkdwn:
        assert "<!" not in text and "<@" not in text and "<http" not in text
        assert "@here" not in text
    # raw_text is not parsed by Slack, so it carries the characters as written.
    assert blocks[3]["rows"] == [
        [{"type": "raw_text", "text": HOSTILE}],
        [{"type": "raw_text", "text": HOSTILE}],
    ]


def test_a_markdown_link_in_card_text_still_links() -> None:
    blocks = _blocks(
        _spec({"t": _el("Text", content="[PR](https://x.example/1)")}, ["t"])
    )

    assert blocks[0]["text"]["text"] == "<https://x.example/1|PR>"


def test_the_card_is_posted_with_its_fallback_text_as_the_agent() -> None:
    adapter, client = _adapter()

    ref = _run(
        adapter.send_ui_message(
            "C1", "deploybot", FULL, "fallback", "C1:100.0", room_wide_mention=False
        )
    )

    assert ref == "C1:1.0"
    posted = client.posted[0]
    assert posted["channel"] == "C1"
    assert posted["text"] == "fallback"
    assert posted["blocks"] == _blocks(FULL)
    assert posted["thread_ts"] == "100.0"
    assert posted["username"] == "deploybot"
    assert "icon_url" in posted
    assert "reply_broadcast" not in posted


def test_a_card_and_a_text_message_go_out_with_the_same_identity() -> None:
    adapter, client = _adapter()

    text_ref = _run(adapter.send_message("C1", "deploybot", "hi", None))
    card_ref = _run(
        adapter.send_ui_message(
            "C1", "deploybot", FULL, "hi", None, room_wide_mention=False
        )
    )

    text, card = client.posted
    assert (text_ref, card_ref) == ("C1:1.0", "C1:2.0")
    for key in ("username", "icon_url", "thread_ts", "unfurl_links", "unfurl_media"):
        assert text.get(key) == card.get(key), key


def _press_payload(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "block_actions",
        "user": {"id": "U1", "username": "alice", "name": "alice"},
        "channel": {"id": "C1"},
        "container": {"type": "message", "channel_id": "C1", "message_ts": "1.0"},
        "message": {"ts": "1.0", "text": "fallback", "blocks": blocks},
        "actions": [
            {"type": "button", "action_id": "switch.ui:go", "value": "g"},
        ],
    }


class _Socket:
    async def send_socket_mode_response(self, response: Any) -> None:
        return None


def _press(adapter: SlackAdapter, payload: dict[str, Any], settle: bool) -> None:
    async def on_press(interaction: InboundInteraction) -> None:
        if settle:
            await adapter.settle_card_press(
                interaction, "Go", author="my-agent", spec=FULL, body="text"
            )

    adapter.set_interaction_handler(on_press)
    _run(
        adapter._handle_socket_event(
            _Socket(),  # type: ignore[arg-type]
            SocketModeRequest(type="interactive", envelope_id="e1", payload=payload),
        )
    )


def test_a_settled_press_takes_off_every_button_but_links_and_says_who_chose() -> None:
    adapter, client = _adapter()
    more = {
        "type": "actions",
        "elements": [
            {"type": "button", "action_id": "switch.ui:again", "value": "again"}
        ],
    }
    blocks = [*_blocks(FULL), more]
    adapter._resolve_user_name = _named("alice", "a<b>&c")  # type: ignore[method-assign]

    _press(adapter, _press_payload(blocks), settle=True)

    update = client.updated[0]
    assert update["channel"] == "C1" and update["ts"] == "1.0"
    assert update["text"] == "fallback"
    *kept, links, chosen = update["blocks"]
    assert kept == blocks[:-2]
    assert links["elements"] == [blocks[-2]["elements"][-1]]
    assert links["elements"][0]["url"] == "https://example.com/docs"
    assert chosen == {
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": "✅ a&lt;b&gt;&amp;c chose Go"}],
    }
    assert adapter._pressed_cards == {}


def test_a_card_of_the_most_blocks_still_fits_once_answered() -> None:
    adapter, client = _adapter()
    texts = {f"t{i}": _el("Text", content="x") for i in range(MAX_BLOCKS - 3)}
    spec = _spec(
        {
            **texts,
            "act": _el("Actions", ["go", "doc"]),
            "go": _el("Button", id="go", label="Go", value="g"),
            "doc": _el("LinkButton", label="Docs", url="https://example.com/docs"),
        },
        [*texts, "act"],
        title="Pick",
    )
    blocks = _blocks(spec)
    assert len(blocks) == MAX_BLOCKS - 1

    _press(adapter, _press_payload(blocks), settle=True)

    assert len(client.updated[0]["blocks"]) == MAX_BLOCKS


def test_a_press_that_is_not_settled_leaves_the_card_alone() -> None:
    adapter, client = _adapter()

    _press(adapter, _press_payload(_blocks(FULL)), settle=False)

    assert client.updated == []
    assert adapter._pressed_cards == {}


def _named(name: str, display_name: str) -> Any:
    async def resolve(_user_id: str) -> Any:
        return type("User", (), {"name": name, "display_name": display_name})()

    return resolve


def test_a_press_settles_though_another_on_its_card_finished_first() -> None:
    adapter, client = _adapter()
    blocks = _blocks(FULL)

    async def scenario() -> None:
        release = asyncio.Event()
        presses: list[InboundInteraction] = []

        async def on_press(interaction: InboundInteraction) -> None:
            presses.append(interaction)
            if len(presses) == 1:
                await release.wait()
                await adapter.settle_card_press(
                    interaction, "Go", author="my-agent", spec=FULL, body="text"
                )

        adapter.set_interaction_handler(on_press)
        first = asyncio.create_task(
            adapter.dispatch_event(
                envelope_type="interactive", payload=_press_payload(blocks)
            )
        )
        while not presses:
            await asyncio.sleep(0)
        await adapter.dispatch_event(
            envelope_type="interactive", payload=_press_payload(blocks)
        )
        release.set()
        await first

    _run(scenario())

    assert len(client.updated) == 1
    assert adapter._pressed_cards == {}


@pytest.mark.parametrize(
    ("props", "length"),
    [
        ({"content": "x" * 2998, "style": "bold"}, 3000),
        ({"content": "&" * 600}, 3000),
        ({"content": "<" * 750}, 3000),
    ],
)
def test_text_at_the_rendered_limit_draws(props: dict[str, Any], length: int) -> None:
    (block,) = _blocks(_spec({"t": _el("Text", **props)}, ["t"]))

    assert len(block["text"]["text"]) == length


def test_a_field_at_the_rendered_limit_draws() -> None:
    # *label*\nvalue: 3 characters of framing.
    spec = _spec(
        {"fs": _el("Fields", ["f"]), "f": _el("Field", label="&", value="v" * 1992)},
        ["fs"],
    )

    (block,) = _blocks(spec)

    assert len(block["fields"][0]["text"]) == 2000


def test_text_the_translation_grows_past_a_limit_is_refused_by_name() -> None:
    def grow(text: str) -> str:
        return text + "!"

    text = _spec({"t": _el("Text", content="x" * 2998, style="bold")}, ["t"])
    field = _spec(
        {"fs": _el("Fields", ["f"]), "f": _el("Field", label="l", value="v" * 1995)},
        ["fs"],
    )

    with pytest.raises(UISpecError) as text_error:
        ui_spec_to_blocks(text, grow)
    with pytest.raises(UISpecError) as field_error:
        ui_spec_to_blocks(field, grow)

    assert text_error.value.issues[0].startswith(
        "elements.t.props.content: 3001 characters as sent to Slack, over 3000"
    )
    assert field_error.value.issues[0].startswith(
        "elements.f.props.label+value: 2001 characters as sent to Slack, over 2000"
    )

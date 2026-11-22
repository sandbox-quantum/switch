"""An agent's card (`ui_spec`) drawn as an Adaptive Card under the agent's
header, posted with its body as the preview, and its buttons pressed and
settled."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CardRejectedError
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.cards import (
    CARD_BUTTON_VERB,
    ui_spec_elements,
)
from switch_core.bridges.collaboration.teams.connector import (
    BotConnectorRefused,
    BotConnectorUnavailable,
    checked_payload,
)
from switch_core.ui_spec import UISpec, answerer_name, parse_ui_spec

from .test_teams_sdk_only import AGENT, CHANNEL, ROOT, SERVICE_URL, _Connector, _teams

CONVERSATION = f"{CHANNEL};messageid={ROOT}"


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
        "sec": _el("Section", ["f", "div", "img"]),
        "f": _el("Fields", ["f1"]),
        "f1": _el("Field", label="Status", value=3),
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
    title="Status",
    subtitle="nightly",
    imageUrl="https://example.com/logo.png",
)

BUTTONS = _spec(
    {
        "a1": _el("Actions", ["go"]),
        "go": _el("Button", id="go", label="Go", value="g"),
        "a2": _el("Actions", ["no"]),
        "no": _el("Button", id="no", label="No"),
    },
    ["a1", "a2"],
    title="Pick",
)


def _elements(spec: UISpec) -> list[dict[str, Any]]:
    adapter, _ = _teams()
    return ui_spec_elements(spec, adapter._card_text)


def _card(activity: dict[str, Any]) -> dict[str, Any]:
    return dict(activity["attachments"][0]["content"])


def test_every_component_draws_as_its_element() -> None:
    els = _elements(FULL)

    assert [e["type"] for e in els] == [
        "TextBlock",
        "TextBlock",
        "Image",
        "TextBlock",
        "TextBlock",
        "TextBlock",
        "FactSet",
        "Image",
        "Table",
        "TextBlock",
        "Chart.Pie",
        "Chart.VerticalBar.Grouped",
        "ActionSet",
    ]
    title, subtitle, logo, intro, quiet, loud, facts, img, table, caption = els[:10]
    assert title["text"] == "Status"
    assert (title["size"], title["weight"]) == ("Large", "Bolder")
    assert subtitle["isSubtle"] is True
    assert logo == {
        "type": "Image",
        "url": "https://example.com/logo.png",
        "altText": "Status",
    }
    assert intro["text"] == "**All** green" and "isSubtle" not in intro
    assert quiet["isSubtle"] is True
    assert loud["weight"] == "Bolder"
    assert facts["facts"] == [{"title": "Status", "value": "3"}]
    # The Divider is the separator above the element after it.
    assert img["separator"] is True and "separator" not in facts
    assert img["altText"] == "graph"

    assert [c["horizontalCellContentAlignment"] for c in table["columns"]] == [
        "Left",
        "Right",
    ]
    assert [
        [cell["items"][0]["text"] for cell in row["cells"]] for row in table["rows"]
    ] == [["Service", "p95"], ["api", "120"], ["web", "80"]]
    assert caption["text"] == "last hour" and caption["isSubtle"] is True

    pie, bar, actions = els[10:]
    assert pie["title"] == "Share"
    assert pie["data"] == [{"legend": "a", "value": 3}]
    assert pie["fallback"]["type"] == "Table"
    assert bar["data"] == [
        {"legend": "req", "values": [{"x": "Mon", "y": 1}, {"x": "Tue", "y": 2.5}]}
    ]
    assert bar["xAxisTitle"] == "Day" and "yAxisTitle" not in bar
    assert [
        [cell["items"][0]["text"] for cell in row["cells"]]
        for row in bar["fallback"]["rows"]
    ] == [["Day", "req"], ["Mon", "1"], ["Tue", "2.5"]]

    go, stop, doc = actions["actions"]
    assert go == {
        "type": "Action.Execute",
        "title": "Go",
        "verb": CARD_BUTTON_VERB,
        "data": {"switchCard": {"action": "switch.ui:go", "value": "g"}},
        "fallback": "drop",
        "style": "positive",
    }
    assert stop["style"] == "destructive"
    assert stop["data"]["switchCard"]["value"] == "stop"
    assert doc == {
        "type": "Action.OpenUrl",
        "title": "Docs",
        "url": "https://example.com/docs",
    }


def test_line_and_area_charts_draw_as_line_charts() -> None:
    for kind in ("line", "area"):
        spec = _spec(
            {
                "c": _el(
                    "Chart",
                    title="t",
                    chart={
                        "type": kind,
                        "categories": ["a"],
                        "series": [{"name": "s", "values": [1]}],
                    },
                )
            },
            ["c"],
        )
        assert _elements(spec)[0]["type"] == "Chart.Line"


async def test_card_text_cannot_mention_anybody() -> None:
    adapter, connector = _teams()
    adapter.prime_mention_targets({"alice": "aad-alice"})
    spec = _spec(
        {"t": _el("Text", content="@alice <at>alice</at> @channel")},
        ["t"],
        title="hi @alice",
    )

    await adapter.send_ui_message(
        CHANNEL, AGENT, spec, "body", ROOT, room_wide_mention=False
    )

    card = _card(connector.sends[0]["activity"])
    assert "msteams" not in card
    texts = " ".join(e.get("text", "") for e in card["body"][1:])
    assert "<at>" not in texts
    assert "@channel" not in texts


async def test_the_card_replaces_the_body_and_the_body_is_the_preview() -> None:
    adapter, connector = _teams()

    ref = await adapter.send_ui_message(
        CHANNEL, AGENT, FULL, "All green", ROOT, room_wide_mention=False
    )

    assert ref == "MSG1"
    sent = connector.sends[0]
    assert sent["conversation_id"] == CONVERSATION
    activity = sent["activity"]
    assert activity["summary"].endswith(": All green")
    card = _card(activity)
    assert card["version"] == "1.5"
    assert card["fallbackText"].endswith(": All green")
    # The agent's header, then the card; the body is not drawn again.
    assert card["body"][0]["type"] == "ColumnSet"
    assert card["body"][1]["text"] == "Status"
    assert all(e.get("text") != "All green" for e in card["body"])


async def test_a_refused_card_raises_so_the_body_is_posted_instead() -> None:
    adapter, connector = _teams()
    connector.fail_send = BotConnectorRefused("too big", status=None, retry_after=None)

    with pytest.raises(CardRejectedError, match="too big"):
        await adapter.send_ui_message(
            CHANNEL, AGENT, FULL, "body", ROOT, room_wide_mention=False
        )


async def test_an_unknown_outcome_is_not_raised_so_nothing_posts_twice() -> None:
    adapter, connector = _teams()
    connector.fail_send = BotConnectorUnavailable(
        "timeout", status=None, retry_after=None
    )

    assert (
        await adapter.send_ui_message(
            CHANNEL, AGENT, FULL, "body", ROOT, room_wide_mention=False
        )
        is None
    )


def _press(action: str = "switch.ui:go", value: str = "g") -> dict[str, Any]:
    return {
        "type": "invoke",
        "name": "adaptiveCard/action",
        "serviceUrl": SERVICE_URL,
        "conversation": {"id": CONVERSATION, "conversationType": "channel"},
        "channelData": {"channel": {"id": CHANNEL}},
        "replyToId": "MSG1",
        "from": {"id": "29:presser", "aadObjectId": "aad-kim", "name": "kim"},
        "value": {
            "action": {
                "type": "Action.Execute",
                "verb": CARD_BUTTON_VERB,
                "data": {"switchCard": {"action": action, "value": value}},
            },
            "trigger": "manual",
        },
    }


def _handled() -> tuple[TeamsAdapter, _Connector, list[InboundInteraction]]:
    adapter, connector = _teams()
    seen: list[InboundInteraction] = []

    async def record(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(record)
    return adapter, connector, seen


async def test_a_press_names_the_card_by_the_ref_it_was_posted_under() -> None:
    adapter, _, seen = _handled()
    ref = await adapter.send_ui_message(
        CHANNEL, AGENT, BUTTONS, "pick", ROOT, room_wide_mention=False
    )

    assert await adapter.receive_activity(_press()) is None

    [press] = seen
    assert press.action_id == "switch.ui:go"
    assert press.value == "g"
    assert press.message_ref == ref
    assert press.sender_id == "aad-kim"
    assert press.channel_id == CHANNEL


async def test_a_press_not_carrying_a_card_action_is_refused() -> None:
    adapter, _, seen = _handled()

    answer = await adapter.receive_activity(_press(action="other:go"))

    assert answer is not None and answer["statusCode"] == 400
    assert seen == []


@pytest.mark.parametrize(
    "conversation",
    [
        pytest.param(f"{CHANNEL};messageid=MSG1", id="its-own-post"),
        pytest.param(CONVERSATION, id="under-a-thread-root"),
    ],
)
async def test_a_settled_card_is_redrawn_with_who_chose_and_only_its_links(
    conversation: str,
) -> None:
    """Redrawn from the card as the room holds it, in the conversation the
    press came from, so it needs no record of the post and settles after a
    restart too."""
    spec = _spec(
        {
            "a1": _el("Actions", ["go", "docs"]),
            "go": _el("Button", id="go", label="Go", value="g"),
            "docs": _el("LinkButton", label="Docs", url="https://example.com/docs"),
            "a2": _el("Actions", ["no"]),
            "no": _el("Button", id="no", label="No"),
        },
        ["a1", "a2"],
        title="Pick",
    )
    adapter, connector = _teams()

    async def settle(interaction: InboundInteraction) -> None:
        await adapter.settle_card_press(
            interaction.model_copy(update={"sender_display_name": "@kim"}),
            "Go",
            author=AGENT,
            spec=spec,
            body="pick",
        )

    adapter.set_interaction_handler(settle)
    press = _press()
    press["conversation"]["id"] = conversation

    assert await adapter.receive_activity(press) is None

    [update] = connector.updates
    assert update["activity_id"] == "MSG1"
    assert update["conversation_id"] == conversation
    assert update["service_url"] == SERVICE_URL
    assert update["activity"]["summary"].endswith(": pick")
    body = _card(update["activity"])["body"]
    assert [e["type"] for e in body[1:]] == ["TextBlock", "ActionSet", "TextBlock"]
    assert [a["type"] for a in body[2]["actions"]] == ["Action.OpenUrl"]
    assert body[3]["text"] == "✅ @​kim chose Go"


async def test_a_card_at_the_size_limit_still_fits_once_answered() -> None:
    label = "<" * 75

    def card(n: int) -> UISpec:
        texts = {
            f"t{i}": _el("Text", content="x" * min(3000, n - i))
            for i in range(0, n, 3000)
        }
        return _spec(
            {
                **texts,
                "a": _el("Actions", ["go"]),
                "go": _el("Button", id="go", label=label, value="g"),
            },
            [*texts, "a"],
            title="Pick",
        )

    async def fits(n: int) -> bool:
        adapter, _ = _teams()
        try:
            await adapter.send_ui_message(
                CHANNEL, AGENT, card(n), "pick", ROOT, room_wide_mention=False
            )
        except CardRejectedError:
            return False
        return True

    low, high = 1, 60000
    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if await fits(middle) else (low, middle - 1)
    assert 1 < low < 60000
    adapter, connector = _teams()

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id="aad-kim",
            sender_name="kim",
            sender_display_name=answerer_name("@" * 100),
            action_id="switch.ui:go",
            value="g",
            message_ref="MSG1",
        ),
        label,
        author=AGENT,
        spec=card(low),
        body="pick",
    )

    [update] = connector.updates
    checked_payload("update", update["activity"])

"""An agent's card (`ui_spec`) drawn as Discord embeds and buttons, posted
under its text, and its buttons pressed and settled."""

from __future__ import annotations

import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import CardRejectedError
from switch_core.bridges.collaboration.discord.adapter import (
    _WEBHOOK_NAME,
    DiscordAdapter,
)
from switch_core.bridges.collaboration.discord.ui_embeds import (
    EMBED_TOTAL_MAX,
    parse_card_custom_id,
    ui_spec_to_message,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.ui_spec import UISpec, answerer_name, button_action, parse_ui_spec

from .test_discord_card_buttons import _Interaction
from .test_discord_sdk_only import (
    CHANNEL_ID,
    DM_CHANNEL_ID,
    ROOT_MESSAGE_ID,
    _adapter,
    _DMChannel,
    _guild_setup,
    _Webhook,
)

HOSTILE = "@everyone @here <@123456789012345678> <@&123456789012345678> <#42>"


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
        "div": _el("Divider"),
        "img": _el("Image", url="https://example.com/b.png", alt="graph"),
        "tbl": _el(
            "Table",
            headers=["Service", "p95"],
            rows=[["api", 120], ["web", "80"]],
            align=["left", "right"],
            caption="last hour",
        ),
        "bars": _el(
            "Chart",
            title="Latency",
            chart={
                "type": "bar",
                "categories": ["mon", "tue"],
                "series": [{"name": "api", "values": [1, 2.5]}],
                "xLabel": "day",
                "yLabel": "ms",
            },
        ),
        "pie": _el(
            "Chart",
            title="Share",
            chart={
                "type": "pie",
                "segments": [{"label": "a", "value": 3}, {"label": "b", "value": 1}],
            },
        ),
        "f": _el("Fields", ["f1", "f2"]),
        "f1": _el("Field", label="Status", value="Passed"),
        "f2": _el("Field", label="Took", value=4),
        "acts": _el("Actions", ["ok", "no", "docs"]),
        "ok": _el("Button", id="promote", label="Promote", style="primary"),
        "no": _el("Button", id="stop", label="Stop", style="danger", value="halt now"),
        "docs": _el("LinkButton", label="Docs", url="https://example.com/docs"),
    },
    ["intro", "quiet", "div", "img", "tbl", "bars", "pie", "f", "acts"],
    title="Deploy 1.4.2",
    subtitle="prod",
    imageUrl="https://example.com/a.png",
)


def _buttons(view: discord.ui.View) -> list[tuple[str | None, str | None, Any]]:
    return [
        (item.label, item.custom_id or item.url, item.style)
        for item in view.children
        if isinstance(item, discord.ui.Button)
    ]


def test_every_component_draws_into_the_embeds() -> None:
    embeds, view = ui_spec_to_message(FULL, interactive=True)

    main, extra = embeds
    assert main.title == "Deploy 1.4.2"
    assert main.image.url == "https://example.com/a.png"
    assert extra.image.url == "https://example.com/b.png"
    assert [(f.name, f.value, f.inline) for f in main.fields] == [
        ("Status", "Passed", True),
        ("Took", "4", True),
    ]
    description = main.description or ""
    # A Divider is a short rule a line break from its neighbours.
    assert description.startswith(
        "prod\n\n**All** green\n\n*checked 5m ago*\n─────\n```"
    )
    assert (
        "```\nService  p95\n-------  ---\napi      120\nweb       80\n```"
        in description
    )
    assert "*last hour*" in description
    assert "**Latency** (ms)\n```\nday  api\n---  ---\nmon    1\ntue  2.5\n```" in (
        description
    )
    assert "a      3    75%" in description
    assert view is not None
    assert _buttons(view) == [
        ("Promote", "switch.ui:promote", discord.ButtonStyle.primary),
        ("Stop", "switch.ui:stop halt now", discord.ButtonStyle.danger),
        ("Docs", "https://example.com/docs", discord.ButtonStyle.link),
    ]


def test_fields_before_other_text_stay_in_order_in_the_description() -> None:
    spec = _spec(
        {
            "f": _el("Fields", ["f1", "f2"]),
            "f1": _el("Field", label="Status", value="<@1> ok"),
            "f2": _el("Field", label="Took", value=4),
            "t": _el("Text", content="after"),
            "g": _el("Fields", ["g1"]),
            "g1": _el("Field", label="Last", value="here"),
            "d": _el("Divider"),
            "a": _el("Actions", ["b"]),
            "b": _el("Button", id="go", label="Go"),
        },
        ["f", "t", "g", "d", "a"],
        title="Pick",
    )

    [embed], _ = ui_spec_to_message(spec, interactive=True)

    assert embed.description == (
        "**Status:** <\u200b@1> ok\n**Took:** 4\n\nafter\n─────"
    )
    # The last Fields, with nothing drawn in the text after it, are fields.
    assert [(f.name, f.value) for f in embed.fields] == [("Last", "here")]


def test_a_buttons_custom_id_gives_back_the_action_core_matches() -> None:
    for key in ("ok", "no"):
        props = FULL.elements[key].props
        _, view = ui_spec_to_message(FULL, interactive=True)
        assert view is not None
        drawn = next(
            i.custom_id
            for i in view.children
            if isinstance(i, discord.ui.Button) and i.label == props.label  # type: ignore[union-attr]
        )
        assert parse_card_custom_id(drawn or "") == button_action(props)  # type: ignore[arg-type]
    assert parse_card_custom_id("sw:token:1") is None


def test_each_actions_starts_its_own_row() -> None:
    spec = _spec(
        {
            "a1": _el("Actions", [f"b{i}" for i in range(6)]),
            "a2": _el("Actions", ["c"]),
            **{f"b{i}": _el("Button", id=f"b{i}", label=f"B{i}") for i in range(6)},
            "c": _el("Button", id="c", label="C"),
        },
        ["a1", "a2"],
        title="t",
    )
    _, view = ui_spec_to_message(spec, interactive=True)
    assert view is not None
    assert [item.row for item in view.children] == [0, 0, 0, 0, 0, 1, 2]


def test_card_text_cannot_mention_or_resolve_entities() -> None:
    spec = _spec(
        {
            "t": _el("Text", content=HOSTILE),
            "f": _el("Fields", ["f1"]),
            "f1": _el("Field", label=HOSTILE, value=HOSTILE),
        },
        ["t", "f"],
        title=HOSTILE,
    )
    embeds, _ = ui_spec_to_message(spec, interactive=True)
    embed = embeds[0]
    for text in (
        embed.title,
        embed.description,
        embed.fields[0].name,
        embed.fields[0].value,
    ):
        assert text is not None
        assert "@everyone" not in text and "@here" not in text
        assert "<@" not in text and "<#" not in text


@pytest.mark.parametrize(
    ("elements", "children", "card", "reason"),
    [
        (
            {
                "t": _el("Text", content="x" * 3000),
                "u": _el("Text", content="y" * 3000),
            },
            ["t", "u"],
            {},
            "description",
        ),
        (
            {
                "f": _el("Fields", ["f1"]),
                "f1": _el("Field", label="L", value="v" * 1500),
            },
            ["f"],
            {},
            "value",
        ),
        (
            {
                "f": _el("Fields", ["f1"]),
                "f1": _el("Field", label="L" * 300, value="v"),
            },
            ["f"],
            {},
            "name",
        ),
        (
            {
                "f": _el("Fields", [f"f{i}" for i in range(26)]),
                **{f"f{i}": _el("Field", label="L", value="v") for i in range(26)},
            },
            ["f"],
            {},
            "26 fields",
        ),
        (
            {
                f"i{n}": _el("Image", url=f"https://example.com/{n}.png", alt="a")
                for n in range(11)
            },
            [f"i{n}" for n in range(11)],
            {},
            "embeds",
        ),
        (
            {
                "a": _el("Actions", ["l"]),
                "l": _el(
                    "LinkButton", label="L", url="https://example.com/" + "p" * 600
                ),
            },
            ["a"],
            {},
            "URL",
        ),
        (
            {
                "a": _el("Actions", ["b"]),
                "b": _el("Button", id="b", label="B", value="v" * 200),
            },
            ["a"],
            {},
            "Discord allows 100",
        ),
        (
            {
                **{f"a{n}": _el("Actions", [f"b{n}"]) for n in range(6)},
                **{f"b{n}": _el("Button", id=f"b{n}", label="B") for n in range(6)},
            },
            [f"a{n}" for n in range(6)],
            {},
            "rows",
        ),
    ],
)
def test_a_card_over_a_discord_limit_is_refused_before_posting(
    elements: dict[str, Any], children: list[str], card: dict[str, Any], reason: str
) -> None:
    spec = _spec(elements, children, title="t", **card)
    with pytest.raises(ValueError, match=reason):
        ui_spec_to_message(spec, interactive=True)


def test_a_button_needs_a_message_the_application_owns() -> None:
    with pytest.raises(ValueError, match="does not own"):
        ui_spec_to_message(FULL, interactive=False)
    links_only = _spec(
        {
            "a": _el("Actions", ["l"]),
            "l": _el("LinkButton", label="L", url="https://example.com"),
        },
        ["a"],
        title="t",
    )
    _, view = ui_spec_to_message(links_only, interactive=False)
    assert view is not None and len(view.children) == 1


# ── Posting ──────────────────────────────────────────────────────────────────


def _handled(adapter: DiscordAdapter) -> list[InboundInteraction]:
    seen: list[InboundInteraction] = []

    async def took(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(took)
    return seen


def _agents_webhook(channel: Any) -> _Webhook:
    return next(w for w in channel.existing_webhooks if w.name == _WEBHOOK_NAME)


async def test_the_card_is_posted_under_its_text_through_the_agents_webhook() -> None:
    adapter, channel, thread, _ = _guild_setup()
    _handled(adapter)

    ref = await adapter.send_ui_message(
        str(CHANNEL_ID),
        "my-agent",
        FULL,
        "Deploy 1.4.2 passed",
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        room_wide_mention=False,
    )

    sent = _agents_webhook(channel).sent[0]
    assert sent["content"] == "Deploy 1.4.2 passed"
    assert sent["embeds"][0].title == "Deploy 1.4.2"
    assert sent["allowed_mentions"].everyone is False
    assert sent["thread"] is thread
    assert sent["view"].is_finished()
    assert ref == f"{ROOT_MESSAGE_ID}:901"


async def test_a_room_wide_card_may_page_the_channel_from_its_text() -> None:
    adapter, channel, _thread, _ = _guild_setup()

    await adapter.send_ui_message(
        str(CHANNEL_ID),
        "my-agent",
        _spec({}, [], title="t"),
        "@everyone heads up",
        None,
        room_wide_mention=True,
    )

    assert _agents_webhook(channel).sent[0]["allowed_mentions"].everyone is True


async def test_buttons_on_a_webhook_somebody_else_made_fall_back_to_text() -> None:
    adapter, channel, _thread, _ = _guild_setup()
    _handled(adapter)
    channel.existing_webhooks[0] = _Webhook(_WEBHOOK_NAME, creator=None)

    with pytest.raises(CardRejectedError, match="does not own"):
        await adapter.send_ui_message(
            str(CHANNEL_ID), "my-agent", FULL, "text", None, room_wide_mention=False
        )

    assert channel.existing_webhooks[0].sent == []


@pytest.mark.parametrize(
    ("status", "raised"),
    [(400, CardRejectedError), (403, CardRejectedError), (500, discord.HTTPException)],
)
async def test_only_a_card_discord_refuses_falls_back_to_text(
    status: int, raised: type[Exception]
) -> None:
    adapter, channel, _thread, _ = _guild_setup()
    _handled(adapter)
    _agents_webhook(channel).send_error = discord.HTTPException(
        SimpleNamespace(status=status, reason="refused"),  # type: ignore[arg-type]
        "refused",
    )

    with pytest.raises(raised):
        await adapter.send_ui_message(
            str(CHANNEL_ID), "my-agent", FULL, "text", None, room_wide_mention=False
        )


async def test_a_lost_response_is_not_taken_for_a_refusal() -> None:
    # discord.py parses the response inside the send: a JSONDecodeError there
    # may follow a card Discord posted, so it must not repost the text.
    adapter, channel, _thread, _ = _guild_setup()
    _handled(adapter)
    _agents_webhook(channel).send_error = json.JSONDecodeError("bad", "", 0)

    with pytest.raises(json.JSONDecodeError):
        await adapter.send_ui_message(
            str(CHANNEL_ID), "my-agent", FULL, "text", None, room_wide_mention=False
        )


async def test_text_too_long_for_one_message_falls_back_before_posting() -> None:
    adapter, channel, _thread, _ = _guild_setup()

    with pytest.raises(CardRejectedError, match="2000"):
        await adapter.send_ui_message(
            str(CHANNEL_ID),
            "my-agent",
            _spec({}, [], title="t"),
            "x" * 2001,
            None,
            room_wide_mention=False,
        )

    assert _agents_webhook(channel).sent == []


async def test_a_dm_card_is_the_bots_own_message_with_the_agent_named() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    _handled(adapter)

    ref = await adapter.send_ui_message(
        str(DM_CHANNEL_ID), "my-agent", FULL, "text", None, room_wide_mention=False
    )

    assert dm.sent[0]["content"].endswith(": text")
    assert "my-agent" in dm.sent[0]["content"]
    assert dm.sent[0]["embeds"][0].title == "Deploy 1.4.2"
    assert dm.sent[0]["view"] is not None
    assert ref == f"{DM_CHANNEL_ID}:501"


# ── Pressing ─────────────────────────────────────────────────────────────────


class _CardPress(_Interaction):
    def __init__(self, custom_id: str, *, channel: Any, message: Any) -> None:
        super().__init__(custom_id, channel=channel, message=message)
        self.redraws: list[dict[str, Any]] = []

    async def edit_original_response(self, **kwargs: Any) -> None:
        self.redraws.append(kwargs)


class _CardMessage:
    def __init__(self, channel: Any, sent: dict[str, Any]) -> None:
        self.id = 901
        self.channel = channel
        self.embeds = sent["embeds"]
        self.components = [
            discord.ActionRow(row)  # type: ignore[arg-type]
            for row in sent["view"].to_components()
        ]


async def _pressed(settle: bool) -> tuple[_CardPress, list[InboundInteraction]]:
    adapter, channel, thread, _ = _guild_setup()
    seen: list[InboundInteraction] = []

    async def took(interaction: InboundInteraction) -> None:
        seen.append(interaction)
        if settle:
            await adapter.settle_card_press(
                interaction, "Stop", author="my-agent", spec=FULL, body="text"
            )

    adapter.set_interaction_handler(took)
    ref = await adapter.send_ui_message(
        str(CHANNEL_ID),
        "my-agent",
        FULL,
        "text",
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        room_wide_mention=False,
    )
    sent = _agents_webhook(channel).sent[0]
    press = _CardPress(
        "switch.ui:stop halt now", channel=thread, message=_CardMessage(thread, sent)
    )
    await adapter._handle_interaction(press)  # type: ignore[arg-type]
    assert seen[0].message_ref == ref
    assert adapter._pressed_cards == {}
    return press, seen


async def test_a_press_carries_the_button_and_the_card_it_was_on() -> None:
    press, seen = await _pressed(settle=False)

    assert press.response.deferred == 1
    assert (seen[0].action_id, seen[0].value) == ("switch.ui:stop", "halt now")
    assert seen[0].channel_id == str(CHANNEL_ID)
    assert seen[0].sender_name == "kim"
    assert press.redraws == []


async def test_a_settled_press_takes_off_every_button_but_links_and_says_who_chose() -> (
    None
):
    press, _ = await _pressed(settle=True)

    redraw = press.redraws[0]
    assert [(b.label, b.url) for b in redraw["view"].children] == [
        ("Docs", "https://example.com/docs")
    ]
    assert redraw["view"].is_finished()
    # In the footer of the last embed rather than an embed of its own.
    assert len(redraw["embeds"]) == len(press.message.embeds)
    assert redraw["embeds"][-1].footer.text == "✅ Kim Lee chose Stop"
    assert redraw["embeds"][0].title == "Deploy 1.4.2"


def _largest(fits: Callable[[int], bool], high: int) -> int:
    low = 0
    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if fits(middle) else (low, middle - 1)
    return low


async def test_a_card_at_the_size_limit_still_fits_once_answered() -> None:
    def card(n: int) -> UISpec:
        fields = {f"f{i}": _el("Field", label="L", value="v" * 1000) for i in range(5)}
        return _spec(
            {
                "t": _el("Text", content="x" * n),
                "fs": _el("Fields", list(fields)),
                **fields,
                "acts": _el("Actions", ["no"]),
                "no": _el("Button", id="stop", label="Stop", value="halt now"),
            },
            ["t", "fs", "acts"],
            title="Deploy",
        )

    def fits(n: int) -> bool:
        try:
            ui_spec_to_message(card(n), interactive=True)
        except ValueError:
            return False
        return True

    n = _largest(fits, 3000)
    assert 0 < n < 3000
    embeds, view = ui_spec_to_message(card(n), interactive=True)
    adapter, _channel, thread, _ = _guild_setup()
    press = _CardPress(
        "switch.ui:stop halt now",
        channel=thread,
        message=_CardMessage(thread, {"embeds": embeds, "view": view}),
    )
    adapter._pressed_cards[f"{thread.id}:901"] = press  # type: ignore[assignment]

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=str(CHANNEL_ID),
            sender_id="1",
            sender_name="kim",
            sender_display_name=answerer_name("k" * 100),
            action_id="switch.ui:stop",
            value="halt now",
            message_ref=f"{thread.id}:901",
        ),
        "Stop",
        author="my-agent",
        spec=card(n),
        body="text",
    )

    redraw = press.redraws[0]["embeds"]
    assert redraw[-1].footer.text.startswith("✅ kkk")
    assert sum(len(e) for e in redraw) <= EMBED_TOTAL_MAX


async def test_settling_with_no_press_held_leaves_the_card_alone() -> None:
    adapter, _channel, _thread, _ = _guild_setup()

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=str(CHANNEL_ID),
            sender_id="1",
            sender_name="kim",
            sender_display_name="kim",
            action_id="switch.ui:stop",
            value="halt now",
            message_ref=f"{CHANNEL_ID}:901",
        ),
        "Stop",
        author="my-agent",
        spec=FULL,
        body="text",
    )

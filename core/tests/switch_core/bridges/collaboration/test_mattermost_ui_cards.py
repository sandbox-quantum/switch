"""An agent's card (`ui_spec`) drawn as Mattermost message attachments, posted
under its text, and its buttons pressed and settled."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from switch_core.agent_display_name import ZERO_WIDTH_SPACE
from switch_core.bridges.collaboration.ingress import CallbackRefused
from switch_core.bridges.collaboration.mattermost import adapter as mm_adapter
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.callback import (
    CardPress,
    read_press,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.ui_spec import UISpec, parse_ui_spec

from .test_mattermost_press import CHANNEL, HANDLE, USER, _adapter, _key, _record
from .test_mattermost_sdk_only import _posts

HOSTILE = "@here @channel @alice"


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
        "facts": _el("Fields", ["f1", "f2"]),
        "f1": _el("Field", label="Env", value="prod"),
        "f2": _el("Field", label="Build", value=42),
        "img": _el("Image", url="https://example.com/a b.png", alt="graph"),
        "div": _el("Divider"),
        "tbl": _el(
            "Table",
            headers=["Service", "p95"],
            rows=[["api|v2", 120]],
            align=["left", "right"],
            caption="last hour",
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
        "more": _el("Actions", ["again"]),
        "again": _el("Button", id="again", label="Again"),
    },
    ["intro", "quiet", "facts", "img", "div", "tbl", "bar", "act", "more"],
    title="Status",
    subtitle="nightly",
    imageUrl="https://example.com/logo.png",
)


async def _send(adapter: MattermostAdapter, spec: UISpec = FULL) -> str | None:
    return await adapter.send_ui_message(
        CHANNEL, "worker", spec, "the body", "root-1", room_wide_mention=False
    )


async def test_a_card_draws_as_attachments_under_its_body() -> None:
    adapter = _adapter()
    _record(adapter)
    ref = await _send(adapter)

    post = _posts(adapter).created[-1]
    assert ref == "post-1"
    assert post["message"] == "the body"
    assert post["root_id"] == "root-1"
    # A part Mattermost would draw above one already in the attachment (text
    # above an image, text above fields) starts the next attachment.
    head, facts, image, data, again = post["props"]["attachments"]
    assert head == {
        "title": "Status",
        "text": "nightly",
        "image_url": "https://example.com/logo.png",
        "fallback": head["fallback"],
    }
    assert head["fallback"].startswith("**Status**\nnightly")
    assert facts == {
        "text": "**All** green\n_checked 5m ago_",
        "fields": [
            {"title": "Env", "value": "prod", "short": True},
            {"title": "Build", "value": "42", "short": True},
        ],
    }
    assert image == {"text": "![graph](https://example.com/a%20b.png)"}

    assert data["text"].split("\n") == [
        "| Service | p95 |",
        "| :--- | ---: |",
        "| api\\|v2 | 120 |",
        "last hour",
        "**Load**",
        "| Day | req |",
        "| --- | --- |",
        "| Mon | 1 |",
        "| Tue | 2.5 |",
        "[Docs](https://example.com/docs)",
    ]
    assert [(a["id"], a["name"], a.get("style")) for a in data["actions"]] == [
        ("switchui0", "Go", "primary"),
        ("switchui1", "Stop", "danger"),
    ]
    # Each Actions is a row of its own, settled on its own.
    assert again == {"actions": [again["actions"][0]]}
    assert again["actions"][0]["id"] == "switchui2"
    assert post["props"]["switch_ui_actions"] == {
        "switchui0": ["switch.ui:go", "g"],
        "switchui1": ["switch.ui:stop", "stop"],
        "switchui2": ["switch.ui:again", "again"],
    }


async def test_card_text_mentions_nobody() -> None:
    adapter = _adapter()
    spec = _spec(
        {
            "t": _el("Text", content=HOSTILE),
            "fs": _el("Fields", ["f"]),
            "f": _el("Field", label=HOSTILE, value=HOSTILE),
            "tbl": _el("Table", headers=[HOSTILE], rows=[[HOSTILE]]),
        },
        ["t", "fs", "tbl"],
        title=HOSTILE,
        subtitle=HOSTILE,
    )
    await _send(adapter, spec)

    attachments = _posts(adapter).created[-1]["props"]["attachments"]
    drawn = repr(attachments)
    for word in ("@here", "@channel", "@alice"):
        assert word not in drawn
    assert f"@{ZERO_WIDTH_SPACE}alice" in attachments[0]["text"]


async def test_without_a_callback_address_buttons_are_listed_as_text() -> None:
    adapter = _adapter(callback_base_url=None)
    await _send(adapter)

    props = _posts(adapter).created[-1]["props"]
    assert all("actions" not in a for a in props["attachments"])
    assert "switch_ui_actions" not in props
    assert "**Go** · **Stop**" in props["attachments"][-1]["text"]


async def test_a_card_too_big_for_the_post_raises_before_posting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = _adapter()
    monkeypatch.setattr(mm_adapter, "_MAX_PROPS", 100)

    with pytest.raises(ValueError, match="post props"):
        await _send(adapter)
    assert _posts(adapter).created == []


def _press_body(adapter: MattermostAdapter, name: str, **overrides: Any) -> Any:
    post = _posts(adapter).created[-1]
    actions = [
        a for att in post["props"]["attachments"] for a in att.get("actions", [])
    ]
    action = next(a for a in actions if a["name"] == name)
    body = {
        "user_id": USER,
        "post_id": "post-1",
        "channel_id": CHANNEL,
        "context": copy.deepcopy(action["integration"]["context"]),
    }
    return body | overrides


async def test_a_press_arrives_as_the_buttons_action_on_the_posted_card() -> None:
    adapter = _adapter()
    seen = _record(adapter)
    ref = await _send(adapter)

    assert await adapter._handle_callback(_press_body(adapter, "Go")) == {}

    assert seen == [
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id=USER,
            sender_name=HANDLE,
            action_id="switch.ui:go",
            value="g",
            message_ref=ref,
        )
    ]


async def test_a_press_with_an_edited_value_or_moved_channel_is_refused() -> None:
    adapter = _adapter()
    seen = _record(adapter)
    await _send(adapter)
    forged = _press_body(adapter, "Go")
    forged["context"]["switch"]["value"] = "other"

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(forged)
    moved = _press_body(adapter, "Go", channel_id="chan-2")
    assert read_press([_key()], moved) is None
    assert isinstance(read_press([_key()], _press_body(adapter, "Go")), CardPress)
    assert seen == []


async def test_settling_a_press_replaces_its_buttons_with_the_choice() -> None:
    adapter = _adapter()
    _record(adapter)
    ref = await _send(adapter)
    posts = _posts(adapter)
    # Mattermost hands a post back without its actions' integrations.
    for att in posts.stored["post-1"]["props"]["attachments"]:
        for action in att.get("actions", []):
            action.pop("integration")

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id=USER,
            sender_name="@alice",
            action_id="switch.ui:go",
            value="g",
            message_ref=ref,
        ),
        "Go",
    )

    patched_ref, patch = posts.patched[-1]
    assert patched_ref == ref
    assert patch["props"]["from_bot"] == "true"
    head, *_, data, again = patch["props"]["attachments"]
    assert head["title"] == "Status"
    assert "actions" not in data
    assert again["actions"][0]["integration"]["url"].endswith("/callback")
    assert data["footer"] == f"✅ @{ZERO_WIDTH_SPACE}alice chose Go"


async def test_settling_keeps_other_button_rows_pressable() -> None:
    adapter = _adapter()
    seen = _record(adapter)
    spec = _spec(
        {
            "a1": _el("Actions", ["yes"]),
            "yes": _el("Button", id="yes", label="Yes"),
            "d": _el("Divider"),
            "a2": _el("Actions", ["no"]),
            "no": _el("Button", id="no", label="No"),
        },
        ["a1", "d", "a2"],
        title="Pick",
    )
    ref = await _send(adapter, spec)
    posts = _posts(adapter)
    for att in posts.stored["post-1"]["props"]["attachments"]:
        for action in att.get("actions", []):
            action.pop("integration")

    await adapter.settle_card_press(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id=USER,
            sender_name=HANDLE,
            action_id="switch.ui:yes",
            value="yes",
            message_ref=ref,
        ),
        "Yes",
    )

    first, second = posts.patched[-1][1]["props"]["attachments"]
    assert "actions" not in first and first["footer"] == "✅ alice chose Yes"
    (no,) = second["actions"]
    await adapter._handle_callback(
        {
            "user_id": USER,
            "post_id": ref,
            "channel_id": CHANNEL,
            "context": no["integration"]["context"],
        }
    )
    assert [(i.action_id, i.value) for i in seen] == [("switch.ui:no", "no")]

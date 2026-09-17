"""Answering a Mattermost permission card by pressing it.

The buttons are message-attachment actions, which Mattermost carries in the
post's props rather than in anything a reader sees. Each one holds an
`integration` — the URL the press is delivered to and a context to deliver with
it — and the server keeps that half to itself: it is never serialised to a
client, which is what makes it somewhere a credential can live.

What travels in a button is the card's opaque token, the number beside the
option, and a signature over the two. Who pressed comes from the body
Mattermost posts, and both halves are resolved against the stored record rather
than trusted.

An option a button already shows in full loses its line in the body: the same
choice printed twice is the second copy pushing the rest of the card off a
phone. Mattermost documents no budget for a button's name, so the width is a
legibility one, and an option too long for it keeps its line — as does every
option on a card that earned no buttons at all.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest
from mattermostdriver.exceptions import NotEnoughPermissions

from switch_core.bridges.collaboration.adapter import RichContentFailed
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.callback import (
    MAX_BUTTON_LABEL,
    read_press,
)
from switch_core.bridges.collaboration.session.form import (
    posted_form,
    resolve_pressed_position,
)
from switch_core.bridges.collaboration.session.renderers import parse_answer_position
from switch_core.sessions.contract import ApprovalResult

from .test_mattermost_press import (
    CALLBACK_BASE,
    CHANNEL,
    _adapter,
    _body,
    _key,
    _record,
)
from .test_mattermost_sdk_only import _activity, _card, _posts

CALLBACK_URL = f"{CALLBACK_BASE}/collaboration/mattermost/bridge-1/callback"


def _handled(**kwargs: Any) -> tuple[MattermostAdapter, list[Any]]:
    """An adapter that takes presses, and the list of the ones it took."""
    adapter = _adapter(**kwargs)
    return adapter, _record(adapter)


def _buttons(post: dict[str, Any]) -> list[dict[str, Any]]:
    """Every action on a post, as Mattermost would find them in its props."""
    attachments = (post.get("props") or {}).get("attachments") or []
    return [action for attachment in attachments for action in attachment["actions"]]


def _created(adapter: MattermostAdapter) -> dict[str, Any]:
    return _posts(adapter).created[0]


def _patched(adapter: MattermostAdapter) -> dict[str, Any]:
    return _posts(adapter).patched[0][1]


# ── What the card offers ─────────────────────────────────────────────────────


async def test_an_open_card_offers_a_button_for_every_option_it_lists() -> None:
    """Numbered the way the body numbers them and the way a typed answer names
    them, so pressing and typing mean the same thing by the same word."""
    adapter, _ = _handled()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    assert [button["name"] for button in _buttons(_created(adapter))] == [
        "1. Allow once",
        "2. Deny",
    ]


async def test_every_button_is_addressed_to_this_bridges_own_callback_url() -> None:
    """The listener is shared between bridges and routes on the path, so the
    path is the whole of what says which bridge a press belongs to."""
    adapter, _ = _handled()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    assert {button["integration"]["url"] for button in _buttons(_created(adapter))} == {
        CALLBACK_URL
    }


async def test_a_button_carries_the_card_and_the_place_and_nothing_else() -> None:
    """No option id, no actor, no label. Everything a client could rewrite is
    resolved against the record, so the less a press carries the less there is
    to resolve — and the signature is only as wide as what it covers."""
    adapter, _ = _handled()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    for button in _buttons(_created(adapter)):
        context = button["integration"]["context"]
        assert set(context) == {"switch"}
        assert set(context["switch"]) == {"token", "position", "signature"}
    assert "allow-once" not in str(_buttons(_created(adapter)))


async def test_each_button_is_signed_for_its_own_option() -> None:
    """One credential per button rather than one per card. A context lifted off
    the cheaper option cannot be posted back as the costlier one, because the
    number it names is part of what was signed."""
    adapter, _ = _handled()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    contexts = [
        button["integration"]["context"]["switch"]
        for button in _buttons(_created(adapter))
    ]
    assert len({context["signature"] for context in contexts}) == 2
    presses = [read_press(_key(), _body({"switch": context})) for context in contexts]
    assert [press.position for press in presses if press is not None] == [1, 2]


async def test_a_context_signed_for_one_option_does_not_verify_for_another() -> None:
    adapter, _ = _handled()
    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")
    first, second = _buttons(_created(adapter))

    forged = dict(first["integration"]["context"]["switch"])
    forged["position"] = second["integration"]["context"]["switch"]["position"]

    assert read_press(_key(), _body({"switch": forged})) is None


async def test_the_body_drops_the_options_the_buttons_already_show() -> None:
    """The same choice twice is the second copy pushing the rest of the card
    off a phone screen. The buttons carry the numbers, so the instruction to
    answer by number still names something the reader can see."""
    adapter, _ = _handled()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    text = _created(adapter)["message"]
    assert "1. Allow once" not in text
    assert "2. Deny" not in text
    assert "R7" in text
    assert [button["name"] for button in _buttons(_created(adapter))] == [
        "1. Allow once",
        "2. Deny",
    ]


async def test_an_option_too_long_for_its_button_keeps_its_line_in_the_body() -> None:
    """A button shows what it has room for. Where that is less than the whole
    option, the body is the only place the rest of it is written, so the line
    stays and the reader can still tell the two choices apart."""
    adapter, _ = _handled()
    card = await _card()
    long_label = "Allow once, " + "but only for the staging volume " * 4
    stretched = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={
                    "options": [
                        card.request.content.options[0].model_copy(
                            update={"label": long_label}
                        ),
                        card.request.content.options[1],
                    ]
                }
            )
        }
    )

    await adapter.post_rich(
        CHANNEL, "worker", replace(card, request=stretched), "root-1"
    )

    text = _created(adapter)["message"]
    assert "1. Allow once, but only for the staging volume" in text
    assert "2. Deny" not in text
    first, second = _buttons(_created(adapter))
    assert first["name"].endswith("…")
    assert len(first["name"]) <= MAX_BUTTON_LABEL + len("1. ")
    assert second["name"] == "2. Deny"


async def test_a_card_that_earns_no_buttons_keeps_every_option_in_its_body() -> None:
    """The suppression is a promise that a control is carrying the option. A
    form too big to show faithfully earns no controls, and the drawing that
    discovered that had already dropped the lines — so it is drawn again."""
    adapter, _ = _handled()
    card = await _card()
    clipped = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={"detail": "Deletes the production volume. " * 2000}
            )
        }
    )

    await adapter.post_rich(CHANNEL, "worker", replace(card, request=clipped), "root-1")

    text = _created(adapter)["message"]
    assert _buttons(_created(adapter)) == []
    assert "1. Allow once" in text
    assert "2. Deny" in text


async def test_the_failure_text_keeps_the_options_it_has_no_buttons_for() -> None:
    """What goes in a `RichContentFailed` is posted as plain text with nothing
    to press. A body that dropped its options on the promise of a button would
    ask for a choice it had stopped printing."""
    adapter, _ = _handled()

    text = adapter.rich_fallback_text(await _card())

    assert "1. Allow once" in text
    assert "2. Deny" in text


async def test_a_refused_edit_reports_the_options_the_card_stopped_printing() -> None:
    """The one that actually reaches a reader. A card whose redraw is refused
    is reported with its own text, and the publisher sends that on as an
    ordinary message — where there are no buttons to carry the options, so the
    drawing that suppressed them is the wrong one to report with."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")
    _posts(adapter).patch_error = NotEnoughPermissions("403")

    with pytest.raises(RichContentFailed) as raised:
        await adapter.update_rich(CHANNEL, "worker", ref, card, "root-1")

    assert "1. Allow once" in raised.value.text
    assert "2. Deny" in raised.value.text
    assert "1. Allow once" not in _created(adapter)["message"]


async def test_a_refused_post_reports_the_options_its_buttons_never_got() -> None:
    """Nothing was posted, so the reported text is the only place the options
    appear at all."""
    adapter, _ = _handled()
    _posts(adapter).create_error = NotEnoughPermissions("403")

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    assert "1. Allow once" in raised.value.text
    assert "2. Deny" in raised.value.text


async def test_a_card_that_lost_its_connection_still_says_what_it_was_asking() -> None:
    """A dropped connection takes the driver and the loop with it and leaves
    the callback address configured, so the drawing that suppressed the options
    is still the one this path would otherwise report."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")
    adapter._main_loop = None

    with pytest.raises(RichContentFailed) as raised:
        await adapter.update_rich(CHANNEL, "worker", ref, card, "root-1")

    assert "1. Allow once" in raised.value.text
    assert "2. Deny" in raised.value.text


async def test_a_card_with_no_bot_to_post_it_still_says_what_it_was_asking() -> None:
    """Refused before Mattermost is reached, and the same reasoning applies:
    the buttons that were to carry the options were never posted either."""
    adapter, _ = _handled()

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(CHANNEL, "stranger", await _card(), "root-1")

    assert "1. Allow once" in raised.value.text
    assert "2. Deny" in raised.value.text


async def test_a_button_keeps_its_id_across_a_redraw() -> None:
    """Mattermost mints an id for an action that arrives without one, and only
    on the create path. A card is redrawn many times, and an id that changed
    under a reader would remount the control they were mid-press on."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")

    await adapter.update_rich(CHANNEL, "worker", ref, card, "root-1")

    assert [button["id"] for button in _buttons(_created(adapter))] == [
        "switch1",
        "switch2",
    ]
    assert [button["id"] for button in _buttons(_patched(adapter))] == [
        "switch1",
        "switch2",
    ]


# ── When the buttons come off ────────────────────────────────────────────────


async def test_a_settled_card_is_redrawn_without_its_buttons() -> None:
    """Every redraw builds the actions again, so a request that settled loses
    its controls without anything having to remember that it had them."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")

    settled = replace(
        card, request=card.request.model_copy(update={"state": "resolved"})
    )
    await adapter.update_rich(CHANNEL, "worker", ref, settled, "root-1")

    assert _buttons(_created(adapter)) != []
    assert _patched(adapter)["props"] == {
        "from_bot": "true",
        "switch_publication": "tok-1",
    }


async def test_a_redraw_keeps_the_props_the_server_put_on_the_post() -> None:
    """A patch replaces props wholesale, and what is on them is not only what
    Switch sent: the marker saying the post came from a bot was added by
    Mattermost. Writing the props fresh would take it off the card, and the
    reader would stop being told who they are answering."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")

    await adapter.update_rich(CHANNEL, "worker", ref, card, "root-1")

    props = _patched(adapter)["props"]
    assert props["from_bot"] == "true"
    assert props["switch_publication"] == "tok-1"
    assert _buttons({"props": props}) != []


async def test_a_card_that_cannot_be_answered_here_offers_nothing_to_press() -> None:
    """It says why in its own words, and a live button under that sentence is
    an invitation to the refusal the sentence just explained."""
    adapter, _ = _handled()

    await adapter.post_rich(
        CHANNEL,
        "worker",
        await _card(unavailable_reason="Answer this one in the Console."),
        "root-1",
    )

    assert _buttons(_created(adapter)) == []


async def test_a_card_that_could_not_show_its_decision_offers_nothing_to_press() -> (
    None
):
    """The body says it is too long to answer here — and a button beside that
    sentence answers it anyway. The press would resolve against the saved form
    and settle the request on text the reader never saw."""
    adapter, _ = _handled()
    card = await _card()
    clipped = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={"detail": "Deletes the production volume. " * 2000}
            )
        }
    )

    await adapter.post_rich(CHANNEL, "worker", replace(card, request=clipped), "root-1")

    assert "cannot be answered from this message" in _created(adapter)["message"]
    assert _buttons(_created(adapter)) == []


async def test_a_status_has_nothing_to_press() -> None:
    adapter, _ = _handled()

    await adapter.post_rich(
        CHANNEL, "worker", _activity(publication_token="tok-turn"), "root-1"
    )

    assert _buttons(_created(adapter)) == []


async def test_a_statuss_redraw_leaves_the_posts_props_alone() -> None:
    """Only a card has buttons, so only a card's redraw has any business
    rewriting props — and a patch that carried them would have to read the post
    back first for no gain."""
    adapter, _ = _handled()
    ref = await adapter.post_rich(
        CHANNEL, "worker", _activity(publication_token="tok-turn"), "root-1"
    )

    await adapter.update_rich(
        CHANNEL, "worker", ref, _activity(publication_token="tok-turn"), "root-1"
    )

    assert set(_patched(adapter)) == {"message"}


# ── Bridges that draw none ───────────────────────────────────────────────────


async def test_a_bridge_with_no_callback_address_draws_no_buttons() -> None:
    """Nothing fails: the card still posts and is still answerable by typing.
    A button whose press could not be delivered would be a control that reports
    a failure of its own to whoever pressed it."""
    adapter, _ = _handled(callback_base_url=None)

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    assert _buttons(_created(adapter)) == []
    assert _created(adapter)["props"] == {"switch_publication": "tok-1"}


async def test_a_bridge_that_takes_no_presses_draws_no_buttons() -> None:
    """The address is reachable and the place on the listener is held, but
    nothing is wired up to route a press: it would be refused on arrival."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    assert _buttons(_created(adapter)) == []


async def test_a_bridge_that_draws_no_buttons_still_takes_the_old_ones_off() -> None:
    """A deployment that has withdrawn its callback address is not a deployment
    that never had one. Cards posted while it had one are still in the channel
    with buttons on them, pointing at a route that has gone, and this is the
    only pass that can take them off. Removing a control cannot be conditional
    on being able to offer one."""
    adapter, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")
    assert _buttons(_created(adapter)) != []
    adapter._config = adapter._config.model_copy(update={"callback_base_url": None})

    await adapter.update_rich(CHANNEL, "worker", ref, card, "root-1")

    props = _patched(adapter)["props"]
    assert "attachments" not in props
    assert props["from_bot"] == "true"


# ── The press that comes back ────────────────────────────────────────────────


async def test_the_card_and_the_press_agree_on_the_option() -> None:
    """The loop: the adapter draws the control, Mattermost hands the context
    back, and the record turns it into the option the reader pressed."""
    adapter, seen = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "worker", card, "root-1")
    context = _buttons(_created(adapter))[1]["integration"]["context"]

    assert await adapter._handle_callback(_body(context, post_id=ref)) == {}

    interaction = seen[0]
    assert interaction.value == card.reference.token
    assert interaction.message_ref == ref
    answer = resolve_pressed_position(
        posted_form(card.request),
        parse_answer_position(interaction.action_id) or 0,
    )
    assert isinstance(answer, ApprovalResult)
    assert answer.option_id == card.request.content.options[1].option_id

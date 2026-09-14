"""Telegram publishes SDK sessions, and the legacy renderer no longer runs.

What is under test here is the rich-content seam on the one platform with no
per-message identity at all: the compact status and the request card, drawn as
HTML rather than Markdown, attributed in the body because a bot cannot be
attributed anywhere else, anchored to a forum topic or to a reply target
depending on what the chat actually is, edited in place, paced under Telegram's
own limits, and loud when any of that fails.

The old runtime-state renderer is still in the file (removing it is its own
task) but nothing routes to it any more. The first test holds that line: the
two renderers must not both draw, or every turn appears twice.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from telegram.error import (
    BadRequest,
    ChatMigrated,
    Forbidden,
    NetworkError,
    RetryAfter,
    TimedOut,
)

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    _REDRAW_INTERVAL,
    TelegramAdapter,
)

from .test_session_activity import _item, _turn
from .test_telegram_adapter import CHAT_ID, _adapter, _bot

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

CHANNEL = str(CHAT_ID)
TOPIC_ID = "88"
ASKER_ID = 60606
ASKER = str(ASKER_ID)


def _activity(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn("running"), **kwargs)


def _ended(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Done.")]
    return TurnActivity(items, _turn("completed"), **kwargs)


async def _card(**kwargs: Any) -> RequestCard:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, "session-demo")
    request = projection.open_requests()[0]
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"), **kwargs)


def _forum(adapter: TelegramAdapter) -> None:
    _bot(adapter).chat.is_forum = True


def _posted(adapter: TelegramAdapter) -> dict[str, Any]:
    return _bot(adapter).messages[0]


def _edited(adapter: TelegramAdapter) -> dict[str, Any]:
    return _bot(adapter).edits[-1]


# ── The legacy renderer is off ───────────────────────────────────────────────


async def test_the_legacy_renderer_no_longer_draws_alongside_the_sdk_one() -> None:
    """Both would draw the same turn, and the chat would show it twice."""
    adapter = _adapter()

    for state in ("working", "awaiting-input", "idle"):
        await adapter.apply_runtime_state(
            CHANNEL,
            "my-agent",
            state,
            mention_handle="someone",
            thread_root_id=None,
        )
    await adapter.reposition_runtime_state(CHANNEL, "my-agent", None)

    assert _bot(adapter).messages == []
    assert _bot(adapter).edits == []
    assert adapter.renders_legacy_runtime_state is False
    assert adapter.publishes_sdk_sessions is True


def test_telegram_notifies_a_chat_without_anybody_being_named() -> None:
    """Everyone in a Telegram chat is told about a new message, so a mention is
    emphasis rather than the only route to a reader."""
    adapter = _adapter()

    assert adapter.notifies_only_by_mention is False
    assert adapter.separate_attention_slot is True
    assert adapter.separate_activity_log is False
    assert adapter.redraws_for_elapsed_time is False
    assert adapter.supports_activity_reactions is True
    assert adapter.activity_reactions_per_agent is False


# ── The body is HTML, and it carries the agent's name ────────────────────────


async def test_a_status_is_drawn_as_html_because_telegram_parses_no_markdown() -> None:
    """`**Working…**` would reach a reader as those four characters."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    text = _posted(adapter)["text"]
    assert _posted(adapter)["parse_mode"] == "HTML"
    assert "<b>" in text
    assert "**" not in text


async def test_every_publication_says_which_agent_it_is() -> None:
    """One bot posts for all of them, so the name in the body is the only thing
    telling two agents in a chat apart."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    assert "<b>my-agent</b>" in _posted(adapter)["text"]


async def test_a_redraw_still_names_the_agent_after_a_restart() -> None:
    """The name comes with the call, so nothing about a redraw depends on this
    process having been the one that posted."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    restarted = _adapter()
    await restarted.update_rich(CHANNEL, "my-agent", ref, _activity())

    assert "<b>my-agent</b>" in _edited(restarted)["text"]


async def test_a_card_prints_the_handle_it_answers_to_in_a_code_span() -> None:
    """A reader is meant to copy it, and Telegram makes a `<code>` span
    tap-to-copy — backticks would just be backticks."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    text = _posted(adapter)["text"]
    assert "request <code>R7</code>" in text
    assert "`R7`" not in text


async def test_a_console_deeplink_is_offered_as_text_rather_than_a_dead_link() -> None:
    """Telegram renders an anchor only for the schemes it knows. A
    `switchdash://` one is rejected outright or silently stripped of its
    address, so the address itself is shown instead."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        _activity(session_url="switchdash://session/abc"),
        None,
    )

    text = _posted(adapter)["text"]
    assert "<code>switchdash://session/abc</code>" in text
    assert "<a href" not in text


async def test_a_web_console_link_is_a_real_link() -> None:
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        _activity(session_url="https://switch.example/s/abc"),
        None,
    )

    assert '<a href="https://switch.example/s/abc">' in _posted(adapter)["text"]


# ── Naming the person who asked ──────────────────────────────────────────────


async def test_the_asker_is_mentioned_by_id_so_a_private_account_is_reached() -> None:
    """A bare `@handle` only notifies an account that has a public one;
    `tg://user?id=` notifies either way."""
    adapter = _adapter()
    adapter._user_names[ASKER_ID] = "alice"

    await adapter.post_rich(
        CHANNEL, "my-agent", await _card(notify_external_id=ASKER), None
    )

    text = _posted(adapter)["text"]
    assert f'<a href="tg://user?id={ASKER_ID}">@alice</a>' in text


async def test_an_account_this_bridge_has_never_seen_is_not_given_a_made_up_name() -> (
    None
):
    """A `tg://user` anchor needs visible text, and the only honest text is a
    name the account has actually used here. Nothing is lost by leaving it out:
    the chat is notified of the message regardless."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", await _card(notify_external_id=ASKER), None
    )

    text = _posted(adapter)["text"]
    assert "tg://user" not in text
    assert "@" not in text


async def test_a_redraw_does_not_repeat_the_mention() -> None:
    """An edit does not notify, so a handle added on every redraw is a handle
    that reaches nobody it has not already reached."""
    adapter = _adapter()
    adapter._user_names[ASKER_ID] = "alice"
    ref = await adapter.post_rich(
        CHANNEL, "my-agent", await _card(notify_external_id=ASKER), None
    )

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, await _card(notify_external_id=ASKER)
    )

    assert "tg://user" in _posted(adapter)["text"]
    assert "tg://user" not in _edited(adapter)["text"]


# ── A topic and a reply target are not the same thing ────────────────────────


async def test_a_card_in_a_forum_is_addressed_to_its_topic() -> None:
    """In a forum the root is the topic. Sent as a reply target instead, the
    card replies to whichever message happens to hold that number and lands in
    General the moment the topic's opening message is gone — which is the
    agent's question put to the whole group rather than to the people in it."""
    adapter = _adapter()
    _forum(adapter)

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), TOPIC_ID)

    assert _posted(adapter)["message_thread_id"] == int(TOPIC_ID)
    assert "reply_parameters" not in _posted(adapter)


async def test_a_card_in_an_ordinary_group_replies_to_what_was_asked() -> None:
    """Outside a forum Telegram has no thread, so the root is a message."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), TOPIC_ID)

    assert "message_thread_id" not in _posted(adapter)
    assert _posted(adapter)["reply_parameters"].message_id == int(TOPIC_ID)


async def test_the_chat_is_asked_once_rather_than_on_every_publication() -> None:
    adapter = _adapter()
    calls: list[Any] = []
    original = _bot(adapter).get_chat

    async def counted(chat_id: Any) -> Any:
        calls.append(chat_id)
        return await original(chat_id)

    _bot(adapter).get_chat = counted  # type: ignore[method-assign]

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), TOPIC_ID)
    await adapter.post_rich(CHANNEL, "my-agent", _activity(), TOPIC_ID)

    assert len(calls) == 1


async def test_a_chat_that_will_not_say_what_it_is_keeps_its_reservation() -> None:
    """Guessing would put a card in the wrong topic, and treating the lookup as
    a refusal would let the caller repost a question it may already have
    asked."""
    adapter = _adapter()

    async def refuse(chat_id: Any) -> Any:
        raise TimedOut()

    _bot(adapter).get_chat = refuse  # type: ignore[method-assign]

    with pytest.raises(TimedOut):
        await adapter.post_rich(CHANNEL, "my-agent", await _card(), TOPIC_ID)
    assert _bot(adapter).messages == []


# ── A send whose outcome is unknown ──────────────────────────────────────────


def test_telegram_says_it_cannot_find_a_card_again_rather_than_implying_it_might() -> (
    None
):
    """A bot cannot read a chat's history, so `find_request_card` has nowhere
    to look and always answers None. The flag is what tells the publisher that
    the None is permanent: waiting for a later lookup to succeed would keep a
    question in the chat that silently refuses the answer it asks for."""
    assert TelegramAdapter.recovers_uncertain_posts is False
    assert (
        TelegramAdapter.find_request_card is CollaborationAdapter.find_request_card  # noqa: E501 — the base's "nowhere to look"
    )


async def test_the_notice_pointing_at_console_is_sent_as_telegram_html() -> None:
    """The one message that goes out when a card cannot be confirmed.

    It is written as Switch Markdown by the publisher, like every other admin
    notice, so the link has to survive the conversion or it reaches the chat
    with its brackets showing on the one platform where the raw deeplink would
    not have been a link at all.
    """
    adapter = _adapter()

    await adapter.admin_message(
        CHANNEL,
        "Switch could not confirm that request **R1** reached this chat. "
        "Answer it in [Switch Console](https://switch.example/deeplink/session?x=1) "
        "instead.",
        TOPIC_ID,
    )

    sent = _bot(adapter).messages[0]["text"]
    assert "<b>R1</b>" in sent
    assert '<a href="https://switch.example/deeplink/session?x=1">' in sent
    assert "**" not in sent and "[" not in sent


# ── Failing loudly, and only where Telegram actually refused ─────────────────


async def test_a_refusal_is_reported_as_one_so_the_reservation_is_dropped() -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("chat not found")

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)


async def test_a_bad_request_is_a_refusal_even_though_it_is_a_network_error() -> None:
    """python-telegram-bot makes `BadRequest` a subclass of `NetworkError`. An
    uncertain-outcome branch written first would swallow every rejection
    Telegram actually made and hold the reservation open forever."""
    assert issubclass(BadRequest, NetworkError)
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("message text is empty")

    with pytest.raises(RichContentFailed) as caught:
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)
    assert not isinstance(caught.value, RichContentThrottled)


@pytest.mark.parametrize(
    "error",
    [Forbidden("bot was kicked"), ChatMigrated(new_chat_id=-100999)],
    ids=["forbidden", "migrated"],
)
async def test_the_other_definite_refusals_are_refusals_too(error: Exception) -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = error

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)


@pytest.mark.parametrize(
    "error",
    [TimedOut(), NetworkError("connection reset")],
    ids=["timeout", "network"],
)
async def test_an_unknown_outcome_keeps_its_reservation_by_raising_itself(
    error: Exception,
) -> None:
    """The send may have landed and the response been lost. Reported as a
    refusal, the caller would discard the reservation and ask again."""
    adapter = _adapter()
    _bot(adapter).send_message_error = error

    with pytest.raises(type(error)):
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)


async def test_a_failed_edit_is_reported_rather_than_logged_and_forgotten() -> None:
    """A card that failed to redraw is still showing a settled request as open,
    and the caller has a reply to post about that — but only if it is told."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)
    _bot(adapter).edit_error = BadRequest("message to edit not found")

    with pytest.raises(RichContentFailed):
        await adapter.update_rich(CHANNEL, "my-agent", ref, await _card())


async def test_an_edit_telegram_calls_unchanged_is_not_a_failure() -> None:
    """ "message is not modified" means the chat already shows what was asked
    for, which is the outcome the caller wanted."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)
    _bot(adapter).edit_error = BadRequest("Message is not modified")

    await adapter.update_rich(CHANNEL, "my-agent", ref, _ended())


async def test_a_publication_is_never_retried_as_stripped_plain_text() -> None:
    """`_send_chunk` does that for relayed host text, where losing the markup
    beats losing the message. Here the markup is Switch's own, and a silent
    downgrade would leave the publisher believing the card posted properly."""
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("can't parse entities")

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)
    assert _bot(adapter).messages == []


# ── Pacing, so a turn does not spend the chat's whole allowance ──────────────


async def test_being_rate_limited_says_how_long_to_wait() -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = RetryAfter(17)

    with pytest.raises(RichContentThrottled) as caught:
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)
    assert caught.value.retry_after == 17


async def test_a_429_pauses_the_whole_chat_rather_than_the_one_message() -> None:
    """Telegram charges the limit to the chat, so the next publication in it
    waits rather than discovering the same thing for itself."""
    adapter = _adapter()
    _bot(adapter).send_message_error = RetryAfter(17)
    with pytest.raises(RichContentThrottled):
        await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    with pytest.raises(RichContentThrottled):
        await adapter.post_rich(CHANNEL, "other-agent", await _card(), None)
    assert _bot(adapter).messages == []


async def test_progress_arriving_faster_than_the_chat_can_take_it_waits() -> None:
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    with pytest.raises(RichContentThrottled) as caught:
        await adapter.update_rich(CHANNEL, "my-agent", ref, _activity())
    assert 0 < caught.value.retry_after <= _REDRAW_INTERVAL
    assert _bot(adapter).edits == []


async def test_the_end_of_a_turn_is_never_held_back() -> None:
    """A reader waiting on the outcome is waiting on precisely the thing the
    pacing would delay."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, _ended())

    assert len(_bot(adapter).edits) == 1


async def test_a_problem_somebody_has_to_act_on_is_never_held_back() -> None:
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, _activity(error_summary="The agent went away.")
    )

    assert "went away" in _edited(adapter)["text"]


async def test_a_card_is_never_held_back() -> None:
    """A settled card showing as open is wrong in a way no reader can tell from
    a card that is simply slow."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, await _card())

    assert len(_bot(adapter).edits) == 1


# ── The working reaction ─────────────────────────────────────────────────────


async def test_one_mark_is_shared_between_agents_and_not_added_twice() -> None:
    """Every agent reacts through the one bot account, and Telegram allows it
    one reaction per message."""
    adapter = _adapter()

    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True
    )
    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="two", working=True
    )

    assert len(_bot(adapter).reactions) == 1


async def test_force_marks_again_because_the_record_may_be_empty_and_wrong() -> None:
    """After a restart this process knows nothing about what is already on the
    message, which is not the same as knowing there is nothing."""
    adapter = _adapter()

    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True, force=True
    )
    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True, force=True
    )

    assert len(_bot(adapter).reactions) == 2


async def test_a_transient_reaction_failure_raises_so_the_publisher_retries() -> None:
    """The publisher records the turn as drawn only once the chat shows what it
    says it shows."""
    adapter = _adapter()
    _bot(adapter).reaction_error = TimedOut()

    with pytest.raises(TimedOut):
        await adapter.mark_activity(
            CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True
        )


async def test_a_chat_with_reactions_off_is_not_retried_for_the_whole_turn(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Refused now is refused every time, so it is said once and the turn goes
    on without the mark."""
    adapter = _adapter()
    _bot(adapter).reaction_error = BadRequest("REACTION_INVALID")

    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True
    )

    assert any("without it" in record.message for record in caplog.records)


async def test_the_typing_nudge_is_sent_where_the_agent_was_asked() -> None:
    adapter = _adapter()

    await adapter.notify_working(CHANNEL, "my-agent", None)

    assert _bot(adapter).actions[0]["chat_id"] == CHAT_ID

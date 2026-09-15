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

from dataclasses import replace
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
    ActivityMarkRefused,
    CollaborationAdapter,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.form import (
    posted_form,
    resolve_pressed_position,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    parse_answer_position,
)
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    _REDRAW_INTERVAL,
    TelegramAdapter,
)
from switch_core.sessions.contract import ApprovalResult, Item

from .test_session_activity import _item, _turn
from .test_telegram_adapter import (
    CHAT_ID,
    _adapter,
    _bot,
    _FakeCallbackQuery,
    _FakeChat,
    _FakeSentMessage,
    _FakeUpdate,
    _FakeUser,
)

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"
QUESTIONS_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.questions.json"
)

CHANNEL = str(CHAT_ID)
TOPIC_ID = "88"
SESSION_URL = "https://console.example/sessions/session-demo"
ASKER_ID = 60606
ASKER = str(ASKER_ID)


def _activity(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn("running"), **kwargs)


def _ended(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Done.")]
    return TurnActivity(items, _turn("completed"), **kwargs)


def _tool(status: str) -> Item:
    return _item(itemId=f"item-{status}", title="Read the adapter", status=status)


def _running(*extra: Item) -> TurnActivity:
    """A turn mid-flight, with everything a status can draw from: a tool call
    in progress, a duration to count and a session to link to."""
    items = [_tool("in-progress"), *extra]
    return TurnActivity(
        items, _turn("running"), elapsed_seconds=12, session_url=SESSION_URL
    )


def _finished(*extra: Item) -> TurnActivity:
    items = [_tool("completed"), *extra]
    return TurnActivity(
        items, _turn("completed"), elapsed_seconds=42, session_url=SESSION_URL
    )


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
    await restarted.update_rich(CHANNEL, "my-agent", ref, _activity(), None)

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
        CHANNEL, "my-agent", ref, await _card(notify_external_id=ASKER), None
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


async def test_a_card_anchored_to_a_stored_message_reference_replies_to_it() -> None:
    """The form the publication seam actually passes, which is not the form
    inbound records.

    A card's root is resolved through the message map, and what that stores is
    this platform's own reference to a message — `chat:message`, the same
    string `post_rich` hands back. Read as a bare number it is not one, so
    every card raised in an ordinary Telegram chat was refused before it was
    drawn and only ever reached the Console.
    """
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), f"{CHANNEL}:75")

    params = _posted(adapter)["reply_parameters"]
    assert params.message_id == 75
    # A card that detaches is the agent's question put to the whole chat.
    assert params.allow_sending_without_reply is False


async def test_a_message_reference_in_a_forum_is_a_reply_rather_than_a_topic() -> None:
    """A composite reference names one message, so its number is a message id
    in a forum too. Passed as `message_thread_id` it would name whichever topic
    happens to hold that number — a different room of people."""
    adapter = _adapter()
    _forum(adapter)

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), f"{CHANNEL}:75")

    assert "message_thread_id" not in _posted(adapter)
    assert _posted(adapter)["reply_parameters"].message_id == 75


async def test_a_card_rooted_in_another_chat_is_refused() -> None:
    """Replying to message 75 of some other chat would either fail or quote
    this chat's message 75, which is a different conversation. Neither is the
    exchange that raised the request."""
    adapter = _adapter()

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", await _card(), "-1009999999:75")
    assert _bot(adapter).messages == []


async def test_a_root_that_names_no_number_at_all_is_still_refused() -> None:
    adapter = _adapter()

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", await _card(), "sw_abc123")
    assert _bot(adapter).messages == []


async def test_the_chat_is_asked_once_rather_than_on_every_publication() -> None:
    adapter = _adapter()
    calls: list[Any] = []
    original = _bot(adapter).get_chat

    async def counted(chat_id: Any) -> Any:
        calls.append(chat_id)
        return await original(chat_id)

    _bot(adapter).get_chat = counted  # type: ignore[method-assign]

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), TOPIC_ID)
    await adapter.post_rich(CHANNEL, "my-agent", await _card(), TOPIC_ID)

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
        await adapter.update_rich(CHANNEL, "my-agent", ref, await _card(), None)


async def test_an_edit_telegram_calls_unchanged_is_not_a_failure() -> None:
    """ "message is not modified" means the chat already shows what was asked
    for, which is the outcome the caller wanted."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)
    _bot(adapter).edit_error = BadRequest("Message is not modified")

    await adapter.update_rich(CHANNEL, "my-agent", ref, await _card(), None)


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
        await adapter.update_rich(CHANNEL, "my-agent", ref, _activity(), None)
    assert 0 < caught.value.retry_after <= _REDRAW_INTERVAL
    assert _bot(adapter).edits == []


async def test_the_end_of_a_turn_is_never_held_back() -> None:
    """A reader waiting on the outcome is waiting on precisely the thing the
    pacing would delay."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, _ended(), None)

    assert "Turn complete." in _edited(adapter)["text"]


async def test_a_problem_somebody_has_to_act_on_is_never_held_back() -> None:
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, _activity(error_summary="The agent went away."), None
    )

    assert "went away" in _edited(adapter)["text"]


async def test_a_card_is_never_held_back() -> None:
    """A settled card showing as open is wrong in a way no reader can tell from
    a card that is simply slow."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, await _card(), None)

    assert len(_bot(adapter).edits) == 1


async def test_two_agents_publishing_in_one_chat_share_its_budget() -> None:
    """Telegram's limits are the chat's, and so is the 429 that follows from
    overspending them. Metering each message on its own would let five agents
    in one group send five times what one agent can."""
    adapter = _adapter()
    await adapter.post_rich(CHANNEL, "one", _activity(), None)

    with pytest.raises(RichContentThrottled):
        await adapter.post_rich(CHANNEL, "two", _activity(), None)
    assert len(_bot(adapter).messages) == 1


async def test_one_agents_redraw_paces_the_next_agents() -> None:
    adapter = _adapter()
    await adapter.update_rich(CHANNEL, "one", f"{CHAT_ID}:11", _activity(), None)

    with pytest.raises(RichContentThrottled):
        await adapter.update_rich(CHANNEL, "two", f"{CHAT_ID}:12", _activity(), None)
    assert len(_bot(adapter).edits) == 1


async def test_another_chat_is_not_held_back_by_this_one() -> None:
    adapter = _adapter()
    await adapter.post_rich(CHANNEL, "one", _activity(), None)

    await adapter.post_rich("-1002000000002", "one", _activity(), None)

    assert len(_bot(adapter).messages) == 2


# ── A finished turn stays, as a line ─────────────────────────────────────────


async def test_a_finished_status_is_edited_to_its_final_state_and_left_there() -> None:
    """What a reader scrolling the chat wants from a turn that has ended is
    that it ran, how long it took and where to open it. Deleting the status
    left them with none of that."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, _finished(), None)

    text = _edited(adapter)["text"]
    assert _bot(adapter).deletes == []
    assert "Worked for 42s" in text
    assert f'<a href="{SESSION_URL}">' in text


async def test_a_finished_status_in_a_forum_topic_is_kept_the_same_way() -> None:
    """A topic is the conversation, and the record belongs in it."""
    adapter = _adapter()
    _forum(adapter)
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), TOPIC_ID)

    await adapter.update_rich(CHANNEL, "my-agent", ref, _finished(), TOPIC_ID)

    assert _bot(adapter).deletes == []
    assert "Worked for 42s" in _edited(adapter)["text"]


async def test_a_finished_status_stops_counting_and_drops_what_was_running() -> None:
    """The timer and the running marks are the parts that are wrong the moment
    the turn ends, and a retained status keeps showing whatever it last said."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)
    assert "Working…" in _bot(adapter).messages[0]["text"]

    await adapter.update_rich(CHANNEL, "my-agent", ref, _finished(), None)

    text = _edited(adapter)["text"]
    assert "Working…" not in text
    assert "running" not in text


async def test_a_telegram_status_never_names_the_tool_of_the_moment() -> None:
    """It is compact for the reason it used to be deleted: the chat is the
    conversation itself, so the status is a line and its link rather than a
    running commentary. What the turn is doing is in the Console."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _running(), None)

    text = _bot(adapter).messages[0]["text"]
    assert "Read the adapter" not in text
    assert "Now:" not in text and "Last:" not in text


async def test_a_call_that_failed_still_shows_on_a_finished_status() -> None:
    """Not chatter about progress. A turn whose total reads as a clean run,
    with a declined call inside it, is the status saying the wrong thing."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, _finished(_tool("failed")), None
    )

    assert "1 failed" in _edited(adapter)["text"]


async def test_a_finished_turn_that_still_has_a_problem_to_report_says_so() -> None:
    """The attention message outlives the turn that raised it: somebody has to
    act on it, and a turn ending is not that having happened."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, _ended(error_summary="The host went away."), None
    )

    assert "went away" in _edited(adapter)["text"]


async def test_nothing_this_bridge_publishes_is_ever_taken_down() -> None:
    """A status and a card are both the record of something that happened, and
    each says on its face what became of it."""
    adapter = _adapter()
    status = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)
    card = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    await adapter.update_rich(CHANNEL, "my-agent", status, _finished(), None)
    await adapter.update_rich(CHANNEL, "my-agent", card, await _card(), None)

    assert _bot(adapter).deletes == []


async def test_a_finished_status_is_still_redrawn_when_the_turn_says_more() -> None:
    """Nothing is retired, so a late revision of a turn that has ended reaches
    the chat rather than being dropped on the floor."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)
    await adapter.update_rich(CHANNEL, "my-agent", ref, _finished(), None)

    await adapter.update_rich(
        CHANNEL, "my-agent", ref, _finished(_tool("declined")), None
    )

    assert "1 declined" in _edited(adapter)["text"]


# ── Publications do not drift out of the conversation they belong to ─────────


async def test_a_publication_does_not_detach_from_a_reply_target_that_is_gone() -> None:
    """Detaching costs a relayed line its quote and nothing else. A card that
    detaches is the agent's question put to the whole chat instead of to the
    exchange that raised it, and an answer typed at it there binds a request
    those readers never saw."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), TOPIC_ID)

    parameters = _posted(adapter)["reply_parameters"]
    assert parameters.allow_sending_without_reply is False


async def test_a_relayed_message_still_detaches_rather_than_being_lost() -> None:
    """The same anchor, the opposite trade: this is conversation, and the chat
    is where it belongs either way."""
    adapter = _adapter()

    await adapter.send_message(CHANNEL, "my-agent", "Just saying.", TOPIC_ID)

    parameters = _bot(adapter).messages[0]["reply_parameters"]
    assert parameters.allow_sending_without_reply is True


async def test_a_root_that_is_not_an_id_refuses_the_publication() -> None:
    """Posting to the chat instead would be answering a question nobody there
    asked, and the publisher has a route for a destination it cannot reach."""
    adapter = _adapter()

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", await _card(), "topic-three")
    assert _bot(adapter).messages == []


# ── What the turn has been doing stays in the Console ────────────────────────


def _tools(count: int) -> TurnActivity:
    items = [
        _item(itemId=f"item-{index}", title=f"Read file {index}", status="completed")
        for index in range(count)
    ]
    return TurnActivity(items, _turn("running"))


async def test_the_tool_log_is_not_drawn_into_the_chat_at_all() -> None:
    """A status that stays needs to be worth keeping. Nine tool titles folded
    into it is a running commentary on a turn the reader can open in the
    Console, sitting permanently in the conversation."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _tools(9), None)

    text = _posted(adapter)["text"]
    assert "Read file" not in text
    assert "<blockquote" not in text
    assert len(_bot(adapter).messages) == 1


async def test_the_status_still_says_how_the_calls_went() -> None:
    """Dropping the log is not dropping the outcome: nine done is one short
    line, and it is the part a reader cannot get from the duration."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _tools(9), None)

    assert "9 done" in _posted(adapter)["text"]


async def test_a_tool_title_cannot_reach_the_chat_as_markup() -> None:
    """Nothing draws it today, and a title is host text whatever draws it
    next."""
    adapter = _adapter()
    content = TurnActivity(
        [_item(title="<b>everything below is mine</b>")],
        _turn("running"),
    )

    await adapter.post_rich(CHANNEL, "my-agent", content, None)

    assert "everything below is mine" not in _posted(adapter)["text"]


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


async def test_a_chat_with_reactions_off_says_so_rather_than_swallowing_it() -> None:
    """Refused now is refused every time, and the adapter says which kind of
    failure that is. What it means for the turn is the publisher's to decide."""
    adapter = _adapter()
    _bot(adapter).reaction_error = BadRequest("REACTION_INVALID")

    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True
        )


async def test_a_refused_removal_is_reported_whatever_this_process_remembers() -> None:
    """The adapter does not decide whether a mark is outstanding.

    It used to, by looking in a set that a restart empties — so after one, a
    refused removal looked like nothing to remove. Both of these refuse
    identically now; the difference is the durable record's to know, and
    `test_activity_durability` is where that is pinned.
    """
    adapter = _adapter()
    await adapter.mark_activity(
        CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=True
    )
    _bot(adapter).reaction_error = Forbidden("the bot may no longer react here")

    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=False
        )

    fresh = _adapter()
    _bot(fresh).reaction_error = Forbidden("the bot may no longer react here")

    with pytest.raises(ActivityMarkRefused):
        await fresh.mark_activity(
            CHANNEL, f"{CHAT_ID}:55", agent_name="one", working=False, force=True
        )


async def test_the_typing_nudge_is_sent_where_the_agent_was_asked() -> None:
    adapter = _adapter()

    await adapter.notify_working(CHANNEL, "my-agent", None)

    assert _bot(adapter).actions[0]["chat_id"] == CHAT_ID


async def test_the_typing_nudge_stays_in_the_topic_it_was_asked_in() -> None:
    """People reading one forum topic do not see another's, so a nudge sent to
    the chat is a nudge sent to the wrong room."""
    adapter = _adapter()
    _forum(adapter)

    await adapter.notify_working(CHANNEL, "my-agent", TOPIC_ID)

    assert _bot(adapter).actions[0]["message_thread_id"] == int(TOPIC_ID)


async def test_a_reply_target_is_not_sent_as_though_it_were_a_topic() -> None:
    """Outside a forum the root is a message. Passed as a topic id it names
    whichever topic happens to hold that number, or none at all."""
    adapter = _adapter()

    await adapter.notify_working(CHANNEL, "my-agent", TOPIC_ID)

    assert "message_thread_id" not in _bot(adapter).actions[0]


# ── The card's buttons, and the press that comes back ────────────────────────


def _keyboard(markup: Any) -> list[tuple[str, str]]:
    """Every button on a message, as the label and the payload it carries."""
    if markup is None:
        return []
    return [
        (button.text, button.callback_data)
        for row in markup.inline_keyboard
        for button in row
    ]


async def _press(
    adapter: TelegramAdapter, data: str, **overrides: Any
) -> list[InboundInteraction]:
    """Drive a press from the update Telegram would deliver."""
    seen: list[InboundInteraction] = []

    async def record(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(record)
    await adapter._handle_update(
        _FakeUpdate(callback_query=_FakeCallbackQuery(data=data, **overrides))
    )
    return seen


async def test_an_open_card_offers_a_button_for_every_option_it_lists() -> None:
    """Numbered the way the body numbers them, so pressing and typing agree."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    assert _keyboard(_posted(adapter)["reply_markup"]) == [
        ("1. Allow once", "sw:tok-1:1"),
        ("2. Deny", "sw:tok-1:2"),
    ]


async def test_a_press_carries_the_request_and_where_the_control_was() -> None:
    """And nothing else. The option's own id never goes into the payload: it
    is unbounded text the host chose, and 64 bytes is the whole budget."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    payloads = [data for _, data in _keyboard(_posted(adapter)["reply_markup"])]
    assert all(len(data.encode()) <= 64 for data in payloads)
    assert not any("allow-once" in data or "deny" in data for data in payloads)


async def test_a_press_payload_stays_inside_the_limit_on_a_wordy_card() -> None:
    """The budget is bytes, not characters, and a label is host text in any
    script. What the button carries is bounded by the token and a count, so
    neither the label nor the option id can push it over."""
    adapter = _adapter()
    card = await _card()
    wordy = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={
                    "options": [
                        option.model_copy(
                            update={
                                "option_id": f"опция-{index}-{'x' * 200}",
                                "label": f"Разрешить однократно {'ё' * 100}",
                            }
                        )
                        for index, option in enumerate(card.request.content.options)
                    ]
                }
            )
        }
    )

    await adapter.post_rich(CHANNEL, "my-agent", replace(card, request=wordy), None)

    buttons = _keyboard(_posted(adapter)["reply_markup"])
    assert [data for _, data in buttons] == ["sw:tok-1:1", "sw:tok-1:2"]
    assert all(len(data.encode()) <= 64 for _, data in buttons)
    assert all(len(label) <= 52 for label, _ in buttons)


async def test_a_press_that_would_not_fit_is_refused_rather_than_truncated() -> None:
    """A token this long is not something Switch mints, so it is a change
    somewhere upstream — and a cut payload resolves to another request or to
    none, which is the one outcome worse than not posting the card."""
    adapter = _adapter()
    card = await _card()
    oversized = RequestCard(card.request, RequestReference(token="t" * 64, handle="R7"))

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHANNEL, "my-agent", oversized, None)


async def test_a_settled_card_is_redrawn_without_its_buttons() -> None:
    """An edit carries the whole keyboard, so a redraw with none takes them
    off — a settled request must not still be offering an answer."""
    adapter = _adapter()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, "my-agent", card, None)

    settled = replace(
        card, request=card.request.model_copy(update={"state": "resolved"})
    )
    await adapter.update_rich(CHANNEL, "my-agent", ref, settled, None)

    assert _keyboard(_posted(adapter)["reply_markup"]) != []
    assert _edited(adapter)["reply_markup"] is None


async def test_a_card_that_cannot_be_answered_here_offers_nothing_to_press() -> None:
    """It says why in its own words. A live button under that sentence is an
    invitation to the refusal it just explained."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        await _card(unavailable_reason="Answer this one in the Console."),
        None,
    )

    assert _posted(adapter)["reply_markup"] is None


async def _clipped_detail(**kwargs: Any) -> RequestCard:
    """A card whose decision text is longer than a Telegram message can hold."""
    card = await _card(**kwargs)
    return replace(
        card,
        request=card.request.model_copy(
            update={
                "content": card.request.content.model_copy(
                    update={"detail": "Deletes the production volume. " * 200}
                )
            }
        ),
    )


async def test_a_card_that_could_not_show_its_decision_offers_nothing_to_press() -> (
    None
):
    """The body says it is too long to answer here — and a button beside that
    sentence answers it anyway. The press would resolve against the saved form
    and settle the request on text the reader never saw."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _clipped_detail(), None)

    assert "cannot be answered from this message" in _posted(adapter)["text"]
    assert _posted(adapter)["reply_markup"] is None


async def test_a_card_whose_options_did_not_all_fit_offers_nothing_to_press() -> None:
    """Each option is faithful on its own and there is no room for them all.
    A keyboard here would offer a choice against a list the reader can only
    see part of, which is the same defect reached by the other door."""
    adapter = _adapter()
    card = await _card()
    crowded = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={
                    "options": [
                        card.request.content.options[0].model_copy(
                            update={
                                "option_id": f"option-{index}",
                                "label": f"Option {index}: " + "a" * 1000,
                            }
                        )
                        for index in range(10)
                    ]
                }
            )
        }
    )

    await adapter.post_rich(CHANNEL, "my-agent", replace(card, request=crowded), None)

    assert "more not shown" in _posted(adapter)["text"]
    assert _posted(adapter)["reply_markup"] is None


async def test_a_redraw_takes_the_buttons_off_a_card_that_stopped_fitting() -> None:
    """The same rule on the edit path. A card that grew past what one message
    can show keeps its keyboard otherwise, because an edit carries the whole
    of it and a redraw that says nothing about controls leaves them live."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, await _clipped_detail(), None)

    assert _keyboard(_posted(adapter)["reply_markup"]) != []
    assert _edited(adapter)["reply_markup"] is None


async def test_a_status_has_nothing_to_press() -> None:
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), None)

    assert _posted(adapter)["reply_markup"] is None


async def test_the_card_and_the_press_agree_on_the_option() -> None:
    """The loop: the adapter draws the control, Telegram hands the payload
    back, and the record turns it into the option the reader pressed."""
    adapter = _adapter()
    card = await _card()
    await adapter.post_rich(CHANNEL, "my-agent", card, None)
    _, deny = _keyboard(_posted(adapter)["reply_markup"])

    interaction = (await _press(adapter, deny[1]))[0]

    assert interaction.value == card.reference.token
    answer = resolve_pressed_position(
        posted_form(card.request),
        parse_answer_position(interaction.action_id) or 0,
    )
    assert answer == ApprovalResult(kind="approval", option_id="deny")


async def test_a_press_is_attributed_to_the_account_that_sent_it() -> None:
    """Telegram fills in who pressed; the payload says only which request and
    which control. An id in the data would be a claim rather than a sender."""
    adapter = _adapter()

    interaction = (
        await _press(
            adapter,
            "sw:tok-1:2",
            from_user=_FakeUser(user_id=ASKER_ID, username="asker"),
            message=_FakeSentMessage(_FakeChat(), 404),
        )
    )[0]

    assert interaction.sender_id == ASKER
    assert interaction.sender_name == "asker"
    assert interaction.channel_id == CHANNEL
    assert interaction.message_ref == f"{CHAT_ID}:404"
    assert interaction.action_id.endswith(":2")


async def test_a_press_on_a_keyboard_we_did_not_write_is_closed_and_ignored() -> None:
    """Another bot's buttons in the same chat. The press is still answered:
    an unanswered one spins on the presser's client until it gives up."""
    adapter = _adapter()

    for data in ("", "other-app:go", "sw:tok-1:0", "sw:tok-1:x", "sw:tok-1", "sw::1"):
        assert await _press(adapter, data) == []

    assert len(_bot(adapter).answers) == 6
    assert {answer["text"] for answer in _bot(adapter).answers} == {None}


async def test_a_press_whose_handling_fails_still_closes_the_press() -> None:
    """The failure belongs in the log, not on a button that never stops
    loading."""
    adapter = _adapter()

    async def explode(_interaction: InboundInteraction) -> None:
        raise RuntimeError("the room went away")

    adapter.set_interaction_handler(explode)

    with pytest.raises(RuntimeError):
        await adapter._handle_update(
            _FakeUpdate(callback_query=_FakeCallbackQuery(data="sw:tok-1:1"))
        )

    assert len(_bot(adapter).answers) == 1


async def test_a_refused_press_is_told_to_the_presser_and_to_nobody_else() -> None:
    """Telegram's reply to a press is an alert on that person's client. The
    chat is not told that somebody's answer did not land."""
    adapter = _adapter()

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "Your answer to R7 did not land, because that card is no longer open.",
        )

    adapter.set_interaction_handler(refuse)
    await adapter._handle_update(
        _FakeUpdate(callback_query=_FakeCallbackQuery(data="sw:tok-1:1"))
    )

    answer = _bot(adapter).answers[0]
    assert answer["callback_query_id"] == "cq-1"
    assert answer["show_alert"] is True
    assert "no longer open" in answer["text"]
    assert _bot(adapter).messages == []


async def test_a_notice_longer_than_telegram_shows_is_cut_rather_than_dropped() -> None:
    adapter = _adapter()

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id, interaction.sender_id, "someone", None, "why " * 100
        )

    adapter.set_interaction_handler(refuse)
    await adapter._handle_update(
        _FakeUpdate(callback_query=_FakeCallbackQuery(data="sw:tok-1:1"))
    )

    text = _bot(adapter).answers[0]["text"]
    assert len(text) == 200
    assert text.startswith("why why")
    assert text.endswith("…")


async def test_a_press_taken_without_a_refusal_claims_nothing() -> None:
    """The card's redraw is what says an answer was taken. Saying so here
    would be saying it before the redraw that proves it."""
    adapter = _adapter()

    await _press(adapter, "sw:tok-1:1")

    assert _bot(adapter).answers[0]["text"] is None
    assert _bot(adapter).answers[0]["show_alert"] is False


async def test_a_typed_answers_refusal_is_still_said_in_the_cards_thread() -> None:
    """There is no press to reply to, and a bot cannot message someone who has
    never opened a chat with it, so the thread is what is left."""
    adapter = _adapter()

    await adapter.tell_actor(CHANNEL, ASKER, "asker", f"{CHAT_ID}:99", "Not this one.")

    assert "Not this one." in _bot(adapter).messages[0]["text"]


async def test_telegram_refusing_the_acknowledgement_is_logged_and_left(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The query expires on its own and the answer it acknowledged is already
    decided, so this must not cost the room the press."""
    adapter = _adapter()
    _bot(adapter).answer_error = BadRequest("query is too old")

    with caplog.at_level("WARNING"):
        assert len(await _press(adapter, "sw:tok-1:1")) == 1

    assert any("would not acknowledge" in record.message for record in caplog.records)


async def _asked(request_id: str) -> RequestCard:
    """A card for one of the recorded question forms."""
    source = FixtureEventSource.from_examples(QUESTIONS_PATH, events=[])
    projection = await project(source, "session-questions")
    request = next(
        one for one in projection.snapshot.requests if one.request_id == request_id
    )
    return RequestCard(request, RequestReference(token="tok-1", handle="R43"))


async def test_one_question_with_one_choice_to_make_is_pressable() -> None:
    """The one form a press finishes, so the one form that gets buttons."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _asked("request-one"), None)

    assert _keyboard(_posted(adapter)["reply_markup"]) == [
        ("1. Staging", "sw:tok-1:1"),
        ("2. Production", "sw:tok-1:2"),
    ]


async def test_a_form_no_single_press_can_finish_is_answered_in_words() -> None:
    """Three questions, and one press is one option. Buttons here would submit
    whichever part was pressed last as though it were the whole answer."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _asked("request-form"), None)

    assert _posted(adapter)["reply_markup"] is None
    assert "R43" in _posted(adapter)["text"]

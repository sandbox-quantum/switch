"""Teams publishes SDK sessions, and the legacy renderer no longer runs.

What is under test here is the rich-content seam on the platform whose edits
are addressed to a *conversation* rather than to a message: the compact status
and the request card drawn inside the agent's Adaptive Card, addressed from the
thread the caller kept rather than from a map a restart empties, retired
according to what a deletion leaves behind in each of Teams' two channel
layouts, and truthful about which failures mean "nothing was written".

There is no longer a second renderer anywhere to fall back to, so what the
publication draws is the whole of what a post sees of a turn.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.teams import adapter as teams_adapter
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    _publication_ref,
)
from switch_core.bridges.collaboration.teams.connector import (
    BotConnectorConflict,
    BotConnectorGone,
    BotConnectorRefused,
    BotConnectorThrottled,
    BotConnectorUnavailable,
)

from .test_session_activity import _item, _turn
from .test_teams_adapter import _adapter, _card_text, _run

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

CHANNEL = "19:abc@thread.tacv2"
CHAT = "a:1chat"
ROOT = "post-root-1"
AGENT = "my-agent"
SERVICE_URL = "https://smba.example/amer/"
RUNNING_LINE = "Reading the adapter"
ENDED_LINE = "Turn complete."


class _Connector:
    """Records what reached the wire, and can be told to fail on command."""

    def __init__(self) -> None:
        self.threads: list[dict[str, Any]] = []
        self.sends: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.fail_send: Exception | None = None
        self.fail_update: Exception | None = None
        self.fail_delete: Exception | None = None
        # What a create answers with. Teams is entitled to name the
        # conversation itself rather than after the post it opened.
        self.conversation: str | None = None

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        if self.fail_send is not None:
            raise self.fail_send
        self.threads.append(
            {
                "channel_id": channel_id,
                "activity": activity,
                "service_url": service_url,
            }
        )
        return (self.conversation or f"{channel_id};messageid={ROOT}", ROOT)

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        if self.fail_send is not None:
            raise self.fail_send
        self.sends.append(
            {
                "conversation_id": conversation_id,
                "activity": activity,
                "service_url": service_url,
            }
        )
        return "MSG1"

    async def send_signal(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> None:
        self.sends.append({"conversation_id": conversation_id, "activity": activity})

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        if self.fail_update is not None:
            raise self.fail_update
        self.updates.append(
            {
                "conversation_id": conversation_id,
                "activity_id": activity_id,
                "activity": activity,
                "service_url": service_url,
            }
        )

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        if self.fail_delete is not None:
            raise self.fail_delete
        self.deletes.append(
            {
                "conversation_id": conversation_id,
                "activity_id": activity_id,
                "service_url": service_url,
            }
        )


def _teams(
    layout: str = "post", *, chat: bool = False
) -> tuple[TeamsAdapter, _Connector]:
    adapter = _adapter()
    connector = _Connector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = SERVICE_URL
    if chat:
        adapter._channel_type[CHAT] = "direct"
    else:
        adapter._channel_type[CHANNEL] = "channel_public"
        adapter._channel_layouts[CHANNEL] = layout
    return adapter, connector


def _restart(adapter: TeamsAdapter) -> None:
    """Everything this process learned about a conversation, gone.

    What a restart leaves is what was written down — the publication reference
    the caller stored — and nothing else. `_channel_type` emptying is the one
    that bit: an id it has not heard of reads as a channel, so a chat came back
    as a post inside itself.
    """
    adapter._sent.clear()
    adapter._channel_type.clear()
    adapter._channel_layouts.clear()
    adapter._last_post.clear()
    adapter._service_url.clear()


def _activity(**kwargs: Any) -> TurnActivity:
    items = [_item(status="in-progress", title=RUNNING_LINE)]
    return TurnActivity(items, _turn("running"), **kwargs)


def _ended(**kwargs: Any) -> TurnActivity:
    return TurnActivity([_item()], _turn("completed"), **kwargs)


async def _card(**kwargs: Any) -> RequestCard:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, "session-demo")
    request = projection.open_requests()[0]
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"), **kwargs)


# ── The publication is the only account of the turn ──────────────────────────


def test_the_publication_is_the_only_account_of_a_turn() -> None:
    """There is no second renderer to fall back to, and `bridge_core` reads
    this flag to decide whether to route sessions here at all — so a platform
    that stopped declaring it would go quiet rather than draw the turn some
    other way."""
    adapter, _ = _teams()

    assert adapter.publishes_sdk_sessions is True


def test_teams_reaches_a_reader_by_naming_them_and_in_no_other_way() -> None:
    """A reply inside a post is read by whoever is already following it."""
    adapter, _ = _teams()

    assert adapter.notifies_only_by_mention is True
    assert adapter.separate_attention_slot is True
    assert adapter.separate_activity_log is False
    assert adapter.redraws_for_elapsed_time is False
    # The Bot Connector gives a bot no way to react to a message at all.
    assert adapter.supports_activity_reactions is False


def test_an_uncertain_publication_can_never_be_found_again() -> None:
    """App-only Graph, channel-scoped consent, no message listing and no marker
    on a publication: a search has nowhere to look and nothing to match."""
    adapter, _ = _teams()

    assert adapter.recovers_uncertain_posts is False
    assert adapter.carries_publication_marker is False


# ── One card, no bare text beside it ─────────────────────────────────────────


def test_a_status_is_drawn_inside_the_agents_card() -> None:
    """Teams shows one or the other, never both, so a body split across the
    activity text and an attachment loses half of itself."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    activity = connector.sends[0]["activity"]
    assert "text" not in activity
    assert len(activity["attachments"]) == 1
    assert RUNNING_LINE in _card_text(activity)


def test_the_preview_text_says_what_the_card_says() -> None:
    """Without `summary` Teams shows "cards.unsupported" in a toast, and
    without `fallbackText` it shows it wherever the card cannot render."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    activity = connector.sends[0]["activity"]
    assert RUNNING_LINE in activity["summary"]
    assert RUNNING_LINE in activity["attachments"][0]["content"]["fallbackText"]


def test_a_handle_is_not_drawn_with_backticks_teams_would_show_verbatim() -> None:
    """A TextBlock renders no code span, so `R7` arrives with the backticks on
    it — and the handle is the one thing on the card somebody has to type."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _run(_card()), ROOT))

    body = _card_text(connector.sends[0]["activity"])
    assert "R7" in body
    assert "`" not in body


# ── Where a publication goes, and where a redraw finds it ────────────────────


def test_a_publication_with_no_thread_opens_its_own_post() -> None:
    adapter, connector = _teams()

    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), None))

    assert ref == _publication_ref(SERVICE_URL, f"{CHANNEL};messageid={ROOT}", ROOT)
    assert [t["channel_id"] for t in connector.threads] == [CHANNEL]


def test_a_publication_ignores_the_post_the_relay_last_spoke_in() -> None:
    """`_last_post` is the relay's guess at where an untied reply belongs, and
    it crosses conversations whenever two run in one channel. A publication has
    a durable address to keep, so it opens its own post instead."""
    adapter, connector = _teams()
    adapter._last_post[CHANNEL] = "somebody-elses-post"

    _run(adapter.post_rich(CHANNEL, AGENT, _activity(), None))

    assert connector.sends == []
    assert [t["channel_id"] for t in connector.threads] == [CHANNEL]


def test_a_redraw_is_addressed_by_the_thread_it_was_given() -> None:
    adapter, connector = _teams()

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))

    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"
    assert connector.updates[0]["activity_id"] == "MSG1"


def test_a_redraw_survives_the_restart_that_empties_the_sent_map() -> None:
    """The address used to come from `_sent`, which a process holds and a
    restart drops. A status posted before the restart was then addressed as its
    own thread root — a conversation that does not exist — and every remaining
    edit of that turn was refused."""
    adapter, connector = _teams()
    assert adapter._sent == {}

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))

    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"


def test_a_publication_that_is_its_own_post_is_addressed_by_itself() -> None:
    adapter, connector = _teams()

    _run(adapter.update_rich(CHANNEL, AGENT, ROOT, _activity(), None))

    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"


def test_a_chat_is_its_own_conversation() -> None:
    adapter, connector = _teams(chat=True)

    _run(adapter.post_rich(CHAT, AGENT, _activity(), None))
    _run(adapter.update_rich(CHAT, AGENT, "MSG1", _activity(), None))

    assert connector.sends[0]["conversation_id"] == CHAT
    assert connector.updates[0]["conversation_id"] == CHAT


def test_a_redraw_rebuilds_the_card_rather_than_replacing_it_with_text() -> None:
    """`update_message` sends a bare text activity, which would strip the
    agent's name and avatar off the status halfway through the turn."""
    adapter, connector = _teams()

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))

    activity = connector.updates[0]["activity"]
    assert "text" not in activity
    assert activity["attachments"][0]["content"]["type"] == "AdaptiveCard"


def test_a_redraw_does_not_repeat_the_mention_the_post_already_made() -> None:
    """An edit notifies nobody, so the handle would be a name in the post that
    never reaches anyone it has not already reached."""
    adapter, connector = _teams()
    adapter.prime_mention_targets({"ada": "aad-ada"})
    adapter._sender_handles["aad-ada"] = "ada"

    _run(
        adapter.post_rich(CHANNEL, AGENT, _activity(notify_external_id="aad-ada"), ROOT)
    )
    _run(
        adapter.update_rich(
            CHANNEL, AGENT, "MSG1", _activity(notify_external_id="aad-ada"), ROOT
        )
    )

    assert "<at>ada</at>" in _card_text(connector.sends[0]["activity"])
    assert "<at>ada</at>" not in _card_text(connector.updates[0]["activity"])


def test_a_mention_carries_the_entity_that_makes_it_reach_anybody() -> None:
    """Markup with no entity is inert text, and Teams rejects neither."""
    adapter, connector = _teams()
    adapter.prime_mention_targets({"ada": "aad-ada"})
    adapter._sender_handles["aad-ada"] = "ada"

    _run(
        adapter.post_rich(CHANNEL, AGENT, _activity(notify_external_id="aad-ada"), ROOT)
    )

    card = connector.sends[0]["activity"]["attachments"][0]["content"]
    assert card["msteams"]["entities"][0]["mentioned"]["id"] == "aad-ada"


def test_a_person_this_bridge_holds_no_name_for_is_not_half_mentioned() -> None:
    adapter, connector = _teams()

    _run(
        adapter.post_rich(
            CHANNEL, AGENT, _activity(notify_external_id="aad-stranger"), ROOT
        )
    )

    activity = connector.sends[0]["activity"]
    assert "<at>" not in _card_text(activity)
    assert "msteams" not in activity["attachments"][0]["content"]


# ── Which failures mean "nothing was written" ────────────────────────────────


def test_a_refusal_is_reported_as_one_so_the_reservation_can_go() -> None:
    adapter, connector = _teams()
    connector.fail_send = BotConnectorGone("gone", status=404, retry_after=None)

    with pytest.raises(RichContentFailed) as raised:
        _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    assert RUNNING_LINE in raised.value.text


def test_an_unknown_outcome_is_not_reported_as_a_refusal() -> None:
    """The message may be sitting in the post already. Calling this a refusal
    releases the reservation, and the next cycle posts a second copy."""
    adapter, connector = _teams()
    connector.fail_send = BotConnectorUnavailable(
        "timeout", status=None, retry_after=None
    )

    with pytest.raises(BotConnectorUnavailable):
        _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))


def test_throttling_carries_the_wait_teams_asked_for() -> None:
    adapter, connector = _teams()
    connector.fail_send = BotConnectorThrottled(
        "slow down", status=429, retry_after=12.0
    )

    with pytest.raises(RichContentThrottled) as raised:
        _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    assert raised.value.retry_after == 12.0


def test_throttling_with_no_stated_wait_still_backs_off() -> None:
    adapter, connector = _teams()
    connector.fail_send = BotConnectorThrottled(
        "slow down", status=429, retry_after=None
    )

    with pytest.raises(RichContentThrottled) as raised:
        _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    assert raised.value.retry_after > 0


def test_a_refused_edit_is_reported_rather_than_logged_and_forgotten() -> None:
    """A card that failed to redraw is still offering a settled request, and
    the caller has a reply to post about it — but only if it is told."""
    adapter, connector = _teams()
    connector.fail_update = BotConnectorGone("gone", status=404, retry_after=None)

    with pytest.raises(RichContentFailed):
        _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))


# ── A finished status stays, in both layouts ─────────────────────────────────


def test_a_finished_status_is_edited_to_its_final_state_in_a_posts_channel() -> None:
    """Teams substitutes "This message has been deleted." and keeps it in the
    post, so deleting would leave one tombstone per turn per agent."""
    adapter, connector = _teams("post")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.deletes == []
    assert ENDED_LINE in _card_text(connector.updates[0]["activity"])


def test_a_chat_layout_channel_keeps_the_finished_status_too() -> None:
    """A bot's own message goes from a chat-layout channel without trace, which
    is why the status used to be deleted there. What went with it was the
    record of the turn: that it ran, how long it took, and the link to open
    it."""
    adapter, connector = _teams("chat")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.deletes == []
    assert connector.updates[0]["activity_id"] == "MSG1"
    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"
    assert ENDED_LINE in _card_text(connector.updates[0]["activity"])


def test_a_chat_keeps_it_as_well() -> None:
    adapter, connector = _teams(chat=True)

    _run(adapter.update_rich(CHAT, AGENT, "MSG1", _ended(), None))

    assert connector.deletes == []
    assert connector.updates[0]["conversation_id"] == CHAT


def test_a_request_card_is_never_taken_down() -> None:
    """It is the record of a decision and says on its face what became of it."""
    adapter, connector = _teams("chat")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _run(_card()), ROOT))

    assert connector.deletes == []
    assert len(connector.updates) == 1


def test_a_status_still_reporting_a_problem_outlives_its_turn() -> None:
    adapter, connector = _teams("chat")

    _run(
        adapter.update_rich(
            CHANNEL, AGENT, "MSG1", _ended(error_summary="Disk full."), ROOT
        )
    )

    assert connector.deletes == []
    assert "Disk full." in _card_text(connector.updates[0]["activity"])


def test_a_finished_status_is_still_redrawn_when_the_turn_says_more() -> None:
    """Nothing is retired, so a late revision of a turn that has ended reaches
    the conversation rather than being dropped on the floor."""
    adapter, connector = _teams("chat")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))
    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.deletes == []
    assert len(connector.updates) == 2


# ── The address Teams confirmed is the one kept ──────────────────────────────


def test_the_conversation_the_server_returned_is_the_one_edited() -> None:
    """Teams may name the conversation itself rather than after the post it
    opened. Rebuilding `channel;messageid=root` then edits somewhere else."""
    adapter, connector = _teams()
    connector.conversation = "19:opaque-conversation@thread.tacv2"

    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), None))
    _run(adapter.update_rich(CHANNEL, AGENT, ref, _activity(), None))

    assert connector.updates[0]["conversation_id"] == connector.conversation


def test_a_publication_into_a_carried_reference_keeps_its_region() -> None:
    """The reference names a conversation *and* the service holding it. Taking
    the conversation from it and the region from whatever this process last
    heard from sends the card to the wrong region — and writes that region into
    the reference it returns, so every later redraw repeats it."""
    adapter, connector = _teams()
    adapter._default_service_url = "https://smba.example/other-region/"
    carried = _publication_ref(SERVICE_URL, "19:confirmed@thread.tacv2", "card-1")

    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), carried))

    assert connector.sends[0]["service_url"] == SERVICE_URL
    assert connector.sends[0]["conversation_id"] == "19:confirmed@thread.tacv2"
    assert ref.startswith(
        _publication_ref(SERVICE_URL, "19:confirmed@thread.tacv2", "")
    )


def test_a_notice_about_a_card_goes_to_the_address_teams_confirmed() -> None:
    """A row can hold both a raw thread root and the reference Teams gave back.
    The edit already used the reference; the notice about that edit failing was
    still rebuilding `channel;messageid=root` in the current default region, so
    the correction could land somewhere the card is not."""
    adapter, _connector = _teams()
    carried = _publication_ref(SERVICE_URL, "19:confirmed@thread.tacv2", "card-1")

    assert adapter.notice_address(carried, ROOT) == carried
    assert adapter.notice_address("MSG1", ROOT) == ROOT
    assert adapter.notice_address("MSG1", None) == "MSG1"

    connector = _Connector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example/other-region/"
    connector.fail_update = BotConnectorRefused("no edit", status=403, retry_after=None)
    request = _run(_card()).request
    post = SimpleNamespace(
        token="tok",
        handle="R7",
        external_channel_id=CHANNEL,
        external_post_id=carried,
        thread_id=ROOT,
        request_id=request.request_id,
    )
    cards = SessionRequestCards(
        adapter,
        bridge_id="bridge-1",
        surface="teams",
        posts=None,  # type: ignore[arg-type]
        session_factory=None,  # type: ignore[arg-type]
    )

    with pytest.raises(RichContentFailed):
        _run(cards.refresh(post, request, agent_name=AGENT))  # type: ignore[arg-type]

    assert connector.sends[0]["service_url"] == SERVICE_URL
    assert connector.sends[0]["conversation_id"] == "19:confirmed@thread.tacv2"


def test_a_chat_redraw_after_a_restart_does_not_become_a_channel_thread() -> None:
    """`_channel_type` empties on restart and an unknown id reads as a channel,
    so a chat's card was edited at `chat;messageid=card` — a conversation that
    does not exist, and every later edit of that card was refused."""
    adapter, connector = _teams(chat=True)
    ref = _run(adapter.post_rich(CHAT, AGENT, _activity(), None))

    _restart(adapter)
    _run(adapter.update_rich(CHAT, AGENT, ref, _activity(), None))

    assert connector.updates[0]["conversation_id"] == CHAT


def test_a_chat_status_reaches_its_final_state_after_a_restart() -> None:
    """The last redraw of a turn is the one that matters most, and a restart in
    the middle of a turn is when the address is rebuilt rather than recalled."""
    adapter, connector = _teams(chat=True)
    ref = _run(adapter.post_rich(CHAT, AGENT, _activity(), None))

    _restart(adapter)
    _run(adapter.update_rich(CHAT, AGENT, ref, _ended(), None))

    assert connector.deletes == []
    assert connector.updates[0]["conversation_id"] == CHAT
    assert ENDED_LINE in _card_text(connector.updates[0]["activity"])


def test_a_channel_reply_is_redrawn_in_its_post_after_a_restart() -> None:
    adapter, connector = _teams()
    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    _restart(adapter)
    _run(adapter.update_rich(CHANNEL, AGENT, ref, _activity(), ROOT))

    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"
    assert connector.updates[0]["activity_id"] == "MSG1"


def test_a_publications_own_region_is_the_one_it_is_edited_in() -> None:
    """The service URL is regional and learned from inbound traffic. A process
    that has since heard from one other region sent the edit there instead."""
    adapter, connector = _teams()
    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    _restart(adapter)
    adapter._default_service_url = "https://smba.example/emea/"
    _run(adapter.update_rich(CHANNEL, AGENT, ref, _activity(), ROOT))

    assert connector.updates[0]["service_url"] == SERVICE_URL


def test_a_notice_about_a_card_lands_in_the_card_s_own_conversation() -> None:
    """`admin_message` is given the card's publication reference as its thread
    root, because a card that opened its own post *is* that conversation."""
    adapter, connector = _teams()
    ref = _run(adapter.post_rich(CHANNEL, AGENT, _run(_card()), None))

    _restart(adapter)
    _run(adapter.admin_message(CHANNEL, "That card is stale.", ref))

    assert connector.sends[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"


def test_a_reference_without_an_address_is_rebuilt_and_said_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Anything stored before publications carried their address is a bare
    message id. It still works where the guess holds, and the guess is named."""
    adapter, connector = _teams()

    with caplog.at_level(logging.WARNING):
        _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))

    assert connector.updates[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"
    assert "carries no address" in caplog.text


# ── A conflict is a wait, not a refusal ──────────────────────────────────────


def test_a_transient_edit_conflict_backs_off_instead_of_reporting_failure() -> None:
    """412 means something wrote to the activity first, so the card is one
    revision behind rather than broken. Reported as a failure it put a "could
    not be updated" notice in the channel for something that fixes itself."""
    adapter, connector = _teams()
    connector.fail_update = BotConnectorConflict(
        "changed", status=412, retry_after=None
    )

    with pytest.raises(RichContentThrottled) as raised:
        _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT))

    assert raised.value.retry_after > 0


def test_writes_to_one_conversation_do_not_overlap() -> None:
    """Two publishers redrawing in the same conversation generate 412s against
    each other for as long as both keep retrying. One lock makes it a queue."""
    adapter, connector = _teams()
    overlapped = False
    inside = False

    async def update_activity(**kwargs: Any) -> None:
        nonlocal overlapped, inside
        if inside:
            overlapped = True
        inside = True
        await asyncio.sleep(0)
        inside = False
        connector.updates.append(kwargs)

    connector.update_activity = update_activity  # type: ignore[assignment]

    async def both() -> None:
        await asyncio.gather(
            adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT),
            adapter.update_rich(CHANNEL, AGENT, "MSG1", _activity(), ROOT),
        )

    _run(both())

    assert len(connector.updates) == 2
    assert overlapped is False


def test_a_conversation_with_a_writer_queued_behind_it_is_not_evicted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The registry is bounded, and a lock it drops has to be one nobody is
    using. `locked()` cannot answer that: it reads False from the moment a lock
    is released until the waiter it woke gets a turn to run, so a conversation
    with someone queued on it looks idle for exactly long enough to be thrown
    away. The next writer then takes a brand-new lock and runs beside the
    waiter, which is the ordering the lock was there to provide."""
    monkeypatch.setattr(teams_adapter, "_MAX_CONVERSATION_LOCKS", 1)
    inside = 0
    overlapped = False

    async def scenario() -> None:
        nonlocal inside, overlapped
        adapter, _connector = _teams()
        holding = asyncio.Event()
        queue_formed = asyncio.Event()

        async def write(conversation: str) -> None:
            nonlocal inside, overlapped
            async with adapter._writes_to(conversation):
                inside += 1
                overlapped = overlapped or inside > 1
                for _ in range(3):
                    await asyncio.sleep(0)
                inside -= 1

        async def hold_then_write_elsewhere() -> None:
            async with adapter._writes_to("conversation-A"):
                holding.set()
                await queue_formed.wait()
            # Released, and the waiter is awake but has not resumed: this is
            # the whole window the bug lived in. Writing elsewhere now is what
            # a bounded registry does on a busy bridge.
            async with adapter._writes_to("conversation-B"):
                pass

        first = asyncio.create_task(hold_then_write_elsewhere())
        await holding.wait()
        queued = asyncio.create_task(write("conversation-A"))
        await asyncio.sleep(0)
        queue_formed.set()
        await asyncio.sleep(0)
        await first
        later = asyncio.create_task(write("conversation-A"))
        await asyncio.gather(queued, later)

    _run(scenario())

    assert overlapped is False


# ── A mention that cannot be made is said out loud ───────────────────────────


def test_a_recipient_whose_name_cannot_be_resolved_is_disclosed() -> None:
    """The publisher only knows about the recipient it could not *find*. A name
    that fails to resolve here loses the mention as well, and a card that names
    nobody reads as one whose reader has already seen it."""
    adapter, connector = _teams()

    _run(
        adapter.post_rich(
            CHANNEL, AGENT, _run(_card(notify_external_id="aad-unknown")), ROOT
        )
    )

    body = _card_text(connector.sends[0]["activity"])
    assert "notified no one" in body
    # Not the "nobody is linked" line: somebody is, and sending them to link an
    # account they have already linked fixes nothing.
    assert "Link your" not in body

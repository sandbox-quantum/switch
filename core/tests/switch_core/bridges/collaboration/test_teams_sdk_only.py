"""Teams publishes SDK sessions, and the legacy renderer no longer runs.

What is under test here is the rich-content seam on the platform whose edits
are addressed to a *conversation* rather than to a message: the compact status
and the request card drawn inside the agent's Adaptive Card, addressed from the
thread the caller kept rather than from a map a restart empties, retired
according to what a deletion leaves behind in each of Teams' two channel
layouts, and truthful about which failures mean "nothing was written".

The old runtime-state renderer is still in the file (removing it is its own
task) but nothing routes to it any more. The first test holds that line: the
two renderers must not both draw, or every turn appears twice.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
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
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.connector import (
    BotConnectorGone,
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

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        if self.fail_send is not None:
            raise self.fail_send
        self.threads.append({"channel_id": channel_id, "activity": activity})
        return f"{channel_id};messageid={ROOT}", ROOT

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        if self.fail_send is not None:
            raise self.fail_send
        self.sends.append({"conversation_id": conversation_id, "activity": activity})
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
            }
        )

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        if self.fail_delete is not None:
            raise self.fail_delete
        self.deletes.append(
            {"conversation_id": conversation_id, "activity_id": activity_id}
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


# ── The legacy renderer is off ───────────────────────────────────────────────


def test_the_legacy_renderer_no_longer_draws_alongside_the_sdk_one() -> None:
    """Both would draw the same turn, and the post would show it twice."""
    adapter, connector = _teams()

    for state in ("working", "awaiting-input", "idle"):
        _run(
            adapter.apply_runtime_state(
                CHANNEL, AGENT, state, mention_handle=None, thread_root_id=None
            )
        )
    _run(adapter.reposition_runtime_state(CHANNEL, AGENT, ROOT))

    assert connector.threads == []
    assert connector.sends == []
    assert connector.updates == []
    assert adapter.renders_legacy_runtime_state is False
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

    assert ref == ROOT
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


# ── Retiring a finished status, in each of the two layouts ───────────────────


def test_a_finished_status_is_edited_rather_than_deleted_in_a_posts_channel() -> None:
    """Teams substitutes "This message has been deleted." and keeps it in the
    post, so deleting would leave one tombstone per turn per agent."""
    adapter, connector = _teams("post")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.deletes == []
    assert ENDED_LINE in _card_text(connector.updates[0]["activity"])


def test_a_finished_status_is_removed_where_a_deletion_leaves_nothing() -> None:
    adapter, connector = _teams("chat")

    _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.updates == []
    assert connector.deletes[0]["activity_id"] == "MSG1"
    assert connector.deletes[0]["conversation_id"] == f"{CHANNEL};messageid={ROOT}"


def test_a_finished_status_is_removed_from_a_chat() -> None:
    adapter, connector = _teams(chat=True)

    _run(adapter.update_rich(CHAT, AGENT, "MSG1", _ended(), None))

    assert connector.deletes[0]["conversation_id"] == CHAT


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


def test_a_refused_removal_leaves_the_final_state_instead_of_pretending(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A deletion Teams refused is not a deletion. Left as "Working…" the post
    would report a turn that ended minutes ago as still running."""
    adapter, connector = _teams("chat")
    connector.fail_delete = BotConnectorGone("gone", status=404, retry_after=None)

    with caplog.at_level(logging.WARNING):
        _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert ENDED_LINE in _card_text(connector.updates[0]["activity"])
    assert "would not remove" in caplog.text


def test_a_removal_whose_outcome_is_unknown_is_not_recorded_as_done() -> None:
    """The publisher holds the anchor and can come back to it. A status
    recorded as cleaned up when it was not is one that never goes."""
    adapter, connector = _teams("chat")
    connector.fail_delete = BotConnectorUnavailable(
        "timeout", status=None, retry_after=None
    )

    with pytest.raises(BotConnectorUnavailable):
        _run(adapter.update_rich(CHANNEL, AGENT, "MSG1", _ended(), ROOT))

    assert connector.updates == []

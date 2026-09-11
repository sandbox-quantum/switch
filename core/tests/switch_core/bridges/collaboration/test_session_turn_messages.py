"""One message per turn, kept in step, ending on the turn's final state.

Slice 6 drew a turn and posted it. A live session revises a turn a dozen times
— every tool call opens and closes — and posting each revision fills a channel
with versions of the same turn and no way to tell which one is current. So the
message is posted once and edited afterwards, and the last edit is the state
the turn ended in.

Which needs an anchor: the message a later edit goes to. It is held in memory
for as long as the turn is running, and that is deliberate — see
`SessionTurnActivity`. What is tested here is that one turn keeps one message,
that two turns do not share one, and that a failure to edit does not lose the
message the next change needs.

No database: nothing resolves against an activity message, so unlike a card it
writes no row.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from switch_core.bridges.collaboration.session import outbound
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import Item, TurnUpsert
from switch_core.sessions.projection import SessionProjection

from .test_slack_agent_sessions import FakeWebClient

REPO_ROOT = Path(__file__).resolve().parents[5]
ACTIVITY_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.activity.json"
)

CHANNEL = "C1"
SESSION = "session-activity"
TURN = "turn-activity"


def _adapter(client: FakeWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache[CHANNEL] = "channel"
    return adapter


async def _projection(*streams: str) -> SessionProjection:
    source = FixtureEventSource.from_examples(
        ACTIVITY_PATH, events=streams or ("turnActivity",)
    )
    return await project(source, source.session_id)


def _turn(status: str, turn_id: str = TURN) -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": turn_id, "status": status, "commandId": None}
    )


def _item(turn_id: str = TURN) -> Item:
    return Item.model_validate(
        {
            "itemId": f"item-{turn_id}",
            "turnId": turn_id,
            "revision": 1,
            "kind": "assistant-message",
            "status": "completed",
            "title": "",
            "text": f"Working on {turn_id}",
            "attachments": [],
            "origin": None,
        }
    )


_SAME_AS_THREAD_ROOT = object()


async def _publish(
    activity: SessionTurnActivity,
    items: list[Item],
    turn: TurnUpsert,
    *,
    session_id: str = SESSION,
    channel_id: str = CHANNEL,
    thread_root_id: str | None = None,
    asked_on: Any = _SAME_AS_THREAD_ROOT,
    elapsed_seconds: float | None = None,
) -> bool:
    if asked_on is _SAME_AS_THREAD_ROOT:
        asked_on = thread_root_id
    return await activity.publish(
        items,
        turn,
        session_id=session_id,
        channel_id=channel_id,
        thread_root_id=thread_root_id,
        asked_on=asked_on,
        agent_name="agent-demo",
        elapsed_seconds=elapsed_seconds,
    )


def _blocks(call: dict[str, Any]) -> str:
    return json.dumps(call["blocks"], ensure_ascii=False)


# ── One turn, one message ────────────────────────────────────────────────────


async def test_a_turn_is_posted_once_and_edited_every_time_after() -> None:
    """The whole of the slice, in one test.

    Before this, a session revising a turn six times put six messages in the
    channel; the reader had to work out which was current by scrolling to the
    bottom and hoping nothing else had been said meanwhile.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    items = await _projection()

    await _publish(activity, items.turn_activity(TURN), _turn("running"))
    await _publish(activity, items.turn_activity(TURN), _turn("running"))
    await _publish(activity, items.turn_activity(TURN), _turn("completed"))

    assert len(client.posted) == 1
    assert len(client.updated) == 2
    assert {call["ts"] for call in client.updated} == {"1.0"}


async def test_the_last_edit_is_the_state_the_turn_ended_in() -> None:
    """What the channel is left with once the session has stopped talking.

    Slack's own progress card is deleted at the end of a turn, and that is the
    behaviour this replaces: not a card that vanishes, a message that settles.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    running = await _projection()
    stopped = await _projection("turnActivity", "turnEnd")

    await _publish(activity, running.turn_activity(TURN), _turn("running"))
    await _publish(activity, stopped.turn_activity(TURN), _turn("interrupted"))

    assert "Working…" in _blocks(client.posted[0])
    assert client.deleted == []
    assert "Turn interrupted. 1 step left unfinished." in _blocks(client.updated[0])


async def test_a_second_turn_gets_its_own_message() -> None:
    """One message per turn, not one per session.

    The anchor is released when a turn ends, and a session goes on to do more
    work; an edit of the finished turn would rewrite the wrong history.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("completed"))
    await _publish(activity, [_item("turn-two")], _turn("running", "turn-two"))

    assert len(client.posted) == 2
    assert client.updated == []


async def test_two_sessions_with_the_same_turn_id_do_not_share_a_message() -> None:
    """Turn ids come from the host, so they are unique within a session only."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("running"))
    await _publish(activity, [_item()], _turn("running"), session_id="session-other")

    assert len(client.posted) == 2
    assert client.updated == []


# ── When Slack will not take it ──────────────────────────────────────────────


async def test_a_turn_slack_refused_is_posted_afresh_rather_than_edited() -> None:
    """A refused post leaves no message, so there is nothing to edit into.

    Kept as an anchor anyway, the next change would edit a message ref that was
    never minted and the turn would never appear at all.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    activity = SessionTurnActivity(adapter)
    adapter._web_client = None  # type: ignore[assignment]

    await _publish(activity, [_item()], _turn("running"))
    adapter._web_client = client  # type: ignore[assignment]
    await _publish(activity, [_item()], _turn("running"))

    assert len(client.posted) == 1
    assert client.updated == []


async def test_an_edit_slack_refused_keeps_the_message_for_the_next_change(
    caplog: Any,
) -> None:
    """A failed edit is a stale message, not a lost one.

    Unlike a card there is nothing on it to press, so it is logged and the next
    change goes to the same message rather than starting a second one.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    await _publish(activity, [_item()], _turn("running"))

    client.update_error = "message_not_found"
    with caplog.at_level(logging.ERROR):
        await _publish(activity, [_item()], _turn("running"))
    client.update_error = None
    await _publish(activity, [_item()], _turn("completed"))

    assert "Could not update the activity for turn" in caplog.text
    assert len(client.posted) == 1
    assert [call["ts"] for call in client.updated] == ["1.0"]


async def test_a_failed_last_edit_says_the_channel_is_left_looking_live(
    caplog: Any,
) -> None:
    """Nothing comes after the end of a turn, so nothing will correct it."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    await _publish(activity, [_item()], _turn("running"))

    client.update_error = "message_not_found"
    with caplog.at_level(logging.ERROR):
        await _publish(activity, [_item()], _turn("completed"))

    assert "left showing it as still running" in caplog.text


async def test_more_live_turns_than_are_held_forgets_the_oldest_and_says_so(
    monkeypatch: Any, caplog: Any
) -> None:
    """A turn that stops without saying so holds its anchor for good.

    The ids come from outside, so unbounded means unbounded by anything this
    process controls. Forgetting one costs a reposted turn, which is visible,
    rather than a bridge that grows until it is restarted.
    """
    monkeypatch.setattr(outbound, "_MAX_ANCHORS", 2)
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    with caplog.at_level(logging.WARNING):
        for turn_id in ("turn-one", "turn-two", "turn-three"):
            await _publish(activity, [_item(turn_id)], _turn("running", turn_id))
        await _publish(activity, [_item("turn-one")], _turn("running", "turn-one"))

    assert "turn turn-one" in caplog.text
    assert len(client.posted) == 4
    assert client.updated == []


async def test_forgetting_an_anchor_also_clears_its_threads_eyes(
    monkeypatch: Any,
) -> None:
    """Forgetting an anchor is the only record of where its `:eyes:` went —
    without clearing it here, an evicted turn's thread is left showing the
    reaction forever, since nothing else is tracking that turn any more.
    """
    monkeypatch.setattr(outbound, "_MAX_ANCHORS", 1)
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("running"), thread_root_id="parent-1")
    await _publish(
        activity,
        [_item("turn-two")],
        _turn("running", "turn-two"),
        thread_root_id="parent-2",
    )

    assert client.reactions == [
        ("add", "parent-1", "eyes"),
        ("add", "parent-2", "eyes"),
        ("remove", "parent-1", "eyes"),
    ]


# ── The thread's own :eyes: ───────────────────────────────────────────────────


async def test_a_threaded_turn_reacts_to_the_thread_and_clears_it_at_the_end() -> None:
    """The same signal the old runtime-state indicator put on a message being
    handled, now tied to a turn's own lifecycle: on once the turn's message
    posts, off once the turn ends."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("running"), thread_root_id="parent-1")
    assert client.reactions == [("add", "parent-1", "eyes")]

    await _publish(activity, [_item()], _turn("completed"), thread_root_id="parent-1")
    assert client.reactions == [
        ("add", "parent-1", "eyes"),
        ("remove", "parent-1", "eyes"),
    ]


async def test_a_turn_at_the_channel_root_reacts_to_nothing() -> None:
    """No thread root means no message to put `:eyes:` on."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("running"), thread_root_id=None)
    await _publish(activity, [_item()], _turn("completed"), thread_root_id=None)

    assert client.reactions == []


async def test_a_reaction_failure_does_not_fail_the_turns_own_draw(
    caplog: Any,
) -> None:
    """Best effort: a reaction is not on the port, and losing one is not worth
    failing what the turn itself is trying to show. `_mark_being_read` (the
    mechanism this reuses) already absorbs a Slack refusal and logs its own
    warning without raising, so this is really confirming that reuse holds —
    not a second layer of handling for the same failure."""
    client = FakeWebClient()
    client.reaction_error = "internal_error"
    activity = SessionTurnActivity(_adapter(client))

    with caplog.at_level(logging.WARNING):
        drawn = await _publish(
            activity, [_item()], _turn("running"), thread_root_id="parent-1"
        )

    assert drawn is True
    assert len(client.posted) == 1
    assert "Could not add the working reaction on parent-1 in C1" in caplog.text


async def test_the_reaction_lands_on_the_message_that_actually_asked() -> None:
    """`asked_on` is not necessarily the thread root — a command answered
    inside an existing thread threads under that thread's root, but the
    message that actually asked is the reply itself (`refresh_activity`
    resolves this off the command's own `Origin`), and the turn's own
    `:eyes:` follows that, not the root."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(
        activity,
        [_item()],
        _turn("running"),
        thread_root_id="parent-1",
        asked_on="asker-99",
    )

    assert client.reactions == [("add", "asker-99", "eyes")]


async def test_the_reaction_normalises_a_composite_asked_on() -> None:
    """`asked_on` arrives as the `"channel:ts"` composite an `Origin` carries,
    not a bare ts — Slack's reaction API takes a bare ts, not this class's own
    message reference."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(
        activity,
        [_item()],
        _turn("running"),
        thread_root_id="parent-1",
        asked_on=f"{CHANNEL}:111.0",
    )

    assert client.reactions == [("add", "111.0", "eyes")]


async def test_two_turns_sharing_the_same_asker_do_not_clobber_each_others_eyes() -> (
    None
):
    """Two turns answered in the same thread resolve to the same asking
    message. The first to end must not strip the reaction out from under the
    second still running — the mark comes off only once nothing is left
    holding it."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(
        activity,
        [_item()],
        _turn("running"),
        thread_root_id="parent-1",
        asked_on="asker-1",
    )
    await _publish(
        activity,
        [_item("turn-two")],
        _turn("running", "turn-two"),
        thread_root_id="parent-1",
        asked_on="asker-1",
    )
    assert client.reactions == [("add", "asker-1", "eyes")]

    await _publish(
        activity,
        [_item()],
        _turn("completed"),
        thread_root_id="parent-1",
        asked_on="asker-1",
    )
    assert client.reactions == [("add", "asker-1", "eyes")]

    await _publish(
        activity,
        [_item("turn-two")],
        _turn("completed", "turn-two"),
        thread_root_id="parent-1",
        asked_on="asker-1",
    )
    assert client.reactions == [
        ("add", "asker-1", "eyes"),
        ("remove", "asker-1", "eyes"),
    ]


async def test_a_turn_first_published_already_ended_does_not_touch_the_reaction() -> (
    None
):
    """A turn can arrive already in its final state — recovery replaying a
    turn that finished before the bridge came back, say. Nothing was ever
    watching it, so there is nothing to add and then immediately take off."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item()], _turn("completed"), thread_root_id="parent-1")

    assert client.reactions == []


async def test_releasing_a_claim_this_turn_never_made_still_clears_a_live_reaction() -> (
    None
):
    """This process's own bookkeeping of who claimed a reaction is not the
    same thing as whether Slack is showing one — a turn ending without ever
    having been the one to add it (its claim lost some other way than the
    ordinary claim/release pairing this class does itself) must still take
    the reaction off when nothing else is holding it, or it is stuck showing
    `:eyes:` for good."""
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._eyes.add((CHANNEL, "parent-1"))
    activity = SessionTurnActivity(adapter)

    await _publish(activity, [_item()], _turn("completed"), thread_root_id="parent-1")

    assert client.reactions == [("remove", "parent-1", "eyes")]

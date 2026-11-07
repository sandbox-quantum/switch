"""A queued turn offers the command that withdraws it, and a turn that was
withdrawn says so instead of reading as one that ran."""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_QUEUED_NOTE,
    MARKDOWN,
    cancel_command,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
    render_activity_stream,
)
from switch_core.sessions.contract import TURN_ENDED

from .session_fixtures import _item, _turn
from .slack_fakes import FakeWebClient
from .test_session_interrupt_control import (
    QUEUED_TURN,
    RUNNING_TURN,
    _activity,
    _adapter,
    _button,
    _control,
    _streamed,
)
from .test_session_interrupt_control import _turn as _slack_turn

CHANNEL = "C1"
THREAD = "C1:root"
TURN_ID = "1a2b3c4d-0000-4000-8000-000000000001"
COMMAND = f"!cancel @helper {TURN_ID[:8]}"


def _identity(text: str) -> str:
    return text


def _lines(status: str, *, cancel: str | None, limit: int = 10_000) -> list[str]:
    return turn_status(
        [],
        _turn(status),
        escape=_identity,
        limit=limit,
        markup=MARKDOWN,
        cancel_command=cancel,
        tool_detail=False,
    ).splitlines()


# ── What the command is ──────────────────────────────────────────────────────


def test_the_command_names_the_agent_and_the_first_eight_characters_of_the_turn() -> (
    None
):
    assert cancel_command("helper", TURN_ID) == COMMAND
    assert cancel_command("helper", "short") == "!cancel @helper short"


# ── The neutral card ─────────────────────────────────────────────────────────


def test_a_queued_turn_shows_the_command_to_copy_under_its_state() -> None:
    lines = _lines("queued", cancel=COMMAND)

    assert lines[0] == "**Queued. Waiting for the agent to start…**"
    assert lines[1] == f"To cancel it before the agent starts, send `{COMMAND}`"


def test_only_a_queued_turn_offers_it() -> None:
    for status in ("running", "completed", "cancelled"):
        assert not any("!cancel" in line for line in _lines(status, cancel=COMMAND))


def test_a_card_with_no_command_to_offer_is_what_it_was() -> None:
    assert _lines("queued", cancel=None) == [
        "**Queued. Waiting for the agent to start…**"
    ]


def test_the_command_is_left_out_whole_rather_than_cut() -> None:
    lines = _lines("queued", cancel=COMMAND, limit=60)

    assert lines == ["**Queued. Waiting for the agent to start…**"]


# ── A turn that was withdrawn ────────────────────────────────────────────────


def test_a_cancelled_turn_says_it_never_started() -> None:
    assert _lines("cancelled", cancel=None) == [
        "**Cancelled before the agent started.**"
    ]
    assert "cancelled" in TURN_ENDED


def test_a_cancelled_turn_does_not_claim_to_have_worked_for_any_time() -> None:
    state = turn_state(
        [_item()], _turn("cancelled"), tool_detail=True, elapsed_seconds=45
    )

    assert state == "Cancelled before the agent started."


# ── Slack ────────────────────────────────────────────────────────────────────


def _offered(turn_id: str, stops: str | None) -> TurnActivity:
    activity = _activity(_slack_turn(turn_id, "queued"), stops=stops)
    return TurnActivity(
        activity.items,
        activity.turn,
        activity.elapsed_seconds,
        interrupt_turn_id=stops,
        cancel_command=COMMAND,
    )


async def test_a_queued_turn_behind_a_running_one_offers_both() -> None:
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(
        CHANNEL, "Agent", _offered(QUEUED_TURN, stops=RUNNING_TURN), THREAD
    )

    control = _control(_streamed(client))
    assert control["type"] == "section"
    assert INTERRUPT_QUEUED_NOTE in control["text"]["text"]
    assert f"`{COMMAND}`" in control["text"]["text"]
    assert control["text"]["type"] == "mrkdwn"
    assert _button(control)["value"] == RUNNING_TURN


async def test_a_queued_turn_with_nothing_ahead_still_offers_the_command() -> None:
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(CHANNEL, "Agent", _offered(QUEUED_TURN, stops=None), THREAD)

    control = _control(_streamed(client))
    assert control["type"] == "section"
    assert f"`{COMMAND}`" in control["text"]["text"]
    assert "accessory" not in control


async def test_the_offer_is_written_over_once_the_turn_starts() -> None:
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", _offered(QUEUED_TURN, stops=None), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_slack_turn(QUEUED_TURN, "running"), stops=QUEUED_TURN),
        THREAD,
    )

    control = _control(_streamed(client))
    assert control["type"] == "actions"
    assert COMMAND not in str(control)


async def test_an_ordinary_post_offers_the_command_too() -> None:
    client = FakeWebClient()
    adapter = _adapter(client, streaming=False)

    await adapter.post_rich(CHANNEL, "Agent", _offered(QUEUED_TURN, stops=None), THREAD)

    blocks: list[dict[str, Any]] = client.posted[0]["blocks"]
    assert any(COMMAND in str(block) for block in blocks)


def test_a_running_turn_is_offered_nothing_even_when_a_command_is_handed_over() -> None:
    turn = _slack_turn(RUNNING_TURN, "running")

    plan = render_activity_plan(
        [], turn, interrupt_turn_id=RUNNING_TURN, cancel_command=COMMAND
    )
    stream = render_activity_stream(
        [], turn, interrupt_turn_id=RUNNING_TURN, cancel_command=COMMAND
    )

    assert COMMAND not in str(plan.blocks)
    assert COMMAND not in str(stream.blocks)


def test_a_cancelled_turns_slack_header_says_it_never_started() -> None:
    turn = _slack_turn(QUEUED_TURN, "cancelled")

    plan = render_activity_plan([], turn, interrupt_turn_id=None, cancel_command=None)

    assert "Cancelled before the agent started." in plan.text

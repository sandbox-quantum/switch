"""The audience of a room, as the connecting agent is told it.

Review found this section shipping to nobody. It sat inside the
`include_general` block, and all three connector skills call
`connect_to_room(..., include_general_instructions=False)` because they teach
the Switch workflow out of band — so the `audience` label reached the model on
every event and the rule giving it meaning reached no host that exists.

Nothing would have caught that. `test_disclosure.py` tests the rule as a
function; the delivery of it was tested by nothing at all, which is why the
regression was invisible for a sprint.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.instructions import build_room_instructions
from switch_core.bridges.agent.protocol.types import IntegrationProfile


def _profile() -> IntegrationProfile:
    return IntegrationProfile(
        connection_model="always_on",
        message_exchange=True,
        pre_invocation_mediation=[],
        post_invocation_mediation=[],
        event_reporting=[],
        task_protocol={"can_delegate": False, "can_accept": False},
    )


def _room(channel_type: str | None = "channel_private", **overrides: Any) -> Any:
    return SimpleNamespace(
        id="room-1",
        name="Summit",
        description="Planning",
        channel_type=channel_type,
        admin_mode=False,
        instructions=None,
        external_channel_id="C123",
        **overrides,
    )


def _agent() -> Any:
    return SimpleNamespace(name="Atlas", agent_type="claude_code")


def _instructions(
    room: Any, bridge: Any = None, *, include_general: bool = True
) -> str:
    return build_room_instructions(
        _agent(), room, _profile(), [], bridge, include_general=include_general
    )


def test_the_audience_is_stated_to_the_agent() -> None:
    text = _instructions(_room("channel_private"))

    assert "Who can read this room" in text
    assert "restricted" in text


def test_it_is_stated_even_when_the_general_workflow_is_not() -> None:
    """The regression review found, and the reason this file exists.

    `include_general=False` means "this host already teaches the Switch
    workflow" — every connector skill sets it. Who can read *this room* is not
    workflow, it is this room's state, and a skill written once cannot carry it.
    """
    text = _instructions(_room("direct"), include_general=False)

    assert "Who can read this room" in text
    assert "private" in text


@pytest.mark.parametrize(
    ("channel_type", "expected"),
    [
        ("direct", "private"),
        ("channel_private", "restricted"),
        ("group", "restricted"),
        ("channel_public", "open"),
        ("lobby", "open"),
    ],
)
def test_the_stated_audience_follows_the_room(channel_type: str, expected: str) -> None:
    text = _instructions(_room(channel_type), include_general=False)

    assert f"Audience: **{expected}**" in text


def test_a_room_on_an_external_bridge_is_stated_as_external() -> None:
    """The label the whole thing exists for, and the one a client cannot derive
    — it needs the bridge's type, which the envelope does not carry."""
    bridge = SimpleNamespace(type="email", display_name="Mail")

    text = _instructions(_room("direct"), bridge, include_general=False)

    assert "Audience: **external**" in text


def test_an_uncharacterisable_room_is_not_given_a_guessed_audience() -> None:
    text = _instructions(_room(None), include_general=False)

    assert "Audience: **unknown**" in text


def test_the_rule_says_a_same_sized_room_is_not_the_same_people() -> None:
    """The correction that came out of review: comparing labels permitted one
    person's DM into another person's. An agent told only "equal or narrower is
    fine" would do exactly that."""
    text = _instructions(_room("direct"), include_general=False)

    assert "different DM is a different person" in text


def test_the_open_carve_out_stops_at_the_organisation() -> None:
    """`may_carry` allows `open` into any *internal* room and refuses
    `open → external`.

    The instruction originally put the condition on the source room alone —
    "free only when this room is `open`" — which tells an agent in a public
    channel that repeating its contents anywhere is fine. The email room is
    anywhere. That is internal content going to an outside correspondent, which
    is the single failure this section exists to prevent.
    """
    text = _instructions(_room("channel_public"), include_general=False)

    assert "inside the organisation" in text
    assert "external" in text


def test_the_rule_names_whose_permission_it_is() -> None:
    """Asking whoever the agent is talking to now is unactionable: they are in
    the wider room and cannot consent to hearing something they do not know
    exists — asking them would itself be the disclosure."""
    text = _instructions(_room("channel_private"), include_general=False)

    assert "came from" in text
    assert "not the permission of whoever you are talking to now" in text


def test_it_says_this_is_about_repeating_rather_than_knowing() -> None:
    """US-4 names two failures and the over-corrected one is real: an agent that
    refuses to *use* what it knows gives a visibly worse answer and protects
    nobody."""
    text = _instructions(_room("channel_public"), include_general=False)

    assert "repeating, not knowing" in text

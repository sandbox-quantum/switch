"""What a workspace whose decisions run on a machine resolves to
(`decision/settings.py`, `decision/machine.py`): unavailable without notices
while the model gets ready or once the machine is removed, asked once it has
been ready, whatever happens to it after."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from switch_core.db.models import AgentController, DecisionSettings
from switch_core.decision.machine import REMOVED_REASON
from switch_core.decision.settings import ServerDefault, availability, resolve
from tests.switch_core.decision.machine_helpers import MACHINE_NAME, MODEL, status

SERVER = ServerDefault(
    endpoint_url="http://decision.test/decide", api_key=None, bedrock_enabled=False
)
READY_AT = datetime(2026, 10, 29, 9, 30, tzinfo=UTC)


def _row(*, ready: bool) -> DecisionSettings:
    return DecisionSettings(
        tenant_id="t",
        backend="machine",
        controller_id="c1",
        model=MODEL,
        threshold=None,
        machine_ready_at=READY_AT if ready else None,
    )


def _controller(
    reported: dict | None = None, *, revoked: bool = False
) -> AgentController:
    return AgentController(
        id="c1",
        tenant_id="t",
        owner_id="u",
        name=MACHINE_NAME,
        kind="console",
        api_key_id="key-1",
        status=status() if reported is None else reported,
        revoked_at=READY_AT if revoked else None,
        disconnected_at=datetime(2026, 10, 29, 10, 0, tzinfo=UTC),
    )


def test_getting_ready_is_unavailable_with_the_progress() -> None:
    reported = status(
        state="downloading",
        progress={"done_bytes": 1_200_000_000, "total_bytes": 2_740_000_000},
    )
    resolved = resolve(_row(ready=False), SERVER, _controller(reported), None)

    applies = availability(True, resolved)
    assert resolved.backend == "machine"
    assert not resolved.has_backend
    assert not applies.available
    assert applies.reason == (
        "The decision model on Studio Mac is getting ready "
        "(downloading, 1.2 of 2.7 GB)."
    )
    assert resolved.machine is not None
    assert resolved.machine.state == "downloading"
    assert not resolved.machine.ready


def test_starting_and_waiting_say_so() -> None:
    starting = resolve(
        _row(ready=False), SERVER, _controller(status(state="starting")), None
    )
    waiting = resolve(_row(ready=False), SERVER, _controller(status(state="off")), None)

    assert starting.reason is not None and "(starting)" in starting.reason
    assert waiting.reason is not None and "getting ready" in waiting.reason


def test_running_but_not_yet_recorded_ready_is_still_getting_ready() -> None:
    resolved = resolve(_row(ready=False), SERVER, _controller(), None)

    assert not availability(True, resolved).available


def test_once_ready_it_is_asked() -> None:
    resolved = resolve(_row(ready=True), SERVER, _controller(), None)

    applies = availability(True, resolved)
    assert applies.available and applies.reason is None
    assert resolved.has_backend
    assert resolved.machine is not None and resolved.machine.state == "running"


@pytest.mark.parametrize(
    "reported",
    [
        status(state="failed", reason="model_server_crashed"),
        status(state="off", reason="turned_off_on_machine"),
    ],
    ids=["failed", "turned_off"],
)
def test_once_ready_a_failing_machine_is_still_asked(reported: dict) -> None:
    """It takes the failure path then, with a notice naming it."""
    resolved = resolve(_row(ready=True), SERVER, _controller(reported), None)

    assert availability(True, resolved).available


def test_offline_shows_when_it_went() -> None:
    resolved = resolve(_row(ready=True), SERVER, _controller(), False)

    assert resolved.machine is not None
    assert resolved.machine.state == "offline"
    assert resolved.machine.connected is False
    assert resolved.machine.since == "2026-10-29T10:00:00Z"
    assert availability(True, resolved).available


def test_a_running_machine_says_since_when() -> None:
    resolved = resolve(_row(ready=True), SERVER, _controller(), True)

    assert resolved.machine is not None
    assert resolved.machine.since == "2026-10-29T09:00:00Z"


def test_failed_before_it_was_ready_says_why() -> None:
    reported = status(state="failed", reason="not_enough_disk")
    resolved = resolve(_row(ready=False), SERVER, _controller(reported), None)

    assert resolved.reason == (
        "The decision model on Studio Mac isn't running (not enough disk space). "
        "A workspace admin can see more in Switch Console → Admin → Decision routing."
    )
    assert not availability(True, resolved).available


@pytest.mark.parametrize("ready", [True, False])
def test_a_revoked_machine_is_removed(ready: bool) -> None:
    resolved = resolve(_row(ready=ready), SERVER, _controller(revoked=True), None)

    applies = availability(True, resolved)
    assert not applies.available
    assert applies.reason == REMOVED_REASON
    assert resolved.machine is not None and resolved.machine.state == "removed"


def test_a_missing_machine_is_removed() -> None:
    resolved = resolve(_row(ready=True), SERVER, None, None)

    assert not availability(True, resolved).available
    assert resolved.reason == REMOVED_REASON


def test_the_flag_off_wins() -> None:
    resolved = resolve(_row(ready=True), SERVER, _controller(), None)

    assert not availability(False, resolved).available

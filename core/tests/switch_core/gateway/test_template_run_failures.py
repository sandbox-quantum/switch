"""How a person's template run is reported when it fails, and that reporting
a run that succeeded cannot fail it."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelInUse,
)
from switch_core.gateway import rooms as gateway_rooms
from switch_core.gateway.rooms import _reported, _run_failure
from switch_core.telemetry.template_runs import TemplateRunReport
from tests.telemetry_records import recording_telemetry


def _raised(status: int, cause: Exception | None) -> HTTPException:
    error = HTTPException(status_code=status, detail="no")
    error.__cause__ = cause
    return error


@pytest.mark.parametrize(
    ("status", "cause", "reason"),
    [
        (409, ChannelInUse("taken"), "channel_in_use"),
        (400, ValueError("bad"), "invalid"),
        (403, PermissionError("no"), "forbidden"),
        (502, BridgeOperationError("down"), "bridge_unavailable"),
        (409, None, "error"),
        (404, None, "not_found"),
        (422, None, "error"),
    ],
)
def test_a_failure_is_named_by_what_raised_it(
    status: int, cause: Exception | None, reason: str
) -> None:
    """A conflict that is not a channel in use is not reported as one."""
    assert _run_failure(_raised(status, cause)) == reason


def _report() -> tuple[TemplateRunReport, Any]:
    telemetry, sink = recording_telemetry()
    return TemplateRunReport(telemetry, None, "person", None), sink


async def _answer(result: dict[str, Any]) -> dict[str, Any]:
    return result


async def test_a_run_whose_answer_has_no_counts_is_still_answered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report, sink = _report()

    def broken(_: object) -> int:
        raise TypeError("an answer the report did not expect")

    monkeypatch.setattr(gateway_rooms, "rooms_in", broken)
    result = await _reported(report, _answer({"room": {"room_id": "r"}}))

    assert result == {"room": {"room_id": "r"}}
    assert sink.events("template_run") == []


async def test_a_run_with_no_agents_counts_none() -> None:
    report, sink = _report()

    await _reported(report, _answer({"room": {"room_id": "r"}}))

    [run] = sink.events("template_run")
    assert (run["agents_created"], run["rooms_created"]) == (0, 1)

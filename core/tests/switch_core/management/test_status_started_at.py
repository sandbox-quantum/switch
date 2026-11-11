"""A controller's start time in its status report, for the follow-up's
controller-restart count: declared now with a strict type, accepted and not
read, so a controller that sends it works against this Core."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import StatusControllerInfo

BASE = {"version": "1.2.3", "protocol": 1, "assignment_revision": 1}


def test_a_start_time_is_accepted():
    info = StatusControllerInfo.model_validate(
        {**BASE, "started_at": "2026-11-11T12:00:00Z"}
    )
    assert info.started_at is not None


def test_a_report_without_one_is_unchanged():
    assert StatusControllerInfo.model_validate(BASE).started_at is None


@pytest.mark.parametrize("value", ["yesterday", "CANARY", "2026-13-45T00:00:00Z"])
def test_anything_but_a_time_is_refused(value):
    with pytest.raises(ValidationError):
        StatusControllerInfo.model_validate({**BASE, "started_at": value})

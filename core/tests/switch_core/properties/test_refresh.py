"""Concurrent refreshes of one connection, against `refresh_machine.py`."""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.refresh_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("connector.refresh-single-flight")
def test_concurrent_requests_refresh_a_token_once(postgres_schema: str) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    print(f"reached {dict(COVERAGE)}")
    assert COVERAGE["refreshed in a burst"], f"nothing was refreshed: {dict(COVERAGE)}"
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )

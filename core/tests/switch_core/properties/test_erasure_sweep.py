"""Erasing a person, against a sweep of every column, `erasure_machine.py`."""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.erasure_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("retention.erasure-complete")
def test_an_erased_person_is_named_nowhere(postgres_schema: str) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    print(f"reached {dict(COVERAGE)}")
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )

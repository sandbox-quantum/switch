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
from tests.switch_core.properties.shards import Shard


@pytest.mark.property("retention.erasure-complete")
def test_an_erased_person_is_named_nowhere(postgres_schema: str, shard: Shard) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema), settings=shard.of(settings())
    )
    print(f"reached {dict(COVERAGE)}")
    shard.reached(COVERAGE, SHOULD_REACH)

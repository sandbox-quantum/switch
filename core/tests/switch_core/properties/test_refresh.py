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
from tests.switch_core.properties.shards import Shard


@pytest.mark.property("connector.refresh-single-flight")
def test_concurrent_requests_refresh_a_token_once(
    postgres_schema: str, shard: Shard
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema), settings=shard.of(settings())
    )
    print(f"reached {dict(COVERAGE)}")
    assert COVERAGE["refreshed in a burst"], f"nothing was refreshed: {dict(COVERAGE)}"
    shard.reached(COVERAGE, SHOULD_REACH)

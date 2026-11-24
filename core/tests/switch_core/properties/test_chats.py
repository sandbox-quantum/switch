"""Chat membership against a model of why each membership exists, against
`chats_machine.py`."""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.chats_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)
from tests.switch_core.properties.shards import Shard


@pytest.mark.property("chats.owned-sync-reversible")
@pytest.mark.property("chats.membership-is-read-authority")
def test_chat_membership_follows_its_reasons(
    postgres_schema: str, shard: Shard
) -> None:
    COVERAGE.clear()
    # An owner membership needs a few steps to come about (the creator leaves,
    # then an agent of theirs arrives) and more to be taken back, so each
    # example runs longer than the profile's default.
    current = settings()
    run_state_machine_as_test(
        machine_on(postgres_schema),
        settings=shard.of(
            settings(current, stateful_step_count=max(50, current.stateful_step_count))
        ),
    )
    print(f"reached {dict(COVERAGE)}")
    shard.reached(COVERAGE, SHOULD_REACH)

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


@pytest.mark.property("chats.owned-sync-reversible")
@pytest.mark.property("chats.membership-is-read-authority")
def test_chat_membership_follows_its_reasons(postgres_schema: str) -> None:
    COVERAGE.clear()
    # An owner membership needs a few steps to come about (the creator leaves,
    # then an agent of theirs arrives) and more to be taken back.
    current = settings()
    run_state_machine_as_test(
        machine_on(postgres_schema),
        settings=settings(
            current,
            max_examples=max(100, current.max_examples),
            stateful_step_count=max(50, current.stateful_step_count),
        ),
    )
    print(f"reached {dict(COVERAGE)}")
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )

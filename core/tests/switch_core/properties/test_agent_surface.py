"""The agent operations as agents of two tenants, against
`agent_surface_machine.py`."""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.agent_surface_machine import (
    COVERAGE,
    RAISED,
    REACHED,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("tenancy.agent-surface-no-cross-tenant")
def test_an_agent_never_reaches_another_tenant(postgres_schema: str) -> None:
    COVERAGE.clear()
    REACHED.clear()
    RAISED.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    print(f"reached {dict(COVERAGE)}; stand-ins {dict(REACHED)}; raised {dict(RAISED)}")
    for what in ("a call answered 2xx", "a call refused"):
        assert COVERAGE[what], f"no call was counted as {what!r}: {dict(COVERAGE)}"
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )

from __future__ import annotations

from collections.abc import Iterator

import pytest

from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)


@pytest.fixture(autouse=True)
def _agent_management_operations_off_afterwards() -> Iterator[None]:
    """Installing management enables its agent operations process-wide, as it
    does in production; take them away again so no other test sees them."""
    yield
    disable_agent_management()

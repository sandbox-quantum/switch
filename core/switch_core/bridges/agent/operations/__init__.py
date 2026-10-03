"""Agent operations: defined once, served through every front door."""

# Importing the definitions modules is what populates the registry. Both front
# doors read the registry, so this import is the single point at which the
# operation set comes into existence.
from switch_core.bridges.agent.operations import (
    agent_management as _agent_management,  # noqa: E402,F401
)
from switch_core.bridges.agent.operations import (
    definitions as _definitions,  # noqa: E402,F401
)
from switch_core.bridges.agent.operations.registry import (
    Operation,
    all_operations,
    declared_operations,
    get_operation,
    operation,
)

__all__ = [
    "Operation",
    "all_operations",
    "declared_operations",
    "get_operation",
    "operation",
]

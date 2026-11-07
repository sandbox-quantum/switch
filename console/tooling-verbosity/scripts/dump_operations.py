"""Print the agent operation catalog as `GET /agents/{id}/ops` serves it.

Read off the registry both front doors are built from, so the harness hands
the model the same tools a real server would. Every gated group is enabled,
as on a server with agent management turned on.

    cd core && uv run python ../console/tooling-verbosity/scripts/dump_operations.py
"""

from __future__ import annotations

import json

import switch_core.bridges.agent.operations.agent_management  # noqa: F401
import switch_core.bridges.agent.operations.definitions  # noqa: F401
from switch_core.bridges.agent.api.operations import list_operations
from switch_core.bridges.agent.operations.registry import (
    _GATED,
    enable_operation_group,
)

for group in list(_GATED):
    enable_operation_group(group)

print(json.dumps({"operations": list_operations()}, indent=2, sort_keys=True))

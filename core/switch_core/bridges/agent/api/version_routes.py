"""Authenticated version disclosure on the agent bridge (CHOO-1865).

Nothing about the server's version is reachable without authenticating. An
exact release string maps directly to known CVEs, and Switch is deployed
publicly by people we will never meet.

This endpoint is for diagnostics, periodic checks and bug reports; it is not on
the critical path. A connecting agent already learns the server's ranges from
the first frame of its event stream, and a refused one learns them from the 409
body — both authenticated, and both arriving without an extra call.

Disclosure is scoped to the caller's credential by *where the route lives*
rather than by inspecting the credential: this app authenticates agents, so it
answers for `agent-protocol` and nothing else. The gateway serves its own at
`/gateway/version` behind its own session cookie.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.db.models import Agent
from switch_core.version import server_declaration

router = APIRouter()


@router.get("/version")
async def get_version(
    _agent: Annotated[Agent, Depends(get_agent_from_scope)],
) -> dict[str, Any]:
    """What this switch-core is, and what it speaks to agents.

    `version` is null when switch-core cannot read its own version. Null means
    unknown; a client must render it as such rather than as current.
    """
    return server_declaration("agent-protocol")

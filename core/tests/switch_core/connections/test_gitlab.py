"""The shipped GitLab entry offers no read-only connection.

A token scoped mcp, read_api and read_user can still write through GitLab's
MCP server (a comment through save_note), so a "read" GitLab connection would
tell its owner something the vendor does not enforce.
"""

from __future__ import annotations

import pytest

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.adapters.oauth import Identity, SignIn
from switch_core.connections.flows import Exchange, FlowError, ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import TENANT_ZERO_ID
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.test_broker import _user

GITLAB = CATALOG["gitlab"].definition
SCOPES = ["mcp", "api", "read_user"]


async def test_a_gitlab_flow_cannot_fall_back_to_read_consent(session_factory):
    async with session_factory() as session:
        owner = await _user(session, "gitlab-owner")
        await session.commit()
    flows = ServiceFlows(
        "https://switch.example.test", {}, SignInFlows(session_factory, TEST_KEYRING)
    )
    flow = await flows.start(
        definition=GITLAB,
        tenant_id=TENANT_ZERO_ID,
        user_id=owner.id,
        state="synthetic-gitlab-state",
        port=39232,
        completion_secret="synthetic-completion",
        owner_label="gitlab-owner",
        choices={},
    )
    details = flow.stored.details
    assert (details["consent"], details["scopes"]) == ("write", SCOPES)

    def consent(scopes: list[str]) -> str:
        return flows.consent(
            Exchange(
                flow.stored,
                SignIn(ConnectionSecret({}), scopes, "synthetic-client"),
                Identity("123", "ada"),
                {},
            )
        )

    assert consent(SCOPES) == "write"
    for partial in (["mcp", "read_api", "read_user"], ["mcp", "read_user"], []):
        with pytest.raises(FlowError, match="granted less"):
            consent(partial)

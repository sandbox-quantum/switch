"""Real database checks for rendering a stack-bound session grant."""

import json
import time

import pytest
import yaml

from switch_core.connections.broker import Principal
from switch_core.db.models import Agent
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.test_broker import STORE, _pass_through
from tests.switch_core.connections.test_oauth_fields import definition


@pytest.mark.parametrize("relink", [False, True])
async def test_stack_grant_destination_and_account_binding(
    session_factory, tmp_path, relink
):
    pt = await _pass_through(
        session_factory,
        tmp_path / "catalog",
        expires_in=3000,
        entry=yaml.safe_dump(definition().model_dump(exclude_none=True)),
    )
    async with session_factory() as session:
        connection = await STORE.get_connection(session, pt.world.owner.id, "example")
        connection.encrypted_secret = TEST_KEYRING.encrypt(
            json.dumps(
                {
                    "access_token": "example-access",
                    "refresh_token": "example-refresh",
                    "expires_at": time.time() + 3000,
                    "connection_fields": {"stack": "example.grafana.net"},
                }
            )
        )
        if relink:
            connection.account_id = "another-account"
        await session.commit()
        agent = await session.get(Agent, pt.world.agent.id)
        grants = await pt.broker.grants_for(session, agent, Principal.agent_key())
    if relink:
        assert grants == []
    else:
        assert grants[0]["mcp_servers"] == [
            {
                "name": "example",
                "url": "https://mcp.example.test/mcp/example.grafana.net",
                "headers": {"Authorization": "Bearer {token}"},
            }
        ]
        assert "example-access" not in json.dumps(grants)
        assert "example-refresh" not in json.dumps(grants)

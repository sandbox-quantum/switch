"""A vendor with no read-only scopes must never get a read-labelled grant."""

from types import SimpleNamespace

import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.flows import FlowError, ServiceFlows
from switch_core.connections.loader import ConnectionAccess, ConnectionDefinition
from switch_core.connections.registry import every_scope
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


@pytest.mark.parametrize("levels", ["read", "write", "both"])
def test_oauth_accepts_each_nonempty_shape(levels):
    data = yaml.safe_load(OAUTH_ENTRY)
    if levels == "read":
        del data["access"]["write"]
    if levels == "write":
        del data["access"]["read"]
    definition = ConnectionDefinition.model_validate(data)
    assert every_scope(definition) == (
        ["read:items"] if levels == "read" else ["read:items", "write:items"]
    )
    assert (definition.access.read is None) == (levels == "write")


@pytest.mark.parametrize("data", [{}, {"read": None, "write": None}])
def test_access_rejects_no_levels(data):
    with pytest.raises(ValidationError, match="at least one"):
        ConnectionAccess.model_validate(data)


@pytest.mark.parametrize(
    "granted,expected",
    [(["read:items", "write:items"], "write"), (["read:items"], None), ([], None)],
)
def test_write_only_consent_never_falls_back_to_read(granted, expected):
    exchange = SimpleNamespace(
        signed_in=SimpleNamespace(granted_scopes=granted),
        flow=SimpleNamespace(
            details={
                "name": "Example",
                "consent": "write",
                "read_scopes": None,
                "write_scopes": ["read:items", "write:items"],
            }
        ),
    )
    flows = ServiceFlows(None, None)
    if expected is None:
        with pytest.raises(FlowError, match="needs to write"):
            flows.consent(exchange)
    else:
        assert flows.consent(exchange) == expected


@pytest.mark.parametrize(
    "granted,expected",
    [(["read:items", "write:items"], "write"), (["read:items"], "read")],
)
def test_existing_two_level_consent_keeps_its_fallback(granted, expected):
    exchange = SimpleNamespace(
        signed_in=SimpleNamespace(granted_scopes=granted),
        flow=SimpleNamespace(
            details={
                "name": "Example",
                "consent": "write",
                "read_scopes": ["read:items"],
                "write_scopes": ["read:items", "write:items"],
            }
        ),
    )
    assert ServiceFlows(None, None).consent(exchange) == expected


async def test_write_only_grant_cannot_be_downgraded_or_used_after_grant_off(
    session_factory, tmp_path
):
    from sqlalchemy import delete

    from switch_core.connections.broker import Principal, ServiceError
    from switch_core.db.models import ServiceGrant
    from tests.switch_core.connections.test_broker import _pass_through

    text = OAUTH_ENTRY.replace('  read: { scopes: ["read:items"] }\n', "")
    pt = await _pass_through(
        session_factory, tmp_path / "catalog", expires_in=3000, entry=text
    )
    async with session_factory() as session:
        with pytest.raises(ServiceError, match="on or off"):
            await pt.broker.set_grant(
                session,
                agent=pt.world.agent,
                actor_id=pt.world.owner.id,
                service="example",
                access="read",
                tool_mode=None,
                tools=None,
                resources={},
            )
        grant, _ = await pt.broker.set_grant(
            session,
            agent=pt.world.agent,
            actor_id=pt.world.owner.id,
            service="example",
            access=None,
            tool_mode=None,
            tools=None,
            resources={},
        )
        assert grant.access == "write"
        await session.commit()
        grants = await pt.broker.grants_for(
            session, pt.world.agent, Principal.agent_key()
        )
        assert len(grants) == 1
        await session.execute(
            delete(ServiceGrant).where(ServiceGrant.agent_id == pt.world.agent.id)
        )
        await session.commit()
        assert (
            await pt.broker.grants_for(session, pt.world.agent, Principal.agent_key())
            == []
        )

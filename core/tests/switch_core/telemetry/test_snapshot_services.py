"""The snapshot's service connector counts: who connected a service, which
agents may use one, and which used one this week."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ServiceTokenIssuance
from switch_core.telemetry.snapshot import collect_usage
from tests.switch_core.connections.test_broker import STORE, _connect, _user, _world


def _issuance(
    agent_id: str, owner_id: str, created_at: datetime
) -> ServiceTokenIssuance:
    return ServiceTokenIssuance(
        grant_id="g",
        agent_id=agent_id,
        owner_id=owner_id,
        service="github",
        principal="agent_key",
        permissions={},
        resources={},
        expires_at=created_at + timedelta(hours=1),
        token_sha256=f"sha-{agent_id}-{created_at.timestamp()}",
        revoke_requested=False,
        attempts=0,
        created_at=created_at,
    )


async def test_service_counts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    now = datetime.now(UTC)
    world = await _world(session_factory)
    async with session_factory() as session:
        bob = await _user(session, "bob")
        await _connect(session, bob.id, account_id="2002")
        await STORE.mark_needs_reauthorization(
            session, bob.id, "github", "refresh_refused"
        )
        session.add_all(
            [
                _issuance(world.agent.id, world.owner.id, now - timedelta(hours=1)),
                _issuance(world.agent.id, world.owner.id, now - timedelta(hours=2)),
                _issuance("gone-agent", world.owner.id, now - timedelta(days=20)),
            ]
        )
        await session.commit()

    counts = await collect_usage(session_factory, now=now)
    properties = counts.as_event_properties(session_live_count=0)

    assert {
        name: properties[name]
        for name in (
            "service_connection_count",
            "service_connection_needs_attention_count",
            "service_connected_account_count",
            "service_connected_workspace_count",
            "service_grant_count",
            "service_granted_agent_count",
            "service_agent_active_7d",
            "service_token_issued_7d",
            "service_github_connection_count",
            "service_google_workspace_connection_count",
        )
    } == {
        "service_connection_count": 2,
        "service_connection_needs_attention_count": 1,
        "service_connected_account_count": 1,
        "service_connected_workspace_count": 1,
        "service_grant_count": 1,
        "service_granted_agent_count": 1,
        "service_agent_active_7d": 1,
        "service_token_issued_7d": 2,
        "service_github_connection_count": 2,
        "service_google_workspace_connection_count": 0,
    }

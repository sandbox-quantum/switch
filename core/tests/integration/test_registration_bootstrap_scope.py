"""The deployment-wide AGENT_REGISTRATION_TOKEN must not grant admin authority.

Before this fix, any holder of that one shared secret registered agents owned
by the seeded admin user. Since room/resource authorization treats "owned by
an admin" as "acts with admin authority" (`ProtocolService._resolve_acting_identity`),
that made the token a privilege-escalation vector: a colleague given the
deployment secret to bring up their own agent got an agent that could bypass
`read_visibility`/`write_visibility` on every room and resource in the
deployment, not just their own.

This test registers an agent the same way a standalone agent does — presenting
REGISTRATION_TOKEN to `register_agent_with_token` — and proves the resulting
agent is owned by a dedicated, non-admin account instead.
"""

from __future__ import annotations

import pytest

from tests.integration.conftest import REGISTRATION_TOKEN, Harness, SessionEnv

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


async def test_bootstrap_token_registration_does_not_own_as_admin(
    harness: Harness, session_env: SessionEnv
) -> None:
    result = await harness.register_agent_via_registration_token(
        "colleague-agent", REGISTRATION_TOKEN
    )

    async with session_env.session_factory() as session:  # type: ignore[operator]
        agent = await harness.protocol.agent_store.get(session, result.agent_id)
        assert agent is not None
        assert agent.owner_id is not None
        assert agent.owner_id != harness.owner_id, (
            "agent registered through the deployment-wide bootstrap token "
            "must not be owned by the admin user"
        )

        owner = await session_env.user_store.get(session, agent.owner_id)
        assert owner is not None
        assert owner.role != "admin", (
            "agent registered through the deployment-wide bootstrap token "
            "must not inherit admin authority"
        )


async def test_bootstrap_token_registration_is_repeatable_and_stable(
    harness: Harness, session_env: SessionEnv
) -> None:
    """Two different colleagues sharing the same bootstrap token land on the
    same non-admin owner, rather than each minting a new one."""
    first = await harness.register_agent_via_registration_token(
        "colleague-one", REGISTRATION_TOKEN
    )
    second = await harness.register_agent_via_registration_token(
        "colleague-two", REGISTRATION_TOKEN
    )

    async with session_env.session_factory() as session:  # type: ignore[operator]
        agent_one = await harness.protocol.agent_store.get(session, first.agent_id)
        agent_two = await harness.protocol.agent_store.get(session, second.agent_id)
        assert agent_one is not None and agent_two is not None
        assert agent_one.owner_id == agent_two.owner_id

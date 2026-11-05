"""A controller is not enrolled for someone who has since lost the workspace.

An enrollment code is one more bearer credential, and enrolling with it mints
the controller's own. A code issued while its owner was a member and used
after they stopped being one must not leave a working controller behind with
no standing to answer to (`db/standing.py`).
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, AgentController, TenantMember
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    fixture,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def test_a_code_used_after_its_owner_left_enrolls_nothing(
    harness: Harness, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    owner = await add_member(session_factory, "leaver")
    async with harness.client() as client:
        code = await client.post(
            "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
        )
        assert code.status_code == 201, code.text

        async with session_factory() as session:
            await session.execute(
                delete(TenantMember).where(
                    TenantMember.tenant_id == TENANT_ZERO_ID,
                    TenantMember.user_id == owner.id,
                )
            )
            await session.commit()

        body = fixture("enroll_request.json")
        body["proof"]["code"] = code.json()["code"]
        enrolled = await client.post("/v1/management/controllers/enroll", json=body)

    assert enrolled.status_code == 403, enrolled.text
    async with session_factory() as session:
        controllers = await session.scalars(
            select(AgentController.id).where(AgentController.owner_id == owner.id)
        )
        assert list(controllers) == []

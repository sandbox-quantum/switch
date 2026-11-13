"""The operator overview's "Show name" through the role row-level security applies to (the
`rls_harness`), not the superuser the rest of the suite uses: a superuser
ignores every policy, so only this can show a read that production refuses."""

from __future__ import annotations

import uuid

from switch_core.db.models import Tenant, User
from switch_core.visibility.keyed_id import KeyedIdKind
from switch_core.visibility.read_views import RevealAnswer, _reveal_answer
from tests.conftest import RLSHarness


async def _seed(harness: RLSHarness) -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:8]
    tenant_id = f"tenant-reveal-{suffix}"
    async with harness.owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name="Acme Example"))
        user = User(name="Sam Example", email=f"sam-{suffix}@example.com", role="user")
        session.add(user)
        await session.commit()
        return tenant_id, user.id


async def test_a_workspace_s_name_is_read_with_that_workspace_bound(
    rls_harness: RLSHarness,
) -> None:
    tenant_id, _ = await _seed(rls_harness)
    answer = await _reveal_answer(
        rls_harness.restricted, KeyedIdKind.WORKSPACE, tenant_id
    )
    assert answer == RevealAnswer(name="Acme Example", email=None)


async def test_a_person_s_name_is_read_with_nothing_bound(
    rls_harness: RLSHarness,
) -> None:
    _, user_id = await _seed(rls_harness)
    answer = await _reveal_answer(rls_harness.restricted, KeyedIdKind.USER, user_id)
    assert answer is not None
    assert answer.name == "Sam Example"


async def test_an_unknown_workspace_reads_as_nothing(rls_harness: RLSHarness) -> None:
    answer = await _reveal_answer(
        rls_harness.restricted, KeyedIdKind.WORKSPACE, f"missing-{uuid.uuid4().hex}"
    )
    assert answer is None

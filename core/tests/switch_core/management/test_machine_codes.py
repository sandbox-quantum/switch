"""Core never hands a box a dead registration code. Agent management's side: whether a code can still enroll,
and retiring an unused one so a fresh code is the only live one. A code something already enrolled with is never
touched, so a box that re-registers can't cut off a working controller. Against Postgres."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.session_scope import tenant_session
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    fixture,
)


def _harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _code(harness: Harness, owner) -> str:
    async with harness.client() as client:
        response = await client.post(
            "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
        )
    assert response.status_code == 201, response.text
    return str(response.json()["code"])


async def _enroll(harness: Harness, code: str):
    body = fixture("enroll_request.json")
    body["proof"]["code"] = code
    async with harness.client() as client:
        return await client.post("/v1/management/controllers/enroll", json=body)


async def _live(harness: Harness, code: str, now: datetime) -> bool:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        return await harness.management.service.machine_enrollment_code_live(
            session, code, now
        )


async def _retire(harness: Harness, code: str) -> None:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await harness.management.service.retire_machine_enrollment_code(session, code)
        await session.commit()


async def test_a_fresh_code_is_live_and_an_expired_one_is_not(session_factory) -> None:
    harness = _harness(session_factory)
    owner = await add_member(harness.session_factory, "ada")
    code = await _code(harness, owner)
    now = datetime.now(UTC)
    assert await _live(harness, code, now)
    assert not await _live(harness, code, now + timedelta(days=2))
    assert not await _live(harness, "swce_never-issued", now)


async def test_retiring_an_unused_code_makes_it_stop_working(session_factory) -> None:
    harness = _harness(session_factory)
    owner = await add_member(harness.session_factory, "ada")
    code = await _code(harness, owner)
    await _retire(harness, code)
    refused = await _enroll(harness, code)
    assert refused.status_code == 401
    assert refused.json()["error"]["code"] == "enrollment_code_invalid"
    assert not await _live(harness, code, datetime.now(UTC))


async def test_a_used_code_is_not_live_and_retiring_it_never_cuts_off_its_controller(
    session_factory,
) -> None:
    """The box enrolled, then lost its registration and asks again. The old code is spent; retiring it
    must leave the controller it enrolled working."""
    harness = _harness(session_factory)
    owner = await add_member(harness.session_factory, "ada")
    code = await _code(harness, owner)
    enrolled = await _enroll(harness, code)
    assert enrolled.status_code == 201, enrolled.text
    controller_id = enrolled.json()["controller_id"]
    credential = enrolled.json()["credential"]

    assert not await _live(harness, code, datetime.now(UTC))
    await _retire(harness, code)

    async with harness.client() as client:
        token = await client.post(
            f"/v1/management/controllers/{controller_id}/token",
            json={"credential": credential},
        )
        assert token.status_code == 200, token.text
        assignment = await client.get(
            f"/v1/management/controllers/{controller_id}/assignment",
            headers={"Authorization": f"Bearer {token.json()['access_token']}"},
        )
    assert assignment.status_code == 200, assignment.text

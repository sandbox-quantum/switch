"""The deployment operator making another operator a regular account
(POST /users/{id}/demote).

Against a real database, with the app `test_admin_delete_user.py` builds.
Only the account at the configured admin address stays an operator whatever
happens, and nobody demotes themselves here; the server always keeps one.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, ServerAuditEvent, TenantMember, User
from tests.switch_core.accounts.test_account_deletion import ADMIN_EMAIL
from tests.switch_core.gateway.test_admin_delete_user import _app, _client, _people
from tests.switch_core.gateway.test_tenant_api_routes import _make_member


async def _second_operator(session_factory: async_sessionmaker[AsyncSession]) -> str:
    return await _make_member(
        session_factory,
        name="second-operator",
        tenant_id=TENANT_ZERO_ID,
        role="admin",
        user_role="admin",
    )


async def _role(session_factory: async_sessionmaker[AsyncSession], user_id: str) -> str:
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        return user.role


async def _events(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[tuple[str, str | None, str | None, dict | None]]:
    async with session_factory() as session:
        return [
            (event.action, event.actor_user_id, event.target_id, event.details)
            for event in await session.scalars(
                select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
            )
        ]


async def test_an_operator_makes_another_a_regular_account_and_it_is_logged(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    configured, _ = await _people(session_factory)
    other = await _second_operator(session_factory)

    async with _client(_app(session_factory), configured, ADMIN_EMAIL) as client:
        response = await client.post(f"/users/{other}/demote")

    assert response.status_code == 200, response.text
    assert response.json()["role"] == "user"
    assert response.json()["can_demote"] is False
    assert await _role(session_factory, other) == "user"
    assert await _events(session_factory) == [
        ("user.demoted", configured, other, {"from": "admin", "to": "user"})
    ]
    # Their own workspace role is theirs, and stays.
    async with session_factory() as session:
        membership = await session.get(TenantMember, (TENANT_ZERO_ID, other))
    assert membership is not None and membership.role == "admin"


async def test_the_configured_administrator_account_stays_an_operator(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    configured, _ = await _people(session_factory)
    other = await _second_operator(session_factory)

    async with _client(
        _app(session_factory), other, "second-operator@example.invalid"
    ) as client:
        response = await client.post(f"/users/{configured}/demote")

    assert response.status_code == 409, response.text
    assert "administrator account" in response.json()["detail"]
    assert await _role(session_factory, configured) == "admin"
    assert await _events(session_factory) == []


async def test_an_operator_cannot_demote_themselves(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _people(session_factory)
    other = await _second_operator(session_factory)

    async with _client(
        _app(session_factory), other, "second-operator@example.invalid"
    ) as client:
        response = await client.post(f"/users/{other}/demote")

    assert response.status_code == 409, response.text
    assert "your own account" in response.json()["detail"]
    assert await _role(session_factory, other) == "admin"


async def test_a_regular_account_is_not_an_operator_to_demote(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    configured, member = await _people(session_factory)

    async with _client(_app(session_factory), configured, ADMIN_EMAIL) as client:
        response = await client.post(f"/users/{member}/demote")
        missing = await client.post("/users/nobody/demote")

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Not a platform operator"
    assert missing.status_code == 404, missing.text
    assert await _events(session_factory) == []


async def test_someone_who_is_not_an_operator_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, member = await _people(session_factory)
    other = await _second_operator(session_factory)

    async with _client(
        _app(session_factory), member, "leaving@example.invalid"
    ) as client:
        response = await client.post(f"/users/{other}/demote")

    assert response.status_code == 403, response.text
    assert await _role(session_factory, other) == "admin"


async def test_a_demoted_operator_can_demote_nobody(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Demoting an operator ends every session they hold
    (`db/session_version_ddl.py`), so the one they had open is refused on
    its very next request."""
    configured, _ = await _people(session_factory)
    first = await _second_operator(session_factory)
    second = await _make_member(
        session_factory,
        name="third-operator",
        tenant_id=TENANT_ZERO_ID,
        role="member",
        user_role="admin",
    )
    app = _app(session_factory)
    async with _client(app, first, "second-operator@example.invalid") as client:
        assert (await client.post(f"/users/{second}/demote")).status_code == 200

    async with _client(app, second, "third-operator@example.invalid") as client:
        response = await client.post(f"/users/{first}/demote")

    assert response.status_code == 401, response.text
    assert await _role(session_factory, first) == "admin"
    assert await _role(session_factory, configured) == "admin"

"""Ending a person's sessions everywhere (`users.session_version`).

Every session cookie carries the session version it was minted with, and one
that no longer matches the account's is refused. These drive real HTTP against
real Postgres, so the trigger that moves the version on a password or role
change (`db/session_version_ddl.py`) is the one under test, not a stand-in.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Annotated

import httpx
import jwt
from fastapi import Depends, FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ServerAuditEvent, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    JWT_ALGORITHM,
    AuthenticatedCaller,
    create_jwt,
    get_authenticated_caller,
    hash_password,
)
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring, Purpose

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = "password-one-1"

_USER_STORE = UserStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], email: str, role: str = "user"
) -> str:
    async with session_factory() as session:
        user = User(
            name=email.split("@")[0],
            email=email,
            role=role,
            password_hash=hash_password(_PASSWORD),
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _version(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> int:
    async with session_factory() as session:
        version = await _USER_STORE.session_version(session, user_id)
    assert version is not None
    return version


def _token(user_id: str, email: str, role: str, version: int) -> str:
    return create_jwt(
        user_id,
        email,
        role,
        _KEYRING,
        None,
        session_version=version,
        auth_time=datetime.now(UTC),
    )


def _client(app: FastAPI, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _status(app: FastAPI, token: str) -> int:
    async with _client(app, token) as client:
        return (await client.get("/auth/me")).status_code


class TestTheVersionIsChecked:
    async def test_a_cookie_from_before_the_sessions_ended_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "stale@example.invalid")
        app = _app(session_factory)
        token = _token(user_id, "stale@example.invalid", "user", 0)
        assert await _status(app, token) == 200

        async with session_factory() as session:
            await _USER_STORE.end_sessions(session, user_id)
            await session.commit()

        assert await _status(app, token) == 401
        fresh = _token(user_id, "stale@example.invalid", "user", 1)
        assert await _status(app, fresh) == 200

    async def test_the_routes_that_bind_no_workspace_check_it_too(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "unbound@example.invalid")
        app = _app(session_factory)
        stale = _token(user_id, "unbound@example.invalid", "user", 0)
        async with session_factory() as session:
            await _USER_STORE.end_sessions(session, user_id)
            await session.commit()

        async with _client(app, stale) as client:
            refused = await client.post("/auth/sessions/revoke")
        assert refused.status_code == 401
        assert await _version(session_factory, user_id) == 1

    async def test_a_route_reading_the_caller_without_a_workspace_checks_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "caller@example.invalid")
        app = _app(session_factory)

        @app.get("/caller")
        async def caller(
            who: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
        ) -> str:
            return who.id

        stale = _token(user_id, "caller@example.invalid", "user", 0)
        async with _client(app, stale) as client:
            before = await client.get("/caller")
        async with session_factory() as session:
            await _USER_STORE.end_sessions(session, user_id)
            await session.commit()
        async with _client(app, stale) as client:
            after = await client.get("/caller")

        assert before.json() == user_id
        assert after.status_code == 401
        assert after.json() == {"detail": "Session ended"}

    async def test_a_cookie_minted_before_the_claim_existed_counts_as_version_0(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "legacy@example.invalid")
        app = _app(session_factory)
        claims = jwt.decode(
            _token(user_id, "legacy@example.invalid", "user", 0),
            options={"verify_signature": False},
        )
        del claims["sv"]
        legacy = jwt.encode(
            claims,
            _KEYRING.derive(Purpose.SESSION),
            algorithm=JWT_ALGORITHM,
            headers={"kid": _KEYRING.current.id},
        )
        assert await _status(app, legacy) == 200

        async with session_factory() as session:
            await _USER_STORE.end_sessions(session, user_id)
            await session.commit()
        assert await _status(app, legacy) == 401


class TestWhatEndsSessions:
    async def test_changing_the_password_ends_other_sessions_but_keeps_this_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "changer@example.invalid"
        user_id = await _seed_user(session_factory, email)
        app = _app(session_factory)
        other_device = _token(user_id, email, "user", 0)

        async with _client(app, _token(user_id, email, "user", 0)) as client:
            changed = await client.put(
                "/auth/me/password",
                json={"current_password": _PASSWORD, "new_password": "password-two-2"},
            )
            assert changed.status_code == 200, changed.text
            assert (await client.get("/auth/me")).status_code == 200

        assert await _version(session_factory, user_id) == 1
        assert await _status(app, other_device) == 401

    async def test_a_password_reset_outside_the_gateway_ends_sessions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "reset@example.invalid")
        async with session_factory() as session:
            await session.execute(
                update(User)
                .where(User.id == user_id)
                .values(password_hash=hash_password("reset-by-hand-1"))
            )
            await session.commit()
        assert await _version(session_factory, user_id) == 1

    async def test_losing_the_server_admin_role_ends_sessions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "demoted@example.invalid"
        user_id = await _seed_user(session_factory, email, role="admin")
        app = _app(session_factory)
        token = _token(user_id, email, "admin", 0)
        assert await _status(app, token) == 200

        async with session_factory() as session:
            await session.execute(
                update(User).where(User.id == user_id).values(role="user")
            )
            await session.commit()

        assert await _version(session_factory, user_id) == 1
        assert await _status(app, token) == 401

    async def test_other_updates_leave_sessions_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory, "renamed@example.invalid")
        async with session_factory() as session:
            await session.execute(
                update(User).where(User.id == user_id).values(name="Renamed")
            )
            await session.execute(
                update(User).where(User.id == user_id).values(role="admin")
            )
            await session.commit()
        assert await _version(session_factory, user_id) == 0


class TestSigningOutEverywhere:
    async def test_logout_ends_only_this_device(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "logout@example.invalid"
        user_id = await _seed_user(session_factory, email)
        app = _app(session_factory)
        other_device = _token(user_id, email, "user", 0)

        async with _client(app, _token(user_id, email, "user", 0)) as client:
            assert (await client.post("/auth/logout")).status_code == 200

        assert await _status(app, other_device) == 200

    async def test_signing_out_of_all_devices_ends_every_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "everywhere@example.invalid"
        user_id = await _seed_user(session_factory, email)
        app = _app(session_factory)
        this_device = _token(user_id, email, "user", 0)
        other_device = _token(user_id, email, "user", 0)

        async with _client(app, this_device) as client:
            ended = await client.post("/auth/sessions/revoke")
        assert ended.status_code == 200, ended.text
        assert "switch_auth" in ended.headers.get("set-cookie", "")

        assert await _status(app, this_device) == 401
        assert await _status(app, other_device) == 401
        async with session_factory() as session:
            actions = (
                await session.scalars(
                    select(ServerAuditEvent.action).where(
                        ServerAuditEvent.target_id == user_id
                    )
                )
            ).all()
        assert actions == ["user.sessions_ended"]

    async def test_the_operator_can_sign_someone_out_everywhere(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator_id = await _seed_user(
            session_factory, "operator@example.invalid", role="admin"
        )
        person = "person@example.invalid"
        person_id = await _seed_user(session_factory, person)
        app = _app(session_factory)
        person_token = _token(person_id, person, "user", 0)

        operator = _token(operator_id, "operator@example.invalid", "admin", 0)
        async with _client(app, operator) as client:
            ended = await client.post(f"/users/{person_id}/sessions/revoke")
        assert ended.status_code == 200, ended.text

        assert await _status(app, person_token) == 401
        assert await _status(app, operator) == 200
        async with session_factory() as session:
            event = (
                await session.scalars(
                    select(ServerAuditEvent).where(
                        ServerAuditEvent.target_id == person_id
                    )
                )
            ).one()
        assert (event.action, event.actor_user_id) == (
            "user.sessions_ended",
            operator_id,
        )

    async def test_only_the_operator_can_sign_someone_else_out(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        mallory = "mallory@example.invalid"
        mallory_id = await _seed_user(session_factory, mallory)
        victim = "victim@example.invalid"
        victim_id = await _seed_user(session_factory, victim)
        app = _app(session_factory)

        async with _client(app, _token(mallory_id, mallory, "user", 0)) as client:
            refused = await client.post(f"/users/{victim_id}/sessions/revoke")
        assert refused.status_code == 403
        assert await _version(session_factory, victim_id) == 0

    async def test_the_operator_naming_no_account_gets_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator_id = await _seed_user(
            session_factory, "op404@example.invalid", role="admin"
        )
        app = _app(session_factory)
        token = _token(operator_id, "op404@example.invalid", "admin", 0)
        async with _client(app, token) as client:
            missing = await client.post("/users/no-such-user/sessions/revoke")
        assert missing.status_code == 404

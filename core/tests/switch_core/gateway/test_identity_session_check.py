"""A session that signed in through WorkOS AuthKit stands on its AuthKit
session: every authenticated path refuses it once that has ended, a re-mint
keeps it, and the gateway follows it with WorkOS (`gateway/identity_sessions.py`).

Real HTTP against real Postgres; WorkOS is a stand-in.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated

import httpx
import jwt
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.identity_session_store import IdentitySessionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    create_jwt,
    decode_jwt,
    get_authenticated_caller,
    get_authenticated_user_id,
    session_is_current,
)
from switch_core.gateway.auth_routes import router
from switch_core.gateway.identity_sessions import CHECK_EVERY, IdentitySessions
from switch_core.keys import Keyring, Purpose
from switch_core.workos_authkit import AuthKitUnavailable

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_USERS = UserStore()
_STORE = IdentitySessionStore()


class _WorkOS:
    """Stands in for AuthKit's session listing."""

    def __init__(self, active: set[str]) -> None:
        self.active = active
        self.asked: list[str] = []
        self.fail: Exception | None = None

    async def active_session_ids(self, user_id: str) -> set[str]:
        self.asked.append(user_id)
        if self.fail is not None:
            raise self.fail
        return set(self.active)


def _app(
    session_factory: async_sessionmaker[AsyncSession], workos: _WorkOS | None
) -> tuple[FastAPI, IdentitySessions]:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)

    @app.get("/caller")
    async def caller(
        who: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    ) -> dict[str, str]:
        return {"id": who.id}

    @app.get("/user-id")
    async def user_id(
        who: Annotated[str, Depends(get_authenticated_user_id)],
    ) -> dict[str, str]:
        return {"id": who}

    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USERS
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
    )
    follower = IdentitySessions(session_factory, workos)  # type: ignore[arg-type]
    app.state.identity_sessions = follower
    return app, follower


async def _person(session_factory: async_sessionmaker[AsyncSession], email: str) -> str:
    async with session_factory() as session:
        user = User(name=email.split("@")[0], email=email, role="user")
        await _USERS.create(session, user)
        await session.commit()
        return user.id


async def _signed_in(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    session_id: str,
    checked_at: datetime,
) -> str:
    async with session_factory() as session:
        row_id = await _STORE.record(
            session,
            user_id=user_id,
            provider="workos",
            session_id=session_id,
            followed=True,
            now=checked_at,
        )
        await session.commit()
        return row_id


def _cookie(user_id: str, email: str, identity_session: str | None) -> str:
    return create_jwt(
        user_id,
        email,
        "user",
        _KEYRING,
        None,
        session_version=0,
        auth_time=datetime.now(UTC),
        identity_session=identity_session,
    )


def _client(app: FastAPI, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _end(session_factory: async_sessionmaker[AsyncSession], row_id: str) -> None:
    async with session_factory() as session:
        await _STORE.end(session, [row_id], datetime.now(UTC))
        await session.commit()


async def _settle(follower: IdentitySessions) -> None:
    await asyncio.gather(*list(follower._tasks))


PATHS = [
    ("GET", "/auth/me"),  # get_current_user
    ("GET", "/user-id"),  # get_authenticated_user_id
    ("POST", "/auth/refresh"),  # get_current_user, re-mints
    ("GET", "/caller"),  # get_authenticated_caller
]


@pytest.mark.parametrize(("method", "path"), PATHS)
async def test_every_path_refuses_a_session_whose_sign_in_ended(
    session_factory: async_sessionmaker[AsyncSession], method: str, path: str
) -> None:
    user_id = await _person(
        session_factory, f"ended-{path.strip('/').replace('/', '-')}@example.test"
    )
    row_id = await _signed_in(session_factory, user_id, f"s-{path}", datetime.now(UTC))
    app, _follower = _app(session_factory, None)
    token = _cookie(user_id, "x@example.test", row_id)

    async with _client(app, token) as client:
        assert (await client.request(method, path)).status_code == 200
    await _end(session_factory, row_id)
    async with _client(app, token) as client:
        refused = await client.request(method, path)
    assert refused.status_code == 401
    assert refused.json()["detail"] == "Your sign-in has ended. Sign in again."


async def test_a_cookie_naming_someone_elses_sign_in_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-isid@example.test")
    eve = await _person(session_factory, "eve-isid@example.test")
    adas = await _signed_in(session_factory, ada, "s-ada", datetime.now(UTC))
    app, _ = _app(session_factory, None)
    async with _client(app, _cookie(eve, "eve-isid@example.test", adas)) as client:
        assert (await client.get("/auth/me")).status_code == 401


async def test_a_cookie_naming_no_recorded_sign_in_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-missing@example.test")
    app, _ = _app(session_factory, None)
    async with _client(
        app, _cookie(ada, "ada-missing@example.test", "no-such-row")
    ) as client:
        assert (await client.get("/auth/me")).status_code == 401


async def test_a_re_mint_keeps_the_sign_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-remint@example.test")
    row_id = await _signed_in(session_factory, ada, "s-remint", datetime.now(UTC))
    app, _ = _app(session_factory, None)
    async with _client(app, _cookie(ada, "ada-remint@example.test", row_id)) as client:
        response = await client.post("/auth/refresh")
    assert response.status_code == 200
    renewed = response.cookies["switch_auth"]
    assert decode_jwt(renewed, _KEYRING)["isid"] == row_id


async def test_a_password_session_names_no_sign_in_and_needs_no_follower(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-plain@example.test")
    app, _ = _app(session_factory, None)
    del app.state.identity_sessions
    async with _client(app, _cookie(ada, "ada-plain@example.test", None)) as client:
        response = await client.post("/auth/refresh")
    assert response.status_code == 200
    assert "isid" not in decode_jwt(response.cookies["switch_auth"], _KEYRING)


async def test_a_sign_in_not_checked_lately_is_asked_about_and_kept_while_alive(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-alive@example.test")
    stale = datetime.now(UTC) - CHECK_EVERY - timedelta(minutes=2)
    row_id = await _signed_in(session_factory, ada, "s-alive", stale)
    workos = _WorkOS({"s-alive", "s-of-another-app"})
    app, follower = _app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-alive@example.test", row_id)) as client:
        assert (await client.get("/auth/me")).status_code == 200
        await _settle(follower)
        assert (await client.get("/auth/me")).status_code == 200
    assert workos.asked == [ada]
    async with session_factory() as session:
        row = await _STORE.get(session, row_id)
    assert row is not None and row.ended_at is None and row.checked_at > stale


async def test_a_sign_in_ended_at_workos_ends_the_switch_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-gone@example.test")
    stale = datetime.now(UTC) - CHECK_EVERY - timedelta(minutes=2)
    row_id = await _signed_in(session_factory, ada, "s-gone", stale)
    app, follower = _app(session_factory, _WorkOS({"s-other"}))
    async with _client(app, _cookie(ada, "ada-gone@example.test", row_id)) as client:
        assert (await client.get("/auth/me")).status_code == 200
        await _settle(follower)
        assert (await client.get("/auth/me")).status_code == 401


async def test_a_sign_in_checked_lately_is_not_asked_about(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-fresh@example.test")
    row_id = await _signed_in(session_factory, ada, "s-fresh", datetime.now(UTC))
    workos = _WorkOS(set())
    app, follower = _app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-fresh@example.test", row_id)) as client:
        assert (await client.get("/auth/me")).status_code == 200
    await _settle(follower)
    assert workos.asked == []


async def test_requests_at_once_ask_workos_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-once@example.test")
    stale = datetime.now(UTC) - CHECK_EVERY - timedelta(minutes=2)
    row_id = await _signed_in(session_factory, ada, "s-once", stale)
    workos = _WorkOS({"s-once"})
    app, follower = _app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-once@example.test", row_id)) as client:
        await asyncio.gather(*(client.get("/auth/me") for _ in range(5)))
    await _settle(follower)
    assert workos.asked == [ada]


async def test_workos_not_answering_keeps_the_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-down@example.test")
    stale = datetime.now(UTC) - CHECK_EVERY - timedelta(minutes=2)
    row_id = await _signed_in(session_factory, ada, "s-down", stale)
    workos = _WorkOS(set())
    workos.fail = AuthKitUnavailable("WorkOS answered 503.")
    app, follower = _app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-down@example.test", row_id)) as client:
        assert (await client.get("/auth/me")).status_code == 200
        await _settle(follower)
        assert (await client.get("/auth/me")).status_code == 200
    async with session_factory() as session:
        assert (await _STORE.get(session, row_id)).ended_at is None  # type: ignore[union-attr]


async def test_without_authkit_an_ended_sign_in_is_still_refused_but_none_is_asked_about(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-off@example.test")
    stale = datetime.now(UTC) - CHECK_EVERY - timedelta(minutes=2)
    row_id = await _signed_in(session_factory, ada, "s-off", stale)
    app, follower = _app(session_factory, None)
    async with _client(app, _cookie(ada, "ada-off@example.test", row_id)) as client:
        assert (await client.get("/auth/me")).status_code == 200
        assert not follower._tasks
        await _end(session_factory, row_id)
        assert (await client.get("/auth/me")).status_code == 401


async def test_an_open_socket_asks_again_and_closes_once_the_sign_in_ended(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-socket@example.test")
    row_id = await _signed_in(session_factory, ada, "s-socket", datetime.now(UTC))
    app, _ = _app(session_factory, None)
    connection = SimpleNamespace(app=app)

    async def current() -> bool:
        return await session_is_current(
            connection,  # type: ignore[arg-type]
            session_factory,
            _USERS,
            ada,
            0,
            row_id,
        )

    assert await current() is True
    await _end(session_factory, row_id)
    assert await current() is False


# ── Signing out ──────────────────────────────────────────────────────────────


class _AuthKitSignOut(_WorkOS):
    """Stands in for AuthKit's sign-out and revoke calls."""

    def __init__(self) -> None:
        super().__init__(set())
        self.revoked: list[str] = []
        self.refuse: set[str] = set()

    async def revoke_session(self, session_id: str) -> None:
        if session_id in self.refuse:
            raise AuthKitUnavailable("WorkOS answered 503.")
        self.revoked.append(session_id)

    def logout_url(self, session_id: str, return_to: str | None) -> str:
        return f"https://api.workos.example.test/logout?session_id={session_id}&return_to={return_to}"


def _sign_out_app(
    session_factory: async_sessionmaker[AsyncSession], workos: _AuthKitSignOut | None
) -> FastAPI:
    app, follower = _app(session_factory, workos)
    app.dependency_overrides[gw_deps.get_identity_sessions] = lambda: follower
    config = SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
        dashboard_base_url="https://switch.example.test",
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: config
    return app


async def _live(session_factory: async_sessionmaker[AsyncSession], row_id: str) -> bool:
    async with session_factory() as session:
        row = await _STORE.get(session, row_id)
    return row is not None and row.ended_at is None


async def test_signing_out_ends_the_authkit_session_here_and_at_workos(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-out@example.test")
    row_id = await _signed_in(session_factory, ada, "s-out", datetime.now(UTC))
    app = _sign_out_app(session_factory, _AuthKitSignOut())
    token = _cookie(ada, "ada-out@example.test", row_id)
    async with _client(app, token) as client:
        response = await client.post("/auth/logout")
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "end_session_url": (
            "https://api.workos.example.test/logout?session_id=s-out"
            "&return_to=https://switch.example.test/login"
        ),
    }
    assert 'switch_auth=""' in response.headers["set-cookie"]
    assert not await _live(session_factory, row_id)
    # Any copy of the cookie is refused now.
    async with _client(app, token) as client:
        assert (await client.get("/auth/me")).status_code == 401


async def test_an_expired_cookie_still_ends_what_it_stood_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-expired@example.test")
    row_id = await _signed_in(session_factory, ada, "s-expired", datetime.now(UTC))
    expired = jwt.encode(
        {
            "sub": ada,
            "email": "ada-expired@example.test",
            "role": "user",
            "tenant_id": None,
            "sv": 0,
            "isid": row_id,
            "iat": 1_700_000_000,
            "exp": 1_700_000_100,
        },
        _KEYRING.derive(Purpose.SESSION),
        algorithm="HS256",
        headers={"kid": _KEYRING.current.id},
    )
    app = _sign_out_app(session_factory, _AuthKitSignOut())
    async with _client(app, expired) as client:
        response = await client.post("/auth/logout")
    assert response.json()["end_session_url"] is not None
    assert not await _live(session_factory, row_id)


async def test_signing_out_of_a_password_session_sends_the_browser_nowhere(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-pw-out@example.test")
    app = _sign_out_app(session_factory, _AuthKitSignOut())
    async with _client(app, _cookie(ada, "ada-pw-out@example.test", None)) as client:
        response = await client.post("/auth/logout")
    assert response.json() == {"ok": True, "end_session_url": None}


async def test_without_authkit_signing_out_ends_the_session_here_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-off-out@example.test")
    row_id = await _signed_in(session_factory, ada, "s-off-out", datetime.now(UTC))
    app = _sign_out_app(session_factory, None)
    async with _client(app, _cookie(ada, "ada-off-out@example.test", row_id)) as client:
        response = await client.post("/auth/logout")
    assert response.json() == {"ok": True, "end_session_url": None}
    assert not await _live(session_factory, row_id)


async def test_signing_out_everywhere_revokes_switchs_other_sessions_at_workos(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-all@example.test")
    here = await _signed_in(session_factory, ada, "s-here", datetime.now(UTC))
    laptop = await _signed_in(session_factory, ada, "s-laptop", datetime.now(UTC))
    gone = await _signed_in(session_factory, ada, "s-gone-already", datetime.now(UTC))
    workos = _AuthKitSignOut()
    app = _sign_out_app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-all@example.test", here)) as client:
        response = await client.post("/auth/sessions/revoke")
    assert response.status_code == 200
    assert sorted(workos.revoked) == ["s-gone-already", "s-laptop"]
    assert "session_id=s-here" in response.json()["end_session_url"]
    for row_id in (here, laptop, gone):
        assert not await _live(session_factory, row_id)


async def test_a_session_workos_would_not_revoke_is_reported_and_the_sign_out_still_carried(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _person(session_factory, "ada-partial@example.test")
    here = await _signed_in(session_factory, ada, "s-here-2", datetime.now(UTC))
    stuck = await _signed_in(session_factory, ada, "s-stuck", datetime.now(UTC))
    workos = _AuthKitSignOut()
    workos.refuse = {"s-stuck"}
    app = _sign_out_app(session_factory, workos)
    async with _client(app, _cookie(ada, "ada-partial@example.test", here)) as client:
        response = await client.post("/auth/sessions/revoke")
    assert response.status_code == 502
    assert "1 of your sign-ins" in response.json()["detail"]
    assert "session_id=s-here-2" in response.json()["end_session_url"]
    assert 'switch_auth=""' in response.headers["set-cookie"]
    # Left live, to be tried again; the Switch sessions ended regardless.
    assert await _live(session_factory, stuck)
    assert not await _live(session_factory, here)


async def test_the_operator_signing_someone_out_revokes_their_sessions_at_workos(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        operator = User(name="Op", email="op-revoke@example.test", role="admin")
        await _USERS.create(session, operator)
        await session.commit()
        operator_id = operator.id
    eve = await _person(session_factory, "eve-revoked@example.test")
    row_id = await _signed_in(session_factory, eve, "s-eve", datetime.now(UTC))
    workos = _AuthKitSignOut()
    app = _sign_out_app(session_factory, workos)
    async with _client(
        app, _cookie(operator_id, "op-revoke@example.test", None)
    ) as client:
        response = await client.post(f"/users/{eve}/sessions/revoke")
        assert response.status_code == 200, response.text
        workos.refuse = {"s-eve-2"}
        await _signed_in(session_factory, eve, "s-eve-2", datetime.now(UTC))
        failed = await client.post(f"/users/{eve}/sessions/revoke")
    assert workos.revoked == ["s-eve"]
    assert not await _live(session_factory, row_id)
    assert failed.status_code == 502

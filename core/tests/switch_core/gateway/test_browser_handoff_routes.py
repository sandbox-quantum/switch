"""The sign-in link Switch Console hands a browser (`gateway/browser_handoff.py`).

Real HTTP against real Postgres: Console's session mints a link, and a
browser that holds no session, or someone else's, peeks at and redeems it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.workspace_deletion import delete_workspace
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    BrowserHandoff,
    RevokedSession,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.browser_handoff_store import MINT_LIMIT
from switch_core.db.stores.identity_session_store import IdentitySessionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    BROWSER_HANDOFFS,
    JWT_ALGORITHM,
    REVOKED_SESSIONS,
    SESSION_MAX_AGE,
    TENANT_ARCHIVED,
    TENANT_SELECTION_INVALID,
    create_jwt,
    decode_jwt,
)
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.browser_handoff import (
    ENDED_DETAIL,
    EXPIRED_DETAIL,
    checked_next,
)
from switch_core.gateway.browser_handoff import router as handoff_router
from switch_core.gateway.identity_sessions import IdentitySessions
from switch_core.keys import Keyring, Purpose
from switch_core.workos_authkit import AuthKit
from tests.switch_core.gateway.login_limit_defaults import LOGIN_LIMIT_DEFAULTS

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_USER_STORE = UserStore()
_ACME = "acme"
# When Console's session signed in: the browser's must carry it on.
_SIGNED_IN = (datetime.now(UTC) - timedelta(hours=3)).replace(microsecond=0)
_CONSOLE_SID = "console-session-id"


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(handoff_router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
        **LOGIN_LIMIT_DEFAULTS,
    )
    app.state.identity_sessions = IdentitySessions(session_factory, None)
    return app


async def _person(
    session_factory: async_sessionmaker[AsyncSession], name: str, tenants: list[str]
) -> User:
    async with session_factory() as session:
        user = User(name=name.title(), email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        for tenant_id in tenants:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user.id, role="member")
            )
        await session.commit()
        return user


@pytest.fixture
async def people(
    session_factory: async_sessionmaker[AsyncSession],
) -> SimpleNamespace:
    async with session_factory() as session:
        session.add(Tenant(id=_ACME, slug=_ACME, name="Acme"))
        await session.commit()
    return SimpleNamespace(
        ada=await _person(session_factory, "ada", [TENANT_ZERO_ID, _ACME]),
        bob=await _person(session_factory, "bob", [TENANT_ZERO_ID]),
    )


@pytest.fixture
def app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    return _app(session_factory)


def _cookie(
    user: User,
    *,
    tenant_id: str | None = _ACME,
    session_id: str = _CONSOLE_SID,
    auth_time: datetime = _SIGNED_IN,
    identity_session: str | None = None,
) -> str:
    return create_jwt(
        user.id,
        user.email,
        user.role,
        _KEYRING,
        tenant_id,
        session_version=0,
        auth_time=auth_time,
        session_id=session_id,
        identity_session=identity_session,
    )


def _client(app: FastAPI, token: str | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token} if token is not None else None,
    )


async def _mint(app: FastAPI, token: str, next_path: str = "/rooms/r1") -> str:
    """Console asks for a link, and the code is read out of its fragment."""
    async with _client(app, token) as console:
        response = await console.post("/auth/handoff", json={"next": next_path})
    assert response.status_code == 201, response.text
    path = response.json()["path"]
    assert path.startswith("/auth/handoff#code=")
    return str(path.split("#code=", 1)[1])


async def _peek(app: FastAPI, code: str, token: str | None = None) -> httpx.Response:
    async with _client(app, token) as browser:
        return await browser.post("/auth/handoff/peek", json={"code": code})


async def _redeem(app: FastAPI, code: str, token: str | None = None) -> httpx.Response:
    async with _client(app, token) as browser:
        return await browser.post("/auth/handoff/redeem", json={"code": code})


async def _rows(factory: async_sessionmaker[AsyncSession]) -> list[BrowserHandoff]:
    async with factory() as session:
        return list(await session.scalars(select(BrowserHandoff)))


# ── Where a link may send the browser ───────────────────────────────────────


@pytest.mark.parametrize(
    "next_path",
    [
        "//evil.example",
        "//evil.example/rooms",
        "https://evil.example",
        "https://evil.example/rooms",
        "/\\evil.example",
        "/rooms\\..\\evil",
        "javascript:alert(1)",
        "rooms",
        "",
        "/\t/evil.example",
        "/\n/evil.example",
        "/gateway/auth/me",
        "/assets/index.js",
        "/rooms/" + "a" * 2050,
    ],
)
async def test_next_must_be_one_of_the_dashboard_s_pages(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
    next_path: str,
) -> None:
    async with _client(app, _cookie(people.ada)) as console:
        response = await console.post("/auth/handoff", json={"next": next_path})
    assert response.status_code == 400, response.text
    assert response.json()["detail"].startswith("next ")
    assert await _rows(session_factory) == []


@pytest.mark.parametrize(
    "next_path",
    [
        "/",
        "/rooms",
        "/rooms/r1",
        "/rooms/r1/",
        "/rooms/r1?workspace=acme",
        "/settings/org/guardrails#top",
        "/agents/a1?workspace=acme#rooms",
    ],
)
def test_a_page_keeps_its_query_and_fragment(next_path: str) -> None:
    assert checked_next(next_path) == next_path


async def test_a_body_with_anything_else_in_it_is_refused(
    app: FastAPI, people: SimpleNamespace
) -> None:
    async with _client(app, _cookie(people.ada)) as console:
        response = await console.post(
            "/auth/handoff", json={"next": "/rooms", "user_id": people.bob.id}
        )
    assert response.status_code == 422


async def test_minting_needs_a_session(
    app: FastAPI, people: SimpleNamespace, session_factory
) -> None:
    async with _client(app) as anonymous:
        response = await anonymous.post("/auth/handoff", json={"next": "/rooms"})
    assert response.status_code == 401
    assert await _rows(session_factory) == []


async def test_a_person_may_mint_only_so_many_links_a_minute(
    app: FastAPI, people: SimpleNamespace
) -> None:
    for _ in range(MINT_LIMIT):
        await _mint(app, _cookie(people.ada))
    async with _client(app, _cookie(people.ada)) as console:
        refused = await console.post("/auth/handoff", json={"next": "/rooms"})
    assert refused.status_code == 429
    assert 0 < int(refused.headers["retry-after"]) <= 60
    await _mint(app, _cookie(people.bob, tenant_id=TENANT_ZERO_ID))


async def test_a_refused_mint_says_when_the_next_will_be_let_through(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """`Retry-After` is the wait until the oldest mint counted leaves the
    minute, in whole seconds rounded up, not the whole minute."""
    for _ in range(MINT_LIMIT):
        await _mint(app, _cookie(people.ada))
    async with session_factory() as session:
        await session.execute(
            update(BrowserHandoff).values(created_at=func.now() - timedelta(seconds=10))
        )
        oldest = await session.scalar(select(BrowserHandoff.id).limit(1))
        await session.execute(
            update(BrowserHandoff)
            .where(BrowserHandoff.id == oldest)
            .values(created_at=func.now() - timedelta(seconds=35))
        )
        await session.commit()

    async with _client(app, _cookie(people.ada)) as console:
        refused = await console.post("/auth/handoff", json={"next": "/rooms"})

    assert refused.status_code == 429
    assert 20 < int(refused.headers["retry-after"]) <= 25


# ── Redeeming ───────────────────────────────────────────────────────────────


async def test_redeeming_signs_the_browser_in_with_a_session_of_its_own(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada), "/rooms/r1?workspace=acme")

    redeemed = await _redeem(app, code)

    assert redeemed.status_code == 200, redeemed.text
    assert redeemed.json() == {"next": "/rooms/r1?workspace=acme"}
    browser = redeemed.cookies["switch_auth"]
    claims = decode_jwt(browser, _KEYRING)
    assert claims["sub"] == people.ada.id
    assert claims["tenant_id"] == _ACME
    assert claims["auth_time"] == int(_SIGNED_IN.timestamp())
    assert claims["sv"] == 0
    # A new session, not a copy of Console's.
    assert claims["sid"] != _CONSOLE_SID
    [row] = await _rows(session_factory)
    assert (row.console_sid, row.browser_sid) == (_CONSOLE_SID, claims["sid"])
    assert claims["exp"] <= int((_SIGNED_IN + SESSION_MAX_AGE).timestamp())
    async with _client(app, browser) as signed_in:
        me = await signed_in.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["id"] == people.ada.id


async def test_a_link_is_redeemed_once(app: FastAPI, people: SimpleNamespace) -> None:
    code = await _mint(app, _cookie(people.ada))
    assert (await _redeem(app, code)).status_code == 200

    again = await _redeem(app, code)
    assert again.status_code == 410
    assert again.json() == {"detail": EXPIRED_DETAIL}
    assert "switch_auth" not in again.cookies
    assert (await _peek(app, code)).status_code == 410


async def test_an_expired_link_is_refused(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada))
    async with session_factory() as session:
        await session.execute(
            update(BrowserHandoff).values(
                expires_at=datetime.now(UTC) - timedelta(seconds=1)
            )
        )
        await session.commit()

    peeked = await _peek(app, code)
    assert peeked.status_code == 410
    assert peeked.json() == {"detail": EXPIRED_DETAIL}
    redeemed = await _redeem(app, code)
    assert redeemed.status_code == 410
    assert "switch_auth" not in redeemed.cookies


async def test_a_code_never_minted_is_refused(
    app: FastAPI, people: SimpleNamespace
) -> None:
    assert (await _peek(app, "made-up")).status_code == 410
    assert (await _redeem(app, "made-up")).status_code == 410


async def test_a_link_made_before_signing_out_everywhere_is_refused(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada))
    async with session_factory() as session:
        await _USER_STORE.end_sessions(session, people.ada.id)
        await session.commit()

    redeemed = await _redeem(app, code)
    assert redeemed.status_code == 410
    assert redeemed.json() == {"detail": ENDED_DETAIL}
    assert "switch_auth" not in redeemed.cookies
    # Spent all the same.
    assert (await _redeem(app, code)).json() == {"detail": EXPIRED_DETAIL}


async def test_a_link_made_by_a_console_session_signed_out_since_is_refused(
    app: FastAPI, people: SimpleNamespace
) -> None:
    console = _cookie(people.ada)
    code = await _mint(app, console)
    async with _client(app, console) as client:
        assert (await client.post("/auth/logout")).status_code == 200

    redeemed = await _redeem(app, code)
    assert redeemed.status_code == 410
    assert redeemed.json() == {"detail": ENDED_DETAIL}
    assert "switch_auth" not in redeemed.cookies


async def test_a_link_for_an_account_deleted_since_is_refused(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada))
    async with session_factory() as session:
        await session.execute(
            TenantMember.__table__.delete().where(TenantMember.user_id == people.ada.id)
        )
        await session.delete(await session.get(User, people.ada.id))
        await session.commit()

    assert (await _redeem(app, code)).status_code == 410


async def test_a_sign_in_older_than_a_session_may_live_is_refused(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada))
    async with session_factory() as session:
        await session.execute(
            update(BrowserHandoff).values(
                auth_time=datetime.now(UTC) - SESSION_MAX_AGE - timedelta(seconds=1)
            )
        )
        await session.commit()

    redeemed = await _redeem(app, code)
    assert redeemed.status_code == 401
    assert "switch_auth" not in redeemed.cookies


async def _leave_acme(factory: async_sessionmaker[AsyncSession], ada: User) -> None:
    async with tenant_session(factory, _ACME) as session:
        removed = await session.scalars(
            delete(TenantMember)
            .where(TenantMember.tenant_id == _ACME, TenantMember.user_id == ada.id)
            .returning(TenantMember.user_id)
        )
        assert list(removed) == [ada.id]
        await session.commit()


async def _archive_acme(factory: async_sessionmaker[AsyncSession], ada: User) -> None:
    async with tenant_session(factory, _ACME) as session:
        archived = await session.scalars(
            update(Tenant)
            .where(Tenant.id == _ACME)
            .values(archived_at=func.now())
            .returning(Tenant.id)
        )
        assert list(archived) == [_ACME]
        await session.commit()


async def _delete_acme(factory: async_sessionmaker[AsyncSession], ada: User) -> None:
    async with tenant_session(factory, _ACME) as session:
        await delete_workspace(session, _ACME, ada.id, ada.id)
        await session.commit()


@pytest.mark.parametrize(
    ("change", "refusal"),
    [
        (_leave_acme, TENANT_SELECTION_INVALID),
        (_archive_acme, TENANT_ARCHIVED),
        (_delete_acme, TENANT_SELECTION_INVALID),
    ],
    ids=["membership-removed", "workspace-archived", "workspace-deleted"],
)
async def test_a_link_to_a_workspace_left_since_signs_in_to_a_stale_selection(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
    change: Callable[[async_sessionmaker[AsyncSession], User], Awaitable[None]],
    refusal: str,
) -> None:
    """The workspace a link names can go between mint and redeem. Redeeming
    still signs the browser in, selecting it, and the browser's first
    workspace-bound request is answered as any session selecting a
    workspace it may no longer enter is: the claim only selects."""
    console = _cookie(people.ada)
    code = await _mint(app, console)
    await change(session_factory, people.ada)

    redeemed = await _redeem(app, code)

    assert redeemed.status_code == 200, redeemed.text
    browser = redeemed.cookies["switch_auth"]
    assert decode_jwt(browser, _KEYRING)["tenant_id"] == _ACME
    async with _client(app, browser) as client:
        first = await client.get("/auth/me")
    async with _client(app, console) as client:
        consoles = await client.get("/auth/me")
    assert first.status_code == 403, first.text
    assert first.json()["detail"]["error"] == refusal
    assert (consoles.status_code, consoles.json()) == (first.status_code, first.json())


async def test_redeeming_is_recorded_in_the_workspace_it_signs_in_to(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(app, _cookie(people.ada), "/agents/a1")
    assert (await _redeem(app, code)).status_code == 200

    async with tenant_session(session_factory, _ACME) as session:
        [event] = list(
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.BROWSER_HANDOFF.value
                )
            )
        )
    assert event.tenant_id == _ACME
    assert event.actor_user_id == people.ada.id
    assert (event.target_type, event.target_id) == ("user", people.ada.id)
    assert event.details == {"next": "/agents/a1"}


async def test_a_cookie_from_before_session_ids_can_still_mint(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    claims = decode_jwt(_cookie(people.ada), _KEYRING)
    del claims["sid"]
    legacy = _signed(claims)

    code = await _mint(app, legacy)
    redeemed = await _redeem(app, code)

    assert redeemed.status_code == 200, redeemed.text
    [row] = await _rows(session_factory)
    assert row.console_sid is None
    assert (
        decode_jwt(redeemed.cookies["switch_auth"], _KEYRING)["sid"] == row.browser_sid
    )


def _signed(claims: dict) -> str:
    return jwt.encode(
        claims,
        _KEYRING.derive(Purpose.SESSION),
        algorithm=JWT_ALGORITHM,
        headers={"kid": _KEYRING.current.id},
    )


# ── Peeking ─────────────────────────────────────────────────────────────────


async def test_peeking_with_no_session_says_whose_link_it_is_and_spends_nothing(
    app: FastAPI, people: SimpleNamespace
) -> None:
    code = await _mint(app, _cookie(people.ada))

    peeked = await _peek(app, code)

    assert peeked.status_code == 200, peeked.text
    assert peeked.json() == {
        "name": "Ada",
        "email": "ada@example.invalid",
        "workspace_name": "Acme",
        "signed_in_as": None,
        "same_person": False,
    }
    assert (await _redeem(app, code)).status_code == 200


async def test_peeking_signed_in_as_the_same_person_says_so(
    app: FastAPI, people: SimpleNamespace
) -> None:
    code = await _mint(app, _cookie(people.ada))
    already = _cookie(people.ada, tenant_id=TENANT_ZERO_ID, session_id="browser-1")

    peeked = (await _peek(app, code, already)).json()

    assert peeked["signed_in_as"] == {"name": "Ada", "email": "ada@example.invalid"}
    assert peeked["same_person"] is True


async def test_peeking_signed_in_as_someone_else_names_them(
    app: FastAPI, people: SimpleNamespace
) -> None:
    code = await _mint(app, _cookie(people.ada))
    bob = _cookie(people.bob, tenant_id=TENANT_ZERO_ID, session_id="bob-browser")

    peeked = (await _peek(app, code, bob)).json()

    assert peeked["name"] == "Ada"
    assert peeked["signed_in_as"] == {"name": "Bob", "email": "bob@example.invalid"}
    assert peeked["same_person"] is False


@pytest.mark.parametrize("cookie", ["not-a-session", "ended", "signed-out"])
async def test_peeking_ignores_a_cookie_that_signs_nobody_in(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
    cookie: str,
) -> None:
    code = await _mint(app, _cookie(people.ada))
    token = cookie
    if cookie == "ended":
        token = _cookie(people.bob, tenant_id=TENANT_ZERO_ID, session_id="bob-1")
        async with session_factory() as session:
            await _USER_STORE.end_sessions(session, people.bob.id)
            await session.commit()
    elif cookie == "signed-out":
        token = _cookie(people.bob, tenant_id=TENANT_ZERO_ID, session_id="bob-2")
        async with _client(app, token) as client:
            await client.post("/auth/logout")

    peeked = await _peek(app, code, token)

    assert peeked.status_code == 200
    assert peeked.json()["signed_in_as"] is None


async def test_no_code_reaches_the_log(
    app: FastAPI, people: SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        code = await _mint(app, _cookie(people.ada))
        await _peek(app, code)
        await _redeem(app, code)
        await _redeem(app, code)
    assert code not in caplog.text


# ── Signing out ─────────────────────────────────────────────────────────────


async def _me(app: FastAPI, token: str) -> int:
    async with _client(app, token) as client:
        return (await client.get("/auth/me")).status_code


async def _sign_out(app: FastAPI, token: str) -> None:
    async with _client(app, token) as client:
        assert (await client.post("/auth/logout")).status_code == 200


async def _open_browser(app: FastAPI, token: str) -> str:
    """Console opens a page in a browser: the browser's new session cookie."""
    redeemed = await _redeem(app, await _mint(app, token))
    assert redeemed.status_code == 200, redeemed.text
    return str(redeemed.cookies["switch_auth"])


async def test_a_browser_opened_from_an_authkit_sign_in_ends_when_that_sign_in_does(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = IdentitySessionStore()
    async with session_factory() as session:
        row_id = await store.record(
            session,
            user_id=people.ada.id,
            provider="workos",
            provider_user_id="user_ADA",
            session_id="session_CONSOLE",
            followed=True,
            now=datetime.now(UTC),
        )
        await session.commit()
    console = _cookie(people.ada, identity_session=row_id)

    browser = await _open_browser(app, console)

    assert decode_jwt(browser, _KEYRING)["isid"] == row_id
    assert await _me(app, browser) == 200
    async with session_factory() as session:
        await store.end(session, [row_id], datetime.now(UTC))
        await session.commit()
    assert await _me(app, console) == 401
    assert await _me(app, browser) == 401


async def test_signing_out_in_a_browser_console_opened_leaves_its_authkit_sign_in(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The browser stands on Console's AuthKit session; signing out of the
    browser ends only the browser's own session, and sends it nowhere."""

    def workos(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"WorkOS was asked {request.url}")

    app.state.identity_sessions = IdentitySessions(
        session_factory,
        AuthKit(
            httpx.AsyncClient(transport=httpx.MockTransport(workos)),
            "sk_test_example",  # gitleaks:allow
            "https://api.workos.test",
            "client_EXAMPLE",
        ),
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
        dashboard_base_url="https://dashboard.example.test",
        **LOGIN_LIMIT_DEFAULTS,
    )
    store = IdentitySessionStore()
    async with session_factory() as session:
        row_id = await store.record(
            session,
            user_id=people.ada.id,
            provider="workos",
            provider_user_id="user_ADA",
            session_id="session_CONSOLE",
            followed=True,
            now=datetime.now(UTC),
        )
        await session.commit()
    console = _cookie(people.ada, identity_session=row_id)
    browser = await _open_browser(app, console)

    async with _client(app, browser) as client:
        signed_out = await client.post("/auth/logout")

    assert signed_out.status_code == 200
    assert signed_out.json()["end_session_url"] is None
    assert await _me(app, browser) == 401
    assert await _me(app, console) == 200
    async with session_factory() as session:
        assert (await store.get(session, row_id)).ended_at is None  # type: ignore[union-attr]

    # Console signing out of its own session does end it, there and at WorkOS.
    async with _client(app, console) as client:
        console_out = await client.post("/auth/logout")
    assert console_out.json()["end_session_url"].startswith(
        "https://api.workos.test/user_management/sessions/logout?session_id=session_CONSOLE"
    )
    async with session_factory() as session:
        assert (await store.get(session, row_id)).ended_at is not None  # type: ignore[union-attr]


async def test_signing_out_of_console_signs_out_the_browsers_it_opened(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    console = _cookie(people.ada)
    first = await _open_browser(app, console)
    second = await _open_browser(app, console)
    elsewhere = await _open_browser(
        app, _cookie(people.ada, session_id="another-console")
    )

    await _sign_out(app, console)

    assert await _me(app, console) == 401
    assert await _me(app, first) == 401
    assert await _me(app, second) == 401
    # A browser another Console session opened stays signed in.
    assert await _me(app, elsewhere) == 200
    async with session_factory() as session:
        revoked = {
            row.session_id: row.expires_at
            for row in await session.scalars(select(RevokedSession))
        }
    browser_sids = {decode_jwt(t, _KEYRING)["sid"] for t in (first, second)}
    assert set(revoked) == {_CONSOLE_SID} | browser_sids
    # Each kept as long as a copy of it could be live.
    assert set(revoked.values()) == {_SIGNED_IN + SESSION_MAX_AGE}


async def test_a_browser_refreshed_before_console_signs_out_is_signed_out_too(
    app: FastAPI, people: SimpleNamespace
) -> None:
    console = _cookie(people.ada)
    browser = await _open_browser(app, console)
    async with _client(app, browser) as client:
        refreshed = (await client.post("/auth/refresh")).cookies["switch_auth"]

    await _sign_out(app, console)

    assert await _me(app, refreshed) == 401


async def test_signing_out_in_the_browser_leaves_console_signed_in(
    app: FastAPI, people: SimpleNamespace
) -> None:
    console = _cookie(people.ada)
    browser = await _open_browser(app, console)
    other_browser = await _open_browser(app, console)

    await _sign_out(app, browser)

    assert await _me(app, browser) == 401
    assert await _me(app, console) == 200
    assert await _me(app, other_browser) == 200


async def test_a_browser_s_own_links_are_signed_out_with_console(
    app: FastAPI, people: SimpleNamespace
) -> None:
    """A browser session can ask for a link too; whatever it opens goes when
    the Console session that opened it signs out."""
    console = _cookie(people.ada)
    browser = await _open_browser(app, console)
    grandchild = await _open_browser(app, browser)

    await _sign_out(app, console)

    assert await _me(app, grandchild) == 401


async def test_a_console_cookie_from_before_session_ids_links_nothing(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """It can still open a browser signed in, but it cannot be signed out of
    on its own, so nothing ties the browser to it."""
    claims = decode_jwt(_cookie(people.ada), _KEYRING)
    del claims["sid"]
    legacy = _signed(claims)
    browser = await _open_browser(app, legacy)

    await _sign_out(app, legacy)

    assert await _me(app, browser) == 200
    [row] = await _rows(session_factory)
    assert row.console_sid is None
    async with session_factory() as session:
        assert list(await session.scalars(select(RevokedSession))) == []


async def test_a_redeem_waiting_on_console_s_sign_out_is_refused(
    app: FastAPI,
    people: SimpleNamespace,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Console signs out while the browser is redeeming: the redeem waits on
    the rows the sign-out locked, then finds Console signed out, and no
    browser session is left behind unrevoked."""
    code = await _mint(app, _cookie(people.ada))
    async with session_factory() as signing_out:
        await REVOKED_SESSIONS.revoke(
            signing_out, _CONSOLE_SID, expires_at=_SIGNED_IN + SESSION_MAX_AGE
        )
        assert (
            await BROWSER_HANDOFFS.lock_sessions_opened_by(signing_out, [_CONSOLE_SID])
            == []
        )
        redeeming = asyncio.create_task(_redeem(app, code))
        await asyncio.sleep(0.3)
        assert not redeeming.done()
        await signing_out.commit()
    redeemed = await redeeming

    assert redeemed.status_code == 410
    assert redeemed.json() == {"detail": ENDED_DETAIL}
    assert "switch_auth" not in redeemed.cookies

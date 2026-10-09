"""Self sign-up, and the cloud machine it starts warming."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text

from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, CloudMachine, TenantMember, User
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_BEING_REMOVED,
    MACHINE_NEEDS_ADMIN,
    MACHINE_NEEDS_ATTENTION,
    MACHINES_FULL,
    workspace_on,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import decode_jwt, get_current_user, verify_password
from switch_core.gateway.auth_routes import MACHINE_OWNER_STOPPED, _prewarm
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.hosted_machines import MACHINES_DISABLED
from switch_core.gateway.hosted_machines import router as machine_router
from switch_core.keys import Keyring
from switch_core.tenant_context import tenant_scope

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

pytestmark = pytest.mark.no_ambient_tenant

PASSWORD = "correct horse battery"


@pytest.fixture
async def signup_app(session_factory):
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(machine_router)
    app.state.hosted_controller_settings = SimpleNamespace(
        allowed_tenant_ids=[TENANT_ZERO_ID]
    )
    config = SimpleNamespace(
        gateway_signup_open=True,
        gateway_signup_mode="default_tenant",
        gateway_signup_max_per_hour=20,
        gateway_password_login_enabled=True,
        gateway_oidc_enabled=False,
        gateway_oidc_provider_label=None,
        hosted_launch_capacity=2,
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
    )
    identity: dict[str, User] = {}

    async def sessions():
        async with session_factory() as session:
            yield session

    async def scoped_sessions():
        with tenant_scope(TENANT_ZERO_ID):
            async with session_factory() as session:
                yield session

    app.dependency_overrides[get_system_session] = sessions
    app.dependency_overrides[get_session] = scoped_sessions
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_user_store] = UserStore
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield SimpleNamespace(
            client=client,
            app=app,
            config=config,
            identity=identity,
            factory=session_factory,
        )


async def _signup(app, email: str = "new.person@example.com", **extra):
    return await app.client.post(
        "/auth/signup", json={"email": email, "password": PASSWORD, **extra}
    )


async def _user(app, email: str) -> User:
    async with app.factory() as session:
        user = await session.scalar(select(User).where(User.email == email))
        assert user is not None
        return user


async def _machines(app) -> list[CloudMachine]:
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            return list(await session.scalars(select(CloudMachine)))


async def _ensure(app, email: str):
    app.identity["user"] = await _user(app, email)
    with tenant_scope(TENANT_ZERO_ID):
        return await app.client.post("/hosted-machines/ensure")


def test_signup_needs_password_login_too():
    def config(**values) -> SwitchConfig:
        return SwitchConfig.model_construct(**values)

    assert config(
        gateway_signup_enabled=True, gateway_password_login_enabled=True
    ).gateway_signup_open
    assert not config(
        gateway_signup_enabled=True, gateway_password_login_enabled=False
    ).gateway_signup_open
    assert not config(
        gateway_signup_enabled=False, gateway_password_login_enabled=True
    ).gateway_signup_open


@pytest.mark.parametrize("mode", ["invite_only", "open"])
def test_signup_is_closed_outside_default_tenant_mode(mode):
    """Sign-up lands a new account in tenant zero, which is only what
    `gateway_signup_mode` decides for a first sign-in under `default_tenant`."""
    assert not SwitchConfig.model_construct(
        gateway_signup_enabled=True,
        gateway_password_login_enabled=True,
        gateway_signup_mode=mode,
    ).gateway_signup_open


OIDC = {
    "gateway_oidc_issuer_url": "https://idp.example.com",
    "gateway_oidc_client_id": "switch",
    "gateway_oidc_client_secret": "placeholder",  # gitleaks:allow
}


def test_signup_is_closed_when_oidc_is_configured():
    assert not SwitchConfig.model_construct(
        gateway_signup_enabled=True, gateway_password_login_enabled=True, **OIDC
    ).gateway_signup_open


async def test_oidc_deployment_refuses_signup(signup_app):
    app = signup_app
    app.app.dependency_overrides[get_config] = lambda: SwitchConfig.model_construct(
        gateway_signup_enabled=True, gateway_password_login_enabled=True, **OIDC
    )
    body = (await app.client.get("/auth/config")).json()
    assert (body["oidc_enabled"], body["signup_enabled"]) == (True, False)
    assert (await _signup(app)).status_code == 403
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 0


async def test_auth_config_reports_signup(signup_app):
    app = signup_app
    assert (await app.client.get("/auth/config")).json()["signup_enabled"] is True
    app.config.gateway_signup_open = False
    assert (await app.client.get("/auth/config")).json()["signup_enabled"] is False


async def test_disabled_signup_is_refused(signup_app):
    app = signup_app
    app.config.gateway_signup_open = False
    response = await _signup(app)
    assert response.status_code == 403
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 0


async def test_signup_signs_in_a_tenant_zero_member_with_a_warming_machine(
    signup_app,
):
    app = signup_app
    response = await _signup(app, email="  New.Person@Example.com ")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["email"] == "new.person@example.com"
    assert body["name"] == "new.person"
    assert body["role"] == "user"
    assert body["server"]
    assert body["machine"] == {"status": "starting", "reason": None}

    user = await _user(app, "new.person@example.com")
    assert body["id"] == user.id
    assert verify_password(PASSWORD, user.password_hash)
    token = decode_jwt(response.cookies["switch_auth"], TEST_KEYRING)
    assert token["sub"] == user.id
    async with app.factory() as session:
        member = await session.get(TenantMember, (TENANT_ZERO_ID, user.id))
    assert member is not None

    (machine,) = await _machines(app)
    assert (machine.owner_id, machine.state, machine.desired_state) == (
        user.id,
        "queued",
        "running",
    )
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            workspace = await workspace_on(session, machine.id)
    assert workspace is not None
    assert (workspace.owner_id, workspace.controller_id) == (user.id, None)

    login = await app.client.post(
        "/auth/login", json={"email": "new.person@example.com", "password": PASSWORD}
    )
    assert login.status_code == 200, login.text


async def test_signup_keeps_a_display_name(signup_app):
    response = await _signup(signup_app, display_name="  Ada Lovelace ")
    assert response.status_code == 201, response.text
    assert response.json()["name"] == "Ada Lovelace"


async def test_duplicate_email_is_a_conflict(signup_app):
    app = signup_app
    assert (await _signup(app)).status_code == 201
    again = await _signup(app, email="NEW.person@example.com")
    assert again.status_code == 409
    assert again.json()["detail"] == "Email already registered"
    assert len(await _machines(app)) == 1


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "new.person@example.com", "password": "short"},
        {"email": "new.person@example.com", "password": "x" * 73},
        {"email": "not-an-email", "password": PASSWORD},
    ],
)
async def test_weak_password_or_bad_email_is_rejected(signup_app, payload):
    app = signup_app
    response = await app.client.post("/auth/signup", json=payload)
    assert response.status_code == 422
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 0


async def test_signup_succeeds_without_cloud_capacity(signup_app, caplog):
    app = signup_app
    app.config.hosted_launch_capacity = 0
    response = await _signup(app)
    assert response.status_code == 201, response.text
    assert response.json()["machine"] == {
        "status": "unavailable",
        "reason": MACHINES_DISABLED,
    }
    assert await _machines(app) == []
    assert "has no cloud machine warming" in caplog.text
    await _user(app, "new.person@example.com")


async def test_signup_warms_no_machine_outside_the_allowed_workspaces(signup_app):
    app = signup_app
    app.app.state.hosted_controller_settings = SimpleNamespace(
        allowed_tenant_ids=["another-tenant"]
    )
    response = await _signup(app)
    assert response.status_code == 201, response.text
    assert response.json()["machine"] == {
        "status": "unavailable",
        "reason": MACHINES_DISABLED,
    }
    assert await _machines(app) == []


async def test_signup_succeeds_when_every_machine_is_in_use(signup_app):
    app = signup_app
    app.config.hosted_launch_capacity = 1
    assert (await _signup(app, email="first@example.com")).status_code == 201
    response = await _signup(app, email="second@example.com")
    assert response.status_code == 201, response.text
    assert response.json()["machine"] == {
        "status": "unavailable",
        "reason": MACHINES_FULL,
    }
    assert len(await _machines(app)) == 1


async def test_ensure_is_idempotent(signup_app):
    app = signup_app
    app.config.hosted_launch_capacity = 0
    await _signup(app)
    app.config.hosted_launch_capacity = 2
    first = await _ensure(app, "new.person@example.com")
    assert first.status_code == 200, first.text
    second = await _ensure(app, "new.person@example.com")
    assert second.status_code == 200, second.text
    assert first.json()["machine_id"] == second.json()["machine_id"]
    assert first.json()["desired_state"] == "running"
    assert len(await _machines(app)) == 1


async def test_ensure_leaves_an_owner_stopped_machine_stopped(signup_app):
    app = signup_app
    await _signup(app)
    (machine,) = await _machines(app)
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            row = await session.get(CloudMachine, machine.id)
            assert row is not None
            row.state = "stopped"
            row.desired_state = "stopped"
            row.stop_reason = "owner"
            row.revision = 2
            await session.commit()
    response = await _ensure(app, "new.person@example.com")
    assert response.status_code == 200, response.text
    assert response.json()["machine_id"] == machine.id
    (after,) = await _machines(app)
    assert (after.desired_state, after.stop_reason, after.revision) == (
        "stopped",
        "owner",
        2,
    )


async def _set_machine(app, machine_id: str, **values) -> None:
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            row = await session.get(CloudMachine, machine_id)
            assert row is not None
            for key, value in values.items():
                setattr(row, key, value)
            await session.commit()


@pytest.mark.parametrize(
    ("values", "reason"),
    [
        (
            {"state": "error", "error": "The instance failed its status checks."},
            MACHINE_NEEDS_ATTENTION,
        ),
        (
            {"state": "error", "error_code": "machine_needs_attention"},
            MACHINE_NEEDS_ADMIN,
        ),
        ({"state": "retained", "desired_state": "deleted"}, MACHINE_BEING_REMOVED),
        ({"state": "error", "desired_state": "deleted"}, MACHINE_BEING_REMOVED),
        ({"state": "deleting", "desired_state": "deleted"}, MACHINE_BEING_REMOVED),
        (
            {
                "state": "error",
                "desired_state": "retained",
                "retain_until": datetime.now(UTC) - timedelta(minutes=1),
            },
            MACHINE_BEING_REMOVED,
        ),
        (
            {
                "state": "error",
                "desired_state": "deleted",
                "error_code": "machine_needs_attention",
            },
            MACHINE_NEEDS_ADMIN,
        ),
        (
            {
                "state": "error",
                "desired_state": "retained",
                "error_code": "machine_needs_attention",
                "retain_until": datetime.now(UTC) - timedelta(minutes=1),
            },
            MACHINE_NEEDS_ADMIN,
        ),
        (
            {"state": "stopped", "desired_state": "stopped", "stop_reason": "owner"},
            MACHINE_OWNER_STOPPED,
        ),
    ],
    ids=[
        "error",
        "error-needs-admin",
        "retained-deleting",
        "error-deleting",
        "deleting",
        "error-released",
        "needs-admin-deleting",
        "needs-admin-released",
        "owner-stopped",
    ],
)
async def test_ensure_returns_an_unclaimable_machine_as_it_is(
    signup_app, values, reason
):
    app = signup_app
    await _signup(app)
    (machine,) = await _machines(app)
    await _set_machine(app, machine.id, revision=2, **values)
    response = await _ensure(app, "new.person@example.com")
    assert response.status_code == 200, response.text
    assert response.json()["machine_id"] == machine.id
    assert (response.json()["state"], response.json()["revision"]) == (
        values["state"],
        2,
    )
    (after,) = await _machines(app)
    assert (after.state, after.desired_state, after.revision) == (
        values["state"],
        values.get("desired_state", "running"),
        2,
    )
    user = await _user(app, "new.person@example.com")
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            prewarmed = await _prewarm(
                session,
                app.factory,
                user.id,
                app.config,
                app.app.state.hosted_controller_settings,
            )
    assert (prewarmed.status, prewarmed.reason) == ("unavailable", reason)


async def test_ensure_wakes_an_idle_sleeping_machine(signup_app):
    app = signup_app
    await _signup(app)
    (machine,) = await _machines(app)
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            row = await session.get(CloudMachine, machine.id)
            assert row is not None
            row.state = "stopped"
            row.desired_state = "stopped"
            row.stop_reason = "idle"
            await session.commit()
    response = await _ensure(app, "new.person@example.com")
    assert response.status_code == 200, response.text
    (after,) = await _machines(app)
    assert (after.desired_state, after.stop_reason) == ("running", None)


async def test_ensure_refuses_when_cloud_machines_are_off(signup_app):
    app = signup_app
    await _signup(app)
    app.config.hosted_launch_capacity = 0
    response = await _ensure(app, "new.person@example.com")
    assert response.status_code == 503
    assert response.json()["detail"] == MACHINES_DISABLED


async def _user_count(app) -> int:
    async with app.factory() as session:
        return await session.scalar(select(func.count()).select_from(User))


async def test_signup_is_refused_once_the_hourly_cap_is_reached(signup_app, caplog):
    app = signup_app
    app.config.gateway_signup_max_per_hour = 2
    assert (await _signup(app, email="first@example.com")).status_code == 201
    assert (await _signup(app, email="second@example.com")).status_code == 201

    response = await _signup(app, email="third@example.com")
    assert response.status_code == 429, response.text
    assert response.json()["detail"] == (
        "Too many sign-ups on this server in the last hour. Try again later."
    )
    assert 1 <= int(response.headers["Retry-After"]) <= 3600
    assert "2 users created in the last hour (cap 2)" in caplog.text
    async with app.factory() as session:
        assert await UserStore().get_by_email(session, "third@example.com") is None
    assert await _user_count(app) == 2


async def test_signup_cap_counts_a_rolling_hour(signup_app):
    app = signup_app
    app.config.gateway_signup_max_per_hour = 1
    assert (await _signup(app, email="first@example.com")).status_code == 201
    assert (await _signup(app, email="second@example.com")).status_code == 429

    async with app.factory() as session:
        await session.execute(
            text("UPDATE users SET created_at = created_at - interval '61 minutes'")
        )
        await session.commit()

    response = await _signup(app, email="second@example.com")
    assert response.status_code == 201, response.text


async def test_concurrent_signups_cannot_overrun_the_cap(signup_app):
    app = signup_app
    app.config.gateway_signup_max_per_hour = 1
    responses = await asyncio.gather(
        _signup(app, email="first@example.com"),
        _signup(app, email="second@example.com"),
    )
    assert sorted(r.status_code for r in responses) == [201, 429]
    assert await _user_count(app) == 1

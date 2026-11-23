"""Self sign-up, and the cloud machine it starts warming."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

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
from switch_core.gateway import auth_routes, hosted_machines
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
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.keys import Keyring
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.login_limit_defaults import LOGIN_LIMIT_DEFAULTS
from tests.telemetry_records import recording_telemetry

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

pytestmark = pytest.mark.no_ambient_tenant

PASSWORD = "correct horse battery"


def _hosted_settings(tenants: list[str] | None) -> HostedControllerSettings:
    """The real settings model, not a stand-in, so a field added to it (the
    account list, say) is there with its default rather than missing."""
    return HostedControllerSettings(
        # None here means every workspace, said explicitly ("*"): with hosted
        # agents v2 on, an unset list is nobody.
        allowed_tenant_ids=(["*"] if process_hosted_v2() else None)
        if tenants is None
        else tenants,
        allowed_user_ids=["*"] if process_hosted_v2() else None,
        token="t" * 32,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )


@pytest.fixture
async def signup_app(session_factory):
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(machine_router)
    app.state.hosted_controller_settings = _hosted_settings([TENANT_ZERO_ID])
    config = SimpleNamespace(
        gateway_signup_open=True,
        gateway_signup_mode="default_tenant",
        gateway_signup_max_per_hour=20,
        gateway_signup_refused_header=None,
        gateway_password_login_enabled=True,
        gateway_oidc_enabled=False,
        gateway_oidc_provider_label=None,
        gateway_oidc_login_options=[],
        hosted_launch_capacity=2,
        hosted_agents_enabled=True,
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
        **LOGIN_LIMIT_DEFAULTS,
        gateway_allow_test_account_reset=False,
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


async def test_with_a_warm_pool_a_signup_makes_no_box(signup_app) -> None:
    """With v2's box provisioning on and a warm pool, a box is taken from
    the pool, or made, at the person's first start, never at sign-up: the
    answer still says nothing is wrong."""
    app = signup_app
    app.config.hosted_box_provisioning = True
    app.config.hosted_pool_size = 1
    response = await _signup(app, email="new.person@example.com")
    assert response.status_code == 201, response.text
    assert response.json()["machine"] == {"status": "starting", "reason": None}
    assert await _machines(app) == []


async def test_with_no_warm_pool_a_v2_signup_still_warms_a_machine(
    signup_app, monkeypatch
) -> None:
    """With v2 on and no pool, a sign-up asks for the person's machine as it
    did before the pool."""
    from switch_core.gateway import auth_routes
    from switch_core.gateway.schemas import SignupMachine

    asked: list[str] = []

    async def prewarm(session, factory, user_id, config, settings):  # type: ignore[no-untyped-def]
        asked.append(user_id)
        return SignupMachine(status="starting", reason=None)

    monkeypatch.setattr(auth_routes, "_prewarm", prewarm)
    app = signup_app
    app.config.hosted_box_provisioning = True
    app.config.hosted_pool_size = 0
    response = await _signup(app, email="another.person@example.com")
    assert response.status_code == 201, response.text
    assert len(asked) == 1


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


class _NamelessUserStore(UserStore):
    """Writes the user with no name, which `users.name` refuses: an integrity
    failure that is not the email being taken."""

    async def create(self, session, user: User) -> None:
        user.name = None  # type: ignore[assignment]
        await super().create(session, user)


async def test_an_integrity_failure_other_than_the_email_is_not_a_conflict(
    signup_app,
):
    app = signup_app
    app.app.dependency_overrides[get_user_store] = _NamelessUserStore
    with pytest.raises(IntegrityError, match='null value in column "name"'):
        await _signup(app)
    async with app.factory() as session:
        assert await UserStore().get_by_email(session, "new.person@example.com") is None


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


async def test_signup_succeeds_without_cloud_machines(signup_app, caplog):
    app = signup_app
    app.config.hosted_agents_enabled = False
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
    app.app.state.hosted_controller_settings = _hosted_settings(["another-tenant"])
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
    app.config.hosted_agents_enabled = False
    await _signup(app)
    app.config.hosted_agents_enabled = True
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
    app.config.hosted_agents_enabled = False
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
        "Too many sign-ups in the last hour. Try again later."
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


async def _signup_from(app, address: str, email: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app.app, client=(address, 4321)),
        base_url="https://switch.example.com",
    ) as client:
        return await client.post(
            "/auth/signup", json={"email": email, "password": PASSWORD}
        )


async def test_one_address_cannot_spend_everyones_sign_ups(signup_app):
    """The hourly cap is one budget for the whole deployment, so a limit per
    client address stands in front of it: one client's burst leaves the rest
    of the budget to everyone else."""
    app = signup_app
    app.config.gateway_signup_max_per_hour_per_address = 3
    for n in range(3):
        response = await _signup_from(app, "203.0.113.7", f"burst{n}@example.com")
        assert response.status_code == 201, response.text

    refused = await _signup_from(app, "203.0.113.7", "burst3@example.com")
    assert refused.status_code == 429, refused.text
    assert refused.json()["detail"] == (
        "Too many sign-ups from your network. Try again in 60 minutes."
    )
    assert 3590 <= int(refused.headers["Retry-After"]) <= 3600
    newcomer = await _signup_from(app, "198.51.100.9", "newcomer@example.com")
    assert newcomer.status_code == 201, newcomer.text
    assert await _user_count(app) == 4


async def test_the_deployment_wide_cap_still_holds_across_addresses(signup_app):
    app = signup_app
    app.config.gateway_signup_max_per_hour = 2
    app.config.gateway_signup_max_per_hour_per_address = 5
    assert (await _signup_from(app, "203.0.113.1", "a@example.com")).status_code == 201
    assert (await _signup_from(app, "203.0.113.2", "b@example.com")).status_code == 201
    refused = await _signup_from(app, "203.0.113.3", "c@example.com")
    assert refused.status_code == 429
    assert refused.json()["detail"] == (
        "Too many sign-ups in the last hour. Try again later."
    )


async def test_an_address_signs_up_again_once_its_hour_is_over(signup_app):
    app = signup_app
    app.config.gateway_signup_max_per_hour_per_address = 1
    assert (await _signup_from(app, "203.0.113.7", "a@example.com")).status_code == 201
    assert (await _signup_from(app, "203.0.113.7", "b@example.com")).status_code == 429

    async with app.factory() as session:
        await session.execute(
            text(
                "UPDATE auth_attempts SET"
                " window_started_at = window_started_at - interval '61 minutes',"
                " locked_until = locked_until - interval '61 minutes',"
                " expires_at = expires_at - interval '61 minutes'"
            )
        )
        await session.commit()

    response = await _signup_from(app, "203.0.113.7", "b@example.com")
    assert response.status_code == 201, response.text


async def test_sign_ups_through_a_proxy_are_left_to_the_deployment_wide_cap(
    signup_app,
):
    """From a private address, every client behind the proxy shares it."""
    app = signup_app
    app.config.gateway_signup_max_per_hour_per_address = 1
    assert (await _signup_from(app, "10.0.0.7", "a@example.com")).status_code == 201
    assert (await _signup_from(app, "10.0.0.7", "b@example.com")).status_code == 201


@pytest.fixture
def reported(monkeypatch):
    """What sign-up and the cloud machine routes report."""
    service, sink = recording_telemetry()
    monkeypatch.setattr(auth_routes, "current_telemetry", lambda: service)
    monkeypatch.setattr(hosted_machines, "current_telemetry", lambda: service)
    return sink


async def test_a_sign_up_reports_the_account_and_the_new_machine(signup_app, reported):
    assert (await _signup(signup_app)).status_code == 201

    assert reported.events("account_created") == [{"method": "signup"}]
    assert reported.events("cloud_machine_requested") == [{"change": "new"}]


async def test_a_claim_that_changes_nothing_is_not_reported(signup_app, reported):
    await _signup(signup_app)
    assert (await _ensure(signup_app, "new.person@example.com")).status_code == 200

    assert reported.events("cloud_machine_requested") == [{"change": "new"}]


async def test_a_claim_that_starts_a_sleeping_machine_says_so(signup_app, reported):
    app = signup_app
    await _signup(app)
    (machine,) = await _machines(app)
    with tenant_scope(TENANT_ZERO_ID):
        async with app.factory() as session:
            row = await session.get(CloudMachine, machine.id)
            assert row is not None
            row.desired_state = "stopped"
            row.stop_reason = "idle"
            await session.commit()

    assert (await _ensure(app, "new.person@example.com")).status_code == 200

    assert reported.events("cloud_machine_requested") == [
        {"change": "new"},
        {"change": "restarted"},
    ]


async def test_refused_sign_ups_say_why(signup_app, reported):
    app = signup_app
    assert (await _signup(app)).status_code == 201
    assert (await _signup(app)).status_code == 409
    app.config.gateway_signup_open = False
    assert (await _signup(app, email="later@example.com")).status_code == 403

    assert reported.events("signup_refused") == [
        {"reason": "email_taken"},
        {"reason": "disabled"},
    ]
    assert reported.events("account_created") == [{"method": "signup"}]


async def test_a_sign_up_over_the_hourly_cap_is_reported_as_rate_limited(
    signup_app, reported
):
    signup_app.config.gateway_signup_max_per_hour = 1
    assert (await _signup(signup_app, email="first@example.com")).status_code == 201
    assert (await _signup(signup_app, email="second@example.com")).status_code == 429

    assert reported.events("signup_refused") == [{"reason": "rate_limited"}]


REFUSED_HEADER = "x-amzn-waf-signup-refused"


async def test_a_sign_up_the_edge_marks_as_refused_creates_no_account(
    signup_app, reported
):
    app = signup_app
    app.config.gateway_signup_refused_header = REFUSED_HEADER
    refused = await app.client.post(
        "/auth/signup",
        json={"email": "far.away@example.com", "password": PASSWORD},
        headers={REFUSED_HEADER: "country"},
    )
    assert refused.status_code == 403
    assert refused.json()["detail"] == (
        "New Switch accounts are not available in your country."
    )
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 0
    assert reported.events("signup_refused") == [{"reason": "country"}]

    assert (await _signup(app, email="nearby@example.com")).status_code == 201


async def test_the_refused_header_is_ignored_while_no_header_is_configured(
    signup_app,
):
    response = await signup_app.client.post(
        "/auth/signup",
        json={"email": "far.away@example.com", "password": PASSWORD},
        headers={REFUSED_HEADER: "country"},
    )
    assert response.status_code == 201


async def test_the_owner_stopping_and_starting_their_machine_is_reported(
    signup_app, reported
):
    app = signup_app
    await _signup(app)
    app.identity["user"] = await _user(app, "new.person@example.com")
    (machine,) = await _machines(app)

    with tenant_scope(TENANT_ZERO_ID):
        stopped = await app.client.post(
            f"/hosted-machines/{machine.id}/lifecycle",
            json={"action": "stop", "revision": machine.revision},
        )
        assert stopped.status_code == 200, stopped.text
        started = await app.client.post(
            f"/hosted-machines/{machine.id}/lifecycle",
            json={"action": "start", "revision": stopped.json()["machine"]["revision"]},
        )
        assert started.status_code == 200, started.text

    assert reported.events("cloud_machine_stopped") == [{}]
    assert reported.events("cloud_machine_started") == [{"stopped_by": "owner"}]
    assert reported.events("cloud_machine_woken") == []

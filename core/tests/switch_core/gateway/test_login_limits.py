"""Password sign-in guessing is counted and locked out (`gateway/login_limits.py`).

Against a real Postgres, as the counts live in `auth_attempts` so that they
hold across replicas. Time passing is the stored timestamps moving back, so
nothing here sleeps.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import bcrypt
import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.gateway.oidc_routes as oidc_routes
from switch_core.db.models import TENANT_ZERO_ID, AuthAttempt, ServerAuditEvent, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import login_limits
from switch_core.gateway.auth import decode_jwt, get_current_user, hash_password
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.keys import Keyring
from switch_core.observability.catalogue import AUTH_SIGN_IN_LOCKOUTS
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.organization_directory import LocalDirectory
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.test_oidc_routes import _config as oidc_config
from tests.switch_core.gateway.test_oidc_routes import _FakeClient

pytestmark = pytest.mark.no_ambient_tenant

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
PASSWORD = "the right password"
ADA = "ada@example.com"
NOBODY = "nobody@example.com"
# Documentation ranges (RFC 5737, RFC 3849): internet addresses as far as the
# limits are concerned, and nobody's.
CLIENT = "203.0.113.7"
OTHER_CLIENT = "198.51.100.9"

EMAIL_PAUSED = (
    "Password sign-in for this email address is paused after too many failed "
    "attempts. Try again in 15 minutes. An administrator of this Switch server "
    "can lift the pause sooner."
)
NETWORK_PAUSED = (
    "Password sign-in from your network is paused after too many failed "
    "attempts. Try again in 15 minutes."
)
SINGLE_SIGN_ON = "Signing in with single sign-on still works."


class World(SimpleNamespace):
    app: FastAPI
    config: SimpleNamespace
    factory: async_sessionmaker[AsyncSession]
    identity: dict[str, User]

    def client(self, address: str = CLIENT) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=(address, 4321)),
            base_url="https://switch.example.com",
        )

    async def sign_in(
        self, email: str, password: str, address: str = CLIENT
    ) -> httpx.Response:
        async with self.client(address) as client:
            return await client.post(
                "/auth/login", json={"email": email, "password": password}
            )

    async def later(self, by: timedelta) -> None:
        """Move every count `by` into the past, as if that much time passed."""
        async with self.factory() as session:
            await session.execute(
                update(AuthAttempt).values(
                    window_started_at=AuthAttempt.window_started_at - by,
                    locked_until=AuthAttempt.locked_until - by,
                    expires_at=AuthAttempt.expires_at - by,
                )
            )
            await session.commit()

    async def wait_out(self) -> None:
        """Let time pass until no wait refuses an attempt: the short waits
        between failures, never a lock-out."""
        now = datetime.now(UTC)
        async with self.factory() as session:
            last = await session.scalar(
                select(AuthAttempt.locked_until)
                .where(
                    AuthAttempt.locked_until > now,
                    AuthAttempt.locked_until < now + timedelta(minutes=1),
                )
                .order_by(AuthAttempt.locked_until.desc())
                .limit(1)
            )
        if last is not None:
            await self.later(last - datetime.now(UTC) + timedelta(milliseconds=10))

    async def rows(self, kind: str) -> list[AuthAttempt]:
        async with self.factory() as session:
            return list(
                await session.scalars(
                    select(AuthAttempt).where(AuthAttempt.kind == kind)
                )
            )


async def _user(
    factory: async_sessionmaker[AsyncSession],
    email: str,
    *,
    role: str = "user",
    password: str | None = PASSWORD,
) -> User:
    with tenant_scope(TENANT_ZERO_ID):
        async with factory() as session:
            user = User(
                name=email.split("@")[0],
                email=email,
                role=role,
                password_hash=hash_password(password) if password is not None else None,
            )
            await UserStore().create(session, user)
            await session.commit()
            return user


@pytest.fixture
async def world(session_factory, monkeypatch) -> AsyncIterator[World]:
    monkeypatch.setattr(login_limits, "_warned_uncounted", False)
    app = FastAPI()
    app.include_router(auth_router)
    config = SimpleNamespace(
        gateway_password_login_enabled=True,
        gateway_oidc_enabled=False,
        gateway_tenant_choice_enabled=False,
        gateway_login_max_failures=10,
        gateway_login_max_failures_per_address=50,
        gateway_login_failure_window_minutes=15,
        gateway_login_lock_minutes=15,
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
    await _user(session_factory, ADA)
    yield World(app=app, config=config, factory=session_factory, identity=identity)


async def _guess(world: World, email: str) -> httpx.Response:
    """A wrong password for `email`, sent again after any short wait it is
    told to take first. Answers with the first reply that is not a wait."""
    while True:
        response = await world.sign_in(email, "a wrong guess")
        if response.status_code != 429 or int(response.headers["Retry-After"]) >= 60:
            return response
        await world.wait_out()


async def _fail_until_locked(world: World, email: str) -> list[int]:
    """Wrong passwords for `email` until one is refused for a lock, not a
    wait. The statuses, in order."""
    statuses = []
    while True:
        response = await _guess(world, email)
        statuses.append(response.status_code)
        if response.status_code == 429:
            return statuses


class TestPerEmail:
    async def test_ten_failures_lock_the_email_even_against_the_right_password(
        self, world: World
    ) -> None:
        assert await _fail_until_locked(world, ADA) == [401] * 10 + [429]

        refused = await world.sign_in(ADA, PASSWORD)
        assert refused.status_code == 429
        assert refused.json() == {"detail": EMAIL_PAUSED}
        assert 890 <= int(refused.headers["Retry-After"]) <= 900

        await world.later(timedelta(minutes=15))
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 200

    async def test_after_three_free_failures_each_makes_the_next_wait_twice_as_long(
        self, world: World
    ) -> None:
        for _ in range(4):
            assert (await world.sign_in(ADA, "a wrong guess")).status_code == 401
        waits = []
        for _ in range(4):
            refused = await world.sign_in(ADA, "a wrong guess")
            assert refused.status_code == 429
            waits.append(refused.headers["Retry-After"])
            await world.wait_out()
            assert (await world.sign_in(ADA, "a wrong guess")).status_code == 401
        assert waits == ["1", "2", "4", "8"]

    async def test_an_email_with_no_account_locks_out_exactly_as_one_with_an_account(
        self, world: World
    ) -> None:
        """Otherwise the lock would say which emails have accounts."""
        answers = {}
        for email in (ADA, NOBODY):
            seen = []
            while not seen or "minutes" not in seen[-1][1]["detail"]:
                if seen and seen[-1][0] == 429:
                    await world.wait_out()
                response = await world.sign_in(email, "a wrong guess")
                seen.append(
                    (
                        response.status_code,
                        response.json(),
                        response.headers.get("Retry-After"),
                    )
                )
            answers[email] = seen
        assert [status for status, _, _ in answers[ADA]] == [401] * 4 + [
            429,
            401,
            429,
            401,
            429,
            401,
            429,
            401,
            429,
            401,
            429,
            401,
            429,
        ]
        assert answers[ADA] == answers[NOBODY]

    async def test_a_success_clears_the_count(self, world: World) -> None:
        for _ in range(6):
            await world.wait_out()
            assert (await world.sign_in(ADA, "a wrong guess")).status_code == 401
        await world.wait_out()
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 200
        assert await world.rows(login_limits.LOGIN_EMAIL) == []
        for _ in range(4):
            assert (await world.sign_in(ADA, "a wrong guess")).status_code == 401

    async def test_the_count_is_the_emails_whatever_its_case(
        self, world: World
    ) -> None:
        for email in ("ada@example.com", "Ada@Example.com", "ADA@EXAMPLE.COM"):
            assert (await world.sign_in(email, "a wrong guess")).status_code == 401
        [row] = await world.rows(login_limits.LOGIN_EMAIL)
        assert row.attempts == 3

    async def test_the_table_never_holds_the_email_or_the_address(
        self, world: World
    ) -> None:
        await world.sign_in(ADA, "a wrong guess")
        rows = await world.rows(login_limits.LOGIN_EMAIL) + await world.rows(
            login_limits.LOGIN_ADDRESS
        )
        assert len(rows) == 2
        for row in rows:
            assert ADA not in row.key and CLIENT not in row.key

    async def test_attempts_sent_at_once_are_counted_exactly(
        self, world: World
    ) -> None:
        """Counted before the password is checked, so a burst cannot all get
        past a count none of it has added to yet."""
        responses = await asyncio.gather(
            *(world.sign_in(ADA, f"guess {n}") for n in range(30))
        )
        statuses = sorted(response.status_code for response in responses)
        # Three free failures, then the fourth makes the rest wait.
        assert statuses == [401] * 4 + [429] * 26


class TestPerAddress:
    async def test_one_address_failing_across_many_emails_is_locked_out(
        self, world: World
    ) -> None:
        world.config.gateway_login_max_failures_per_address = 5
        for n in range(5):
            response = await world.sign_in(f"person{n}@example.com", "a guess")
            assert response.status_code == 401
        refused = await world.sign_in("person5@example.com", "a guess")
        assert refused.status_code == 429
        assert refused.json() == {"detail": NETWORK_PAUSED}
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 429
        assert (
            await world.sign_in(ADA, PASSWORD, address=OTHER_CLIENT)
        ).status_code == 200

    async def test_successes_do_not_count_against_the_address(
        self, world: World
    ) -> None:
        world.config.gateway_login_max_failures_per_address = 3
        for _ in range(6):
            assert (await world.sign_in(ADA, PASSWORD)).status_code == 200
        [row] = await world.rows(login_limits.LOGIN_ADDRESS)
        assert (row.attempts, row.locked_until) == (0, None)

    async def test_an_ipv6_client_is_counted_by_its_64(self, world: World) -> None:
        world.config.gateway_login_max_failures_per_address = 2
        for n, address in enumerate(["2001:db8:1:2::1", "2001:db8:1:2::ffff"]):
            response = await world.sign_in(f"p{n}@example.com", "a guess", address)
            assert response.status_code == 401
        refused = await world.sign_in(NOBODY, "a guess", "2001:db8:1:2:abcd::9")
        assert refused.status_code == 429
        elsewhere = await world.sign_in(NOBODY, "a guess", "2001:db8:1:3::1")
        assert elsewhere.status_code == 401

    @pytest.mark.parametrize(
        "address", ["10.1.2.3", "172.20.0.4", "192.168.1.9", "127.0.0.1", "fd00::5"]
    )
    async def test_a_proxys_address_is_not_counted_and_the_log_says_why(
        self, world: World, caplog, address: str
    ) -> None:
        """Behind a proxy uvicorn does not trust, every client arrives with
        the proxy's address; counting it would let anyone lock out everyone."""
        world.config.gateway_login_max_failures_per_address = 1
        with caplog.at_level(logging.WARNING, logger=login_limits.__name__):
            for n in range(3):
                response = await world.sign_in(f"p{n}@example.com", "a guess", address)
                assert response.status_code == 401
        assert await world.rows(login_limits.LOGIN_ADDRESS) == []
        warnings = [r for r in caplog.records if "FORWARDED_ALLOW_IPS" in r.message]
        assert len(warnings) == 1


class TestOperator:
    async def test_the_operator_lifts_a_lock_and_it_is_audited(
        self, world: World
    ) -> None:
        operator = await _user(world.factory, "operator@example.com", role="admin")
        await _fail_until_locked(world, ADA)
        async with world.factory() as session:
            ada = await UserStore().get_by_email(session, ADA)
        assert ada is not None

        world.identity["user"] = operator
        async with world.client() as client:
            cleared = await client.delete(f"/users/{ada.id}/sign-in-lock")
        assert cleared.status_code == 200, cleared.text
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 200
        async with world.factory() as session:
            [event] = await session.scalars(select(ServerAuditEvent))
        assert (event.action, event.actor_user_id, event.target_id) == (
            "user.sign_in_lock_cleared",
            operator.id,
            ada.id,
        )

    async def test_only_the_operator_may(self, world: World) -> None:
        bob = await _user(world.factory, "bob@example.com")
        async with world.factory() as session:
            ada = await UserStore().get_by_email(session, ADA)
        assert ada is not None
        world.identity["user"] = bob
        async with world.client() as client:
            refused = await client.delete(f"/users/{ada.id}/sign-in-lock")
        assert refused.status_code == 403

    async def test_an_unknown_account_is_not_found(self, world: World) -> None:
        world.identity["user"] = await _user(
            world.factory, "operator@example.com", role="admin"
        )
        async with world.client() as client:
            missing = await client.delete("/users/no-such-user/sign-in-lock")
        assert missing.status_code == 404


class TestTheLockIsSaidPlainly:
    """A lock says what is paused, until when, and what still gets the person
    in, the same for an email with an account as for one without."""

    async def test_single_sign_on_is_named_where_the_server_offers_it(
        self, world: World
    ) -> None:
        world.config.gateway_oidc_enabled = True
        answers = []
        for email in (ADA, NOBODY):
            await _fail_until_locked(world, email)
            refused = await world.sign_in(email, PASSWORD)
            answers.append((refused.status_code, refused.json()))
        assert answers[0] == answers[1]
        assert answers[0] == (
            429,
            {
                "detail": EMAIL_PAUSED.replace(
                    " An administrator", f" {SINGLE_SIGN_ON} An administrator"
                )
            },
        )

    async def test_a_short_wait_between_failures_is_not_called_a_pause(
        self, world: World
    ) -> None:
        for _ in range(4):
            await world.sign_in(ADA, "a wrong guess")
        refused = await world.sign_in(ADA, "a wrong guess")
        assert refused.json() == {
            "detail": "Too many sign-in attempts. Try again in 1 second."
        }

    async def test_a_network_lock_is_not_offered_to_the_operator(
        self, world: World
    ) -> None:
        """The operator's route lifts an email's lock, not an address's."""
        world.config.gateway_login_max_failures_per_address = 2
        world.config.gateway_oidc_enabled = True
        for n in range(2):
            await world.sign_in(f"p{n}@example.com", "a guess")
        refused = await world.sign_in(ADA, PASSWORD)
        assert refused.json() == {"detail": f"{NETWORK_PAUSED} {SINGLE_SIGN_ON}"}


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    installed = MetricsRegistry()
    install(installed)
    yield installed
    uninstall()


def _lockouts(registry: MetricsRegistry) -> list[tuple[dict, float]]:
    return sorted(
        (
            (dict(point.attributes), point.value)
            for payload in registry.collect()
            if payload.name == AUTH_SIGN_IN_LOCKOUTS.name
            for point in payload.numbers
        ),
        key=repr,
    )


class TestLockOutsAreCounted:
    """For an operator to see someone keeping a person out on purpose, by
    which limit locked and nothing about whom."""

    async def test_each_lock_out_counts_once_by_its_limit(
        self, world: World, registry: MetricsRegistry
    ) -> None:
        await _fail_until_locked(world, ADA)
        # Refused while locked: no new lock-out.
        await world.sign_in(ADA, "a wrong guess")
        await world.later(timedelta(minutes=15))
        await _fail_until_locked(world, ADA)
        world.config.gateway_login_max_failures_per_address = 3
        for n in range(3):
            await world.sign_in(f"p{n}@example.com", "a guess", OTHER_CLIENT)

        assert _lockouts(registry) == [
            ({"limit": "client_address"}, 1.0),
            ({"limit": "email"}, 2.0),
        ]

    async def test_the_attempt_that_reaches_the_limit_and_succeeds_is_none(
        self, world: World, registry: MetricsRegistry
    ) -> None:
        for _ in range(9):
            await _guess(world, ADA)
        await world.wait_out()

        assert (await world.sign_in(ADA, PASSWORD)).status_code == 200
        assert _lockouts(registry) == []


class TestTheLockLeavesOtherWaysIn:
    """The lock is on password sign-in alone (`/auth/login`): it never ends
    a session already signed in, nor turns away single sign-on."""

    async def test_a_session_signed_in_before_the_lock_carries_on(
        self, world: World
    ) -> None:
        signed_in = await world.sign_in(ADA, PASSWORD)
        assert signed_in.status_code == 200
        cookie = signed_in.cookies["switch_auth"]
        assert await _fail_until_locked(world, ADA) == [401] * 10 + [429]
        del world.app.dependency_overrides[get_current_user]

        async with world.client() as client:
            client.cookies.set("switch_auth", cookie)
            me = await client.get("/auth/me")
            refreshed = await client.post("/auth/refresh")

        assert me.status_code == 200, me.text
        assert me.json()["email"] == ADA
        assert refreshed.status_code == 200, refreshed.text
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 429

    async def test_single_sign_on_signs_in_an_email_whose_password_is_locked(
        self, world: World, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        assert await _fail_until_locked(world, ADA) == [401] * 10 + [429]
        token = {
            "userinfo": {
                "email": ADA,
                "email_verified": True,
                "sub": "idp|ada",
                "name": "Ada",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        with tenant_scope(TENANT_ZERO_ID):
            async with world.factory() as session:
                response = await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=oidc_config(),
                    session=session,
                    session_factory=world.factory,
                    user_store=UserStore(),
                    organization_directory=LocalDirectory(),
                )

        assert response.status_code == 303
        cookie = response.headers["set-cookie"].split("switch_auth=", 1)[1]
        claims = decode_jwt(cookie.split(";", 1)[0], oidc_config().keyring)
        async with world.factory() as session:
            ada = await UserStore().get_by_email(session, ADA)
        assert ada is not None and claims["sub"] == ada.id
        assert (await world.sign_in(ADA, PASSWORD)).status_code == 429


class TestOnePasswordCheckEach:
    """Every sign-in pays for one bcrypt comparison, so its timing does not
    say whether the email has an account."""

    @pytest.mark.parametrize(
        ("email", "password", "status"),
        [
            (NOBODY, PASSWORD, 401),
            (ADA, "a wrong guess", 401),
            (ADA, PASSWORD, 200),
            ("sso-only@example.com", PASSWORD, 401),
        ],
    )
    async def test_exactly_one_comparison(
        self, world: World, monkeypatch, email: str, password: str, status: int
    ) -> None:
        await _user(world.factory, "sso-only@example.com", password=None)
        checked = []
        real = bcrypt.checkpw

        def counting(password: bytes, hashed: bytes) -> bool:
            checked.append(hashed)
            return real(password, hashed)

        monkeypatch.setattr(bcrypt, "checkpw", counting)
        assert (await world.sign_in(email, password)).status_code == status
        assert len(checked) == 1
        # At the cost every account's hash is made with.
        assert checked[0].split(b"$")[2] == hash_password("x").encode().split(b"$")[2]

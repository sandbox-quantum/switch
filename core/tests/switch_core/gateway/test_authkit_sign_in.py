"""Signing in through WorkOS AuthKit: the gateway's sign-in routes with
`GATEWAY_SIGN_IN_PROVIDER=workos`, end to end over HTTP, against real
Postgres and a stand-in for WorkOS."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware

import switch_core.gateway.oidc_routes as oidc_routes
from switch_core.config import WORKOS_IDENTITY_ISSUER, SwitchConfig
from switch_core.db.models import (
    IdentitySession,
    OidcIdentity,
    Organization,
    OrganizationMember,
    User,
)
from switch_core.db.stores.identity_session_store import IdentitySessionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import decode_jwt
from switch_core.organization_directory import (
    DirectoryMembership,
    DirectoryUnavailable,
    LocalDirectory,
)
from switch_core.workos_authkit import AuthKit

API = "https://api.workos.example.test"
CLIENT_ID = "client_SWITCH"
CALLBACK = "http://switch.example.test/gateway/auth/oidc/callback"


def _config(**overrides: object) -> SwitchConfig:
    base: dict[str, object] = dict(
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        id_server_name="m",
        agent_registration_token="t",
        secret_keys="test:" + "x" * 40,
        gateway_admin_email="a@b.c",
        gateway_admin_password="pw",
        gateway_sign_in_provider="workos",
        workos_client_id=CLIENT_ID,
        workos_api_key="workos-api-key-placeholder",  # gitleaks:allow
        workos_api_url=API,
        gateway_oidc_redirect_url=CALLBACK,
        gateway_signup_mode="open",
    )
    base.update(overrides)
    return SwitchConfig(**base)  # type: ignore[arg-type]


def _access_token(session_id: str) -> str:
    return jwt.encode(
        {"sub": "ignored", "sid": session_id, "exp": 4_000_000_000},
        "test-signing-key-long-enough-for-hs256",
        algorithm="HS256",
    )


class _WorkOS:
    """Stands in for WorkOS's authenticate endpoint."""

    def __init__(self) -> None:
        self.user = {
            "id": "user_ADA",
            "email": "ada@example.test",
            "email_verified": True,
            "first_name": "Ada",
            "last_name": "Lovelace",
        }
        self.session_id = "session_ONE"
        self.impersonator: dict[str, str] | None = None
        self.status = 200
        self.body: dict[str, object] | None = None
        self.exchanged: list[dict[str, object]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/authenticate"
        body = json.loads(request.content)
        self.exchanged.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json=self.body or {})
        answer: dict[str, object] = {
            "user": self.user,
            "organization_id": None,
            "access_token": _access_token(self.session_id),
            "refresh_token": "refresh-placeholder",
        }
        if self.impersonator is not None:
            answer["impersonator"] = self.impersonator
        return httpx.Response(200, json=answer)


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    workos: _WorkOS,
    config: SwitchConfig,
    directory: object = None,
) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    gateway = FastAPI()
    gateway.include_router(oidc_routes.router)
    gateway.dependency_overrides[gw_deps.get_config] = lambda: config
    gateway.dependency_overrides[gw_deps.get_system_session] = _session_dep
    gateway.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    gateway.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    gateway.dependency_overrides[gw_deps.get_organization_directory] = (
        LocalDirectory if directory is None else (lambda: directory)
    )
    gateway.add_middleware(SessionMiddleware, secret_key="test")
    gateway.state.authkit = AuthKit(
        httpx.AsyncClient(transport=httpx.MockTransport(workos.handler)),
        "workos-api-key-placeholder",  # gitleaks:allow
        API,
        CLIENT_ID,
    )
    app = FastAPI()
    app.mount("/gateway", gateway)
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://switch.example.test",
        follow_redirects=False,
    )


async def _start(client: httpx.AsyncClient, query: str = "") -> dict[str, str]:
    response = await client.get(f"/gateway/auth/oidc/login{query}")
    assert response.status_code == 302, response.text
    location = urlsplit(response.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == (
        f"{API}/user_management/authorize"
    )
    return {key: values[0] for key, values in parse_qs(location.query).items()}


async def _come_back(
    client: httpx.AsyncClient, authorize: dict[str, str], code: str = "the-code"
) -> httpx.Response:
    return await client.get(
        "/gateway/auth/oidc/callback",
        params={"code": code, "state": authorize["state"]},
    )


def _sign_in_error(response: httpx.Response) -> str | None:
    location = urlsplit(response.headers["location"])
    if location.path != "/login":
        return None
    return parse_qs(location.query).get("sign_in_error", [None])[0]


async def _signed_in_as(
    session_factory: async_sessionmaker[AsyncSession], response: httpx.Response
) -> tuple[User, IdentitySession]:
    claims = decode_jwt(response.cookies["switch_auth"], _config().keyring)
    async with session_factory() as session:
        user = await session.get(User, claims["sub"])
        row = await session.get(IdentitySession, claims["isid"])
    assert user is not None and row is not None
    return user, row


class TestStartingASignIn:
    async def test_it_goes_to_authkit_with_pkce_and_comes_back_here(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            authorize = await _start(client)
        assert authorize["client_id"] == CLIENT_ID
        assert authorize["provider"] == "authkit"
        assert authorize["redirect_uri"] == CALLBACK
        assert authorize["response_type"] == "code"
        assert authorize["code_challenge_method"] == "S256"
        assert len(authorize["state"]) >= 32

    async def test_what_workos_sends_to_the_initiate_login_uri_is_passed_on(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            authorize = await _start(
                client, "?invitation_token=Inv1te_Token&login_hint=ada%40example.test"
            )
        assert authorize["invitation_token"] == "Inv1te_Token"
        assert authorize["login_hint"] == "ada@example.test"

    async def test_a_login_hint_any_address_can_be_is_passed_on(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            authorize = await _start(
                client, "?login_hint=o%27brien%2Bx%3Dy%40example.test"
            )
        assert authorize["login_hint"] == "o'brien+x=y@example.test"

    async def test_a_malformed_forwarded_value_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            response = await client.get(
                "/gateway/auth/oidc/login", params={"organization_id": "org 1"}
            )
        assert response.status_code == 400

    async def test_there_are_no_login_options(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            response = await client.get("/gateway/auth/oidc/login?provider=google")
        assert response.status_code == 400


class TestCompletingASignIn:
    async def test_a_first_sign_in_makes_the_account_and_records_the_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            authorize = await _start(client)
            response = await _come_back(client, authorize)

        assert response.status_code == 303
        assert response.headers["location"] == "/"
        user, row = await _signed_in_as(session_factory, response)
        assert (user.email, user.name, user.password_hash) == (
            "ada@example.test",
            "Ada Lovelace",
            None,
        )
        assert (
            row.user_id,
            row.provider,
            row.provider_user_id,
            row.session_id,
        ) == (user.id, "workos", "user_ADA", "session_ONE")
        # Kept for acting in the person's organization, and only encrypted.
        assert "refresh-placeholder" not in row.encrypted_refresh_token
        assert (
            _config().keyring.decrypt(row.encrypted_refresh_token)
            == "refresh-placeholder"
        )
        async with session_factory() as session:
            identity = await session.scalar(
                select(OidcIdentity).where(OidcIdentity.user_id == user.id)
            )
        assert identity is not None
        assert (identity.iss, identity.sub) == (WORKOS_IDENTITY_ISSUER, "user_ADA")
        # The code was exchanged with the verifier behind the challenge.
        [exchange] = workos.exchanged
        challenge = (
            base64.urlsafe_b64encode(
                hashlib.sha256(str(exchange["code_verifier"]).encode()).digest()
            )
            .rstrip(b"=")
            .decode()
        )
        assert challenge == authorize["code_challenge"]
        assert exchange["code"] == "the-code"
        assert exchange["client_id"] == CLIENT_ID

    async def test_signing_in_again_on_the_same_session_is_the_same_record(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            first = await _come_back(client, await _start(client))
            again = await _come_back(client, await _start(client))
        (ada, first_row), (same, again_row) = (
            await _signed_in_as(session_factory, first),
            await _signed_in_as(session_factory, again),
        )
        assert ada.id == same.id
        assert first_row.id == again_row.id

    async def test_a_session_handed_out_again_after_it_ended_is_a_new_record(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            first = await _come_back(client, await _start(client))
            _, first_row = await _signed_in_as(session_factory, first)
            async with session_factory() as session:
                await IdentitySessionStore().end(
                    session, [first_row.id], datetime.now(UTC)
                )
                await session.commit()
            again = await _come_back(client, await _start(client))
        _, again_row = await _signed_in_as(session_factory, again)
        assert again_row.id != first_row.id

    async def test_lands_where_it_was_asked_to_on_the_dashboards_own_host(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(
            session_factory,
            _WorkOS(),
            _config(frontend_base_url="https://dashboard.example.test"),
        )
        async with _client(app) as client:
            authorize = await _start(client, "?next=%2Frooms%2Fr1%3Ftab%3Ddocuments")
            response = await _come_back(client, authorize)
        assert response.headers["location"] == (
            "https://dashboard.example.test/rooms/r1?tab=documents"
        )

    @pytest.mark.parametrize(
        "next_value",
        [
            "https://elsewhere.example.test/",
            "//elsewhere.example.test/x",
            "/\\elsewhere",
            "rooms",
            # A browser drops a tab from an address: this is //elsewhere.
            "/\t/elsewhere.example.test",
            "/\x00/elsewhere.example.test",
            # On this host, but not one of the dashboard's pages.
            "/gateway/auth/oidc/login",
        ],
    )
    async def test_a_landing_place_off_the_dashboard_lands_on_its_home(
        self, session_factory: async_sessionmaker[AsyncSession], next_value: str
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            response = await client.get(
                "/gateway/auth/oidc/login", params={"next": next_value}
            )
            authorize = {
                key: values[0]
                for key, values in parse_qs(
                    urlsplit(response.headers["location"]).query
                ).items()
            }
            landed = await _come_back(client, authorize)
        assert landed.headers["location"] == "/"

    async def test_two_sign_ins_in_one_browser_each_finish(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            first = await _start(client, "?next=%2Frooms")
            second = await _start(client, "?next=%2Fagents")
            assert (await _come_back(client, second)).headers["location"] == "/agents"
            assert (await _come_back(client, first)).headers["location"] == "/rooms"

    async def test_an_unverified_address_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        workos.user["email_verified"] = False
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "email_unverified"
        assert "switch_auth" not in response.cookies

    async def test_an_impersonated_sign_in_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        workos.impersonator = {"email": "support@example.test", "reason": "debug"}
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "impersonation"
        async with session_factory() as session:
            assert await UserStore().get_by_email(session, "ada@example.test") is None

    async def test_a_code_workos_refuses_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        workos.status = 400
        workos.body = {"error": "invalid_grant"}
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "refused"

    async def test_workos_failing_is_unavailable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        workos.status = 503
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "unavailable"

    @pytest.mark.parametrize(
        ("error", "code"), [("access_denied", "cancelled"), ("server_error", "refused")]
    )
    async def test_a_sign_in_workos_sends_back_with_an_error_says_so(
        self, session_factory: async_sessionmaker[AsyncSession], error: str, code: str
    ) -> None:
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            authorize = await _start(client)
            response = await client.get(
                "/gateway/auth/oidc/callback",
                params={"error": error, "state": authorize["state"]},
            )
        assert _sign_in_error(response) == code

    async def test_a_state_this_browser_did_not_keep_restarts_once_then_gives_up(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        workos = _WorkOS()
        app = _app(session_factory, workos, _config())
        async with _client(app) as client:
            restarted = await client.get(
                "/gateway/auth/oidc/callback",
                params={"code": "c", "state": "forgotten"},
            )
            assert restarted.status_code == 303
            assert restarted.headers["location"] == "/gateway/auth/oidc/login?restart=1"
            again = await _start(client, "?restart=1")
            client.cookies.clear()
            gave_up = await _come_back(client, again)
        assert _sign_in_error(gave_up) == "expired"
        assert workos.exchanged == []

    async def test_a_session_live_under_another_account_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            other = User(
                name="Eve", email=f"eve-{uuid.uuid4().hex}@example.test", role="user"
            )
            session.add(other)
            await session.commit()
            await IdentitySessionStore().record(
                session,
                user_id=other.id,
                provider="workos",
                provider_user_id="user_OTHER",
                session_id="session_ONE",
                encrypted_refresh_token="sealed-refresh-token",
                now=datetime.now(UTC),
            )
            await session.commit()
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "refused"


class TestUnderTheWorkOSDirectory:
    async def test_an_account_with_the_same_address_is_not_joined(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(User(name="Ada", email="ada@example.test", role="user"))
            await session.commit()
        config = _config(
            organization_directory="workos", gateway_signup_mode="invite_only"
        )
        app = _app(session_factory, _WorkOS(), config)
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert _sign_in_error(response) == "account_conflict"

    async def test_a_legacy_identity_is_not_moved_by_its_subject(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A row from before issuers were tracked is copied by the linking
        command, never matched and moved by an AuthKit sign-in."""
        async with session_factory() as session:
            ada = User(name="Ada", email="ada-legacy@example.test", role="user")
            session.add(ada)
            await session.flush()
            session.add(OidcIdentity(user_id=ada.id, iss=None, sub="user_ADA"))
            await session.commit()
        config = _config(
            organization_directory="workos", gateway_signup_mode="invite_only"
        )
        app = _app(session_factory, _WorkOS(), config)
        async with _client(app) as client:
            await _come_back(client, await _start(client))
        async with session_factory() as session:
            legacy = await session.scalar(
                select(OidcIdentity).where(OidcIdentity.user_id == ada.id)
            )
        assert legacy is not None and legacy.iss is None


class _Directory:
    """A directory kept outside Switch: answers `memberships`, or raises."""

    def __init__(self, memberships: object) -> None:
        self.memberships = memberships
        self.asked: list[str] = []

    async def memberships_at_sign_in(self, subject: str):
        self.asked.append(subject)
        if isinstance(self.memberships, Exception):
            raise self.memberships
        return self.memberships


class TestBringingInOrganizations:
    """Under the WorkOS directory the person's organizations are brought into
    Switch at sign-in, and neither WorkOS nor Switch failing stops it."""

    def _config(self) -> SwitchConfig:
        return _config(
            organization_directory="workos", gateway_signup_mode="invite_only"
        )

    async def test_their_organizations_are_brought_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        linked = f"org_workos_{uuid.uuid4().hex[:8]}"
        organization_id = f"org-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(
                Organization(
                    id=organization_id,
                    slug=organization_id,
                    name="Acme",
                    workos_organization_id=linked,
                )
            )
            await session.commit()
        directory = _Directory([DirectoryMembership(linked, "org_admin")])
        app = _app(session_factory, _WorkOS(), self._config(), directory)
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        user, _ = await _signed_in_as(session_factory, response)
        assert directory.asked == ["user_ADA"]
        async with session_factory() as session:
            member = await session.get(OrganizationMember, (organization_id, user.id))
        assert member is not None and member.role == "org_admin"

    async def test_an_unreachable_directory_does_not_stop_the_sign_in(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        directory = _Directory(DirectoryUnavailable("WorkOS answered 500."))
        app = _app(session_factory, _WorkOS(), self._config(), directory)
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert "switch_auth" in response.cookies
        assert "WorkOS answered 500." in caplog.text

    async def test_a_failure_writing_switchs_rows_does_not_stop_the_sign_in(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        async def failing(*_args: object) -> None:
            raise OperationalError("UPDATE organization_members", {}, Exception())

        monkeypatch.setattr(oidc_routes, "bring_in_memberships", failing)
        app = _app(session_factory, _WorkOS(), self._config(), _Directory([]))
        async with _client(app) as client:
            response = await _come_back(client, await _start(client))
        assert "switch_auth" in response.cookies
        [record] = [r for r in caplog.records if "may be behind" in r.message]
        assert record.levelname == "ERROR"


class TestHandingTheSignInBackToConsole:
    async def test_the_code_carries_the_session_into_consoles_cookie(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        verifier = "v" * 43
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        app = _app(session_factory, _WorkOS(), _config())
        async with _client(app) as client:
            authorize = await _start(
                client,
                "?"
                + "&".join(
                    [
                        "return_to=http%3A%2F%2F127.0.0.1%3A51234%2Fswitch-sign-in",
                        "state=" + "s" * 24,
                        "challenge=" + challenge,
                    ]
                ),
            )
            back = await _come_back(client, authorize)
            assert back.status_code == 303
            assert "switch_auth" not in back.cookies
            location = urlsplit(back.headers["location"])
            assert location.netloc == "127.0.0.1:51234"
            code = parse_qs(location.query)["code"][0]
            exchanged = await client.post(
                "/gateway/auth/oidc/exchange", json={"code": code, "verifier": verifier}
            )
        assert exchanged.status_code == 200
        _, row = await _signed_in_as(session_factory, exchanged)
        assert row.session_id == "session_ONE"


class TestTheAddressASignInCameFrom:
    """The client's own address, as uvicorn resolved it behind the proxies it
    trusts (`FORWARDED_ALLOW_IPS`), never a proxy's."""

    def _request(self, client: str) -> SimpleNamespace:
        return SimpleNamespace(client=SimpleNamespace(host=client), headers={})

    def test_a_clients_own_address_is_sent(self) -> None:
        assert oidc_routes._client_ip(self._request("198.51.100.7")) == "198.51.100.7"  # type: ignore[arg-type]

    def test_an_ipv4_address_carried_in_ipv6_is_sent_as_ipv4(self) -> None:
        request = self._request("::ffff:198.51.100.7")
        assert oidc_routes._client_ip(request) == "198.51.100.7"  # type: ignore[arg-type]

    @pytest.mark.parametrize("proxy", ["10.0.0.5", "127.0.0.1", "fd00::1", ""])
    def test_a_proxys_address_or_none_is_not_sent(self, proxy: str) -> None:
        assert oidc_routes._client_ip(self._request(proxy)) is None  # type: ignore[arg-type]

"""The operator's connector-app routes, against Postgres and fake vendors.

Only the server's operator reaches them; a save is checked with the vendor
and stored only when the vendor accepts it; it is in use at once; and no
secret leaves in a response, an audit row or a log line beyond its last four
characters.
"""

from __future__ import annotations

import base64
import json
import logging
import secrets
import uuid
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_credentials import (
    GITHUB_NEEDS_HTTPS,
    ConnectorApps,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import (
    ServerAuditEvent,
    ServiceAppCredential,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_app_credential_store import (
    ServiceAppCredentialStore,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.connector_apps import router as connector_apps_router
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _config
from tests.switch_core.connections.fake_vendor import (
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
    FakeGoogle,
)
from tests.switch_core.management.harness import Harness, build_harness, cookies_for

PUBLIC = "https://switch.example.com"
HTTP_PUBLIC = "http://switch.example.com"
# The address a server Switch Console runs has.
LOOPBACK_PUBLIC = "http://127.0.0.1:8000"
APPS = "/gateway/connector-apps"
GOOGLE = "google-workspace"
AIRTABLE = "airtable"
AIRTABLE_CALLBACK = f"{PUBLIC}/gateway/service-connections/{AIRTABLE}/flows/callback"
AIRTABLE_SECRET = "example-airtable-secret-0000"
GITHUB_CLIENT_ID = "example-github-client-id"
GITHUB_SECRET = "example-github-secret-0000"


class FakeGitHub:
    """GitHub's App side: `GET /app` with the App's JWT, and the code
    exchange that tells a right client secret from a wrong one."""

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.client_id = GITHUB_CLIENT_ID
        self.client_secret = GITHUB_SECRET
        self.permissions = {
            "contents": "write",
            "pull_requests": "write",
            "metadata": "read",
        }

    def pem(self, key: rsa.RSAPrivateKey | None = None) -> str:
        return (
            (key or self.key)
            .private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            .decode()
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/app" and request.method == "GET":
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            try:
                claims = jwt.decode(token, self.key.public_key(), algorithms=["RS256"])
            except jwt.InvalidTokenError:
                return httpx.Response(
                    401, json={"message": "A JSON web token could not be decoded"}
                )
            if claims.get("iss") != self.client_id:
                return httpx.Response(401, json={"message": "Integration not found"})
            return httpx.Response(
                200,
                json={
                    "slug": "example-app",
                    "client_id": self.client_id,
                    "permissions": self.permissions,
                },
            )
        if request.url.path == "/login/oauth/access_token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if (form.get("client_id"), form.get("client_secret")) == (
                self.client_id,
                self.client_secret,
            ):
                return httpx.Response(200, json={"error": "bad_verification_code"})
            return httpx.Response(200, json={"error": "incorrect_client_credentials"})
        return httpx.Response(404)


class FakeAirtable:
    """Airtable's side: its MCP server names the authorization server, whose
    token endpoint, as Airtable's was seen to, wants a PKCE verifier before
    anything else, takes the secret only as HTTP Basic, and compares the
    redirect only with a real code."""

    MCP = "https://mcp.airtable.com/mcp"
    RESOURCE = "https://mcp.airtable.com/.well-known/oauth-protected-resource/mcp"
    ISSUER = "https://airtable.com/oauth2/v1"

    def __init__(self) -> None:
        self.client_id = STATIC_CLIENT_ID
        self.client_secret = AIRTABLE_SECRET
        self.token_requests: list[dict[str, str]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = f"{request.url.scheme}://{request.url.host}{request.url.path}"
        if url == self.MCP:
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": f'Bearer resource_metadata="{self.RESOURCE}"'
                },
            )
        if url == self.RESOURCE:
            return httpx.Response(
                200, json={"resource": self.MCP, "authorization_servers": [self.ISSUER]}
            )
        if (
            url
            == "https://airtable.com/.well-known/oauth-authorization-server/oauth2/v1"
        ):
            return httpx.Response(
                200,
                json={
                    "issuer": self.ISSUER,
                    "authorization_endpoint": f"{self.ISSUER}/authorize",
                    "token_endpoint": f"{self.ISSUER}/token",
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": [
                        "client_secret_basic",
                        "none",
                    ],
                },
            )
        if url == f"{self.ISSUER}/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if "code_verifier" not in form:
                return httpx.Response(400, json={"error": "invalid_request"})
            pair = f"{self.client_id}:{self.client_secret}".encode()
            if (
                request.headers.get("authorization")
                != f"Basic {base64.b64encode(pair).decode()}"
                or "client_secret" in form
            ):
                return httpx.Response(401, json={"error": "invalid_client"})
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(404)


class World:
    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], public_url: str | None
    ) -> None:
        self.google = FakeGoogle()
        self.github = FakeGitHub()
        self.airtable = FakeAirtable()
        self.unreachable = False
        self.vendor_calls: list[str] = []
        self.public_url = public_url
        # Settings beyond the public URL, such as a configured GitHub App.
        self.config: dict[str, object] = {}
        self.harness: Harness = build_harness(session_factory)
        self.session_factory = session_factory

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.vendor_calls.append(str(request.url))
        if self.unreachable:
            raise httpx.ConnectError("unreachable", request=request)
        if request.url.host in ("api.github.com", "github.com"):
            return self.github.handle(request)
        if request.url.host in ("mcp.airtable.com", "airtable.com"):
            return self.airtable.handle(request)
        return self.google.handle(request)

    async def install(self, environ: dict[str, str] | None = None) -> ConnectorApps:
        http = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        registration = ClientRegistration(
            session_factory=self.session_factory,
            keyring=TEST_KEYRING,
            public_url=self.public_url,
            server_name="switch.example.com",
        )
        apps = ConnectorApps(
            catalog=CATALOG,
            config=_config(gateway_public_url=self.public_url, **self.config),
            environ=environ or {},
            session_factory=self.session_factory,
            store=ServiceAppCredentialStore(TEST_KEYRING),
            http=http,
            registration=registration,
        )
        await apps.load()
        broker = ServiceBroker(
            session_factory=self.session_factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters=build_adapters(
                CATALOG,
                github_app=apps.github_app(),
                oauth_clients=apps.oauth_clients(),
                http=http,
                registration=registration,
            ),
            disabled={},
            store=ServiceConnectionStore(),
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=self.public_url,
        )
        app = self.harness.gateway_app
        app.state.service_broker = broker
        app.state.connector_apps = apps
        app.state.github_connections = None
        app.state.service_flows = ServiceFlows(
            self.public_url, SignInFlows(self.session_factory, TEST_KEYRING)
        )
        app.include_router(connector_apps_router)
        app.include_router(service_connections_router)
        app.include_router(service_flows_router)
        return apps


async def _user(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    role: str = "user",
    member_role: str = "member",
    tenant_id: str = "default",
) -> User:
    async with session_factory() as session:
        user = User(
            name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role=role
        )
        session.add(user)
        await session.flush()
        session.add(
            TenantMember(
                tenant_id=await _tenant_id(session, tenant_id),
                user_id=user.id,
                role=member_role,
            )
        )
        await session.commit()
        return user


async def _tenant_id(session: AsyncSession, slug: str) -> str:
    tenant = await session.scalar(select(Tenant).where(Tenant.slug == slug))
    if tenant is None:
        tenant = Tenant(id=f"tenant-{slug}", slug=slug, name=slug)
        session.add(tenant)
        await session.flush()
    return tenant.id


def _google_body(**overrides: object) -> dict[str, object]:
    return {
        "client_id": STATIC_CLIENT_ID,
        "client_secret": STATIC_CLIENT_SECRET,
        "replace": False,
        **overrides,
    }


async def _rows(session_factory) -> list[ServiceAppCredential]:
    async with session_factory() as session:
        return list(await session.scalars(select(ServiceAppCredential)))


async def _audit(session_factory) -> list[ServerAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
            )
        )


@pytest.fixture
async def world(session_factory) -> World:
    return World(session_factory, PUBLIC)


@pytest.fixture
async def http_world(session_factory) -> World:
    return World(session_factory, HTTP_PUBLIC)


@pytest.fixture
async def loopback_world(session_factory) -> World:
    return World(session_factory, LOOPBACK_PUBLIC)


@pytest.fixture
async def local_world(session_factory) -> World:
    """A server with no public address, as a local one runs."""
    return World(session_factory, None)


@pytest.fixture
async def operator(session_factory) -> User:
    return await _user(session_factory, "operator", role="admin")


class TestOnlyTheOperator:
    @pytest.mark.parametrize("member_role", ["member", "admin", "owner"])
    async def test_everyone_else_is_refused_on_every_route(
        self, world: World, session_factory, member_role: str
    ) -> None:
        await world.install()
        someone = await _user(session_factory, "someone", member_role=member_role)
        async with world.harness.client() as client:
            cookies = cookies_for(someone)
            answers = [
                await client.get(APPS, cookies=cookies),
                await client.put(
                    f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
                ),
                await client.post(f"{APPS}/{GOOGLE}/import", cookies=cookies),
                await client.post(f"{APPS}/{GOOGLE}/check", cookies=cookies),
                await client.get(
                    f"{APPS}/{GOOGLE}/impact",
                    params={"client_id": "x"},
                    cookies=cookies,
                ),
                await client.delete(f"{APPS}/{GOOGLE}", cookies=cookies),
            ]
        assert [answer.status_code for answer in answers] == [403] * 6
        assert await _rows(session_factory) == []

    async def test_the_operator_reads_every_app(self, world: World, operator) -> None:
        await world.install()
        async with world.harness.client() as client:
            listed = await client.get(APPS, cookies=cookies_for(operator))
        assert listed.status_code == 200, listed.text
        body = listed.json()
        assert body["public_url"] == PUBLIC
        apps = {entry["slug"]: entry for entry in body["apps"]}
        assert set(apps) == {"github", GOOGLE, AIRTABLE}
        assert apps[GOOGLE]["source"] == "none"
        google = f"{PUBLIC}/gateway/service-connections/{GOOGLE}/flows/callback"
        assert apps[GOOGLE]["redirect_uri"] == google
        assert apps[GOOGLE]["redirect_uris"] == [google]
        assert apps[GOOGLE]["needs_public_url"] is True
        github = f"{PUBLIC}/gateway/provider-connections/github/callback"
        assert apps["github"]["redirect_uri"] == github
        assert apps["github"]["redirect_uris"] == [github]
        assert apps["github"]["needs_public_url"] is True
        assert apps["github"]["scopes"] == []
        # Airtable comes back to Core's own callback, as Google does, and its
        # integration lists the scopes a sign-in may ask for.
        assert apps[AIRTABLE]["redirect_uris"] == [AIRTABLE_CALLBACK]
        assert apps[AIRTABLE]["redirect_uri"] == AIRTABLE_CALLBACK
        assert apps[AIRTABLE]["needs_public_url"] is True
        assert apps[AIRTABLE]["scopes"] == [
            "data.records:read",
            "schema.bases:read",
            "data.recordComments:read",
            "workspacesAndBases:read",
            "data.records:write",
            "data.recordComments:write",
        ]
        # A client Core registers itself is nothing for the operator to set up.
        assert "atlassian" not in apps
        assert set(body) == {"public_url", "apps"}

    async def test_an_unknown_service_is_not_found(
        self, world: World, operator
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/datadog", json=_google_body(), cookies=cookies_for(operator)
            )
        assert answer.status_code == 404


class TestSaving:
    async def test_a_checked_client_is_saved_audited_and_in_use_at_once(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            port = secrets.token_urlsafe(32)
            start = {"port": 43123, "state": port, "completion_secret": "c" * 43}
            before = await client.post(
                f"/gateway/service-connections/{GOOGLE}/flows",
                json=start,
                cookies=cookies,
            )
            saved = await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
            )
            after = await client.post(
                f"/gateway/service-connections/{GOOGLE}/flows",
                json={**start, "state": secrets.token_urlsafe(32)},
                cookies=cookies,
            )
        assert before.status_code == 503
        assert saved.status_code == 200, saved.text
        entry = saved.json()
        assert entry["source"] == "saved"
        assert entry["client_id"] == STATIC_CLIENT_ID
        assert entry["secrets"]["client_secret"] == {
            "set": True,
            "last4": STATIC_CLIENT_SECRET[-4:],
        }
        assert entry["updated_by_name"] == "operator"
        assert after.status_code == 200, after.text
        [event] = await _audit(session_factory)
        assert event.action == "connector_app.saved"
        assert event.actor_user_id == operator.id
        assert event.details == {
            "service": GOOGLE,
            "fields_changed": ["client_id", "client_secret"],
            "client_id": STATIC_CLIENT_ID,
        }

    async def test_the_first_save_needs_every_secret(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/{GOOGLE}",
                json=_google_body(client_secret=None),
                cookies=cookies_for(operator),
            )
        assert answer.status_code == 422
        assert answer.json()["detail"] == "Enter the client secret."
        assert await _rows(session_factory) == []

    async def test_a_refusal_stores_nothing(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/{GOOGLE}",
                json=_google_body(client_secret="example-wrong-secret"),
                cookies=cookies_for(operator),
            )
        assert answer.status_code == 422
        assert answer.json()["field"] == "client_secret"
        assert "doesn't recognise this client ID and secret" in answer.json()["detail"]
        assert await _rows(session_factory) == []
        assert await _audit(session_factory) == []

    async def test_an_unreachable_vendor_stores_nothing(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        world.unreachable = True
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
        assert answer.status_code == 503
        assert answer.json()["detail"] == "Couldn't reach Google Workspace. Try again."
        assert await _rows(session_factory) == []

    async def test_another_client_id_needs_replace(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            assert (
                await client.put(
                    f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
                )
            ).status_code == 200
            world.google.client_id = "another-client-id"
            refused = await client.put(
                f"{APPS}/{GOOGLE}",
                json=_google_body(client_id="another-client-id"),
                cookies=cookies,
            )
            switched = await client.put(
                f"{APPS}/{GOOGLE}",
                json=_google_body(client_id="another-client-id", replace=True),
                cookies=cookies,
            )
        assert refused.status_code == 409
        assert "different app" in refused.json()["detail"]
        assert switched.status_code == 200, switched.text
        [row] = await _rows(session_factory)
        assert row.client_id == "another-client-id"
        events = await _audit(session_factory)
        assert events[-1].details["previous_client_id"] == STATIC_CLIENT_ID

    async def test_saving_is_refused_while_configuration_is_set(
        self, world: World, operator, session_factory, tmp_path: Path
    ) -> None:
        path = tmp_path / "google.json"
        path.write_text(
            json.dumps(
                {"client_id": STATIC_CLIENT_ID, "client_secret": STATIC_CLIENT_SECRET}
            )
        )
        await world.install({"GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH": str(path)})
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
        assert answer.status_code == 409
        assert answer.json()["detail"] == (
            "GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH is set, so Switch uses that. Copy "
            "it into Switch, then unset it and restart."
        )
        assert await _rows(session_factory) == []


class TestGitHub:
    async def test_the_slug_comes_from_github_and_a_partial_save_keeps_the_key(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            first = await client.put(
                f"{APPS}/github",
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "private_key": world.github.pem(),
                    "replace": False,
                },
                cookies=cookies,
            )
            world.github.client_secret = "example-github-secret-1111"
            rotated = await client.put(
                f"{APPS}/github",
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": "example-github-secret-1111",
                    "replace": False,
                },
                cookies=cookies,
            )
        assert first.status_code == 200, first.text
        entry = first.json()
        assert entry["fields"] == {"slug": "example-app"}
        assert entry["install_url"] == (
            "https://github.com/apps/example-app/installations/new"
        )
        assert entry["secrets"]["private_key"]["fingerprint"].startswith("SHA256:")
        assert rotated.status_code == 200, rotated.text
        assert (
            rotated.json()["secrets"]["private_key"] == entry["secrets"]["private_key"]
        )
        app = world.harness.gateway_app.state.github_connections
        assert app.client_secret == "example-github-secret-1111"
        events = await _audit(session_factory)
        assert events[-1].details["fields_changed"] == ["client_secret"]

    async def test_a_key_of_another_app_is_refused(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/github",
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "private_key": world.github.pem(other),
                    "replace": False,
                },
                cookies=cookies_for(operator),
            )
        assert answer.status_code == 422
        assert answer.json()["field"] == "private_key"
        assert await _rows(session_factory) == []

    async def test_an_app_short_of_a_read_permission_is_refused_saying_which(
        self, world: World, operator, session_factory
    ) -> None:
        """Saved, it would fail at the first token any grant asks for."""
        await world.install()
        world.github.permissions = {"contents": "write", "metadata": "read"}
        async with world.harness.client() as client:
            answer = await client.put(
                f"{APPS}/github",
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "private_key": world.github.pem(),
                    "replace": False,
                },
                cookies=cookies_for(operator),
            )
        assert answer.status_code == 422, answer.text
        assert answer.json()["detail"].startswith(
            "The App lacks repository permissions agents need to read: Pull "
            "requests needs Read-only, and it has no access."
        )
        checks = {check["name"]: check["ok"] for check in answer.json()["checks"]}
        assert checks == {
            "private_key": True,
            "permissions": False,
            "client_secret": True,
        }
        assert await _rows(session_factory) == []


READ_ONLY = (
    "This server's GitHub App lets agents read only, so GitHub can't be granted "
    "for writing. Whoever runs your Switch server can change that in Switch "
    "Console, under Admin → Connector apps."
)


def _github_body(world: World) -> dict[str, object]:
    return {
        "client_id": GITHUB_CLIENT_ID,
        "client_secret": GITHUB_SECRET,
        "private_key": world.github.pem(),
        "replace": False,
    }


async def _github_entry(world: World, operator: User) -> dict[str, object]:
    async with world.harness.client() as client:
        listed = await client.get(APPS, cookies=cookies_for(operator))
    assert listed.status_code == 200, listed.text
    [entry] = [app for app in listed.json()["apps"] if app["slug"] == "github"]
    return entry


async def _github_service(world: World, operator: User) -> dict[str, object]:
    async with world.harness.client() as client:
        listed = await client.get(
            "/gateway/service-connections", cookies=cookies_for(operator)
        )
    assert listed.status_code == 200, listed.text
    [entry] = [c for c in listed.json()["connections"] if c["slug"] == "github"]
    return entry


class TestGitHubReadOnly:
    """An App with the read permissions and not the write ones is saved, and
    lets agents read only, until GitHub says otherwise."""

    async def test_an_app_that_can_only_read_is_saved_read_only(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        world.github.permissions = {
            "contents": "read",
            "pull_requests": "read",
            "metadata": "read",
        }
        async with world.harness.client() as client:
            saved = await client.put(
                f"{APPS}/github",
                json=_github_body(world),
                cookies=cookies_for(operator),
            )
        assert saved.status_code == 200, saved.text
        entry = saved.json()
        assert (entry["read_only"], entry["lacks_write"]) == (
            True,
            ["Contents", "Pull requests"],
        )
        checks = {check["name"]: check for check in entry["checks"]}
        assert checks["permissions"]["ok"] is True
        assert "Agents can only read through it" in checks["permissions"]["message"]
        [row] = await _rows(session_factory)
        assert row.settings == {
            "slug": "example-app",
            "permissions": world.github.permissions,
        }
        broker = world.harness.gateway_app.state.service_broker
        assert broker.read_only("github") == READ_ONLY
        assert (await _github_service(world, operator))["read_only_reason"] == (
            READ_ONLY
        )

    async def test_an_app_that_can_write_is_not(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            saved = await client.put(
                f"{APPS}/github",
                json=_github_body(world),
                cookies=cookies_for(operator),
            )
        assert saved.status_code == 200, saved.text
        assert (saved.json()["read_only"], saved.json()["lacks_write"]) == (False, [])
        assert (await _github_service(world, operator))["read_only_reason"] is None

    async def test_a_check_keeps_what_github_says_and_follows_a_change(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        world.github.permissions = {"contents": "read", "pull_requests": "read"}
        broker = world.harness.gateway_app.state.service_broker
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            saved = await client.put(
                f"{APPS}/github", json=_github_body(world), cookies=cookies
            )
            assert saved.status_code == 200, saved.text
            [before] = await _rows(session_factory)
            # Checked again unchanged, it stays read-only, and nothing is written.
            again = await client.post(f"{APPS}/github/check", cookies=cookies)
            assert again.status_code == 200, again.text
            assert again.json()["ok"] is True
            [unchanged] = await _rows(session_factory)
            assert unchanged.updated_at == before.updated_at
            assert (await _github_entry(world, operator))["read_only"] is True
            assert broker.read_only("github") == READ_ONLY

            # The App is given write at GitHub: the next check says so, and
            # agents can be granted writing at once.
            world.github.permissions = {"contents": "write", "pull_requests": "write"}
            granted = await client.post(f"{APPS}/github/check", cookies=cookies)
            assert granted.status_code == 200, granted.text
            assert (await _github_entry(world, operator))["read_only"] is False
            assert broker.read_only("github") is None

            # And taken away again.
            world.github.permissions = {"contents": "read", "pull_requests": "write"}
            await client.post(f"{APPS}/github/check", cookies=cookies)
        entry = await _github_entry(world, operator)
        assert (entry["read_only"], entry["lacks_write"]) == (True, ["Contents"])
        assert broker.read_only("github") == READ_ONLY
        [row] = await _rows(session_factory)
        assert row.settings["permissions"] == world.github.permissions
        assert row.updated_by == operator.id
        # A check is not a save: the audit trail holds the one save.
        assert [event.action for event in await _audit(session_factory)] == [
            "connector_app.saved"
        ]

    async def test_an_app_from_configuration_is_taken_to_write(
        self, world: World, operator, session_factory, tmp_path: Path
    ) -> None:
        """Switch never asks about a configured App before using it."""
        config = tmp_path / "github.json"
        config.write_text(
            json.dumps(
                {
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "slug": "example-app",
                    "origin": PUBLIC,
                }
            )
        )
        key = tmp_path / "github.pem"
        key.write_text(world.github.pem())
        world.config = {
            "github_app_config_path": str(config),
            "github_app_private_key_path": str(key),
        }
        await world.install()
        world.github.permissions = {"contents": "read", "pull_requests": "read"}
        async with world.harness.client() as client:
            checked = await client.post(
                f"{APPS}/github/check", cookies=cookies_for(operator)
            )
        assert checked.status_code == 200, checked.text
        assert checked.json()["ok"] is True
        assert (await _github_entry(world, operator))["read_only"] is False
        broker = world.harness.gateway_app.state.service_broker
        assert broker.read_only("github") is None
        assert await _rows(session_factory) == []


class TestGitHubNeedsHttps:
    def _body(self, world: World) -> dict[str, object]:
        return {
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_SECRET,
            "private_key": world.github.pem(),
            "replace": False,
        }

    async def test_the_list_says_why_github_cannot_be_set_up(
        self, http_world: World, operator
    ) -> None:
        await http_world.install()
        async with http_world.harness.client() as client:
            listed = await client.get(APPS, cookies=cookies_for(operator))
        assert listed.status_code == 200, listed.text
        body = listed.json()
        assert body["public_url"] == HTTP_PUBLIC
        apps = {entry["slug"]: entry for entry in body["apps"]}
        assert apps["github"]["setup_blocked"] == GITHUB_NEEDS_HTTPS
        assert apps["github"]["redirect_uri"] is None
        assert apps[GOOGLE]["setup_blocked"] is None
        assert apps[GOOGLE]["redirect_uri"] == (
            f"{HTTP_PUBLIC}/gateway/service-connections/{GOOGLE}/flows/callback"
        )

    async def test_the_catalog_says_github_cannot_work_here(
        self, http_world: World, operator
    ) -> None:
        await http_world.install()
        async with http_world.harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(operator)
            )
        assert listed.status_code == 200, listed.text
        services = {entry["slug"]: entry for entry in listed.json()["connections"]}
        assert services["github"]["unavailable_code"] == "needs_https"
        assert services["github"]["unavailable_reason"] == (
            "GitHub can't be used on this server: its address must be https, or "
            "http on your own computer (localhost or 127.0.0.1)."
        )
        assert services["github"]["server_setup_needed"] is False
        assert services[GOOGLE]["unavailable_code"] == "app_not_set_up"
        assert services[GOOGLE]["server_setup_needed"] is True

    async def test_saving_and_checking_github_are_refused_before_github_is_asked(
        self, http_world: World, operator, session_factory
    ) -> None:
        await http_world.install()
        async with http_world.harness.client() as client:
            cookies = cookies_for(operator)
            saved = await client.put(
                f"{APPS}/github", json=self._body(http_world), cookies=cookies
            )
            checked = await client.post(f"{APPS}/github/check", cookies=cookies)
        for answer in (saved, checked):
            assert answer.status_code == 409, answer.text
            assert answer.json()["detail"] == GITHUB_NEEDS_HTTPS
        assert http_world.vendor_calls == []
        assert await _rows(session_factory) == []
        assert await _audit(session_factory) == []

    async def test_a_configured_github_app_is_checked_but_not_copied_in(
        self, http_world: World, operator, session_factory, tmp_path: Path
    ) -> None:
        config = tmp_path / "github.json"
        config.write_text(
            json.dumps(
                {
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "slug": "example-app",
                    "origin": PUBLIC,
                }
            )
        )
        key = tmp_path / "github.pem"
        key.write_text(http_world.github.pem())
        http_world.config = {
            "github_app_config_path": str(config),
            "github_app_private_key_path": str(key),
        }
        apps = await http_world.install()
        assert apps.effective("github").source == "configuration"
        async with http_world.harness.client() as client:
            cookies = cookies_for(operator)
            copied = await client.post(f"{APPS}/github/import", cookies=cookies)
            checked = await client.post(f"{APPS}/github/check", cookies=cookies)
        assert copied.status_code == 409, copied.text
        assert copied.json()["detail"] == GITHUB_NEEDS_HTTPS
        assert await _rows(session_factory) == []
        assert checked.status_code == 200, checked.text
        assert checked.json()["ok"] is True

    async def test_google_is_set_up_as_before(
        self, http_world: World, operator, session_factory
    ) -> None:
        await http_world.install()
        async with http_world.harness.client() as client:
            saved = await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
        assert saved.status_code == 200, saved.text
        assert saved.json()["setup_blocked"] is None
        assert len(await _rows(session_factory)) == 1


class TestGitHubOnThisComputer:
    """A server only this computer reaches, as Switch Console runs one, is
    called back over plain http on the loopback address, which GitHub takes."""

    CALLBACK = f"{LOOPBACK_PUBLIC}/gateway/provider-connections/github/callback"

    async def test_the_list_offers_github_with_its_callback(
        self, loopback_world: World, operator
    ) -> None:
        await loopback_world.install()
        async with loopback_world.harness.client() as client:
            listed = await client.get(APPS, cookies=cookies_for(operator))
            catalog = await client.get(
                "/gateway/service-connections", cookies=cookies_for(operator)
            )
        assert listed.status_code == 200, listed.text
        apps = {entry["slug"]: entry for entry in listed.json()["apps"]}
        assert apps["github"]["setup_blocked"] is None
        assert apps["github"]["redirect_uris"] == [self.CALLBACK]
        services = {entry["slug"]: entry for entry in catalog.json()["connections"]}
        assert services["github"]["unavailable_code"] == "app_not_set_up"
        assert services["github"]["server_setup_needed"] is True

    async def test_a_github_app_is_saved_and_called_back_there(
        self, loopback_world: World, operator, session_factory
    ) -> None:
        apps = await loopback_world.install()
        async with loopback_world.harness.client() as client:
            saved = await client.put(
                f"{APPS}/github",
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "client_secret": GITHUB_SECRET,
                    "private_key": loopback_world.github.pem(),
                    "replace": False,
                },
                cookies=cookies_for(operator),
            )
        assert saved.status_code == 200, saved.text
        assert saved.json()["load_error"] is None
        assert saved.json()["redirect_uris"] == [self.CALLBACK]
        app = apps.github_app()
        assert app is not None and app.connections.callback == self.CALLBACK
        assert len(await _rows(session_factory)) == 1


class TestAirtable:
    async def test_airtable_is_checked_on_its_server_callback(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            saved = await client.put(
                f"{APPS}/{AIRTABLE}",
                json=_google_body(client_secret=AIRTABLE_SECRET),
                cookies=cookies,
            )
            checked = await client.post(f"{APPS}/{AIRTABLE}/check", cookies=cookies)
        assert saved.status_code == 200, saved.text
        assert saved.json()["source"] == "saved"
        # Saving answers what the check said, as checking it again does.
        assert saved.json()["checks"] == checked.json()["checks"]
        assert checked.status_code == 200, checked.text
        assert checked.json()["ok"] is True
        [check] = checked.json()["checks"]
        assert check["message"] == "Airtable accepts this client ID and secret."
        assert check["note"].startswith("Switch can't check the redirect URL")
        # The check is a code exchange on the redirect the integration lists.
        assert [form["redirect_uri"] for form in world.airtable.token_requests] == [
            AIRTABLE_CALLBACK
        ] * 2
        assert len(await _rows(session_factory)) == 1

    async def test_airtable_needs_the_public_url_as_google_does(
        self, local_world: World, operator, session_factory
    ) -> None:
        await local_world.install()
        async with local_world.harness.client() as client:
            refused = await client.put(
                f"{APPS}/{AIRTABLE}",
                json=_google_body(client_secret=AIRTABLE_SECRET),
                cookies=cookies_for(operator),
            )
            listed = await client.get(APPS, cookies=cookies_for(operator))
        assert refused.status_code == 409
        assert "GATEWAY_PUBLIC_URL" in refused.json()["detail"]
        apps = {entry["slug"]: entry for entry in listed.json()["apps"]}
        assert apps[AIRTABLE]["redirect_uris"] == []
        assert await _rows(session_factory) == []

    async def test_a_wrong_airtable_secret_is_refused_and_not_stored(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            refused = await client.put(
                f"{APPS}/{AIRTABLE}",
                json=_google_body(client_secret="example-wrong-secret-0000"),
                cookies=cookies_for(operator),
            )
        assert refused.status_code == 422, refused.text
        assert refused.json()["field"] == "client_secret"
        assert await _rows(session_factory) == []


class TestImportAndRemove:
    async def test_copying_configuration_in_needs_nothing_retyped(
        self, world: World, operator, session_factory, tmp_path: Path
    ) -> None:
        path = tmp_path / "google.json"
        path.write_text(
            json.dumps(
                {"client_id": STATIC_CLIENT_ID, "client_secret": STATIC_CLIENT_SECRET}
            )
        )
        apps = await world.install({"GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH": str(path)})
        async with world.harness.client() as client:
            answer = await client.post(
                f"{APPS}/{GOOGLE}/import", cookies=cookies_for(operator)
            )
            again = await client.post(
                f"{APPS}/github/import", cookies=cookies_for(operator)
            )
        assert answer.status_code == 200, answer.text
        assert answer.json()["source"] == "configuration"
        assert answer.json()["saved_ignored"] is True
        assert again.status_code == 409
        [row] = await _rows(session_factory)
        assert apps.store.secrets(row) == {"client_secret": STATIC_CLIENT_SECRET}
        [event] = await _audit(session_factory)
        assert event.action == "connector_app.imported"
        assert event.details == {
            "service": GOOGLE,
            "client_id": STATIC_CLIENT_ID,
            "source_variables": ["GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH"],
        }

    async def test_removing_leaves_the_service_not_set_up(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            await client.put(f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies)
            removed = await client.delete(f"{APPS}/{GOOGLE}", cookies=cookies)
            listed = await client.get("/gateway/service-connections", cookies=cookies)
            gone = await client.delete(f"{APPS}/{GOOGLE}", cookies=cookies)
        assert removed.status_code == 200, removed.text
        assert removed.json() == {"connected_members": 0, "workspaces": 0}
        assert gone.status_code == 404
        assert await _rows(session_factory) == []
        [google] = [c for c in listed.json()["connections"] if c["slug"] == GOOGLE]
        assert google["server_setup_needed"] is True
        assert google["unavailable_code"] == "app_not_set_up"
        assert google["unavailable_reason"].startswith(
            "Google Workspace is not set up on this server."
        )
        assert [event.action for event in await _audit(session_factory)] == [
            "connector_app.saved",
            "connector_app.removed",
        ]


class TestCheckAndImpact:
    async def test_checking_the_app_in_use_stores_nothing(
        self, world: World, operator, session_factory
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            nothing = await client.post(f"{APPS}/{GOOGLE}/check", cookies=cookies)
            await client.put(f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies)
            world.google.client_secret = "example-rotated-at-google"
            checked = await client.post(f"{APPS}/{GOOGLE}/check", cookies=cookies)
        assert nothing.status_code == 409
        assert checked.status_code == 200
        assert checked.json()["ok"] is False
        assert len(await _audit(session_factory)) == 1

    async def test_a_passing_google_check_says_it_cannot_see_the_redirect(
        self, world: World, operator
    ) -> None:
        await world.install()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            saved = await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
            )
            checked = await client.post(f"{APPS}/{GOOGLE}/check", cookies=cookies)
        assert saved.json()["checks"] == checked.json()["checks"]
        [check] = checked.json()["checks"]
        assert check["ok"] is True
        assert check["message"] == "Google Workspace accepts this client ID and secret."
        assert check["note"] == (
            "Switch can't check the redirect URI. Connect once to confirm."
        )

    async def test_the_impact_counts_people_across_workspaces(
        self, world: World, operator, session_factory
    ) -> None:
        """Ada is connected in both workspaces, and counted once."""
        await world.install()
        store = ServiceConnectionStore()
        for name, tenants in (
            ("ada", ("default", "other")),
            ("bo", ("default",)),
            ("cy", ("other",)),
        ):
            user = await _user(session_factory, name, tenant_id=tenants[0])
            for tenant in tenants:
                async with session_factory() as session:
                    tenant_id = await _tenant_id(session, tenant)
                    if tenant != tenants[0]:
                        session.add(
                            TenantMember(
                                tenant_id=tenant_id, user_id=user.id, role="member"
                            )
                        )
                    await session.commit()
                async with tenant_session(session_factory, tenant_id) as session:
                    await store.save_connection(
                        session,
                        user_id=user.id,
                        service=GOOGLE,
                        consent="read",
                        granted_scopes=[],
                        account_id=f"account-{name}-{tenant}",
                        external_identity=f"{name}@example.invalid",
                        encrypted_secret=TEST_KEYRING.encrypt("{}"),
                        oauth_client_id=STATIC_CLIENT_ID,
                        method="oauth",
                        choices={},
                    )
                    await session.commit()
        async with world.harness.client() as client:
            cookies = cookies_for(operator)
            await client.put(f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies)
            other = await client.get(
                f"{APPS}/{GOOGLE}/impact",
                params={"client_id": "another-client-id"},
                cookies=cookies,
            )
            same = await client.get(
                f"{APPS}/{GOOGLE}/impact",
                params={"client_id": STATIC_CLIENT_ID},
                cookies=cookies,
            )
            listed = await client.get(APPS, cookies=cookies)
        assert other.json() == {"connected_members": 3, "workspaces": 2}
        assert same.json() == {"connected_members": 0, "workspaces": 0}
        [google] = [a for a in listed.json()["apps"] if a["slug"] == GOOGLE]
        assert (google["connected_members"], google["workspaces"]) == (3, 2)
        assert google["stale_connections"] == 0


class TestNoSecretLeaves:
    async def test_not_in_a_response_an_audit_row_or_a_log_line(
        self, world: World, operator, session_factory, caplog
    ) -> None:
        await world.install()
        pem = world.github.pem()
        responses = []
        with caplog.at_level(logging.DEBUG):
            async with world.harness.client() as client:
                cookies = cookies_for(operator)
                responses.append(
                    await client.put(
                        f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
                    )
                )
                responses.append(
                    await client.put(
                        f"{APPS}/github",
                        json={
                            "client_id": GITHUB_CLIENT_ID,
                            "client_secret": GITHUB_SECRET,
                            "private_key": pem,
                            "replace": False,
                        },
                        cookies=cookies,
                    )
                )
                responses.append(await client.get(APPS, cookies=cookies))
                responses.append(
                    await client.post(f"{APPS}/github/check", cookies=cookies)
                )
        assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
        audit = json.dumps([event.details for event in await _audit(session_factory)])
        logged = "\n".join(record.getMessage() for record in caplog.records)
        key_body = "".join(pem.splitlines()[1:-1])
        for secret in (STATIC_CLIENT_SECRET, GITHUB_SECRET, key_body[:40]):
            for text in [r.text for r in responses] + [audit, logged]:
                assert secret not in text
        assert STATIC_CLIENT_SECRET[-4:] in responses[2].text

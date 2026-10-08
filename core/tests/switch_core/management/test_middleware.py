"""The bearer middleware's controller branch.

With an authenticator supplied, the management paths take controller access
tokens and nothing else: a valid one binds the token's tenant and puts the
principal in `scope["controller"]`; an expired, mis-signed, wrong-audience or
revoked one is refused in the contract envelope. Enrollment and token
exchange pass through unauthenticated. Without an authenticator — the flag
off — none of that exists.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.auth import BearerAuthMiddleware, ControllerPrincipal
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import TENANT_ZERO_ID, Tenant
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.keys import Keyring
from switch_core.management import tokens
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.wiring import create_management
from switch_core.tenant_context import current_tenant_id
from switch_core.trust.client import NullTrustClient
from switch_core.user_changes import LocalUserChanges
from tests.switch_core.management.harness import (
    TOKEN_SECRET,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _middleware(
    harness: Harness, *, controller_auth: ManagementAuthenticator | None
) -> tuple[BearerAuthMiddleware, dict[str, Any]]:
    captured: dict[str, Any] = {}

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        captured["tenant_id"] = current_tenant_id()
        captured["controller"] = scope.get("controller")

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=harness.session_factory,
        controller_auth=controller_auth,
    )
    return mw, captured


async def _dispatch(
    mw: BearerAuthMiddleware, path: str, token: str | None
) -> list[dict[str, Any]]:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
    await mw({"type": "http", "path": path, "headers": headers}, receive, send)
    return sent


def _refusal(sent: list[dict[str, Any]]) -> tuple[int, str]:
    body = json.loads(b"".join(m.get("body", b"") for m in sent[1:]))
    return sent[0]["status"], body["error"]["code"]


async def _enrolled(harness: Harness):
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        return await enroll_console(harness, client, owner)


def _forged(**claims: Any) -> str:
    now = datetime.now(UTC)
    payload = {
        "cid": "c",
        "tid": TENANT_ZERO_ID,
        "oid": "o",
        "aud": tokens.ACCESS_TOKEN_AUDIENCE,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=1)).timestamp()),
        **claims,
    }
    secret = payload.pop("secret", TOKEN_SECRET)
    return tokens.ACCESS_TOKEN_PREFIX + jwt.encode(payload, secret, algorithm="HS256")


class TestAValidToken:
    async def test_binds_the_tenant_and_sets_the_principal(
        self, harness: Harness
    ) -> None:
        controller = await _enrolled(harness)
        mw, captured = _middleware(
            harness, controller_auth=harness.management.authenticator
        )
        sent = await _dispatch(
            mw,
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            controller.access_token,
        )
        assert sent == []
        assert captured["tenant_id"] == TENANT_ZERO_ID
        assert captured["controller"] == ControllerPrincipal(
            controller_id=controller.controller_id,
            owner_id=controller.owner.id,
            tenant_id=TENANT_ZERO_ID,
        )

    async def test_binds_the_tokens_own_tenant(self, harness: Harness) -> None:
        other = "controller-tenant-b"
        async with harness.session_factory() as session:
            session.add(Tenant(id=other, slug=other, name=other))
            await session.commit()
        owner = await add_member(harness.session_factory, "bea", tenant_id=other)
        async with harness.client() as client:
            response = await client.post(
                "/gateway/management/controllers",
                json={
                    "name": "box",
                    "kind": "console",
                    "platform": {"os": "linux", "arch": "x64", "os_version": "6"},
                    "version": "0.1.0",
                },
                cookies=cookies_for(owner, other),
            )
            body = response.json()
            token = await client.post(
                f"/v1/management/controllers/{body['controller_id']}/token",
                json={"credential": body["credential"]},
            )
        mw, captured = _middleware(
            harness, controller_auth=harness.management.authenticator
        )
        await _dispatch(mw, "/v1/controllers/x/events", token.json()["access_token"])
        assert captured["tenant_id"] == other
        assert captured["controller"].tenant_id == other


class TestRefusals:
    @pytest.mark.parametrize(
        ("claims", "code"),
        [
            ({"exp": 1_000_000}, "token_expired"),
            ({"aud": "somebody-else"}, "invalid_credential"),
            (
                {"secret": "a-different-secret-entirely-0123456789"},
                "invalid_credential",
            ),
            ({"cid": "no-such-controller"}, "invalid_credential"),
        ],
    )
    async def test_a_bad_token_is_refused_in_the_envelope(
        self, harness: Harness, claims: dict[str, Any], code: str
    ) -> None:
        controller = await _enrolled(harness)
        base = {"cid": controller.controller_id, "oid": controller.owner.id}
        mw, captured = _middleware(
            harness, controller_auth=harness.management.authenticator
        )
        sent = await _dispatch(
            mw, "/v1/management/controllers/x/assignment", _forged(**{**base, **claims})
        )
        assert _refusal(sent) == (401, code)
        assert captured == {}

    async def test_an_expired_token_minted_by_the_server_is_token_expired(
        self, harness: Harness
    ) -> None:
        controller = await _enrolled(harness)
        token, _ = tokens.mint_access_token(
            secret=TOKEN_SECRET,
            controller_id=controller.controller_id,
            tenant_id=TENANT_ZERO_ID,
            owner_id=controller.owner.id,
            now=datetime.now(UTC) - timedelta(hours=2),
        )
        mw, _ = _middleware(harness, controller_auth=harness.management.authenticator)
        sent = await _dispatch(mw, "/v1/management/controllers/x/status", token)
        assert _refusal(sent) == (401, "token_expired")

    async def test_a_revoked_controllers_live_token_is_refused(
        self, harness: Harness
    ) -> None:
        controller = await _enrolled(harness)
        async with harness.client() as client:
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(controller.owner),
            )
        mw, _ = _middleware(harness, controller_auth=harness.management.authenticator)
        sent = await _dispatch(
            mw, "/v1/management/controllers/x/assignment", controller.access_token
        )
        assert _refusal(sent) == (401, "controller_revoked")

    @pytest.mark.parametrize("token", [None, "an-agent-api-key", "swcc_credential"])
    async def test_anything_but_an_access_token_is_refused(
        self, harness: Harness, token: str | None
    ) -> None:
        mw, _ = _middleware(harness, controller_auth=harness.management.authenticator)
        sent = await _dispatch(mw, "/v1/management/controllers/x/assignment", token)
        assert _refusal(sent) == (401, "invalid_credential")

    async def test_a_token_for_another_controllers_path_is_forbidden(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            for method, path in [
                (
                    "GET",
                    f"/v1/management/controllers/{second.controller_id}/assignment",
                ),
                ("PUT", f"/v1/management/controllers/{second.controller_id}/status"),
                (
                    "GET",
                    f"/v1/management/controllers/{second.controller_id}/operations",
                ),
                (
                    "POST",
                    f"/v1/management/controllers/{second.controller_id}/credential/rotate",
                ),
            ]:
                response = await client.request(method, path, headers=first.headers)
                assert response.status_code == 403, (method, path, response.text)
                assert response.json()["error"]["code"] == "forbidden"


class TestPublicPaths:
    @pytest.mark.parametrize(
        "path",
        ["/v1/management/controllers/enroll", "/v1/management/controllers/abc/token"],
    )
    async def test_pass_through_without_a_token(
        self, harness: Harness, path: str
    ) -> None:
        mw, captured = _middleware(
            harness, controller_auth=harness.management.authenticator
        )
        sent = await _dispatch(mw, path, None)
        assert sent == []
        assert captured["controller"] is None

    async def test_a_nested_token_path_is_not_public(self, harness: Harness) -> None:
        mw, _ = _middleware(harness, controller_auth=harness.management.authenticator)
        sent = await _dispatch(mw, "/v1/management/controllers/a/b/token", None)
        assert _refusal(sent) == (401, "invalid_credential")


class TestTheFlagOff:
    async def test_create_management_returns_nothing(self) -> None:
        class _Off:
            agent_management_enabled = False

        assert (
            create_management(
                _Off(),
                object(),
                AgentConnectionRegistry().controllers,
                LocalUserChanges(),
            )  # type: ignore[arg-type]
            is None
        )

    async def test_the_agent_bridge_app_mounts_no_management_route(self) -> None:
        class _Config:
            agent_auth_cache_ttl_seconds = 1
            agent_auth_cache_max_entries = 16
            keyring = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
            oauth_issuer_url = None
            oauth_audience = None
            oauth_verify_issuer = True
            id_server_name = "test"

        app, _ = create_agent_bridge_app(
            agent_store=object(),  # type: ignore[arg-type]
            agent_session_store=object(),  # type: ignore[arg-type]
            room_store=object(),  # type: ignore[arg-type]
            room_service=object(),  # type: ignore[arg-type]
            client_lifecycle=object(),  # type: ignore[arg-type]
            collab_lifecycle=object(),  # type: ignore[arg-type]
            event_buffer=EventBuffer(sequence_base=0),
            task_store=object(),  # type: ignore[arg-type]
            resource_service=object(),  # type: ignore[arg-type]
            api_key_store=object(),  # type: ignore[arg-type]
            external_user_store=object(),  # type: ignore[arg-type]
            bridge_store=object(),  # type: ignore[arg-type]
            session_factory=object(),
            config=_Config(),  # type: ignore[arg-type]
            approval_outcomes=object(),  # type: ignore[arg-type]
            controller_auth=None,
            trust_client=NullTrustClient(),
        )
        paths = [getattr(route, "path", "") for route in app.routes]
        assert paths
        assert not [path for path in paths if path.startswith("/v1/")]

    async def test_the_middleware_has_no_controller_branch(
        self, harness: Harness
    ) -> None:
        controller = await _enrolled(harness)
        mw, _ = _middleware(harness, controller_auth=None)
        enroll = await _dispatch(mw, "/v1/management/controllers/enroll", None)
        with_token = await _dispatch(
            mw,
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            controller.access_token,
        )
        assert enroll[0]["status"] == 401
        assert with_token[0]["status"] == 401
        # The plain refusal, not the controller envelope.
        assert b"error" not in b"".join(m.get("body", b"") for m in with_token[1:])

"""The members service client: what it sends, and how it reads the answers."""

from __future__ import annotations

import json
import time

import httpx
import jwt
import pytest

from switch_core.members_service import MembersService
from switch_core.organization_directory import (
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
)

URL = "https://members.example.test"
TOKEN = "token-of-the-admin"


def _token(expires_in: int) -> str:
    return jwt.encode({"exp": int(time.time()) + expires_in}, "test-key-not-a-secret")


def _service(handler) -> MembersService:
    return MembersService(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)), URL
    )


class TestChanging:
    async def test_a_role_is_set_by_membership(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"id": "om_1"})

        await _service(handler).set_role(TOKEN, "om_1", "org_admin")

        [request] = seen
        assert (request.method, request.url.path) == (
            "PATCH",
            "/v1/auth/tenants/members/om_1",
        )
        assert json.loads(request.content) == {"role": "org_admin"}
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"

    async def test_a_membership_is_removed(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(204)

        await _service(handler).remove(TOKEN, "om_1")

        assert [(r.method, r.url.path) for r in seen] == [
            ("DELETE", "/v1/auth/tenants/members/om_1")
        ]


class TestRefusals:
    async def test_a_token_it_does_not_accept_is_unavailable_not_a_sign_in(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "unauthorized"})

        token = _token(300)
        with pytest.raises(
            DirectoryUnavailable, match="doesn't accept member changes from Switch"
        ):
            await _service(handler).remove(token, "om_1")
        assert any(
            r.levelname == "ERROR" and "refused Switch's WorkOS token" in r.getMessage()
            for r in caplog.records
        )
        assert token not in caplog.text

    async def test_a_token_that_ran_out_asks_for_a_sign_in(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "unauthorized"})

        with pytest.raises(DirectorySignInRequired):
            await _service(handler).remove(_token(-1), "om_1")

    async def test_its_own_rules_refuse_in_its_words(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                409, json={"error": "cannot remove the last org_admin"}
            )

        with pytest.raises(DirectoryRefusal, match="cannot remove the last org_admin"):
            await _service(handler).remove(TOKEN, "om_1")

    @pytest.mark.parametrize("status", [500, 502, 503])
    async def test_a_failure_is_unavailable(self, status: int) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, text="upstream failed")

        with pytest.raises(DirectoryUnavailable):
            await _service(handler).set_role(TOKEN, "om_1", "viewer")

    async def test_an_unreachable_service_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(DirectoryUnavailable):
            await _service(handler).remove(TOKEN, "om_1")

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
from switch_core.outbound import OutboundHostUnresolved, OutboundURLRefused

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
            DirectoryUnavailable, match="doesn't accept changes from Switch"
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

    async def test_an_address_switch_refuses_is_unavailable(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise OutboundURLRefused(
                "members.example.test resolves to 10.0.0.1, which is not a public address."
            )

        with pytest.raises(DirectoryUnavailable, match="its address is refused"):
            await _service(handler).set_role(TOKEN, "om_1", "org_admin")
        assert any(
            r.levelname == "ERROR" and "not a public address" in r.getMessage()
            for r in caplog.records
        )

    async def test_a_host_that_does_not_resolve_is_unavailable_and_says_so(
        self,
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise OutboundHostUnresolved("members.example.test does not resolve")

        with pytest.raises(DirectoryUnavailable, match="its host does not resolve"):
            await _service(handler).remove(TOKEN, "om_1")


class TestCreatingAnAccount:
    async def test_it_is_created_with_the_creators_token_and_answers_its_organization(
        self,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(201, json={"org_id": "org_NEW"})

        created = await _service(handler).create_tenant(TOKEN, "Acme")

        assert created == "org_NEW"
        [request] = seen
        assert (request.method, request.url.path) == ("POST", "/v1/auth/tenants")
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        assert json.loads(request.content) == {"name": "Acme"}

    async def test_a_name_it_refuses_says_why(self) -> None:
        with pytest.raises(DirectoryRefusal, match="64 characters or fewer"):
            await _service(
                lambda request: httpx.Response(
                    422, json={"error": "name must be 64 characters or fewer"}
                )
            ).create_tenant(TOKEN, "A" * 70)

    async def test_an_answer_naming_no_organization_is_unavailable(self) -> None:
        with pytest.raises(DirectoryUnavailable, match="didn't say which"):
            await _service(lambda request: httpx.Response(201, json={})).create_tenant(
                TOKEN, "Acme"
            )

    async def test_it_is_given_the_time_creating_takes(self) -> None:
        timeouts: list[object] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(request.extensions["timeout"])
            return httpx.Response(201, json={"org_id": "org_NEW"})

        await _service(handler).create_tenant(TOKEN, "Acme")

        assert timeouts == [
            {"connect": 90.0, "read": 90.0, "write": 90.0, "pool": 90.0}
        ]


def _invitation(n: int) -> dict[str, object]:
    return {
        "id": f"invitation_{n}",
        "email": f"person{n}@example.test",
        "state": "pending",
        "role": "viewer",
        "organization_id": "org_a",
        "created_at": "2026-11-25T19:00:00.123456789Z",
        "expires_at": "2026-12-02T19:00:00Z",
    }


class TestInvitations:
    async def test_an_invitation_is_sent_as_asked_and_read_back(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(201, json=_invitation(1))

        invitation = await _service(handler).invite(
            TOKEN, "person1@example.test", "viewer"
        )

        [request] = seen
        assert (request.method, request.url.path) == (
            "POST",
            "/v1/auth/tenants/invitations",
        )
        assert json.loads(request.content) == {
            "email": "person1@example.test",
            "role": "viewer",
        }
        assert (invitation.id, invitation.state, invitation.role) == (
            "invitation_1",
            "pending",
            "viewer",
        )
        assert invitation.created_at.microsecond == 123456

    async def test_every_page_of_invitations_is_read(self) -> None:
        pages: list[str] = []
        everyone = [_invitation(n) for n in range(150)]

        def handler(request: httpx.Request) -> httpx.Response:
            offset = int(request.url.params["offset"])
            pages.append(request.url.params["limit"] + "@" + str(offset))
            return httpx.Response(
                200,
                json={
                    "data": everyone[offset : offset + 100],
                    "total": len(everyone),
                    "limit": 100,
                    "offset": offset,
                },
            )

        invitations = await _service(handler).invitations(TOKEN)

        assert len(invitations) == 150
        assert pages == ["100@0", "100@100"]

    async def test_an_unreadable_invitation_is_unavailable(self) -> None:
        broken = _invitation(1)
        del broken["email"]
        with pytest.raises(DirectoryUnavailable, match="unreadable invitation"):
            await _service(lambda request: httpx.Response(201, json=broken)).invite(
                TOKEN, "person1@example.test", "viewer"
            )

    async def test_a_second_pending_invitation_is_refused_as_the_service_says(
        self,
    ) -> None:
        with pytest.raises(DirectoryRefusal, match="pending invitation"):
            await _service(
                lambda request: httpx.Response(
                    409, json={"error": "email already has a pending invitation"}
                )
            ).invite(TOKEN, "person1@example.test", "viewer")

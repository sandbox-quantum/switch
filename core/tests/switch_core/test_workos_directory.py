"""The WorkOS directory reads a person's memberships at sign-in, against a
stand-in for the WorkOS API."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from switch_core.organization_directory import (
    DirectoryMembership,
    DirectoryRefusal,
    DirectoryUnavailable,
)
from switch_core.workos_directory import WorkOSDirectory

API = "https://workos.example.test"
KEY = "sk_test_example"


class _WorkOS:
    """Answers the two reads the directory makes, from `organizations` (id ->
    metadata) and `memberships` (organization id, role), a page of `page` at
    a time."""

    def __init__(
        self,
        organizations: dict[str, dict],
        memberships: list[tuple[str, str]],
        *,
        page: int = 100,
    ) -> None:
        self.organizations = organizations
        self.memberships = memberships
        self.page = page
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["Authorization"] == f"Bearer {KEY}"
        path = request.url.path
        if path == "/user_management/organization_memberships":
            assert request.url.params["user_id"] == "user_EXAMPLE"
            assert request.url.params["statuses"] == "active"
            start = int(request.url.params.get("after") or 0)
            chunk = self.memberships[start : start + self.page]
            after = start + self.page
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "organization_id": organization_id,
                            "role": {"slug": role},
                            "status": "active",
                        }
                        for organization_id, role in chunk
                    ],
                    "list_metadata": {
                        "after": str(after) if after < len(self.memberships) else None
                    },
                },
            )
        if path.startswith("/organizations/"):
            organization_id = path.removeprefix("/organizations/")
            return httpx.Response(
                200,
                json={
                    "id": organization_id,
                    "name": "Example",
                    "metadata": self.organizations[organization_id],
                },
            )
        return httpx.Response(404)


def _directory(handler) -> WorkOSDirectory:
    return WorkOSDirectory(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)), KEY, API
    )


class TestMembershipsAtSignIn:
    async def test_one_membership_per_customer_with_the_highest_role(self) -> None:
        """A customer's own organization and one a product made beneath it
        name the same customer; an `org_admin` of either is its Org Admin."""
        workos = _WorkOS(
            organizations={
                "org_root": {"tenant_id": "ten_a"},
                "org_child": {"tenant_id": "ten_a"},
                "org_other": {"tenant_id": "ten_b"},
            },
            memberships=[
                ("org_root", "member"),
                ("org_child", "org_admin"),
                ("org_other", "editor"),
            ],
        )

        memberships = await _directory(workos).memberships_at_sign_in("user_EXAMPLE")

        assert memberships == [
            DirectoryMembership(customer_id="ten_a", role="org_admin"),
            DirectoryMembership(customer_id="ten_b", role="member"),
        ]

    async def test_every_page_is_read(self) -> None:
        workos = _WorkOS(
            organizations={f"org_{i}": {"tenant_id": f"ten_{i}"} for i in range(5)},
            memberships=[(f"org_{i}", "member") for i in range(5)],
            page=2,
        )

        memberships = await _directory(workos).memberships_at_sign_in("user_EXAMPLE")

        assert [membership.customer_id for membership in memberships] == [
            f"ten_{i}" for i in range(5)
        ]

    async def test_an_organization_naming_no_customer_is_skipped(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        workos = _WorkOS(
            organizations={"org_bare": {}, "org_a": {"tenant_id": "ten_a"}},
            memberships=[("org_bare", "org_admin"), ("org_a", "member")],
        )

        memberships = await _directory(workos).memberships_at_sign_in("user_EXAMPLE")

        assert memberships == [DirectoryMembership(customer_id="ten_a", role="member")]
        assert "org_bare names no customer" in caplog.text

    @pytest.mark.parametrize(
        "answer",
        [
            httpx.Response(500),
            httpx.Response(401),
            httpx.Response(200, json={"data": "not a list"}),
            httpx.Response(200, content=json.dumps([1, 2])),
        ],
    )
    async def test_an_answer_switch_cannot_use_is_unavailable(
        self, answer: httpx.Response
    ) -> None:
        with pytest.raises(DirectoryUnavailable):
            await _directory(lambda request: answer).memberships_at_sign_in(
                "user_EXAMPLE"
            )

    async def test_an_unreachable_workos_is_unavailable(self) -> None:
        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(DirectoryUnavailable, match="ConnectError"):
            await _directory(unreachable).memberships_at_sign_in("user_EXAMPLE")


class TestChangesFromSwitch:
    """Changes made from Switch go through the service that owns the customer
    record; until that is wired in, they are refused for a customer's
    organization, and an organization Switch keeps itself stays its own."""

    async def test_a_customers_organization_refuses_them(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))
        customer = SimpleNamespace(customer_id="ten_a")

        for change in (
            directory.join(customer, "u", "member"),  # type: ignore[arg-type]
            directory.set_role(customer, "u", "org_admin"),  # type: ignore[arg-type]
            directory.remove(customer, "u"),  # type: ignore[arg-type]
        ):
            with pytest.raises(DirectoryRefusal):
                await change

    async def test_an_organization_switch_keeps_itself_needs_nothing(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))
        local = SimpleNamespace(customer_id=None)

        await directory.join(local, "u", "member")  # type: ignore[arg-type]
        await directory.set_role(local, "u", "org_admin")  # type: ignore[arg-type]
        await directory.remove(local, "u")  # type: ignore[arg-type]

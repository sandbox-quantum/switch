"""The WorkOS directory reads a person's memberships at sign-in, against a
stand-in for the WorkOS API."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from switch_core.organization_directory import (
    DirectoryMembership,
    DirectoryOrganization,
    DirectoryRefusal,
    DirectoryUnavailable,
)
from switch_core.workos_directory import (
    EventCursorRejected,
    WorkOSDirectory,
    customer_id_of,
)

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
    async def test_one_membership_per_organization_in_switchs_roles(self) -> None:
        """Every organization is answered by its WorkOS id, whatever its
        metadata says: which ones a Switch organization follows is Switch's
        own record, not anything WorkOS holds."""
        workos = _WorkOS(
            organizations={},
            memberships=[
                ("org_root", "member"),
                ("org_child", "org_admin"),
                ("org_other", "editor"),
            ],
        )

        memberships = await _directory(workos).memberships_at_sign_in("user_EXAMPLE")

        assert memberships == [
            DirectoryMembership(workos_organization_id="org_root", role="member"),
            DirectoryMembership(workos_organization_id="org_child", role="org_admin"),
            DirectoryMembership(workos_organization_id="org_other", role="member"),
        ]
        assert all(
            not request.url.path.startswith("/organizations/")
            for request in workos.requests
        )

    async def test_every_page_is_read(self) -> None:
        workos = _WorkOS(
            organizations={},
            memberships=[(f"org_{i}", "member") for i in range(5)],
            page=2,
        )

        memberships = await _directory(workos).memberships_at_sign_in("user_EXAMPLE")

        assert [membership.workos_organization_id for membership in memberships] == [
            f"org_{i}" for i in range(5)
        ]

    @pytest.mark.parametrize(
        "answer",
        [
            httpx.Response(500),
            httpx.Response(401),
            httpx.Response(200, json={"data": "not a list"}),
            httpx.Response(200, content=json.dumps([1, 2])),
            httpx.Response(200, content=b"<html>not JSON</html>"),
            httpx.Response(200, json={"data": [], "list_metadata": "not a dict"}),
            httpx.Response(200, json={"data": ["not a dict"]}),
            httpx.Response(
                200,
                json={"data": [{"organization_id": "org_a", "role": "org_admin"}]},
            ),
            httpx.Response(
                200, json={"data": [], "list_metadata": {"after": {"not": "text"}}}
            ),
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


class TestWhatAnOperatorLinks:
    async def test_an_organization_is_read_by_its_id(self) -> None:
        workos = _WorkOS(
            organizations={"org_a": {"tenant_id": "ten_a"}}, memberships=[]
        )

        organization = await _directory(workos).organization("org_a")

        assert customer_id_of(organization) == "ten_a"

    async def test_users_are_found_by_address(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/user_management/users"
            assert request.url.params["email"] == "person@example.test"
            return httpx.Response(
                200,
                json={
                    "data": [{"id": "user_A", "email": "person@example.test"}],
                    "list_metadata": {"after": None},
                },
            )

        users = await _directory(handler).users_with_email("person@example.test")

        assert [user["id"] for user in users] == ["user_A"]


class TestChangesFromSwitch:
    """Changes made from Switch to a linked organization go through the
    service that owns the customer record; until that is wired in, those that
    grant are refused, and an organization nobody linked stays Switch's own."""

    async def test_a_linked_organization_refuses_those_that_grant(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))
        linked = SimpleNamespace(workos_organization_id="org_a")

        for change in (
            directory.join(linked, "u", "member"),  # type: ignore[arg-type]
            directory.set_role(linked, "u", "org_admin"),  # type: ignore[arg-type]
        ):
            with pytest.raises(DirectoryRefusal):
                await change

    async def test_a_linked_organization_lets_switch_take_away(self) -> None:
        """So an Org Admin can end in Switch what WorkOS has ended; a sign-in
        brings back whatever WorkOS still grants."""
        directory = _directory(lambda request: httpx.Response(500))
        linked = SimpleNamespace(workos_organization_id="org_a")

        await directory.set_role(linked, "u", "member")  # type: ignore[arg-type]
        await directory.remove(linked, "u")  # type: ignore[arg-type]

    def test_it_keeps_the_members_of_a_linked_organization_only(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))

        assert directory.keeps_members_of(
            SimpleNamespace(workos_organization_id="org_a")  # type: ignore[arg-type]
        )
        assert not directory.keeps_members_of(
            SimpleNamespace(workos_organization_id=None)  # type: ignore[arg-type]
        )

    async def test_an_organization_switch_keeps_itself_needs_nothing(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))
        local = SimpleNamespace(workos_organization_id=None)

        await directory.join(local, "u", "member")  # type: ignore[arg-type]
        await directory.set_role(local, "u", "org_admin")  # type: ignore[arg-type]
        await directory.remove(local, "u")  # type: ignore[arg-type]

    async def test_a_new_organization_is_switchs_own_until_linked(self) -> None:
        directory = _directory(lambda request: httpx.Response(500))

        created = await directory.create_organization(SimpleNamespace(), "Example")  # type: ignore[arg-type]

        assert created == DirectoryOrganization(
            workos_organization_id=None, customer_id=None
        )
        await directory.discard_organization(created)


class TestWhatTheMirrorReads:
    async def test_events_are_asked_for_by_type_from_the_cursor_oldest_first(
        self,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "event_1",
                            "event": "organization_membership.created",
                            "data": {"user_id": "user_A", "organization_id": "org_a"},
                        }
                    ],
                    "list_metadata": {"after": None},
                },
            )

        directory = _directory(handler)
        types = ("organization_membership.created", "organization.deleted")

        first = await directory.events(
            types, after=None, range_start="2026-11-02T00:00:00+00:00"
        )
        await directory.events(types, after="event_1", range_start="unused")

        assert [event["id"] for event in first] == ["event_1"]
        assert seen[0].url.path == "/events"
        assert seen[0].url.params.get_list("events") == list(types)
        assert seen[0].url.params["order"] == "asc"
        assert seen[0].url.params["range_start"] == "2026-11-02T00:00:00+00:00"
        assert "after" not in seen[0].url.params
        assert seen[1].url.params["after"] == "event_1"
        assert "range_start" not in seen[1].url.params

    async def test_a_page_switch_cannot_read_is_unavailable(self) -> None:
        directory = _directory(
            lambda request: httpx.Response(200, json={"data": ["not an event"]})
        )

        with pytest.raises(DirectoryUnavailable):
            await directory.events(
                ("organization.deleted",), after=None, range_start="x"
            )

    async def test_an_event_is_handed_back_as_sent_for_the_caller_to_judge(
        self,
    ) -> None:
        directory = _directory(
            lambda request: httpx.Response(200, json={"data": [{"id": "event_1"}]})
        )

        assert await directory.events(
            ("organization.deleted",), after=None, range_start="x"
        ) == [{"id": "event_1"}]

    @pytest.mark.parametrize("status", [400, 404, 422])
    async def test_a_refused_cursor_says_so(self, status: int) -> None:
        directory = _directory(lambda request: httpx.Response(status))

        with pytest.raises(EventCursorRejected):
            await directory.events(
                ("organization.deleted",), after="event_old", range_start="x"
            )

    async def test_other_refusals_are_not_the_cursor(self) -> None:
        directory = _directory(lambda request: httpx.Response(401))

        with pytest.raises(DirectoryUnavailable) as refused:
            await directory.events(
                ("organization.deleted",), after="event_1", range_start="x"
            )
        assert not isinstance(refused.value, EventCursorRejected)

    async def test_one_membership_is_read_as_it_is_now(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.params["user_id"] == "user_A"
            assert request.url.params["organization_id"] == "org_a"
            assert request.url.params["statuses"] == "active"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"organization_id": "org_a", "role": {"slug": "org_admin"}}
                    ]
                },
            )

        assert (
            await _directory(handler).membership_role("user_A", "org_a") == "org_admin"
        )

    async def test_no_membership_is_none(self) -> None:
        directory = _directory(lambda request: httpx.Response(200, json={"data": []}))

        assert await directory.membership_role("user_A", "org_a") is None

    async def test_an_organizations_members_are_read_by_user(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.params["organization_id"] == "org_a"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "user_id": "user_A",
                            "organization_id": "org_a",
                            "role": {"slug": "org_admin"},
                        },
                        {
                            "user_id": "user_B",
                            "organization_id": "org_a",
                            "role": {"slug": "editor"},
                        },
                    ]
                },
            )

        assert await _directory(handler).organization_members("org_a") == {
            "user_A": "org_admin",
            "user_B": "member",
        }

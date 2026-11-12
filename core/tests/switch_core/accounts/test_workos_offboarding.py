"""Taking a purged organization out of a WorkOS environment other products
share. WorkOS is faked at the HTTP level, holding users, organizations and
memberships the way the API reports them."""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from switch_core.accounts.workos_offboarding import WorkOSOffboarding

API = "https://workos.test"


@dataclass
class FakeWorkOS:
    users: set[str] = field(default_factory=set)
    organizations: set[str] = field(default_factory=set)
    # Membership id to (user id, organization id, status).
    memberships: dict[str, tuple[str, str, str]] = field(default_factory=dict)
    connections: dict[str, str] = field(default_factory=dict)
    # Paths to answer 500 once, for a call that fails and is retried.
    fail_once: set[str] = field(default_factory=set)
    deleted: list[str] = field(default_factory=list)
    keys: set[str] = field(default_factory=set)

    def member(self, membership_id: str, user_id: str, organization_id: str) -> None:
        self.users.add(user_id)
        self.organizations.add(organization_id)
        self.memberships[membership_id] = (user_id, organization_id, "active")

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.keys.add(request.headers["authorization"])
        path = request.url.path
        if path in self.fail_once:
            self.fail_once.discard(path)
            return httpx.Response(500, json={"message": "try again"})
        if request.method == "GET":
            return self._list(path, request.url.params)
        assert request.method == "DELETE", request.method
        kind, _, key = path.rpartition("/")
        gone = {
            "/user_management/organization_memberships": self.memberships,
            "/user_management/users": self.users,
            "/organizations": self.organizations,
        }[kind]
        if key not in gone:
            return httpx.Response(404, json={"message": "not found"})
        if isinstance(gone, dict):
            del gone[key]
        else:
            gone.discard(key)
        if kind == "/user_management/users":
            for membership_id, (user_id, _, _) in list(self.memberships.items()):
                if user_id == key:
                    del self.memberships[membership_id]
        self.deleted.append(path)
        return httpx.Response(202 if kind != "/organizations" else 204)

    def _list(self, path: str, params: httpx.QueryParams) -> httpx.Response:
        if path == "/user_management/organization_memberships":
            assert params["statuses"] == "active,inactive,pending"
            data = [
                {"id": mid, "user_id": user, "organization_id": org, "status": status}
                for mid, (user, org, status) in self.memberships.items()
                if params.get("user_id", user) == user
                and params.get("organization_id", org) == org
            ]
        elif path == "/connections":
            data = [
                {"id": cid}
                for cid, org in self.connections.items()
                if org == params["organization_id"]
            ]
        elif path == "/directories":
            data = []
        else:
            raise AssertionError(f"unexpected GET {path}")
        return httpx.Response(
            200, json={"data": data, "list_metadata": {"after": None}}
        )

    def client(self) -> WorkOSOffboarding:
        return WorkOSOffboarding(
            httpx.AsyncClient(transport=httpx.MockTransport(self.handler)),
            "sk_test",
            API,
        )


async def test_a_user_in_nothing_else_goes_and_so_does_the_emptied_organization() -> (
    None
):
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")

    steps = await workos.client().carry_out("org_purged", ["user_a"], {"user_a"})

    assert steps.failures == []
    assert [m.id for m in steps.memberships] == ["om_1"]
    assert steps.users_deleted == ["user_a"]
    assert steps.organization_deleted
    assert workos.deleted == [
        "/user_management/organization_memberships/om_1",
        "/user_management/users/user_a",
        "/organizations/org_purged",
    ]
    assert workos.keys == {"Bearer sk_test"}


async def test_a_user_another_product_has_is_kept_and_loses_only_the_membership() -> (
    None
):
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")
    workos.member("om_2", "user_a", "org_other_product")

    steps = await workos.client().carry_out("org_purged", ["user_a"], {"user_a"})

    assert steps.users_deleted == []
    assert "org_other_product" in steps.users_kept["user_a"]
    assert "user_a" in workos.users
    assert set(workos.memberships) == {"om_2"}
    assert steps.organization_deleted


async def test_a_user_switch_still_uses_is_never_deleted() -> None:
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")

    steps = await workos.client().carry_out("org_purged", ["user_a"], set())

    assert steps.users_kept == {"user_a": "Switch still uses this user"}
    assert "user_a" in workos.users and workos.memberships == {}


async def test_the_organization_stays_while_anyone_else_is_in_it() -> None:
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")
    workos.member("om_9", "user_other", "org_purged")
    workos.memberships["om_9"] = ("user_other", "org_purged", "pending")

    steps = await workos.client().carry_out("org_purged", ["user_a"], {"user_a"})

    assert not steps.organization_deleted
    assert "1 other membership" in (steps.organization_kept or "")
    assert "org_purged" in workos.organizations
    assert set(workos.memberships) == {"om_9"}


async def test_the_organization_stays_while_it_has_an_sso_connection() -> None:
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")
    workos.connections["conn_1"] = "org_purged"

    steps = await workos.client().carry_out("org_purged", ["user_a"], {"user_a"})

    assert "SSO connection" in (steps.organization_kept or "")
    assert "org_purged" in workos.organizations


async def test_what_is_gone_already_counts_as_done() -> None:
    """A run after one that finished: WorkOS answers 404 for the user and the
    organization, and lists nothing."""
    workos = FakeWorkOS()

    steps = await workos.client().carry_out("org_purged", ["user_a"], {"user_a"})

    assert steps.failures == []
    assert steps.users_deleted == ["user_a"]
    assert steps.organization_deleted
    assert workos.deleted == []


async def test_a_failure_holds_back_what_depends_on_it_and_a_rerun_finishes() -> None:
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")
    workos.member("om_2", "user_b", "org_purged")
    workos.fail_once.add("/user_management/organization_memberships/om_1")
    client = workos.client()

    first = await client.carry_out(
        "org_purged", ["user_a", "user_b"], {"user_a", "user_b"}
    )

    assert len(first.failures) == 1 and "om_1" in first.failures[0]
    assert first.users_deleted == ["user_b"]
    assert not first.organization_deleted
    assert "user_a" in workos.users and "org_purged" in workos.organizations

    second = await client.carry_out(
        "org_purged", ["user_a", "user_b"], {"user_a", "user_b"}
    )

    assert second.failures == []
    assert second.users_deleted == ["user_a", "user_b"]
    assert second.organization_deleted
    assert workos.users == set() and workos.organizations == set()


async def test_the_plan_says_what_would_go_and_changes_nothing() -> None:
    workos = FakeWorkOS()
    workos.member("om_1", "user_a", "org_purged")
    workos.member("om_2", "user_b", "org_purged")
    workos.member("om_3", "user_b", "org_other_product")

    steps = await workos.client().plan(
        "org_purged", ["user_a", "user_b"], {"user_a", "user_b"}
    )

    assert [m.id for m in steps.memberships] == ["om_1", "om_2"]
    assert steps.users_deleted == ["user_a"]
    assert set(steps.users_kept) == {"user_b"}
    assert steps.organization_deleted
    assert workos.deleted == [] and len(workos.memberships) == 3


async def test_an_unlinked_organization_touches_only_users() -> None:
    workos = FakeWorkOS()
    workos.users.add("user_a")

    steps = await workos.client().carry_out(None, ["user_a"], {"user_a"})

    assert steps.users_deleted == ["user_a"]
    assert not steps.organization_deleted and steps.organization_kept is None
    assert workos.deleted == ["/user_management/users/user_a"]

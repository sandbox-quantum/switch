"""The people the Console windows sign in as, against a fake gateway and a
fake `switch-accounts`. No server."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))

import people  # noqa: E402
from seed import Admin, RequestIds  # noqa: E402

ADMIN_PASSWORD = "admin-secret"
WORKSPACE = "load"


class Server:
    """Accounts, their workspace roles, and the routes `people.sign_in` calls."""

    def __init__(self, accounts: dict[str, dict[str, str]]):
        # address -> {workspace id: role}
        self.accounts = accounts
        self.passwords = {a: people.password(ADMIN_PASSWORD, a) for a in accounts}
        self.created: list[tuple[str, str]] = []
        self.invited: list[tuple[str, str]] = []
        self.tokens: dict[str, tuple[str, str]] = {}

    # The fake kube: `switch-accounts list` and `create`.
    def accounts_command(self, *args: str, stdin: str | None = None) -> str:
        if args[0] == "list":
            return "".join(f"id-{a}\t{a}\tname\t-\t2026-11-23\n" for a in self.accounts)
        assert args[0] == "create" and "--name" in args
        address = args[1]
        assert address not in self.accounts
        self.accounts[address] = {}
        self.passwords[address] = (stdin or "").rstrip("\n")
        self.created.append((address, self.passwords[address]))
        return ""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        cookie = request.headers.get("cookie", "").removeprefix("switch_auth=")
        who = cookie.split("|")[0] if cookie else None
        path = request.url.path.removeprefix("/gateway")
        body = request.read()
        if (request.method, path) == ("POST", "/auth/login"):
            creds = json.loads(body)
            if self.passwords.get(creds["email"]) != creds["password"]:
                return httpx.Response(401)
            return _session(creds["email"], "")
        if (request.method, path) == ("GET", "/tenants"):
            roles = self.accounts[who]
            return httpx.Response(
                200,
                json=[{"id": t, "role": r} for t, r in roles.items()],
            )
        if path == f"/tenants/{WORKSPACE}/invitations":
            assert who == "admin"
            req = json.loads(body)
            self.invited.append((req["email"], req["role"]))
            token = f"t{len(self.tokens)}"
            self.tokens[token] = (req["email"], req["role"])
            return httpx.Response(201, json={"token": token})
        if (request.method, path) == ("POST", "/invitations/accept"):
            address, role = self.tokens.pop(json.loads(body)["token"])
            assert address == who
            self.accounts[who][WORKSPACE] = role
            return _session(who, WORKSPACE)
        if request.method == "POST" and path.endswith("/switch"):
            tenant = path.split("/")[2]
            if tenant not in self.accounts[who]:
                return httpx.Response(403)
            return _session(who, tenant)
        return httpx.Response(404)


def _session(who: str, tenant: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={},
        headers={"set-cookie": f"switch_auth={who}|{tenant}; Path=/; Secure"},
    )


class FakeKube:
    def __init__(self, server: Server):
        self.accounts = server.accounts_command


def _sign_in(server: Server, monkeypatch, windows: int) -> list[str]:
    transport = httpx.MockTransport(server)

    class Person(Admin):
        def __init__(self, gateway_url: str, ids: RequestIds) -> None:
            super().__init__(gateway_url, ids)
            self.http = httpx.AsyncClient(base_url="https://gw", transport=transport)

    monkeypatch.setattr(people, "Admin", Person)
    admin = Person("https://gw", RequestIds("t"))
    admin._cookie = f"admin|{WORKSPACE}"
    return asyncio.run(
        people.sign_in(
            FakeKube(server),
            admin,
            "https://gw",
            WORKSPACE,
            windows,
            ADMIN_PASSWORD,
            RequestIds("t"),
        )
    )


def test_each_window_is_a_person_of_its_own_bound_to_the_run_workspace(monkeypatch):
    server = Server({people.email(0): {WORKSPACE: "admin"}})
    cookies = _sign_in(server, monkeypatch, 3)
    assert cookies == [f"{people.email(i)}|{WORKSPACE}" for i in range(3)]
    # Only the two missing accounts were made, with the derived password on
    # standard input, and only they needed an invitation.
    assert server.created == [
        (people.email(i), people.password(ADMIN_PASSWORD, people.email(i)))
        for i in (1, 2)
    ]
    assert server.invited == [(people.email(1), "admin"), (people.email(2), "admin")]


def test_a_second_run_makes_nothing_and_invites_no_one(monkeypatch):
    server = Server({people.email(i): {WORKSPACE: "admin"} for i in range(2)})
    _sign_in(server, monkeypatch, 2)
    assert server.created == [] and server.invited == []


def test_a_person_in_the_workspace_below_admin_is_raised_to_admin(monkeypatch):
    server = Server({people.email(0): {WORKSPACE: "member"}})
    _sign_in(server, monkeypatch, 1)
    assert server.invited == [(people.email(0), "admin")]
    assert server.accounts[people.email(0)][WORKSPACE] == "admin"


def test_a_password_that_no_longer_matches_says_how_to_recover(monkeypatch):
    server = Server({people.email(0): {WORKSPACE: "admin"}})
    server.passwords[people.email(0)] = "from-an-older-admin-password"
    with pytest.raises(RuntimeError, match="switch-accounts delete"):
        _sign_in(server, monkeypatch, 1)


def test_passwords_are_stable_per_address_and_differ_between_addresses():
    a, b = people.email(0), people.email(1)
    assert people.password("p", a) == people.password("p", a)
    assert people.password("p", a) != people.password("p", b)
    assert people.password("p", a) != people.password("q", a)
    assert len(people.password("p", a)) >= 12
    assert people.email(9) == "load-console-10@example.com"


def test_the_listing_is_read_by_its_address_column():
    listing = "u1\tLoad-Console-01@example.com\tLoad console 01\t-\t2026\n\n"
    assert people.existing(listing) == {"load-console-01@example.com"}

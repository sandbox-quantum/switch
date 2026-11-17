#!/usr/bin/env python3
"""Create the local accounts the gateway's dev role switcher signs in as.

The switcher (`gateway/src/dev/`) shows the dashboard as each permission level
by signing in as a real account that holds it, so every check it meets is the
server's own. This makes those accounts on a local switch-core and writes their
logins to `gateway/.dev-role-accounts.json`, which only the Vite dev server
reads (`gateway/scripts/dev-role-accounts.mjs`):

- Operator: the gateway admin from `.env`, the server's operator.
- Org admin: `org_admin` of the default workspace's organization.
- Workspace admin: admin of the default workspace.
- Member: a member of the default workspace.

It also adds a second workspace to the organization, which the org admin and
the operator can open and the other two cannot, so the two admin levels show
different things.

The accounts are made the way `switch-accounts create` makes them, in no
workspace, then placed in the default workspace as the server's own seeding
places an account (`UserStore.ensure_membership`); the roles are given over
HTTP, as the operator, by the routes an org admin uses. Safe to run again: an
account that still signs in with the saved password is kept, one that does
not has its password set again, and every role is set afresh. Needs `just up`
and `just run`; run it as `just seed-dev-roles`, which loads the server's
configuration and the gateway admin's login from `.env`.
"""

from __future__ import annotations

import asyncio
import http.cookiejar
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts_admin import create_account
from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import hash_password_off_loop
from switch_core.operator_commands import database
from switch_core.tenant_context import no_tenant, tenant_scope

SERVER = "http://localhost:8000"
DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000"
SECOND_WORKSPACE_NAME = "Second workspace"
REPO = Path(__file__).resolve().parents[1]
ACCOUNTS_FILE = REPO / "gateway" / ".dev-role-accounts.json"


@dataclass(frozen=True)
class SeededAccount:
    role: str
    label: str
    name: str
    email: str


SEEDED = [
    SeededAccount(
        "org_admin", "Org admin", "Dev Org Admin", "dev-org-admin@example.test"
    ),
    SeededAccount(
        "workspace_admin",
        "Workspace admin",
        "Dev Workspace Admin",
        "dev-workspace-admin@example.test",
    ),
    SeededAccount("member", "Member", "Dev Member", "dev-member@example.test"),
]


class RequestFailed(Exception):
    def __init__(self, method: str, path: str, status: int, detail: str) -> None:
        super().__init__(f"{method} {path} answered {status}: {detail}")
        self.status = status


class Client:
    """One browser's worth of session cookie."""

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def call(self, method: str, path: str, body: object = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            f"{SERVER}/gateway{path}", data=data, method=method
        )
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(request) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise RequestFailed(
                method, path, error.code, error.read().decode()
            ) from None
        return json.loads(raw) if raw else None

    def sign_in(self, email: str, password: str) -> None:
        self.call("POST", "/auth/login", {"email": email, "password": password})


def saved_password() -> str | None:
    """The seeded accounts' password from the last run, if there was one."""
    if not ACCOUNTS_FILE.exists():
        return None
    try:
        accounts = json.loads(ACCOUNTS_FILE.read_text())["accounts"]
    except (ValueError, KeyError) as error:
        sys.exit(
            f"{ACCOUNTS_FILE} is not what this script writes ({error}). Delete it and run again."
        )
    for account in accounts:
        if account["role"] == SEEDED[0].role:
            return str(account["password"])
    return None


def signs_in(email: str, password: str) -> bool:
    try:
        Client().sign_in(email, password)
    except RequestFailed as error:
        if error.status == 401:
            return False
        raise
    return True


async def ensure_accounts(password: str) -> dict[str, str]:
    """Each seeded account's id, by role, made or repaired as needed, through
    the internals `switch-accounts` uses, on the server's own database."""
    async with database(SwitchConfig(), restricted=False) as session_factory:
        return {
            account.role: await ensure_account(session_factory, account, password)
            for account in SEEDED
        }


async def ensure_account(
    session_factory: async_sessionmaker[AsyncSession],
    account: SeededAccount,
    password: str,
) -> str:
    """The account's id: made if it is missing, its password set again if it
    no longer signs in with `password`, and placed in the default workspace,
    where the roles are given, if it is in none."""
    user_store = UserStore()
    with no_tenant():
        async with session_factory() as session:
            user = await user_store.get_by_email(session, account.email)
    if user is None:
        user = await create_account(
            session_factory,
            email=account.email,
            name=account.name,
            password=password,
            operator=False,
        )
    elif not signs_in(account.email, password):
        print(
            f"{account.email} does not sign in with the saved password; setting it again."
        )
        with no_tenant():
            async with session_factory() as session:
                stored = await session.get(User, user.id)
                assert stored is not None
                stored.password_hash = await hash_password_off_loop(password)
                await session.commit()
    with tenant_scope(DEFAULT_WORKSPACE_ID):
        async with session_factory() as session:
            stored = await session.get(User, user.id)
            assert stored is not None
            await user_store.ensure_membership(session, stored)
            await session.commit()
    return user.id


def ensure_second_workspace(operator: Client) -> None:
    workspaces = operator.call("GET", "/organizations/current/workspaces")
    if any(workspace["name"] == SECOND_WORKSPACE_NAME for workspace in workspaces):
        return
    operator.call(
        "POST", "/organizations/current/workspaces", {"name": SECOND_WORKSPACE_NAME}
    )


def write_accounts(operator_email: str, operator_password: str, password: str) -> None:
    accounts = [
        {
            "role": "operator",
            "label": "Operator",
            "email": operator_email,
            "password": operator_password,
        }
    ] + [
        {
            "role": account.role,
            "label": account.label,
            "email": account.email,
            "password": password,
        }
        for account in SEEDED
    ]
    ACCOUNTS_FILE.write_text(json.dumps({"accounts": accounts}, indent=2) + "\n")
    ACCOUNTS_FILE.chmod(0o600)


def seed(operator_email: str, operator_password: str) -> None:
    operator = Client()
    operator.sign_in(operator_email, operator_password)
    operator.call("POST", f"/tenants/{DEFAULT_WORKSPACE_ID}/switch")
    # Only an org admin may give out organization roles. A new server makes
    # the gateway admin one when it seeds the account.
    tenant = operator.call("GET", "/auth/session")["tenant"]
    if tenant["organization_role"] != "org_admin":
        sys.exit(
            f"{operator_email} is not an org admin of the default workspace's "
            "organization, so it cannot give the test accounts their roles. "
            "A server started on a new database (`just reset`) makes it one."
        )

    password = saved_password() or secrets.token_hex(16)
    ids = asyncio.run(ensure_accounts(password))

    # The organization role first: it decides what someone holds in every
    # workspace, and an org admin's own workspace role cannot be changed at all.
    organization_roles = {
        "org_admin": "org_admin",
        "workspace_admin": "member",
        "member": "member",
    }
    for role, user_id in ids.items():
        operator.call(
            "PATCH",
            f"/organizations/current/members/{user_id}",
            {"role": organization_roles[role]},
        )
    workspace_roles = {"workspace_admin": "admin", "member": "member"}
    for role, workspace_role in workspace_roles.items():
        operator.call(
            "PATCH",
            f"/tenants/{DEFAULT_WORKSPACE_ID}/members/{ids[role]}",
            {"role": workspace_role},
        )
    ensure_second_workspace(operator)
    write_accounts(operator_email, operator_password, password)


def main() -> None:
    operator_email = os.environ.get("GATEWAY_ADMIN_EMAIL")
    operator_password = os.environ.get("GATEWAY_ADMIN_PASSWORD")
    if not operator_email or not operator_password:
        sys.exit(
            "GATEWAY_ADMIN_EMAIL and GATEWAY_ADMIN_PASSWORD are not set. "
            "Run this as `just seed-dev-roles`, which loads them from .env."
        )
    try:
        seed(operator_email, operator_password)
    except urllib.error.URLError as error:
        sys.exit(
            f"Could not reach switch-core at {SERVER} ({error.reason}). Is `just run` up?"
        )
    except RequestFailed as error:
        sys.exit(str(error))

    print(f"Seeded the dev role switcher's accounts on {SERVER}:")
    print(f"  {'Operator':<16} {operator_email}")
    for account in SEEDED:
        print(f"  {account.label:<16} {account.email}")
    print(f'"{SECOND_WORKSPACE_NAME}" is open to the org admin and the operator only.')
    print(
        f"Logins are in {ACCOUNTS_FILE.relative_to(REPO)}; `just gateway-dev` serves them to the switcher, which shows with the gateway_v2 flag on."
    )


if __name__ == "__main__":
    main()

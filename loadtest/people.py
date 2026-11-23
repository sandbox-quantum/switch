"""The people the run's Switch Console windows sign in as, one per window.

The gateway limits each person separately: how many requests they run at once
(`GATEWAY_REQUESTS_PER_CALLER`) and how many streams they hold. Windows that
all signed in as the run's admin counted as one person, so ten windows shared
one person's share. Here each window is its own person, as ten people with
Switch Console open are.

They are fixed accounts, `load-console-01@example.com` and on, made with the
server's `switch-accounts create` in a switch-core pod the first night that
needs them and kept for the next: the server has no route that deletes an
account, so making new ones each night would leave them behind. Each is an
admin of the run's workspace, like the admin the windows used to sign in as,
so a window reads exactly what it read before; only who asks changes.

Their passwords are derived from the admin's (an HMAC per address), so there
is nothing extra to store, and like it they are held in memory only. If the
admin's password changes, sign-in is refused: delete the accounts with
`switch-accounts delete` and the next run makes them again.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac

from seed import Admin, RequestIds, _fail

DOMAIN = "example.com"


def email(index: int) -> str:
    """The address of the person window `index` (from 0) signs in as."""
    return f"load-console-{index + 1:02d}@{DOMAIN}"


def password(admin_password: str, address: str) -> str:
    """The person's password: the same on every run while the admin's is."""
    mac = hmac.new(admin_password.encode(), address.encode(), hashlib.sha256)
    return "Lc1-" + base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def existing(listing: str) -> set[str]:
    """The addresses in `switch-accounts list` output: id, e-mail, name,
    role and created, tab-separated, one account a line."""
    found = set()
    for line in listing.splitlines():
        parts = line.split("\t")
        if len(parts) > 1:
            found.add(parts[1].strip().lower())
    return found


async def sign_in(
    kube,
    admin: Admin,
    gateway_url: str,
    workspace_id: str,
    windows: int,
    admin_password: str,
    ids: RequestIds,
) -> list[str]:
    """One session cookie per window, each a different person signed in and
    bound to `workspace_id`, making the accounts and their admin role there
    when they are missing."""
    addresses = [email(i) for i in range(windows)]
    have = existing(await asyncio.to_thread(kube.accounts, "list"))
    for i, address in enumerate(addresses):
        if address not in have:
            await asyncio.to_thread(
                kube.accounts,
                "create", address, "--name", f"Load console {i + 1:02d}",
                stdin=password(admin_password, address) + "\n",
            )  # fmt: skip
    return [
        await _session(admin, gateway_url, workspace_id, a, admin_password, ids)
        for a in addresses
    ]


async def _session(
    admin: Admin,
    gateway_url: str,
    workspace_id: str,
    address: str,
    admin_password: str,
    ids: RequestIds,
) -> str:
    person = Admin(gateway_url, ids)
    try:
        try:
            await person.login(address, password(admin_password, address))
        except RuntimeError as exc:
            raise RuntimeError(
                f"{address}: {exc}; if the admin's password changed, delete the "
                "account with switch-accounts delete and run again"
            ) from None
        r = await person.call("GET", "/tenants")
        if r.status_code != 200:
            raise _fail(f"listing {address}'s workspaces", r)
        role = next((t.get("role") for t in r.json() if t["id"] == workspace_id), None)
        if role != "admin":
            # An invitation naming the address, accepted by its owner: the
            # way a person joins a workspace, or is raised to admin in it.
            r = await admin.call(
                "POST",
                f"/tenants/{workspace_id}/invitations",
                json={"email": address, "role": "admin", "expires_in_hours": 1},
            )
            if r.status_code != 201:
                raise _fail(f"inviting {address} to the run's workspace", r)
            r = await person.call(
                "POST", "/invitations/accept", json={"token": r.json()["token"]}
            )
            if r.status_code != 200:
                raise _fail(f"{address} accepting the run's workspace", r)
        await person.use_workspace_id(workspace_id)
        if person.cookie is None:
            raise RuntimeError(f"{address} has no session")
        return person.cookie
    finally:
        await person.close()

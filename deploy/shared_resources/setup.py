"""Local dev setup — registers Mattermost bridge with Switch after both are ready.

Runs as a short-lived init container in docker-compose. Waits for Switch and
Mattermost to be healthy, bootstraps the Mattermost admin/team, then registers
the Mattermost bridge via the authorized Switch gateway API — logging in as the
seeded gateway admin first, since bridge administration is an admin action.
Finally it links the seeded Mattermost account to that admin, so the deployment
comes up knowing which chat account its owner is.
"""

import os
import sys
import time

import httpx

SWITCH_URL = os.environ["SWITCH_URL"]
GATEWAY_ADMIN_EMAIL = os.environ["GATEWAY_ADMIN_EMAIL"]
GATEWAY_ADMIN_PASSWORD = os.environ["GATEWAY_ADMIN_PASSWORD"]
MATTERMOST_URL = os.environ["MATTERMOST_URL"]
MATTERMOST_URL_FOR_SWITCH = os.environ.get(
    "MATTERMOST_URL_FOR_SWITCH", "http://localhost:8065"
)
# User-facing Mattermost URL (what people open in their client), used to build
# channel deeplinks. Differs from MATTERMOST_URL_FOR_SWITCH, which is the
# internal address Switch connects to. Optional — falls back to the internal URL.
MATTERMOST_PUBLIC_URL = os.environ.get("MATTERMOST_PUBLIC_URL")
MATTERMOST_ADMIN_USER = os.environ["MATTERMOST_ADMIN_USER"]
MATTERMOST_ADMIN_PASSWORD = os.environ["MATTERMOST_ADMIN_PASSWORD"]
MATTERMOST_ADMIN_EMAIL = os.environ.get(
    "MATTERMOST_ADMIN_EMAIL", f"{os.environ['MATTERMOST_ADMIN_USER']}@localhost.local"
)
MATTERMOST_TEAM_NAME = os.environ["MATTERMOST_TEAM_NAME"]
MATTERMOST_USER = os.environ["MATTERMOST_USER"]
MATTERMOST_USER_PASSWORD = os.environ["MATTERMOST_USER_PASSWORD"]
MATTERMOST_USER_EMAIL = os.environ.get(
    "MATTERMOST_USER_EMAIL", f"{os.environ['MATTERMOST_USER']}@localhost.local"
)

MAX_RETRIES = 60
RETRY_DELAY = 5

# Shorter than MAX_RETRIES: by the time this runs both services have answered,
# so it waits only for the bridge adapter to finish starting.
LINK_MAX_RETRIES = 24


def wait_for_service(url: str, name: str) -> None:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = httpx.get(url, timeout=5)
            if resp.is_success:
                print(f"{name} is ready")
                return
        except httpx.HTTPError:
            pass
        print(f"Waiting for {name} ({attempt}/{MAX_RETRIES})...")
        time.sleep(RETRY_DELAY)
    print(f"ERROR: {name} did not become ready after {MAX_RETRIES} attempts")
    sys.exit(1)


def setup_mattermost() -> str | None:
    """Create admin user and team in Mattermost.

    Returns the Mattermost id of the human account, which is also its
    ``external_user_id`` on the bridge — what linking it to a Switch user is
    keyed by. None when the account could not be created or read.
    """
    client = httpx.Client(base_url=MATTERMOST_URL, timeout=10)

    # Create admin user (first user becomes system admin)
    resp = client.post(
        "/api/v4/users",
        json={
            "username": MATTERMOST_ADMIN_USER,
            "password": MATTERMOST_ADMIN_PASSWORD,
            "email": MATTERMOST_ADMIN_EMAIL,
        },
    )
    if resp.status_code == 201:
        print(f"Created Mattermost admin user: {MATTERMOST_ADMIN_USER}")
    elif resp.status_code in (400, 409):
        print(f"Mattermost admin user already exists: {MATTERMOST_ADMIN_USER}")
    else:
        print(f"Unexpected response creating admin: {resp.status_code} {resp.text}")
        resp.raise_for_status()

    # Login to get token
    resp = client.post(
        "/api/v4/users/login",
        json={
            "login_id": MATTERMOST_ADMIN_USER,
            "password": MATTERMOST_ADMIN_PASSWORD,
        },
    )
    if not resp.is_success:
        print(
            f"ERROR: Could not login to Mattermost as {MATTERMOST_ADMIN_USER}: "
            f"{resp.status_code}. If the password changed, run: just down && just up"
        )
        sys.exit(1)
    token = resp.headers["token"]
    client.headers["Authorization"] = f"Bearer {token}"

    # Create team
    try:
        resp = client.post(
            "/api/v4/teams",
            json={
                "name": MATTERMOST_TEAM_NAME,
                "display_name": MATTERMOST_TEAM_NAME.capitalize(),
                "type": "O",
                "allow_open_invite": True,
            },
        )
        if resp.status_code == 201:
            print(f"Created Mattermost team: {MATTERMOST_TEAM_NAME}")
        elif resp.status_code == 400 and "already exists" in resp.text.lower():
            print(f"Mattermost team already exists: {MATTERMOST_TEAM_NAME}")
        else:
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        print(f"Warning: Could not create team: {e}")

    # Get team ID and ensure open invite is enabled
    resp = client.get(f"/api/v4/teams/name/{MATTERMOST_TEAM_NAME}")
    resp.raise_for_status()
    team_id = resp.json()["id"]
    client.put(
        f"/api/v4/teams/{team_id}/patch",
        json={"allow_open_invite": True},
    )

    # Add admin to team
    admin_resp = client.get("/api/v4/users/me")
    admin_id = admin_resp.json()["id"]
    client.post(
        f"/api/v4/teams/{team_id}/members",
        json={"team_id": team_id, "user_id": admin_id},
    )

    # Create regular user
    try:
        resp = client.post(
            "/api/v4/users",
            json={
                "username": MATTERMOST_USER,
                "password": MATTERMOST_USER_PASSWORD,
                "email": MATTERMOST_USER_EMAIL,
            },
        )
        if resp.status_code == 201:
            user_id = resp.json()["id"]
            print(f"Created Mattermost user: {MATTERMOST_USER}")
        elif resp.status_code == 400 and "already exists" in resp.text.lower():
            print(f"Mattermost user already exists: {MATTERMOST_USER}")
            resp = client.get(f"/api/v4/users/username/{MATTERMOST_USER}")
            user_id = resp.json()["id"]
        else:
            resp.raise_for_status()
            user_id = resp.json()["id"]
    except httpx.HTTPStatusError as e:
        print(f"Warning: Could not create user: {e}")
        user_id = None

    # Add user to team
    if user_id:
        client.post(
            f"/api/v4/teams/{team_id}/members",
            json={"team_id": team_id, "user_id": user_id},
        )
        print(f"Added {MATTERMOST_USER} to team {MATTERMOST_TEAM_NAME}")

    client.close()
    return user_id


def gateway_login() -> httpx.Client:
    """A gateway client authenticated as the seeded admin.

    Bridge administration is admin-gated, so we log in as the seeded gateway
    admin (cookie-based JWT) and drive the same authorized endpoints the
    dashboard uses — there is no unauthenticated bridge-admin surface. The
    login sets the switch_auth cookie on the client, which every subsequent
    gateway call carries.
    """
    client = httpx.Client(base_url=SWITCH_URL, timeout=10)
    resp = client.post(
        "/gateway/auth/login",
        json={"email": GATEWAY_ADMIN_EMAIL, "password": GATEWAY_ADMIN_PASSWORD},
    )
    if not resp.is_success:
        print(
            "ERROR: Could not log in to the Switch gateway as "
            f"{GATEWAY_ADMIN_EMAIL}: {resp.status_code} {resp.text}"
        )
        sys.exit(1)
    return client


def register_bridge(client: httpx.Client) -> str:
    """Register Mattermost bridge with Switch via the authorized gateway API.

    Returns the bridge id — the one already registered, or the new one. A
    registration that fails raises, as it did before: without a bridge there is
    no deployment to speak of, so it is not something to carry on past.
    """
    # Check if bridge already registered
    resp = client.get("/gateway/collaborations")
    if resp.is_success:
        bridges = resp.json()
        for bridge in bridges:
            if bridge.get("bridge_type") == "mattermost":
                bridge_id = bridge["bridge_id"]
                print(f"Mattermost bridge already registered: {bridge_id}")
                # Adopt the default on an instance that predates it, so an
                # existing deployment gains the invariant on its next setup run
                # rather than only new ones.
                if not any(b.get("is_default") for b in bridges):
                    client.post(
                        f"/gateway/collaborations/{bridge_id}/default"
                    ).raise_for_status()
                    print(f"Set Mattermost bridge as default: {bridge_id}")
                return bridge_id

    # Register new bridge
    connection_config: dict[str, str] = {
        "url": MATTERMOST_URL_FOR_SWITCH,
        "admin_user": MATTERMOST_ADMIN_USER,
        "admin_password": MATTERMOST_ADMIN_PASSWORD,
        "team_name": MATTERMOST_TEAM_NAME,
        # The bundled deployment's single human. Added to every channel this
        # bridge creates so they can read rooms that agents created without
        # naming any users — including private ones, which they could not
        # otherwise join.
        "default_member": MATTERMOST_USER,
    }
    if MATTERMOST_PUBLIC_URL:
        connection_config["public_url"] = MATTERMOST_PUBLIC_URL
    resp = client.post(
        "/gateway/collaborations",
        json={
            "bridge_type": "mattermost",
            "display_name": "Mattermost",
            "connection_config": connection_config,
            # The bundled Mattermost is the deployment's own chat, so it is
            # what rooms should bridge to when the caller names nothing.
            "set_as_default": True,
        },
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"Registered Mattermost bridge: {data['bridge_id']} (default)")
    return data["bridge_id"]


def await_directory_account(
    client: httpx.Client, bridge_id: str, external_user_id: str
) -> bool:
    """Wait until the bridge's own directory lists the seeded human account.

    Registering a bridge records it; it does not mean its adapter has finished
    starting, and a claim for an account Switch has never seen is refused until
    it has (409). This probes the directory the claim itself consults, so a
    success here means the next call has what it needs rather than merely that
    some other endpoint answered.
    """
    for attempt in range(1, LINK_MAX_RETRIES + 1):
        resp = client.get(
            f"/gateway/collaborations/{bridge_id}/directory",
            params={"query": MATTERMOST_USER},
        )
        if resp.is_success:
            found = resp.json().get("users", [])
            if any(u.get("external_user_id") == external_user_id for u in found):
                return True
            reason = f"{MATTERMOST_USER} not in the directory yet"
        else:
            reason = f"{resp.status_code} {resp.text}"
        print(
            f"Waiting for the Mattermost bridge to serve its directory "
            f"({attempt}/{LINK_MAX_RETRIES}): {reason}"
        )
        time.sleep(RETRY_DELAY)
    return False


def link_owner_identity(
    client: httpx.Client, bridge_id: str, external_user_id: str
) -> None:
    """Link the seeded Mattermost account to the seeded gateway admin.

    The deployment provisions both halves of one person — a Switch admin and
    the Mattermost account they will chat from — so leaving them unassociated
    means owner-only addressing (CHOO-2137) cannot recognise the owner in the
    deployment's own chat, and the Home page reports an account the user has to
    link by hand (CHOO-2172).

    Only ever claims when the admin holds no identity on this bridge, so a
    re-run is a no-op. Someone who deliberately unlinks themselves and runs
    setup again does get relinked; that is the cost of repairing every existing
    deployment on its next run, and the manual control to undo it is still
    there.
    """
    resp = client.get("/gateway/auth/me/identities")
    if resp.is_success:
        if any(i.get("bridge_id") == bridge_id for i in resp.json()):
            print(f"Gateway admin already linked to a Mattermost account: {bridge_id}")
            return
    else:
        print(
            "WARNING: Could not read the gateway admin's linked accounts: "
            f"{resp.status_code} {resp.text}"
        )
        return

    if not await_directory_account(client, bridge_id, external_user_id):
        print(
            f"WARNING: The Mattermost bridge never listed {MATTERMOST_USER} in its "
            f"directory, so {GATEWAY_ADMIN_EMAIL} was NOT linked to it. Owner-only "
            "agents will not recognise you in Mattermost until you link the account "
            "yourself from the server's Messaging apps section."
        )
        return

    resp = client.post(
        f"/gateway/collaborations/{bridge_id}/identities",
        json={"external_user_id": external_user_id, "username": MATTERMOST_USER},
    )
    if resp.is_success:
        print(f"Linked {GATEWAY_ADMIN_EMAIL} to Mattermost account {MATTERMOST_USER}")
        return
    print(
        f"WARNING: Could not link {GATEWAY_ADMIN_EMAIL} to the Mattermost account "
        f"{MATTERMOST_USER}: {resp.status_code} {resp.text}. Owner-only agents will "
        "not recognise you in Mattermost until you link the account yourself from "
        "the server's Messaging apps section."
    )


def main() -> None:
    print("Switch local setup starting...")

    wait_for_service(f"{MATTERMOST_URL}/api/v4/system/ping", "Mattermost")
    mattermost_user_id = setup_mattermost()

    wait_for_service(f"{SWITCH_URL}/health", "Switch")
    client = gateway_login()
    try:
        bridge_id = register_bridge(client)
        if mattermost_user_id is None:
            print(
                f"WARNING: No Mattermost account for {MATTERMOST_USER}, so "
                f"{GATEWAY_ADMIN_EMAIL} could not be linked to one"
            )
        else:
            link_owner_identity(client, bridge_id, mattermost_user_id)
    finally:
        client.close()

    print("Setup complete!")


if __name__ == "__main__":
    main()

import asyncio
import hashlib
import hmac
import logging

import httpx

logger = logging.getLogger(__name__)

# Wire path served by Tuwunel/conduwuit for shared-secret account creation. It
# lives under the `/_synapse/` namespace for drop-in compatibility with tooling
# written against that endpoint — this is a protocol constant, NOT a reference
# to the homeserver implementation. Must stay verbatim.
SHARED_SECRET_REGISTER_PATH = "/_synapse/admin/v1/register"


class MatrixAdminError(Exception):
    pass


async def wait_for_homeserver(
    server_url: str, *, attempts: int = 60, delay: float = 1.0
) -> None:
    """Block until the Matrix homeserver answers the standard
    ``/_matrix/client/versions`` endpoint, or raise after ``attempts`` tries.

    Replaces the Docker healthcheck dependency: Tuwunel's slim image ships no
    curl/wget, so the homeserver's readiness is polled here instead.
    """
    url = f"{server_url}/_matrix/client/versions"
    async with httpx.AsyncClient(timeout=5) as http:
        for attempt in range(1, attempts + 1):
            try:
                resp = await http.get(url)
                if resp.is_success:
                    logger.info("Homeserver ready at %s", server_url)
                    return
            except httpx.HTTPError:
                pass
            if attempt == 1 or attempt % 10 == 0:
                logger.info(
                    "Waiting for homeserver at %s (attempt %d/%d)",
                    server_url,
                    attempt,
                    attempts,
                )
            await asyncio.sleep(delay)
    raise MatrixAdminError(
        f"Homeserver not reachable at {server_url} after {attempts} attempts"
    )


async def _shared_secret_register(
    http: httpx.AsyncClient,
    register_url: str,
    shared_secret: str,
    username: str,
    password: str,
    *,
    admin: bool,
    display_name: str | None = None,
) -> dict | None:
    """Create a local account via the shared-secret register endpoint.

    Authenticated by an HMAC-SHA1 over the homeserver's
    ``registration_shared_secret``; bypasses interactive auth. Returns the
    register response (containing ``access_token``/``device_id``) on success,
    or ``None`` if the user already exists.
    """
    nonce_resp = await http.get(register_url)
    nonce_resp.raise_for_status()
    nonce = nonce_resp.json()["nonce"]

    mac = hmac.new(shared_secret.encode(), digestmod=hashlib.sha1)
    mac.update(nonce.encode())
    mac.update(b"\x00")
    mac.update(username.encode())
    mac.update(b"\x00")
    mac.update(password.encode())
    mac.update(b"\x00")
    mac.update(b"admin" if admin else b"notadmin")

    body: dict[str, object] = {
        "nonce": nonce,
        "username": username,
        "password": password,
        "admin": admin,
        "mac": mac.hexdigest(),
    }
    if display_name is not None:
        body["displayname"] = display_name

    resp = await http.post(register_url, json=body)
    if resp.status_code == 400 and "M_USER_IN_USE" in resp.text:
        return None
    resp.raise_for_status()
    data: dict = resp.json()
    return data


async def ensure_admin_exists(
    server_url: str,
    username: str,
    password: str,
    shared_secret: str,
) -> None:
    if not shared_secret:
        raise MatrixAdminError("No shared secret configured — cannot create admin user")

    async with httpx.AsyncClient(timeout=10) as http:
        login_url = f"{server_url}/_matrix/client/r0/login"
        try:
            resp = await http.post(
                login_url,
                json={
                    "type": "m.login.password",
                    "user": username,
                    "password": password,
                },
            )
            if resp.is_success:
                logger.info("Matrix admin '%s' already exists", username)
                return
        except httpx.HTTPError as e:
            logger.warning("Could not check if admin '%s' exists: %s", username, e)

        logger.info(
            "Creating Matrix admin '%s' via shared-secret registration", username
        )
        await _shared_secret_register(
            http,
            f"{server_url}{SHARED_SECRET_REGISTER_PATH}",
            shared_secret,
            username,
            password,
            admin=True,
        )
        logger.info("Successfully created Matrix admin '%s'", username)


class MatrixAdmin:
    def __init__(
        self,
        server_url: str,
        admin_user: str,
        access_token: str,
        shared_secret: str,
        http: httpx.AsyncClient,
    ):
        self.server_url = server_url
        self.admin_user = admin_user
        self.access_token = access_token
        self._shared_secret = shared_secret
        self._http = http

    @classmethod
    async def create(
        cls,
        server_url: str,
        admin_user: str,
        admin_password: str,
        shared_secret: str,
    ) -> "MatrixAdmin":
        http = httpx.AsyncClient(
            base_url=server_url,
            timeout=10,
            headers={"Content-Type": "application/json"},
        )
        resp = await http.post(
            "/_matrix/client/r0/login",
            json={
                "type": "m.login.password",
                "user": admin_user,
                "password": admin_password,
            },
        )
        if not resp.is_success:
            await http.aclose()
            raise MatrixAdminError(
                f"Admin login failed: {resp.status_code} {resp.text}"
            )

        access_token: str | None = resp.json().get("access_token")
        if not access_token:
            await http.aclose()
            raise MatrixAdminError("No access_token in login response")

        logger.info("Logged in as Matrix admin '%s'", admin_user)
        instance = cls(server_url, admin_user, access_token, shared_secret, http)
        return instance

    async def close(self) -> None:
        await self._http.aclose()

    async def verify_login(self, user_id: str, password: str) -> bool:
        """Whether ``password`` authenticates ``user_id`` on this homeserver.

        Used by the cutover to detect a pre-existing account whose password
        differs from the one stored in the Switch DB — i.e. the target
        homeserver is not the empty server a cutover expects.
        """
        localpart = user_id.split(":", 1)[0].lstrip("@")
        resp = await self._http.post(
            "/_matrix/client/r0/login",
            json={
                "type": "m.login.password",
                "user": localpart,
                "password": password,
            },
        )
        return resp.is_success

    async def register_user(
        self,
        user_id: str,
        password: str,
        display_name: str | None = None,
        is_admin: bool = False,
    ) -> None:
        """Provision a local Matrix account via shared-secret registration.

        ``user_id`` is the full Matrix id (``@localpart:server``); the
        registration endpoint takes the localpart. Idempotent: an existing
        user is treated as success.
        """
        localpart = user_id.split(":", 1)[0].lstrip("@")
        result = await _shared_secret_register(
            self._http,
            SHARED_SECRET_REGISTER_PATH,
            self._shared_secret,
            localpart,
            password,
            admin=is_admin,
            display_name=display_name,
        )
        if result is None:
            logger.info("User %s already exists", user_id)
        else:
            logger.info("Registered user %s", user_id)

    async def create_room(self, name: str, topic: str) -> str:
        resp = await self._http.post(
            "/_matrix/client/v3/createRoom",
            headers={"Authorization": f"Bearer {self.access_token}"},
            json={
                "name": name,
                "topic": topic,
                "visibility": "private",
                "preset": "private_chat",
            },
        )
        if not resp.is_success:
            raise MatrixAdminError(
                f"Failed to create room: {resp.status_code} {resp.text}"
            )
        room_id: str | None = resp.json().get("room_id")
        if not room_id:
            raise MatrixAdminError("No room_id in createRoom response")
        logger.info("Created room %s (%s)", name, room_id)
        return room_id

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        """Invite a local user to a room. Provided the user has a running
        client (every Switch participant does), its sync loop auto-accepts the
        invite and joins — see ``ClientBase.on_invite``.

        This is how members are added to a room: there is no admin "force-join"
        on Tuwunel/conduwuit, so room setup goes through ordinary invitations.
        """
        resp = await self._http.post(
            f"/_matrix/client/v3/rooms/{room_id}/invite",
            headers={"Authorization": f"Bearer {self.access_token}"},
            json={"user_id": user_id},
        )
        if not resp.is_success:
            # User is already a member — nothing to do. Tuwunel/conduwuit rejects
            # the invite of an existing member with "cannot invite user that is
            # joined or banned"; other servers say "already in the room" /
            # "already joined". Treat all as success (a banned user can't be invited
            # anyway, which is the same no-op for room setup).
            if resp.status_code == 403 and (
                "already in the room" in resp.text
                or "already joined" in resp.text
                or "joined or banned" in resp.text
            ):
                return
            raise MatrixAdminError(
                f"Failed to invite {user_id} to {room_id}: {resp.status_code} {resp.text}"
            )
        logger.info("Invited %s to %s", user_id, room_id)

    async def kick_user(self, room_id: str, user_id: str) -> None:
        resp = await self._http.post(
            f"/_matrix/client/v3/rooms/{room_id}/kick",
            headers={"Authorization": f"Bearer {self.access_token}"},
            json={"user_id": user_id},
        )
        if not resp.is_success:
            # User is already out — nothing to do, the room teardown this serves
            # wants them gone and they are. Tuwunel/conduwuit rejects it with
            # "Cannot kick a user who is not apart of the room" (their typo);
            # Synapse says "not in the room". The counterpart to the
            # already-a-member tolerance in `invite_to_room`.
            if resp.status_code == 403 and (
                "not apart of the room" in resp.text
                or "not in the room" in resp.text
                or "not in room" in resp.text
            ):
                logger.debug(
                    "Skipped kicking %s from %s: already not a member",
                    user_id,
                    room_id,
                )
                return
            raise MatrixAdminError(
                f"Failed to kick {user_id} from {room_id}: {resp.status_code} {resp.text}"
            )
        logger.info("Kicked %s from %s", user_id, room_id)

    async def delete_room(self, room_id: str) -> None:
        """Abandon a room: the admin leaves and forgets it.

        Tuwunel/conduwuit exposes no REST room-purge endpoint (purge is only
        reachable via the server admin-room console). Callers kick the
        remaining members first, so leaving + forgetting empties the room of
        all Switch participants.
        """
        for action in ("leave", "forget"):
            resp = await self._http.post(
                f"/_matrix/client/v3/rooms/{room_id}/{action}",
                headers={"Authorization": f"Bearer {self.access_token}"},
                json={},
            )
            # Already gone / never joined is fine.
            if not resp.is_success and resp.status_code not in (403, 404):
                raise MatrixAdminError(
                    f"Failed to {action} room {room_id}: {resp.status_code} {resp.text}"
                )
        logger.info("Left and forgot room %s", room_id)

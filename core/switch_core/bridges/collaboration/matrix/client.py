"""The calls the Matrix bridge makes to a homeserver's Client-Server API.

The homeserver is the operator's own, reached as the bot account whose access
token they pasted. It is the only Matrix server involved: Switch's message bus
is PostgreSQL, and the Matrix-shaped names inside Switch (`matrix_room_id`,
`m.room.message` bodies) are kept identifiers, not a connection to anything.

Plain `httpx` rather than a Matrix SDK. The bridge uses a dozen endpoints, all
of them JSON over HTTPS, and an SDK would bring its own event loop handling,
storage and encryption machinery for a bridge that refuses encrypted rooms.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any
from urllib.parse import quote

import httpx

from switch_core.bridges.collaboration.models import BridgeOperationError

#: The error codes a homeserver answers with when the access token is not one
#: it accepts: revoked, expired, logged out, or never valid.
TOKEN_REJECTED = frozenset({"M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"})

# How long a homeserver may take to answer anything but a long poll.
_REQUEST_TIMEOUT = 30.0

# Added to a long poll's own timeout, so the server answers before we give up.
_SYNC_GRACE = 30.0


class MatrixApiError(BridgeOperationError):
    """The homeserver answered a request with an error.

    Carries the HTTP status and the Matrix `errcode` so callers can tell a
    token the server no longer accepts from a refusal of one operation, and a
    rate limit from either, without reading the message.
    """

    def __init__(
        self,
        *,
        method: str,
        path: str,
        status: int,
        errcode: str | None,
        error: str | None,
        retry_after_ms: int | None,
    ) -> None:
        detail = f"{errcode}: {error}" if errcode else (error or "no detail")
        super().__init__(
            f"The Matrix homeserver refused {method} {path} ({status} {detail})"
        )
        self.status = status
        self.errcode = errcode
        self.error = error
        self.retry_after_ms = retry_after_ms

    @property
    def rejects_token(self) -> bool:
        return self.status == 401 or self.errcode in TOKEN_REJECTED

    @property
    def unrecognised_endpoint(self) -> bool:
        """The server does not have this endpoint (an older homeserver)."""
        return self.status in (404, 405) and self.errcode in (None, "M_UNRECOGNIZED")

    @property
    def rate_limited(self) -> bool:
        return self.status == 429 or self.errcode == "M_LIMIT_EXCEEDED"


class NotAMatrixAnswer(MatrixApiError):
    """The server answered, but not as a Matrix homeserver's client API does.

    A redirect, an empty body, an HTML page or JSON that is not an object: what
    a website, a reverse proxy or a captive portal answers at an address that
    is not the homeserver's. Usually the server name entered where the client
    address belongs.
    """

    def __init__(self, *, method: str, path: str, status: int, what: str) -> None:
        super().__init__(
            method=method,
            path=path,
            status=status,
            errcode=None,
            error=what,
            retry_after_ms=None,
        )
        self.args = (
            f"The server answered {method} {path} with {what} ({status}), which "
            "is not how a Matrix homeserver's client API answers",
        )


class MediaTooLarge(Exception):
    """A download grew past the size the bridge will take."""


#: The longest a request waits in total for a homeserver that keeps answering
#: "too many requests", across every retry, before the refusal is raised.
RATE_LIMIT_BUDGET_SECONDS = 30.0

#: How many times one request is sent again for a rate limit.
RATE_LIMIT_ATTEMPTS = 10

#: The shortest wait between two attempts, whatever the homeserver says: a
#: limit of zero, or none at all, would otherwise resend at once, forever.
MIN_RETRY_SECONDS = 1.0

#: The longest single wait taken from the homeserver. A wait longer than this
#: is not waited out here: the request fails, and its caller decides what to
#: do (the sync loop backs off and says so; a send is visibly cut short).
MAX_RETRY_SECONDS = 60.0

# Overridden in tests, which count the waits instead of sitting through them.
_sleep = asyncio.sleep

# What is left of the rate-limit budget of the operation under way (one reply,
# however many pieces; one card and its reactions), when one was opened with
# `HomeserverApi.rate_budget`. Per task, so concurrent operations each have
# their own.
_operation_budget: ContextVar[list[float] | None] = ContextVar(
    "matrix_rate_budget", default=None
)

# How many same-origin redirects a media download follows.
_MEDIA_REDIRECTS = 3


def open_http(base_url: str) -> httpx.AsyncClient:
    """An unguarded client, for checking credentials before a bridge exists.

    The homeserver URL has already been through the deployment's outbound
    policy by then (`CollaborationBridgeLifecycleService.check_outbound_urls`).
    A running bridge connects through `guarded_async_client` instead. Neither
    follows redirects: a homeserver's client API does not redirect, and the
    token must not be carried to wherever a redirect points.
    """
    return httpx.AsyncClient(base_url=base_url, timeout=_REQUEST_TIMEOUT)


def _segment(value: str) -> str:
    """One path segment: room ids, event ids and user ids all carry `!$@:`."""
    return quote(value, safe="")


class HomeserverApi:
    """A bot account's session on its homeserver."""

    def __init__(self, http: httpx.AsyncClient, *, access_token: str) -> None:
        self._http = http
        self._headers = {"Authorization": f"Bearer {access_token}"}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        body: Mapping[str, Any] | None = None,
        content: bytes | None = None,
        content_type: str | None = None,
        timeout: float = _REQUEST_TIMEOUT,
    ) -> dict[str, Any]:
        headers = dict(self._headers)
        payload = content
        if body is not None:
            # Serialised here rather than by httpx so the size the homeserver
            # measures (UTF-8, not \u escapes) is the size that is sent.
            payload = json.dumps(body, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"
        elif content_type is not None:
            headers["Content-Type"] = content_type
        waited = 0.0
        attempts = 0
        while True:
            response = await self._http.request(
                method,
                path,
                params=params,
                content=payload,
                headers=headers,
                timeout=timeout,
            )
            if response.status_code < 300:
                return _json_object(method, path, response)
            if 300 <= response.status_code < 400:
                raise NotAMatrixAnswer(
                    method=method,
                    path=path,
                    status=response.status_code,
                    what=f"a redirect to {response.headers.get('location', 'nowhere')}",
                )
            error = _error(method, path, response)
            if not error.rate_limited:
                raise error
            attempts += 1
            # The same request again, path included: a send's transaction id
            # is in its path, so a retry the homeserver had already taken is
            # answered with the event it made rather than a second one.
            asked = (error.retry_after_ms or 0) / 1000
            if asked > MAX_RETRY_SECONDS:
                raise error
            delay = max(asked, MIN_RETRY_SECONDS)
            operation = _operation_budget.get()
            if (
                attempts > RATE_LIMIT_ATTEMPTS
                or waited + delay > RATE_LIMIT_BUDGET_SECONDS
                or (operation is not None and delay > operation[0])
            ):
                raise error
            waited += delay
            if operation is not None:
                operation[0] -= delay
            await _sleep(delay)

    @contextmanager
    def rate_budget(self, seconds: float) -> Iterator[None]:
        """Bound the rate-limit waits of every request made inside, together.

        One reply in nine pieces, or a card and its ten reactions, is one
        thing a reader is waiting for; without a shared bound each request
        could wait out its own, and the whole of it take minutes. Once the
        operation's budget is spent, the next rate limit fails its request.
        """
        token = _operation_budget.set([seconds])
        try:
            yield
        finally:
            _operation_budget.reset(token)

    # ── Account ──────────────────────────────────────────────────────────────

    async def whoami(self) -> dict[str, Any]:
        return await self._request("GET", "/_matrix/client/v3/account/whoami")

    async def account_data(self, user_id: str, data_type: str) -> dict[str, Any] | None:
        try:
            return await self._request(
                "GET",
                f"/_matrix/client/v3/user/{_segment(user_id)}/account_data/"
                f"{_segment(data_type)}",
            )
        except MatrixApiError as error:
            if error.status == 404:
                return None
            raise

    async def set_account_data(
        self, user_id: str, data_type: str, content: Mapping[str, Any]
    ) -> None:
        await self._request(
            "PUT",
            f"/_matrix/client/v3/user/{_segment(user_id)}/account_data/"
            f"{_segment(data_type)}",
            body=content,
        )

    # ── Sync ─────────────────────────────────────────────────────────────────

    async def sync(
        self, *, since: str | None, timeout_ms: int, sync_filter: Mapping[str, Any]
    ) -> dict[str, Any]:
        params: dict[str, str | int] = {
            "timeout": timeout_ms,
            "filter": json.dumps(sync_filter, separators=(",", ":")),
        }
        if since is not None:
            params["since"] = since
        return await self._request(
            "GET",
            "/_matrix/client/v3/sync",
            params=params,
            timeout=timeout_ms / 1000 + _SYNC_GRACE,
        )

    async def messages(
        self,
        room_id: str,
        *,
        from_token: str | None,
        to_token: str | None,
        direction: str,
        limit: int,
        event_filter: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        params: dict[str, str | int] = {"dir": direction, "limit": limit}
        if from_token is not None:
            params["from"] = from_token
        if to_token is not None:
            params["to"] = to_token
        if event_filter is not None:
            params["filter"] = json.dumps(event_filter, separators=(",", ":"))
        return await self._request(
            "GET",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/messages",
            params=params,
        )

    async def relations(
        self,
        room_id: str,
        event_id: str,
        rel_type: str,
        *,
        event_type: str | None,
        direction: str,
        limit: int,
        from_token: str | None,
    ) -> dict[str, Any]:
        path = (
            f"/_matrix/client/v1/rooms/{_segment(room_id)}/relations/"
            f"{_segment(event_id)}/{_segment(rel_type)}"
        )
        if event_type is not None:
            path += f"/{_segment(event_type)}"
        params: dict[str, str | int] = {"dir": direction, "limit": limit}
        if from_token is not None:
            params["from"] = from_token
        return await self._request("GET", path, params=params)

    # ── Rooms ────────────────────────────────────────────────────────────────

    async def send_event(
        self, room_id: str, event_type: str, content: Mapping[str, Any]
    ) -> str:
        answer = await self._request(
            "PUT",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/send/"
            f"{_segment(event_type)}/{uuid.uuid4().hex}",
            body=content,
        )
        event_id = answer.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise RuntimeError(
                f"The homeserver accepted a {event_type} event in {room_id} but "
                "returned no event id."
            )
        return event_id

    async def redact(self, room_id: str, event_id: str) -> None:
        await self._request(
            "PUT",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/redact/"
            f"{_segment(event_id)}/{uuid.uuid4().hex}",
            body={},
        )

    async def event(self, room_id: str, event_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/event/{_segment(event_id)}",
        )

    async def state_event(
        self, room_id: str, event_type: str, state_key: str = ""
    ) -> dict[str, Any] | None:
        """The content of one state event, or None where the room has none."""
        try:
            return await self._request(
                "GET",
                f"/_matrix/client/v3/rooms/{_segment(room_id)}/state/"
                f"{_segment(event_type)}/{_segment(state_key)}",
            )
        except MatrixApiError as error:
            if error.status == 404:
                return None
            raise

    async def state_event_full(
        self, room_id: str, event_type: str, state_key: str = ""
    ) -> dict[str, Any] | None:
        """One state event whole, sender included, or None where there is none.

        A homeserver that ignores `format=event` answers with the content
        alone; the caller then finds no `sender` and trusts nothing in it.
        """
        try:
            return await self._request(
                "GET",
                f"/_matrix/client/v3/rooms/{_segment(room_id)}/state/"
                f"{_segment(event_type)}/{_segment(state_key)}",
                params={"format": "event"},
            )
        except MatrixApiError as error:
            if error.status == 404:
                return None
            raise

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        answer = await self._request(
            "GET", f"/_matrix/client/v3/rooms/{_segment(room_id)}/joined_members"
        )
        joined = answer.get("joined")
        return joined if isinstance(joined, dict) else {}

    async def join(self, room_id: str, *, via: str | None = None) -> None:
        await self._request(
            "POST",
            f"/_matrix/client/v3/join/{_segment(room_id)}",
            params={"server_name": via} if via else None,
            body={},
        )

    async def leave(self, room_id: str) -> None:
        await self._request(
            "POST", f"/_matrix/client/v3/rooms/{_segment(room_id)}/leave", body={}
        )

    async def invite(self, room_id: str, user_id: str) -> None:
        await self._request(
            "POST",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/invite",
            body={"user_id": user_id},
        )

    async def create_room(self, body: Mapping[str, Any]) -> str:
        answer = await self._request("POST", "/_matrix/client/v3/createRoom", body=body)
        room_id = answer.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            raise RuntimeError("The homeserver created a room but returned no id.")
        return room_id

    async def typing(
        self, room_id: str, user_id: str, *, typing: bool, timeout_ms: int
    ) -> None:
        body: dict[str, Any] = {"typing": typing}
        if typing:
            body["timeout"] = timeout_ms
        await self._request(
            "PUT",
            f"/_matrix/client/v3/rooms/{_segment(room_id)}/typing/{_segment(user_id)}",
            body=body,
        )

    async def search_users(self, term: str, *, limit: int) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/_matrix/client/v3/user_directory/search",
            body={"search_term": term, "limit": limit},
        )

    # ── Media ────────────────────────────────────────────────────────────────

    async def media_config(self) -> dict[str, Any]:
        try:
            return await self._request("GET", "/_matrix/client/v1/media/config")
        except MatrixApiError as error:
            if not error.unrecognised_endpoint:
                raise
        return await self._request("GET", "/_matrix/media/v3/config")

    async def upload(self, data: bytes, *, content_type: str, filename: str) -> str:
        answer = await self._request(
            "POST",
            "/_matrix/media/v3/upload",
            params={"filename": filename},
            content=data,
            content_type=content_type,
        )
        uri = answer.get("content_uri")
        if not isinstance(uri, str) or not uri.startswith("mxc://"):
            raise RuntimeError(
                "The homeserver stored the upload but returned no mxc URI."
            )
        return uri

    async def download(
        self, mxc_uri: str, *, max_bytes: int
    ) -> tuple[bytes, str | None]:
        """The file behind an `mxc://` URI and its content type.

        Authenticated media first, as current homeservers require; the legacy
        unauthenticated endpoint only where the server says it does not have
        the new one. Read in pieces and abandoned past `max_bytes`, so a file
        whose event understated its size is not pulled down whole.
        """
        server, _, media_id = mxc_uri.removeprefix("mxc://").partition("/")
        if not server or not media_id or not mxc_uri.startswith("mxc://"):
            raise ValueError(f"{mxc_uri!r} is not an mxc:// URI")
        tail = f"{_segment(server)}/{_segment(media_id)}"
        try:
            return await self._stream(
                f"/_matrix/client/v1/media/download/{tail}", max_bytes
            )
        except MatrixApiError as error:
            if not error.unrecognised_endpoint:
                raise
        return await self._stream(f"/_matrix/media/v3/download/{tail}", max_bytes)

    async def _stream(self, path: str, max_bytes: int) -> tuple[bytes, str | None]:
        """Download one file, following a redirect only if it stays on the
        homeserver.

        Authenticated media may answer with a redirect, to a path of its own or
        to a CDN. The token goes with every request this client makes, so a
        redirect to anywhere else is refused rather than followed, and a
        redirect's own body is never taken for the file.
        """
        url: str | httpx.URL = path
        status = 0
        for _ in range(_MEDIA_REDIRECTS + 1):
            async with self._http.stream(
                "GET", url, headers=self._headers, timeout=_REQUEST_TIMEOUT
            ) as response:
                if 300 <= response.status_code < 400:
                    status = response.status_code
                    location = response.headers.get("location")
                    target = response.url.join(location) if location else None
                    if target is None or not _same_origin(target, response.url):
                        raise NotAMatrixAnswer(
                            method="GET",
                            path=path,
                            status=response.status_code,
                            what=(
                                "a redirect off the homeserver, which is not "
                                f"followed with the bot's token (to {target or 'nowhere'})"
                            ),
                        )
                    url = target
                    continue
                if response.status_code >= 400:
                    await response.aread()
                    raise _error("GET", path, response)
                chunks: list[bytes] = []
                received = 0
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > max_bytes:
                        raise MediaTooLarge(
                            f"more than {max_bytes} bytes; the download was stopped"
                        )
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("content-type")
        raise NotAMatrixAnswer(
            method="GET",
            path=path,
            status=status,
            what=f"more than {_MEDIA_REDIRECTS} redirects",
        )


def _same_origin(one: httpx.URL, other: httpx.URL) -> bool:
    return (one.scheme, one.host, one.port) == (other.scheme, other.host, other.port)


def _json_object(method: str, path: str, response: httpx.Response) -> dict[str, Any]:
    """A successful answer's body, which on the client API is always an object."""
    try:
        parsed = response.json()
    except ValueError as exc:
        kind = response.headers.get("content-type", "no content type")
        what = (
            "an empty body"
            if not response.content
            else f"a body that is not JSON ({kind})"
        )
        raise NotAMatrixAnswer(
            method=method, path=path, status=response.status_code, what=what
        ) from exc
    if not isinstance(parsed, dict):
        raise NotAMatrixAnswer(
            method=method,
            path=path,
            status=response.status_code,
            what=f"JSON that is not an object ({type(parsed).__name__})",
        )
    return parsed


def _error(method: str, path: str, response: httpx.Response) -> MatrixApiError:
    errcode: str | None = None
    message: str | None = None
    retry_after_ms: int | None = None
    try:
        parsed = response.json()
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        errcode = (
            parsed.get("errcode") if isinstance(parsed.get("errcode"), str) else None
        )
        message = parsed.get("error") if isinstance(parsed.get("error"), str) else None
        retry = parsed.get("retry_after_ms")
        # `True` is an int to Python; a negative wait is no wait at all.
        if isinstance(retry, int) and not isinstance(retry, bool):
            retry_after_ms = max(retry, 0)
    if retry_after_ms is None and response.status_code == 429:
        header = response.headers.get("retry-after")
        if header is not None and header.isdigit():
            retry_after_ms = int(header) * 1000
    # The query string is left out: a sync's carries the filter and the
    # position, neither of which belongs in an error a person reads.
    return MatrixApiError(
        method=method,
        path=path.split("?", 1)[0],
        status=response.status_code,
        errcode=errcode,
        error=message,
        retry_after_ms=retry_after_ms,
    )

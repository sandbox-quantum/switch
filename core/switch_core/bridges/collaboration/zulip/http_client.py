"""Zulip's HTTP API, as much of it as the bridge needs.

Zulip has no SDK worth the dependency: a bot authenticates with HTTP basic auth
over its own address and API key, and every endpoint answers the same envelope
(`{"result": "success" | "error", "msg": ..., "code": ...}`) whether it
succeeded or not, so one place reads that envelope and everything above it sees
a `ZulipError` or a body.

The bot dials out. `register` opens an event queue on the organization and
`poll` long-polls it, which is why this connection needs no public address:
Zulip holds the request open for its own long-poll window and hands over the
events that happened while it was waiting.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

#: How long Zulip holds a `poll` request open, in seconds. The read timeout is
#: put above it so a quiet organization is not mistaken for a dead connection.
LONGPOLL_SECONDS = 90.0

#: Zulip caps a topic at 60 characters and a message body at 10,000.
MAX_TOPIC_LENGTH = 60


class ZulipError(Exception):
    """Zulip was asked something and answered with a refusal.

    `status` is the HTTP status the answer arrived with, when there was one, and
    `code` is Zulip's own machine-readable reason (`BAD_EVENT_QUEUE_ID`,
    `UNAUTHORIZED`, …). Both are kept because the two things a caller has to do
    with a failure — tell the operator the credentials are wrong, or start a new
    event queue — are told apart by them and never by the wording, which belongs
    to whichever Zulip release is in front of us.
    """

    def __init__(
        self, message: str, *, status: int | None = None, code: str | None = None
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def _failure(body: Any, response: httpx.Response) -> tuple[str, str | None]:
    """The operator-facing reason and Zulip's code, from whatever came back.

    A refusal normally carries a JSON envelope. A proxy in front of the
    organization, a wrong base address or an HTML error page does not, so the
    status is the fallback rather than an empty message.
    """
    if isinstance(body, dict):
        message = str(body.get("msg") or "").strip()
        code = str(body.get("code") or "") or None
        if message:
            return message, code
        return f"Zulip answered {response.status_code} without saying why.", code
    return (
        f"Zulip answered {response.status_code} with a reply this bridge could not read.",
        None,
    )


class ZulipClient:
    """One bot's connection to one Zulip organization."""

    def __init__(
        self,
        *,
        url: str,
        email: str,
        api_key: str,
        verify_tls: bool = True,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = url.rstrip("/")
        # `transport` is how the tests hand this client a fake organization;
        # production passes nothing and gets a real connection.
        self._client = httpx.AsyncClient(
            base_url=f"{self._url}/api/v1",
            auth=(email, api_key),
            headers={"User-Agent": "switch-zulip-bridge"},
            timeout=httpx.Timeout(timeout, read=LONGPOLL_SECONDS + 30.0),
            verify=verify_tls,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── The envelope ─────────────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self._client.request(
            method, path, params=params, data=data, files=files
        )
        try:
            body = response.json()
        except ValueError:
            body = None
        if (
            response.status_code < 400
            and isinstance(body, dict)
            and body.get("result") == "success"
        ):
            return body
        message, code = _failure(body, response)
        raise ZulipError(message, status=response.status_code, code=code)

    # ── Who we are ───────────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        """The bot's own account. Also the cheapest authenticated call there is,
        which is why the connect form is checked with it."""
        return await self._request("GET", "/users/me")

    async def users(self) -> list[dict[str, Any]]:
        members = (await self._request("GET", "/users")).get("members") or []
        return [member for member in members if isinstance(member, dict)]

    # ── Events ───────────────────────────────────────────────────────────────

    async def register(self) -> dict[str, Any]:
        """Open an event queue.

        `apply_markdown` is off on purpose: with it on Zulip renders each message
        to HTML before handing it over, and the bridge would then have to parse
        the rendering back into text to quote what somebody said. Off, the event
        carries exactly what the person typed.

        Only messages and heartbeats are requested. Edits and deletions made on
        Zulip have no callback in the bridge to mirror them into, so asking for
        them would fill the queue with events nothing can act on.
        """
        return await self._request(
            "POST",
            "/register",
            data={
                "event_types": json.dumps(["message", "heartbeat"]),
                "apply_markdown": json.dumps(False),
                "client_gravatar": json.dumps(False),
            },
        )

    async def poll(self, queue_id: str, last_event_id: int) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/events",
            params={
                "queue_id": queue_id,
                "last_event_id": last_event_id,
                "dont_block": "false",
            },
        )

    # ── Messages ─────────────────────────────────────────────────────────────

    async def send_stream_message(
        self, *, stream_id: str | int, topic: str, content: str
    ) -> str:
        body = await self._request(
            "POST",
            "/messages",
            data={
                "type": "stream",
                "to": stream_id,
                "topic": topic,
                "content": content,
            },
        )
        return str(body.get("id"))

    async def update_message(self, message_id: str, content: str) -> None:
        await self._request(
            "PATCH", f"/messages/{message_id}", data={"content": content}
        )

    async def delete_message(self, message_id: str) -> None:
        await self._request("DELETE", f"/messages/{message_id}")

    async def start_typing(self, *, stream_id: str | int, topic: str) -> None:
        """Start the typing indicator.

        There is no stop: Zulip expires the indicator on its own after a few
        seconds, so the caller's `is_typing=False` needs nothing on the wire.
        """
        await self._request(
            "POST",
            "/typing",
            data={"type": "stream", "op": "start", "to": stream_id, "topic": topic},
        )

    async def upload(self, *, filename: str, mimetype: str, data: bytes) -> str:
        """Put a file on the organization and return the URI a message links to.

        The multipart field is `filename`, which reads like a name rather than
        a file and is Zulip's own spelling for it (checked against the
        published OpenAPI schema); a `file` field is ignored, and the upload
        then fails as an empty request.
        """
        body = await self._request(
            "POST", "/user_uploads", files={"filename": (filename, data, mimetype)}
        )
        return str(body.get("uri") or "")

    async def download(self, url: str) -> bytes:
        """Fetch an uploaded file. Zulip hands events a relative `/user_uploads`
        path, which is absolute only against the organization and not against
        `/api/v1`, so it is resolved here rather than through `base_url`."""
        absolute = (
            url if url.startswith(("http://", "https://")) else f"{self._url}{url}"
        )
        response = await self._client.get(absolute)
        if response.status_code >= 400:
            raise ZulipError(
                f"Zulip answered {response.status_code} for {url}",
                status=response.status_code,
            )
        return response.content

    # ── Streams ──────────────────────────────────────────────────────────────

    async def stream(self, stream_id: str | int) -> dict[str, Any]:
        return dict(
            (await self._request("GET", f"/streams/{stream_id}")).get("stream") or {}
        )

    async def stream_by_name(self, name: str) -> dict[str, Any]:
        body = await self._request(
            "GET", "/streams", params={"include_all_active": "true"}
        )
        for stream in body.get("streams") or []:
            if isinstance(stream, dict) and stream.get("name") == name:
                return stream
        raise ZulipError(f"The organization has no stream named {name!r}.", status=404)

    async def subscribe(
        self,
        *,
        stream: str,
        description: str = "",
        invite_only: bool = False,
        principals: list[int] | None = None,
    ) -> dict[str, Any]:
        """Subscribe this bot to a stream, creating it when it does not exist.

        `principals` adds people to the stream in the same call; Zulip only
        honours it for a bot with permission to subscribe other users, and says
        so in its answer when it does not.
        """
        subscription: dict[str, Any] = {"name": stream, "description": description}
        payload: dict[str, Any] = {"subscriptions": json.dumps([subscription])}
        if invite_only:
            # A property of the request, not of the subscription: `subscriptions`
            # items carry a name, a description and a colour, and Zulip reads
            # privacy for the stream being created at the top level.
            payload["invite_only"] = "true"
        if principals:
            payload["principals"] = json.dumps(principals)
        return await self._request("POST", "/users/me/subscriptions", data=payload)

    async def unsubscribe(self, stream: str) -> None:
        await self._request(
            "DELETE",
            "/users/me/subscriptions",
            params={"subscriptions": json.dumps([stream])},
        )

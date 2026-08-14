"""HTTP client for one AG-UI run.

POST a `RunAgentInput`, consume the SSE response, yield parsed events. The
client is deliberately transparent about *content* — it does not decide whether
a run was complete, which is `RunAssembler.finish()`'s job — and opinionated
about *transport*, because that is where AG-UI leaves the most room to fail
quietly.

Two timeouts, covering different failures, because neither is sufficient alone:

- **Read timeout**, on the underlying client: the longest gap between bytes.
  AG-UI defines no keepalive event, so a model that has gone quiet to think is
  indistinguishable on the wire from a socket that has died. Without this, a
  dead connection hangs until something else gives up.
- **Run timeout**, here: the longest a whole run may take. A producer that
  keeps dribbling bytes forever never trips a read timeout.

Both raise. Neither returns a partial answer as though it were finished.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator

import httpx

from switch_core.bridges.agent.server_connectors.agui.events import (
    AgUiEvent,
    AgUiProtocolError,
    parse_event,
)
from switch_core.bridges.agent.server_connectors.agui.request import RunAgentInput
from switch_core.bridges.agent.server_connectors.agui.sse import (
    SseDecoder,
    decode_json_frame,
)

CONNECT_TIMEOUT_SECONDS = 10.0
"""Establishing the connection is not the slow part; failing fast is right."""

DEFAULT_READ_TIMEOUT_SECONDS = 120.0
"""Longest silence tolerated mid-stream. Generous, because a reasoning model
can legitimately produce nothing for a long time, but finite — see above."""

DEFAULT_RUN_TIMEOUT_SECONDS = 900.0
"""Longest a single run may take, however chatty it is."""

MAX_ERROR_BODY_CHARS = 500


class AgUiTransportError(AgUiProtocolError):
    """The endpoint was unreachable, rejected the run, or dropped the stream."""


class AgUiTimeoutError(AgUiProtocolError):
    """The run exceeded a read or overall deadline."""


def build_http_client(read_timeout_seconds: float) -> httpx.AsyncClient:
    """Build a client with the streaming timeout policy this connector needs.

    Kept here rather than at each call site so the policy is stated once and
    can be asserted by a test.
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=CONNECT_TIMEOUT_SECONDS,
            read=read_timeout_seconds,
            write=CONNECT_TIMEOUT_SECONDS,
            pool=CONNECT_TIMEOUT_SECONDS,
        )
    )


class AgUiClient:
    """Runs an AG-UI agent over HTTP.

    The `httpx` client is injected so tests can drive it through a mock
    transport, and so the connector owns its lifecycle.
    """

    def __init__(
        self,
        *,
        endpoint_url: str,
        bearer_token: str | None,
        http: httpx.AsyncClient,
        run_timeout_seconds: float,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._bearer_token = bearer_token
        self._http = http
        self._run_timeout_seconds = run_timeout_seconds

    async def run(self, request: RunAgentInput) -> AsyncIterator[AgUiEvent]:
        """POST one run and yield its events in order.

        Raises rather than truncating: a non-200, a dropped stream, a blown
        deadline or an uninterpretable frame all surface. Whether the *run*
        was complete is decided by the assembler consuming this.
        """
        deadline = time.monotonic() + self._run_timeout_seconds
        decoder = SseDecoder()

        try:
            async with self._http.stream(
                "POST",
                self._endpoint_url,
                json=request.model_dump(by_alias=True),
                headers=self._headers(),
            ) as response:
                if response.status_code != httpx.codes.OK:
                    raise AgUiTransportError(
                        f"AG-UI endpoint returned HTTP {response.status_code}: "
                        f"{await self._error_body(response)}"
                    )

                async for chunk in response.aiter_text():
                    self._check_deadline(deadline)
                    for frame in decoder.feed(chunk):
                        yield parse_event(decode_json_frame(frame))

                for frame in decoder.close():
                    yield parse_event(decode_json_frame(frame))

        except httpx.TimeoutException as exc:
            raise AgUiTimeoutError(
                f"AG-UI endpoint {self._endpoint_url} went silent for longer than "
                f"the read timeout: {exc!r}"
            ) from exc
        except httpx.HTTPError as exc:
            raise AgUiTransportError(
                f"AG-UI request to {self._endpoint_url} failed: {exc!r}"
            ) from exc

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"
        return headers

    def _check_deadline(self, deadline: float) -> None:
        if time.monotonic() > deadline:
            raise AgUiTimeoutError(
                f"AG-UI run against {self._endpoint_url} exceeded "
                f"{self._run_timeout_seconds}s and was abandoned"
            )

    async def _error_body(self, response: httpx.Response) -> str:
        try:
            body = await response.aread()
        except httpx.HTTPError:
            return "<body unreadable>"
        return body.decode(errors="replace")[:MAX_ERROR_BODY_CHARS] or "<empty body>"

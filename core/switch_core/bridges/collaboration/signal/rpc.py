"""The signal-cli daemon's JSON-RPC endpoint, one call at a time.

Every request carries the connection's account, so one daemon can serve
several Signal numbers on distinct connections. Responses are matched by the
request id and refused loudly when they are not JSON-RPC at all.

Errors are raised by their code, never the daemon's free-text message:
the one code that names a credential problem (-32602, the account is not on
this daemon) becomes `BridgeCredentialError`, a request this client built
wrong (-32600 malformed, -32601 a method the daemon does not know) is a bug
in Switch's use of signal-cli and is raised as one, and everything else is
the platform refusing an operation.
"""

from __future__ import annotations

import itertools
from typing import Any

import httpx

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)

#: The JSON-RPC error codes the daemon reports, as probed on 0.14.9.
RPC_ACCOUNT_NOT_ON_DAEMON = -32602
RPC_INVALID_REQUEST = -32600
RPC_METHOD_NOT_FOUND = -32601

#: The one timeout for every call. The daemon is expected to answer on a
#: private network; a larger download (an attachment) is the only slow one,
#: and a 30-second read leaves headroom for it.
_DEFAULT_TIMEOUT_SECONDS = 30.0


class SignalRpcError(BridgeOperationError):
    """A JSON-RPC `error` result, carrying the daemon's code.

    A `BridgeOperationError` so an unexpected refusal reaches the caller as
    an operation failure that the failure rules read as `platform_error`;
    the code is what anything more specific keys on, never the message.
    """

    def __init__(self, code: int | None, message: str) -> None:
        shown = code if code is not None else "no code"
        super().__init__(f"signal-cli refused the request ({shown}): {message}")
        self.code = code


def _json_rpc_body(response: httpx.Response) -> dict[str, Any]:
    """Parse a JSON-RPC response body, refusing anything that is not one."""
    try:
        body = response.json()
    except ValueError as exc:
        raise BridgeOperationError(
            f"The daemon answered without a JSON-RPC body (HTTP {response.status_code})"
        ) from exc
    if not isinstance(body, dict):
        raise BridgeOperationError(
            "The daemon answered with a JSON-RPC body that is not an object"
        )
    return body


def _raise_for_error(error: dict[str, Any], *, account: str) -> None:
    code = error.get("code")
    message = error.get("message") or "no reason given"
    if code == RPC_ACCOUNT_NOT_ON_DAEMON:
        raise BridgeCredentialError(
            f"The account {account!r} is not on that daemon: {message}. "
            "Register the number there, or point the bridge at the daemon "
            "that holds it."
        )
    if code in (RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND):
        # A request this client built wrong: one Switch itself should not be
        # able to send, or a method this daemon version does not know.
        raise RuntimeError(
            f"Built a JSON-RPC request the daemon rejected ({code}): {message}"
        )
    raise SignalRpcError(code, message)


class SignalRpcClient:
    """One connection's calls to the daemon, over one HTTP client."""

    def __init__(
        self,
        *,
        daemon_url: str,
        account: str,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = daemon_url.rstrip("/") + "/api/v1/rpc"
        self._account = account
        self._http = http or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS)
        self._owns_http = http is None
        self._ids = itertools.count(1)

    async def call(self, method: str, **params: Any) -> Any:
        """One JSON-RPC call. The account goes on every request."""
        request_id = next(self._ids)
        request_params: dict[str, Any] = dict(params)
        request_params["account"] = self._account
        response = await self._http.post(
            self._url,
            json={
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": request_params,
            },
        )
        parsed = _json_rpc_body(response)
        error = parsed.get("error")
        if error is not None:
            _raise_for_error(error, account=self._account)
        return parsed.get("result")

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

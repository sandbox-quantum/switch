"""Agent operations a controller calls over its socket.

A controller relays every call its agents' sessions make. Over HTTP each of
those is a request of its own: parsed, routed, and authenticated with the
controller's access token. The controller's connection already holds one
authenticated WebSocket to this server, so it can send the operations on it
instead (`POST /agents/{id}/ops/{operation}` is the HTTP door to the same
code):

    {"type": "call", "id": "c-17", "agent_id": "...", "operation": "post_message",
     "arguments": {"body": "..."}, "room_id": "...", "request_id": "..."}

and each is answered on the socket with the status and the body the HTTP
route would have answered with:

    {"event": "call.result", "data": {"id": "c-17", "status": 200,
                                       "body": {"result": {...}}}}

A call is authorized exactly as the same operation over HTTP with the
controller's token: its controller is checked against its row (from the
controller-token cache when it holds it), so a revoked controller is refused,
and the agent must be bound to that controller now. The calling session's
room is `room_id`, where an HTTP call sends `X-Switch-Room-Id`.

The server says it takes calls in the socket's first frame (`calls`, with how
many may be in flight at once). A call over that number is answered with 429
and `capacity_exceeded` without running, so the controller can send it over
HTTP instead. Calls run concurrently, and one still running when its socket
closes runs to its end, as an HTTP request does when its client goes away;
only its answer is lost.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from pydantic import TypeAdapter

from switch_core.archived_workspace import WORKSPACE_ARCHIVED
from switch_core.bridges.agent.api.operations import (
    call_operation,
    refusal_status,
    resolve_controller_caller,
)
from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
from switch_core.bridges.agent.protocol.agent_connections import MAX_ID_LENGTH
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.logging_context import log_context
from switch_core.management import reason_codes
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.errors import error_body
from switch_core.request_context import sanitised_request_id
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)

CALL = "call"
CALL_RESULT = "call.result"

# Calls one socket may have running at once. Told to the controller in the
# socket's first frame; one more is refused without running.
MAX_CALLS_IN_FLIGHT = 64

_MAX_CALL_ID_LENGTH = 64

# How the HTTP route encodes its answer: FastAPI serializes a route's return
# value with Pydantic for its declared type, `dict[str, Any]` there.
_BODY: TypeAdapter[dict[str, Any]] = TypeAdapter(dict[str, Any])


@dataclass(frozen=True)
class Call:
    id: str | int
    agent_id: str
    operation: str
    arguments: dict[str, Any]
    room_id: str | None
    request_id: str


class _Malformed(Exception):
    """The call cannot be run as sent; answered with 400."""


def call_id(message: dict[str, Any]) -> str | int | None:
    """The id to answer a call frame with, or None when it has none it can be
    answered by."""
    raw = message.get("id")
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and 0 < len(raw) <= _MAX_CALL_ID_LENGTH:
        return raw
    return None


def calls_offered() -> dict[str, Any]:
    """What the socket's first frame says about calls."""
    return {"max_in_flight": MAX_CALLS_IN_FLIGHT}


def capacity_exceeded(id_: str | int) -> dict[str, Any]:
    """The answer to a call over `MAX_CALLS_IN_FLIGHT`, which did not run."""
    return _result(
        id_,
        429,
        error_body(
            reason_codes.CAPACITY_EXCEEDED,
            f"This connection already has {MAX_CALLS_IN_FLIGHT} calls in flight; "
            "send this one over HTTP or once one is answered.",
            retryable=True,
        ),
    )


async def answer(
    message: dict[str, Any],
    id_: str | int,
    *,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    authenticator: ManagementAuthenticator,
) -> dict[str, Any]:
    """Run one call a controller sent on its socket, and return the frame
    that answers it: every call is answered, a failure with 500 as over
    HTTP."""
    try:
        call = _parse(message, id_)
    except _Malformed as exc:
        return _result(id_, 400, {"detail": str(exc)})
    try:
        return await _run(
            call, principal=principal, protocol=protocol, authenticator=authenticator
        )
    except Exception:
        logger.exception("A call to %s on a controller's socket failed", call.operation)
        return _result(id_, 500, {"detail": "Internal Server Error"})


async def _run(
    call: Call,
    *,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    authenticator: ManagementAuthenticator,
) -> dict[str, Any]:
    id_ = call.id
    try:
        controller = await authenticator.current(principal)
    except ControllerAuthError as exc:
        return _result(id_, 401, error_body(exc.code, exc.message, retryable=False))
    binding = authenticator.presence.binding(call.agent_id)
    if (
        binding is None
        or binding.controller_id != controller.controller_id
        or binding.tenant_id != controller.tenant_id
    ):
        return _result(
            id_,
            403,
            error_body(
                reason_codes.NOT_ASSIGNED,
                f"Agent {call.agent_id} is not assigned to this controller.",
                retryable=False,
            ),
        )
    if await authenticator.stopped_by_archive(binding):
        return _result(
            id_,
            403,
            error_body(
                reason_codes.WORKSPACE_ARCHIVED, WORKSPACE_ARCHIVED, retryable=False
            ),
        )

    with (
        tenant_scope(controller.tenant_id),
        log_context(
            request_id=call.request_id,
            agent_id=call.agent_id,
            tenant_id=controller.tenant_id,
        ),
    ):
        try:
            session_key, caller = await resolve_controller_caller(
                agent_id=call.agent_id, protocol=protocol, room_id=call.room_id
            )
            result = await call_operation(
                operation=call.operation,
                arguments=call.arguments,
                agent_id=call.agent_id,
                connection_id=session_key,
                session=caller,
            )
        except HTTPException as exc:
            return _result(id_, exc.status_code, {"detail": exc.detail})
        except Exception as exc:
            status = refusal_status(exc)
            if status is None:
                raise
            return _result(id_, status, {"detail": str(exc)})
        return _result(id_, 200, _BODY.dump_python({"result": result}, mode="json"))


def _parse(message: dict[str, Any], id_: str | int) -> Call:
    agent_id = message.get("agent_id")
    if not isinstance(agent_id, str) or not 0 < len(agent_id) <= MAX_ID_LENGTH:
        raise _Malformed("A call names the agent it is made as in agent_id.")
    operation = message.get("operation")
    if not isinstance(operation, str) or not operation:
        raise _Malformed("A call names its operation in operation.")
    arguments = message.get("arguments", {})
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise _Malformed("A call's arguments are an object.")
    room_id = message.get("room_id")
    if room_id is not None and (
        not isinstance(room_id, str) or not 0 < len(room_id) <= MAX_ID_LENGTH
    ):
        raise _Malformed("A call's room_id is a room id, or absent.")
    request_id = message.get("request_id")
    return Call(
        id=id_,
        agent_id=agent_id,
        operation=operation,
        arguments=arguments,
        room_id=room_id,
        request_id=sanitised_request_id(
            request_id if isinstance(request_id, str) else ""
        ),
    )


def _result(id_: str | int, status: int, body: Any) -> dict[str, Any]:
    return {"event": CALL_RESULT, "data": {"id": id_, "status": status, "body": body}}

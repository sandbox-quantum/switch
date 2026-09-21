"""HTTP front door for the agent operations (CHOO-1857 / CHOO-490).

`POST /agents/{agent_id}/ops/{operation}` with the operation's arguments as the
JSON body. Operation names are exactly the MCP tool names — one vocabulary, so
a local runtime translating between the two is `POST /ops/${toolName}` and
nothing more.

Both front doors are built from the **same** registry: this one dispatches into
it, and the MCP server registers its tools from it. Parity is therefore
structural — an operation is reachable through both doors the moment it exists,
and neither can quietly fall behind the other.

What is deliberately NOT here: media upload/download (multipart and binary, so
HTTP semantics matter), the event stream, connection lifecycle, mediation, and
registration. Those are not agent tools.
"""

from __future__ import annotations

import inspect
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_protocol, get_session_factory
from switch_core.bridges.agent.operations import all_operations, get_operation
from switch_core.bridges.agent.operations.callctx import CallContext, call_context
from switch_core.bridges.agent.protocol.connections import UnknownConnectionError
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent
from switch_core.sessions.service import SessionAuthority

logger = logging.getLogger(__name__)


class UnknownOperationError(Exception):
    def __init__(self, name: str, known: list[str]) -> None:
        super().__init__(
            f"unknown operation {name!r}; expected one of: {', '.join(sorted(known))}"
        )
        self.name = name


class BadArgumentsError(Exception):
    """The body did not match the operation's parameters."""


def list_operations() -> dict[str, dict[str, Any]]:
    """Every operation, with its parameters.

    Read straight off the registry both doors are built from, so this is the
    authoritative list — for clients and for the protocol documentation.
    """
    return {
        op.name: {
            "description": op.description,
            "input_schema": op.input_schema,
        }
        for op in all_operations().values()
    }


async def call_operation(
    *,
    operation: str,
    arguments: dict[str, Any],
    agent_id: str,
    connection_id: str | None,
) -> Any:
    """Run one operation on behalf of an agent.

    `connection_id` becomes the caller's session key, so an operation that
    depends on the caller's room binding — `connect_to_room`, `post_message`,
    `assume_role` — resolves it from the connection rather than from an MCP
    transport session. That is what makes the two doors interchangeable.
    """
    op = get_operation(operation)
    if op is None:
        raise UnknownOperationError(operation, list(all_operations()))

    fn = op.fn
    signature = inspect.signature(fn)
    accepted = set(signature.parameters)

    unexpected = set(arguments) - accepted
    if unexpected:
        raise BadArgumentsError(
            f"{operation} does not accept: {', '.join(sorted(unexpected))}"
        )

    call_args: dict[str, Any] = dict(arguments)

    missing = [
        name
        for name, param in signature.parameters.items()
        if name not in call_args and param.default is inspect.Parameter.empty
    ]
    if missing:
        raise BadArgumentsError(f"{operation} requires: {', '.join(missing)}")

    with call_context(CallContext(agent_id=agent_id, session_key=connection_id)):
        result = fn(**call_args)
        if inspect.isawaitable(result):
            result = await result
        return result


# ── HTTP router ──────────────────────────────────────────────────────────────


SESSION_SELECTOR_HEADERS = (
    "X-Switch-Session-Id",
    "X-Switch-Session-Host-Id",
    "X-Switch-Session-Epoch",
)


async def resolve_session_key(
    *,
    agent_id: str,
    protocol: ProtocolService,
    factory: async_sessionmaker[AsyncSession],
    connection_id: str | None,
    session_id: str | None,
    host_id: str | None,
    epoch: str | None,
) -> str | None:
    """Which thing owns this caller's room binding, from the selector it sent.

    Two ways to say it. A connection selector names the connection directly; a
    session selector names the session and is answered with the connection that
    session bound, having passed the session fence on the way. While a session
    owns at most one connection the two arrive at the same answer, which is the
    property that lets callers move from one to the other without anything else
    changing.

    Neither is taken on trust, and neither is allowed to be approximately
    right: a selector naming another agent's session or connection, an
    incomplete selector, and two selectors that disagree are all refused rather
    than resolved to something plausible.
    """
    named = [
        header
        for header, value in zip(
            SESSION_SELECTOR_HEADERS, (session_id, host_id, epoch), strict=True
        )
        if value is not None
    ]
    if named and len(named) != len(SESSION_SELECTOR_HEADERS):
        raise HTTPException(
            status_code=400,
            detail=(
                "the session selector is all of "
                f"{', '.join(SESSION_SELECTOR_HEADERS)}; this request carried "
                f"only {', '.join(named)}"
            ),
        )

    bound = connection_id
    if session_id is not None and host_id is not None and epoch is not None:
        from_session = await SessionAuthority(factory).room_connection(
            agent_id, session_id, host_id, epoch
        )
        if connection_id is not None and connection_id != from_session:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"session {session_id} is bound to connection {from_session}, "
                    f"but this request also named connection {connection_id}; "
                    "send one selector or the other"
                ),
            )
        bound = from_session

    if bound is None:
        return None

    # Derived, never taken on trust: a connection belonging to another agent,
    # or to one that has already died, is refused rather than silently treated
    # as no connection at all.
    try:
        protocol.connections.require(agent_id, bound)
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return bound


router = APIRouter(prefix="/agents", tags=["operations"])


@router.get("/{agent_id}/ops")
async def get_operations(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
) -> dict[str, Any]:
    """List every operation and its parameters, straight from the registry."""
    return {"operations": list_operations()}


@router.post("/{agent_id}/ops/{operation}")
async def post_operation(
    agent_id: str,
    operation: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    body: dict[str, Any] | None = None,
    connection_id: Annotated[str | None, Header(alias="x-switch-connection-id")] = None,
    session_id: Annotated[str | None, Header(alias="x-switch-session-id")] = None,
    host_id: Annotated[str | None, Header(alias="x-switch-session-host-id")] = None,
    epoch: Annotated[str | None, Header(alias="x-switch-session-epoch")] = None,
) -> dict[str, Any]:
    """Run one operation. The body is the operation's arguments.

    The caller says what it is bound to, and that is what an operation
    depending on the caller's room binding resolves it from. Either
    `X-Switch-Connection-Id`, naming an open connection, or the session
    selector — `X-Switch-Session-Id` with `X-Switch-Session-Host-Id` and
    `X-Switch-Session-Epoch` — naming the session that bound one. Both are
    read from headers rather than the body, and both are checked against the
    calling agent.
    """
    session_key = await resolve_session_key(
        agent_id=agent.id,
        protocol=protocol,
        factory=factory,
        connection_id=connection_id,
        session_id=session_id,
        host_id=host_id,
        epoch=epoch,
    )

    try:
        result = await call_operation(
            operation=operation,
            arguments=body or {},
            agent_id=agent.id,
            connection_id=session_key,
        )
    except UnknownOperationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BadArgumentsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        # Operations raise ValueError for "you asked for something that is not
        # there or not allowed yet" - surfaced rather than swallowed.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"result": result}

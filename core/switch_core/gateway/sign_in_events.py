"""Sign-ins as security events: a success is a server audit event, a failure
a log-only one.

A success has an account, and goes to `server_audit_events` because a
sign-in is to the server rather than to any one workspace. A failure is
written to the log only (`SecuritySignal.SIGN_IN_FAILED`): the account it
names is whatever the caller typed, and a row per attempt would let anyone
grow an append-only table at will.

`client_ip` is the address the connection came from as uvicorn reports it.
Behind a proxy that is the proxy's unless uvicorn trusts it to forward the
client's (`FORWARDED_ALLOW_IPS`).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.security_events import SecuritySignal, log_security_event


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client is not None else None


async def record_sign_in(
    session: AsyncSession,
    request: Request,
    *,
    user_id: str,
    method: str,
    details: dict[str, Any],
) -> None:
    """Add the success to `session`; the caller commits."""
    await record_server_audit_event(
        session,
        actor_user_id=user_id,
        action=ServerAuditAction.USER_SIGNED_IN,
        target_type="user",
        target_id=user_id,
        details={"method": method, "client_ip": client_ip(request), **details},
    )


def sign_in_failed(
    request: Request,
    *,
    method: str,
    reason: str,
    user_id: str | None,
    tenant_id: str | None,
) -> None:
    log_security_event(
        SecuritySignal.SIGN_IN_FAILED,
        tenant_id=tenant_id,
        actor_user_id=user_id,
        target_type="user",
        target_id=user_id,
        agent_id=None,
        room_id=None,
        details={"method": method, "reason": reason, "client_ip": client_ip(request)},
    )

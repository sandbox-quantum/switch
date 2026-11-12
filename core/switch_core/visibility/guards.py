"""The three roles as request dependencies.

Every visibility route uses exactly one of these, so Core refuses a role's
pages to everyone else whatever Console shows:

- `require_user`: the signed-in person, acting on their own agents only
  (`require_own`). No admin or operator bypass: nobody else sees a user's
  agents through these routes.
- `require_workspace_admin`: an `owner` or `admin` **member** of the workspace
  this request is bound to, by membership row only. Unlike the existing
  `require_tenant_admin`, the operator bit does not pass: an operator opening a
  workspace's People or Activity tab would see names with no reason and no
  audit entry, which gets round the hidden-names rule. Operators
  use their own ids-only views.
- `require_operator`: on Core's operator list (`visibility.operators`), and
  nothing else. Neither workspace ownership nor `users.role == "admin"` grants
  it. The list is re-read when its file changes, so
  a removal takes effect on the next request; that request first records each
  grant and removal in the operators' log.

Operator routes use only `require_operator`: they never go through a workspace
admin or content route, and they return ids, states, counts and codes only.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from switch_core.authz import TENANT_ADMIN_ROLES
from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.tenant_context import current_tenant_id
from switch_core.visibility.audit_log import record_operator_list
from switch_core.visibility.operators import (
    OperatorList,
    OperatorSnapshot,
    warn_if_operators_hold_admin,
)

logger = logging.getLogger(__name__)

# The list stamp last written to the log, per OperatorList, and one lock so
# concurrent requests record a change once per process.
_recorded: dict[int, object] = {}
_record_lock = asyncio.Lock()


def get_operator_list(request: HTTPConnection) -> OperatorList:
    operators = getattr(request.app.state, "operator_list", None)
    if not isinstance(operators, OperatorList):
        # Not wired: nobody is an operator, rather than everybody.
        return OperatorList(None)
    return operators


async def record_list_changes(
    operators: OperatorList, session_factory: async_sessionmaker[AsyncSession]
) -> OperatorSnapshot:
    """Write grants and removals to the log once per change of the file, and
    return the snapshot that is now on the log. Callers check against that
    snapshot, so nobody acts on a grant the log doesn't have yet."""
    snapshot = operators.snapshot()
    if _recorded.get(id(operators)) == snapshot.stamp:
        return snapshot
    async with _record_lock:
        # Read again under the lock: another request may have recorded a newer
        # list meanwhile, and recording an older one after it would log the
        # change backwards.
        snapshot = operators.snapshot()
        if _recorded.get(id(operators)) == snapshot.stamp:
            return snapshot
        granted, removed = await record_operator_list(session_factory, snapshot.ids)
        _recorded[id(operators)] = snapshot.stamp
        if granted or removed:
            logger.info(
                "The Switch operator list changed",
                extra={"granted": len(granted), "removed": len(removed)},
            )
        if granted:
            # A new operator may already hold the admin bit.
            await warn_if_operators_hold_admin(session_factory, operators)
        return snapshot


async def require_user(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    return user


def require_own(user: User, owner_id: str | None) -> None:
    """404 unless `user` owns the thing. 404, not 403, so another user's agent
    looks the same as one that doesn't exist."""
    if owner_id is None or owner_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")


async def require_workspace_admin(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> User:
    """403 unless `user` is an `owner` or `admin` member of the bound workspace.

    Ends its read's transaction before returning, as `get_tenant_is_admin` does.
    """
    tenant_id = current_tenant_id()
    if tenant_id is None:
        raise HTTPException(status_code=403, detail="Workspace admins only")
    role = await user_store.tenant_role(session, tenant_id, user.id)
    await session.commit()
    if role not in TENANT_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Workspace admins only")
    return user


async def require_operator(
    user: Annotated[User, Depends(get_current_user)],
    operators: Annotated[OperatorList, Depends(get_operator_list)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
) -> User:
    # Recorded before answering, so the log never trails a grant in use. A
    # failure here is a 500: no operator acts while the log can't be written.
    snapshot = await record_list_changes(operators, session_factory)
    if user.id not in snapshot.ids:
        raise HTTPException(status_code=403, detail="Switch operators only")
    return user

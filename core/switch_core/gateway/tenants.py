from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    get_authenticated_user_id,
    is_tenant_member,
    list_tenant_memberships,
    set_session_cookie,
)
from switch_core.gateway.auth_routes import _session_response
from switch_core.gateway.dependencies import (
    get_config,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.schemas import SessionUserResponse, TenantMembershipResponse

router = APIRouter()


@router.get("/tenants")
async def list_tenants(
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[TenantMembershipResponse]:
    """The caller's own tenants: id, slug, name, and their role in each.

    Authenticated with `get_authenticated_user_id`, not `get_current_user`:
    the caller may belong to several tenants and have none selected on their
    session, which is exactly the state `get_current_user` cannot resolve
    without this list existing first (`docs/old/multi-tenancy-phase2-tenants.md`,
    §7). This route never holds a bound request session open while it reads
    the others — see `list_tenant_memberships`.
    """
    return await list_tenant_memberships(session_factory, user_store, user_id)


@router.post("/tenants/{tenant_id}/switch")
async def switch_tenant(
    tenant_id: str,
    response: Response,
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionUserResponse:
    """Select `tenant_id` for this session: verify membership, then re-mint
    the cookie carrying it as the tenant claim.

    The membership check is what keeps the claim from being a way in on its
    own: `_resolve_tenant_id` re-reads `tenant_members` on every request
    regardless of what the cookie says, so a forged or stale claim already
    buys nothing — but this route is the one place a *caller* picks the
    value that goes into it, and it must not let them pick a tenant they do
    not belong to.
    """
    if not await is_tenant_member(session_factory, user_id, tenant_id):
        raise HTTPException(status_code=403, detail="Not a member of this tenant")

    user = await user_store.get(session, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    set_session_cookie(
        response, user, config.jwt_secret_key, config.gateway_cookie_secure, tenant_id
    )
    return _session_response(user)

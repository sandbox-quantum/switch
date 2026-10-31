"""Creating organizations and the workspaces in them.

Two routes create: `POST /organizations` makes an organization and its first
workspace for anyone signed in, and `POST /organizations/current/workspaces`
adds a workspace to an organization its `org_admin` is in. `POST /tenants` is
the first of those under its old name, kept for one release. What they share
is here: the per-person allowance, slugs, and the provisioning itself.
"""

from __future__ import annotations

import logging
import re
import secrets
import uuid

from fastapi import HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.clients.client_lifecycle_service import (
    ClientLifecycleService,
    TenantIsolationNotInForce,
)
from switch_core.config import SwitchConfig
from switch_core.db.audit import (
    AuditAction,
    OrganizationAuditAction,
    record_audit_event,
    record_organization_audit_event,
)
from switch_core.db.models import Organization, Tenant, User
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_store import (
    OrganizationSlugTaken,
    OrganizationStore,
)
from switch_core.db.stores.tenant_store import TenantSlugTaken
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    set_session_cookie,
    workspace_creation_refusal,
)
from switch_core.gateway.schemas import (
    OrganizationCreateResponse,
    OrganizationSummary,
    TenantMembershipResponse,
)

logger = logging.getLogger(__name__)

_SLUG_INVALID_CHARS = re.compile(r"[^a-z0-9]+")

# A first choice and this many suffixed ones. Four hex characters make a
# repeat collision on the same name vanishingly unlikely, so running out means
# something other than bad luck is wrong.
_SLUG_ATTEMPTS = 4

_LOCK_NOT_AVAILABLE = "55P03"


def _derive_slug(name: str) -> str:
    """A URL-safe slug from an organization's or workspace's name.

    The slug is an identifier, not the name: the row keeps the name its
    creator typed exactly, and a slug that is already taken gets a short
    random suffix (`_slugs` below). Refusing instead would tell anyone who can
    sign up which names exist on this server.
    """
    slug = _SLUG_INVALID_CHARS.sub("-", name.strip().lower()).strip("-")
    if not slug:
        raise HTTPException(
            status_code=400,
            detail="Name must contain at least one letter or digit",
        )
    return slug


def _slugs(name: str) -> list[str]:
    base = _derive_slug(name)
    return [base] + [
        f"{base}-{secrets.token_hex(2)}" for _ in range(_SLUG_ATTEMPTS - 1)
    ]


def _no_free_slug(kind: str, name: str) -> HTTPException:
    logger.error(
        "Could not find a free slug for %s %r after %d attempts",
        kind,
        name,
        _SLUG_ATTEMPTS,
    )
    return HTTPException(
        status_code=503, detail=f"Could not create the {kind}; please try again"
    )


async def lock_workspace_allowance(
    session: AsyncSession,
    user_id: str,
    config: SwitchConfig,
    *,
    new_organization: bool,
) -> User:
    """Lock the caller's row and raise 403 unless they may create one more
    workspace. Returns the locked row, for the caller to count the creation on.

    Creating a workspace is not just a row: `all_tenant_ids()` drives a fan-out
    per tenant at boot and a sweep every few seconds, so unbounded creation
    buys the deployment steady-state work
    (`docs/old/multi-tenancy-phase2-tenants.md`, §5). A limit of 0 closes
    creation entirely, which is how a deployment that is not ready to offer
    self-service says so; `invite_only` sign-up closes creating organizations.
    What is refused, and why, is `workspace_creation_refusal`'s, so
    `GET /auth/session` reports the same answer this enforces.

    The bound is on workspaces created (`users.workspaces_created`), not on
    workspaces owned: ownership can be handed to another account, so a count of
    ownership could be reset by creating, handing over and stepping down, over
    and over. An invitation into someone else's workspace spends nothing.

    The row lock is what makes the check hold under concurrent requests. It
    is taken `NOWAIT`, so a second request from the same person is refused
    with 409 at once rather than holding a pool connection while it waits —
    the request holding the lock needs more connections to provision, and a
    burst of waiters could starve it of them. `FOR NO KEY UPDATE` rather than
    `FOR UPDATE`, because the new owner membership's foreign key takes a key
    share on this same row from another session, and `FOR UPDATE` would make
    the request wait on itself.
    """
    try:
        user = await session.scalar(
            select(User)
            .where(User.id == user_id)
            .with_for_update(key_share=True, nowait=True)
            # The row may already be loaded on this session, read before the
            # lock was taken.
            .execution_options(populate_existing=True)
        )
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) != _LOCK_NOT_AVAILABLE:
            raise
        raise HTTPException(
            status_code=409,
            detail="Another workspace is being created for you; try again shortly",
        ) from exc
    if user is None:
        raise HTTPException(status_code=401, detail="Unknown user")
    refusal = workspace_creation_refusal(
        config,
        is_operator=False,
        workspaces_created=user.workspaces_created,
        new_organization=new_organization,
    )
    if refusal is not None:
        raise HTTPException(status_code=403, detail=refusal)
    return user


async def create_organization_for(
    response: Response,
    caller: AuthenticatedCaller,
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    organization_store: OrganizationStore,
    client_lifecycle: ClientLifecycleService,
    config: SwitchConfig,
    *,
    name: str,
    workspace_name: str,
) -> OrganizationCreateResponse:
    """Create an organization and its first workspace for `caller`, count it
    against their allowance, and switch their session into the workspace.

    `session` is unbound: it reads and locks the caller's `users` row, which
    carries no tenant, for the length of a creation that has no tenant yet.
    The platform operator is exempt from the allowance, both because the
    bypass is what `is_operator` means everywhere else (`authz.py`) and
    because the person provisioning for other people is the one caller a
    self-service bound must not stop; nothing is counted for them.
    """
    allowance: User | None = None
    if caller.is_operator:
        operator = await user_store.get(session, caller.id)
        if operator is None:
            raise HTTPException(status_code=401, detail="User not found")
        user = operator
        # Not held across provisioning, which opens a session per tenant.
        await session.commit()
    else:
        user = allowance = await lock_workspace_allowance(
            session, caller.id, config, new_organization=True
        )
    organization, tenant = await create_organization(
        session_factory,
        user_store,
        organization_store,
        client_lifecycle,
        caller.id,
        name,
        workspace_name,
    )
    if allowance is not None:
        allowance.workspaces_created += 1
        await session.commit()

    await user_store.record_last_tenant(session, user, tenant.id)
    await session.commit()
    set_session_cookie(
        response, user, config.keyring, config.gateway_cookie_secure, tenant.id
    )
    return OrganizationCreateResponse(
        organization=OrganizationSummary(
            id=organization.id,
            slug=organization.slug,
            name=organization.name,
            role=ORGANIZATION_ADMIN_ROLE,
        ),
        workspace=TenantMembershipResponse(
            id=tenant.id,
            slug=tenant.slug,
            name=tenant.name,
            role="owner",
            organization_role=ORGANIZATION_ADMIN_ROLE,
            organization_id=organization.id,
        ),
    )


async def create_organization(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    organization_store: OrganizationStore,
    client_lifecycle: ClientLifecycleService,
    creator_id: str,
    name: str,
    workspace_name: str,
) -> tuple[Organization, Tenant]:
    """Create an organization named `name` and its first workspace, named
    `workspace_name`. `creator_id` becomes the organization's `org_admin` and
    the workspace's `owner`, a member there in their own right.

    The organization is committed first, because the workspace references it.
    If the workspace then cannot be created, for any reason, the organization
    is deleted again, so a failed creation leaves nothing behind.
    """
    # Both names are checked before anything is written.
    workspace_slugs = _slugs(workspace_name)
    organization: Organization | None = None
    for slug in _slugs(name):
        candidate = Organization(id=str(uuid.uuid4()), name=name, slug=slug)
        try:
            async with organization_session(session_factory, candidate.id) as session:
                await organization_store.create(session, candidate)
                await session.commit()
        except OrganizationSlugTaken:
            continue
        organization = candidate
        break
    if organization is None:
        raise _no_free_slug("organization", name)

    try:
        tenant = await _create_tenant(
            client_lifecycle, organization.id, workspace_name, workspace_slugs
        )
    except BaseException:
        # A failure after the workspace committed leaves it referencing the
        # organization, and the discard is refused; the workspace's own
        # failure is the one to report.
        try:
            await _discard_organization(
                session_factory, organization_store, organization.id
            )
        except Exception:
            logger.exception(
                "Could not discard organization %s after creating its first "
                "workspace %r failed",
                organization.id,
                workspace_name,
            )
        raise

    await _add_creator(
        session_factory,
        user_store,
        tenant,
        creator_id,
        organization_role=ORGANIZATION_ADMIN_ROLE,
        new_organization=organization,
    )
    return organization, tenant


async def create_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    client_lifecycle: ClientLifecycleService,
    organization_id: str,
    creator_id: str,
    name: str,
) -> Tenant:
    """Create a workspace named `name` in `organization_id`, with `creator_id`,
    its `org_admin`, as its `owner`.

    The creator administers it through the organization already; the
    membership row makes them a member there in their own right, as creating
    an organization does for its first workspace, so it stays theirs if they
    stop being `org_admin`.
    """
    tenant = await _create_tenant(client_lifecycle, organization_id, name, _slugs(name))
    await _add_creator(
        session_factory,
        user_store,
        tenant,
        creator_id,
        # Already the organization's `org_admin`, a row joining leaves as it is.
        organization_role="member",
        new_organization=None,
    )
    return tenant


async def _create_tenant(
    client_lifecycle: ClientLifecycleService,
    organization_id: str,
    name: str,
    slugs: list[str],
) -> Tenant:
    for slug in slugs:
        try:
            return await client_lifecycle.create_tenant(name, slug, organization_id)
        except TenantSlugTaken:
            continue
        except TenantIsolationNotInForce as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    raise _no_free_slug("workspace", name)


async def _add_creator(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    tenant: Tenant,
    creator_id: str,
    *,
    organization_role: str,
    new_organization: Organization | None,
) -> None:
    """Make `creator_id` the new workspace's `owner` and record its creation:
    in the workspace's audit log, and in its organization's, with the
    organization's own creation first when `new_organization` was made for it.

    A transaction of its own, after the workspace's: the tenant row has to be
    committed before `ensure_system_client` can provision against it, and that
    happens inside `ClientLifecycleService.create_tenant`. The gap is real — a
    failure here leaves a workspace nobody belongs to — so it is logged with
    what an operator needs to repair it.
    """
    try:
        async with tenant_session(session_factory, tenant.id) as session:
            await user_store.add_membership(
                session,
                tenant_id=tenant.id,
                user_id=creator_id,
                role="owner",
                organization_role=organization_role,
            )
            await record_audit_event(
                session,
                tenant_id=tenant.id,
                actor_user_id=creator_id,
                action=AuditAction.TENANT_CREATED,
                target_type="tenant",
                target_id=tenant.id,
                details={
                    "name": tenant.name,
                    "slug": tenant.slug,
                    "organization_id": tenant.organization_id,
                },
            )
            assert tenant.organization_id is not None
            if new_organization is not None:
                await record_organization_audit_event(
                    session,
                    organization_id=tenant.organization_id,
                    actor_user_id=creator_id,
                    action=OrganizationAuditAction.ORGANIZATION_CREATED,
                    target_type="organization",
                    target_id=new_organization.id,
                    details={
                        "name": new_organization.name,
                        "slug": new_organization.slug,
                    },
                )
            await record_organization_audit_event(
                session,
                organization_id=tenant.organization_id,
                actor_user_id=creator_id,
                action=OrganizationAuditAction.WORKSPACE_CREATED,
                target_type="workspace",
                target_id=tenant.id,
                details={"name": tenant.name, "slug": tenant.slug},
            )
            await session.commit()
    except Exception:
        logger.error(
            "Workspace %s (slug %s) was created but its owner membership for "
            "user %s was not written: it now has no members and its slug is "
            "taken. Insert the membership to repair it.",
            tenant.id,
            tenant.slug,
            creator_id,
        )
        raise


async def _discard_organization(
    session_factory: async_sessionmaker[AsyncSession],
    organization_store: OrganizationStore,
    organization_id: str,
) -> None:
    """Delete the organization made for a workspace that could not be created."""
    async with organization_session(session_factory, organization_id) as session:
        await organization_store.delete_empty(session, organization_id)
        await session.commit()

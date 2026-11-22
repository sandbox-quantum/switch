"""An organization's Switch Trust policy: which one checks every message in
its workspaces, connecting one and disconnecting it. Its `org_admin`s only.

A policy is connected only once Switch Trust has answered a check made with
it (`trust/connection_check.py`), so a policy id or key it refuses is refused
here, not discovered at the first message. Each change reaches every process
before its next check in the organization (`trust/signals.py`) and is
recorded in the organization's audit log; the key is never returned or
recorded.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import OrganizationTrustSettings, User
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_organization_store,
    get_session,
    get_trust_connection_check,
    get_user_store,
    trust_settings_changed,
)
from switch_core.gateway.organizations import made_from, require_organization_admin
from switch_core.gateway.schemas import (
    OrganizationGuardrailsConnectRequest,
    OrganizationGuardrailsResponse,
)
from switch_core.keys import UndecryptableError
from switch_core.trust.client import GuardrailsCheckError, GuardrailsRefusedError
from switch_core.trust.connection_check import TrustConnectionCheck
from switch_core.trust.workspace_policy import DEFAULT_TRUST_ENDPOINT, policy_url

router = APIRouter()

logger = logging.getLogger(__name__)

_NOT_CONNECTED = OrganizationGuardrailsResponse(
    connected=False,
    policy_id=None,
    policy_name=None,
    policy_url=None,
    api_key_last4=None,
    connected_by_name=None,
    connected_at=None,
)


async def _response(
    session: AsyncSession,
    user_store: UserStore,
    settings: OrganizationTrustSettings | None,
    config: SwitchConfig,
) -> OrganizationGuardrailsResponse:
    if settings is None:
        return _NOT_CONNECTED
    try:
        api_key_last4: str | None = config.keyring.decrypt(settings.api_key_encrypted)[
            -4:
        ]
    except UndecryptableError:
        # Encrypted under a key since dropped from SECRET_KEYS: every check
        # then fails open, annotated. Shown as connected with no key ending,
        # so an admin can still open the page and connect it again.
        logger.warning(
            "The Switch Trust API key organization %s connected can't be "
            "decrypted under any current key",
            settings.organization_id,
        )
        api_key_last4 = None
    names = (
        await user_store.names_by_id(session, {settings.updated_by})
        if settings.updated_by
        else {}
    )
    return OrganizationGuardrailsResponse(
        connected=True,
        policy_id=settings.policy_id,
        policy_name=settings.policy_name,
        policy_url=policy_url(settings.endpoint, settings.policy_id),
        api_key_last4=api_key_last4,
        connected_by_name=(
            names.get(settings.updated_by) if settings.updated_by else None
        ),
        connected_at=settings.updated_at.isoformat(),
    )


def _not_connected_because(error: GuardrailsCheckError) -> HTTPException:
    """Why Switch Trust's answer to the connection check kept the policy from
    being connected, in words for the admin who entered it."""
    if isinstance(error, GuardrailsRefusedError) and error.status_code < 500:
        return HTTPException(
            status_code=400,
            detail=(
                f"Switch Trust refused this policy ID and API key (HTTP "
                f"{error.status_code}). Check both on Switch Trust and try again."
            ),
        )
    if isinstance(error, GuardrailsRefusedError):
        return HTTPException(
            status_code=502,
            detail=(
                f"Switch Trust answered with an error (HTTP {error.status_code}), "
                "so the policy wasn't connected. Try again shortly."
            ),
        )
    return HTTPException(
        status_code=502,
        detail=f"Couldn't reach Switch Trust, so the policy wasn't connected: {error}",
    )


@router.get("/organizations/current/guardrails")
async def get_organization_guardrails(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationGuardrailsResponse:
    """The policy the organization connected, if any."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    settings = await OrganizationTrustSettingsStore().get(
        session, access.organization_id
    )
    return await _response(session, user_store, settings, config)


@router.put("/organizations/current/guardrails")
async def connect_organization_guardrails(
    req: OrganizationGuardrailsConnectRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    connection_check: Annotated[
        TrustConnectionCheck, Depends(get_trust_connection_check)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationGuardrailsResponse:
    """Connect a policy, in place of any the organization had, once Switch
    Trust has answered a check made with it.

    Checked at Switch Trust's own address, or, replacing a policy copied from
    the server's former setting, at the address that setting named."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    store = OrganizationTrustSettingsStore()
    current = await store.get(session, access.organization_id)
    endpoint = current.endpoint if current is not None else DEFAULT_TRUST_ENDPOINT
    # Read now: saving loads the new row into this same object.
    previous_policy_id = current.policy_id if current is not None else None
    # Let go of the request's connection while Switch Trust is asked.
    await session.commit()
    try:
        answer = await connection_check(
            endpoint=endpoint, policy_id=req.policy_id, api_key=req.api_key
        )
    except GuardrailsCheckError as error:
        logger.info(
            "Organization %s's Switch Trust policy was not connected: %s",
            access.organization_id,
            error,
        )
        raise _not_connected_because(error) from None
    settings = await store.save(
        session,
        organization_id=access.organization_id,
        endpoint=endpoint,
        policy_id=req.policy_id,
        policy_name=answer.policy_name,
        api_key_encrypted=config.keyring.encrypt(req.api_key),
        updated_by=user.id,
    )
    await record_organization_audit_event(
        session,
        organization_id=access.organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.GUARDRAILS_CONNECTED,
        target_type="guardrails",
        target_id=req.policy_id,
        details={
            "policy_id": req.policy_id,
            "policy_name": answer.policy_name,
            **(
                {"previous_policy_id": previous_policy_id}
                if previous_policy_id not in (None, req.policy_id)
                else {}
            ),
            **made_from(access),
        },
    )
    await session.commit()
    trust_settings_changed(access.organization_id)
    return await _response(session, user_store, settings, config)


@router.delete("/organizations/current/guardrails")
async def disconnect_organization_guardrails(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationGuardrailsResponse:
    """Disconnect the organization's policy: no message in its workspaces is
    checked from the next one on. Disconnecting none changes and records
    nothing."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    store = OrganizationTrustSettingsStore()
    current = await store.get(session, access.organization_id, for_update=True)
    if current is None:
        return _NOT_CONNECTED
    await store.clear(session, access.organization_id)
    await record_organization_audit_event(
        session,
        organization_id=access.organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.GUARDRAILS_DISCONNECTED,
        target_type="guardrails",
        target_id=current.policy_id,
        details={
            "policy_id": current.policy_id,
            "policy_name": current.policy_name,
            **made_from(access),
        },
    )
    await session.commit()
    trust_settings_changed(access.organization_id)
    return _NOT_CONNECTED

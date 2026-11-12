"""A workspace's decision backend for auto-route — that workspace's admins only.

Tenant-scoped, unlike Switch Trust's settings (`gateway/trust_settings.py`):
every route is gated by `require_tenant_admin` and reads or writes the row of
the workspace the request is bound to, never another's. No row means the
server default (`decision/settings.py`). The key is never returned; a key the
server can no longer decrypt still loads, as set but unreadable, so an admin
can save a replacement.
"""

from __future__ import annotations

import logging
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import DecisionSettings, User, require_tenant_id
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.settings import (
    DecisionAvailability,
    availability,
    resolve,
)
from switch_core.gateway.auth import require_tenant_admin
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.schemas import (
    DecisionEffective,
    DecisionOptions,
    DecisionServerDefault,
    DecisionSettingsResponse,
    DecisionSettingsTestRequest,
    DecisionSettingsUpdateRequest,
    DecisionTestError,
    DecisionTestResponse,
    DecisionWorkspaceSettings,
    TestErrorCode,
)
from switch_core.keys import Keyring, UndecryptableError
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

router = APIRouter()

logger = logging.getLogger(__name__)

_STORE = DecisionSettingsStore()


def get_decision_client(request: Request) -> DynamicDecisionClient:
    """The process's decision client (`decision/setup.py`)."""
    client: DynamicDecisionClient = request.app.state.decision_client
    return client


def _response(
    row: DecisionSettings | None, checks: DecisionAvailability, keyring: Keyring
) -> DecisionSettingsResponse:
    server = checks.server
    resolved = resolve(row, server)
    applies = availability(checks.enabled, resolved)
    workspace: DecisionWorkspaceSettings | None = None
    if row is not None:
        last4: str | None = None
        unreadable = False
        if row.api_key_encrypted is not None:
            try:
                last4 = keyring.decrypt(row.api_key_encrypted)[-4:]
            except UndecryptableError:
                unreadable = True
                logger.warning(
                    "Workspace %s's decision key is not decryptable under any "
                    "current key; reporting it as set but unreadable.",
                    row.tenant_id,
                )
        workspace = DecisionWorkspaceSettings(
            backend=row.backend,  # type: ignore[arg-type]
            endpoint=row.endpoint,
            threshold=row.threshold,
            has_api_key=row.api_key_encrypted is not None,
            api_key_last4=last4,
            api_key_unreadable=unreadable,
            updated_at=row.updated_at.isoformat(),
        )
    return DecisionSettingsResponse(
        source=resolved.source,
        effective=DecisionEffective(
            backend=resolved.backend,
            endpoint=resolved.endpoint,
            threshold=resolved.threshold,
            available=applies.available,
            reason=applies.reason,
        ),
        workspace=workspace,
        server_default=DecisionServerDefault(
            configured=server.configured,
            endpoint=server.endpoint_url,
            has_api_key=server.api_key is not None,
        ),
        options=DecisionOptions(
            haiku_anthropic=server.haiku_anthropic,
            haiku_bedrock=server.haiku_bedrock,
        ),
    )


def _refuse_unoffered(
    req: DecisionSettingsUpdateRequest, checks: DecisionAvailability
) -> None:
    server = checks.server
    if req.backend == "haiku_anthropic" and not server.haiku_anthropic:
        raise HTTPException(
            status_code=422,
            detail="Haiku runs in Switch's decision service, and none is set up here.",
        )
    if req.backend == "haiku_bedrock" and not server.haiku_bedrock:
        raise HTTPException(
            status_code=422,
            detail="Haiku on Bedrock isn't offered here: it needs Switch's "
            "decision service and DECISION_BEDROCK_ENABLED.",
        )


async def _refuse_unreachable(endpoint: str, policy: OutboundPolicy) -> None:
    """Refuse an endpoint the server would never connect to on the
    workspace's behalf: link-local and metadata addresses always, and private
    ones unless the operator lists them."""
    try:
        await policy.check_url(endpoint)
    except OutboundURLRefused as refused:
        raise HTTPException(
            status_code=422,
            detail=f"{refused} A workspace's decision endpoint must be a public "
            "address, or a private host whoever runs Switch lists in "
            "OUTBOUND_ALLOWED_PRIVATE_HOSTS.",
        ) from refused


_ENDPOINT_MOVED = (
    "The endpoint changed, so the stored key isn't sent to it. Enter the new "
    "endpoint's key, or remove the stored key to call it without one."
)


def _same_target(
    req: DecisionSettingsUpdateRequest | DecisionSettingsTestRequest,
    existing: DecisionSettings,
) -> bool:
    """Whether a request names the backend, and for an endpoint the URL, the
    stored key was saved for."""
    if existing.backend != req.backend:
        return False
    return req.backend != "endpoint" or existing.endpoint == req.endpoint


def _kept_key(
    req: DecisionSettingsUpdateRequest | DecisionSettingsTestRequest,
    existing: DecisionSettings | None,
) -> str | None:
    """The stored key a request leaves in place: only for the same backend and
    endpoint, so an endpoint's token is never sent to Anthropic as a key, nor
    to a URL other than the one it was saved for."""
    if req.clear_api_key or existing is None or not _same_target(req, existing):
        return None
    return existing.api_key_encrypted


def _endpoint_moved(
    req: DecisionSettingsUpdateRequest | DecisionSettingsTestRequest,
    existing: DecisionSettings | None,
) -> bool:
    """Whether a request moves the saved endpoint to another URL without saying
    what becomes of its key: neither a new key nor `clear_api_key`. Taken
    silently as "no key", it would look as if the key had been kept."""
    return (
        req.backend == "endpoint"
        and req.api_key is None
        and not req.clear_api_key
        and existing is not None
        and existing.backend == "endpoint"
        and existing.api_key_encrypted is not None
        and existing.endpoint != req.endpoint
    )


@router.get("/decision-settings")
async def get_decision_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionSettingsResponse:
    row = await _STORE.get(session, require_tenant_id())
    return _response(row, client.availability, config.keyring)


@router.put("/decision-settings")
async def update_decision_settings(
    req: DecisionSettingsUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionSettingsResponse:
    _refuse_unoffered(req, client.availability)
    if req.backend == "endpoint":
        assert req.endpoint is not None
        await _refuse_unreachable(req.endpoint, client.outbound_policy)
    tenant_id = require_tenant_id()
    existing = await _STORE.get_for_update(session, tenant_id)
    if _endpoint_moved(req, existing):
        raise HTTPException(status_code=422, detail=_ENDPOINT_MOVED)
    api_key_encrypted = (
        config.keyring.encrypt(req.api_key)
        if req.api_key is not None
        else _kept_key(req, existing)
    )
    if req.backend in ("none", "haiku_bedrock"):
        api_key_encrypted = None
    if req.backend == "haiku_anthropic" and api_key_encrypted is None:
        raise HTTPException(
            status_code=422, detail="Haiku on the Anthropic API needs an Anthropic key."
        )
    saved = await _STORE.save(
        session,
        tenant_id,
        backend=req.backend,
        endpoint=req.endpoint if req.backend == "endpoint" else None,
        api_key_encrypted=api_key_encrypted,
        threshold=req.threshold,
    )
    await session.commit()
    client.forget(tenant_id)
    return _response(saved, client.availability, config.keyring)


@router.delete("/decision-settings", status_code=204)
async def delete_decision_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
) -> Response:
    tenant_id = require_tenant_id()
    await _STORE.clear(session, tenant_id)
    await session.commit()
    client.forget(tenant_id)
    return Response(status_code=204)


@router.post("/decision-settings/test")
async def test_decision_settings(
    req: DecisionSettingsTestRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionTestResponse:
    """Run the sample decision against the values entered, saved or not; an
    omitted key means the stored one. `backend: "default"` tests the server
    default, with the server's own endpoint and key and never the
    workspace's. The stored key is used only for the backend and endpoint it
    was saved for. Nothing is saved, and no room's data is sent."""
    existing = await _STORE.get(session, require_tenant_id())
    # Not held across the call to the decision service.
    await session.commit()
    if _endpoint_moved(req, existing):
        return DecisionTestResponse(
            ok=False,
            agent=None,
            model_choice=None,
            confidence=None,
            latency_ms=None,
            backend=req.backend,
            error=DecisionTestError(code="not_configured", message=_ENDPOINT_MOVED),
        )
    api_key = req.api_key
    if api_key is None and req.backend != "default":
        stored = _kept_key(req, existing)
        if stored is not None:
            try:
                api_key = config.keyring.decrypt(stored)
            except UndecryptableError:
                return DecisionTestResponse(
                    ok=False,
                    agent=None,
                    model_choice=None,
                    confidence=None,
                    latency_ms=None,
                    backend=req.backend,
                    error=DecisionTestError(
                        code="not_configured",
                        message="The stored key can't be decrypted here; "
                        "enter it again.",
                    ),
                )
    outcome = await client.test(
        backend=req.backend,
        endpoint=req.endpoint if req.backend == "endpoint" else None,
        api_key=api_key if req.backend in ("endpoint", "haiku_anthropic") else None,
        threshold=req.threshold,
    )
    return DecisionTestResponse(
        ok=outcome.ok,
        agent=outcome.agent,
        model_choice=outcome.model_choice,
        confidence=outcome.confidence,
        latency_ms=outcome.latency_ms,
        backend=outcome.backend,
        error=(
            DecisionTestError(
                code=cast("TestErrorCode", outcome.error_code),
                message=outcome.error_message or "",
            )
            if outcome.error_code is not None
            else None
        ),
    )

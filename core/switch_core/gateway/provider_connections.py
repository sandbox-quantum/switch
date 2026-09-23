import json
from datetime import UTC, datetime
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import case, delete, func, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    HostedLaunch,
    ProviderConnection,
    ProviderVerification,
    User,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import (
    ProviderConnectionBusy,
    ProviderConnectionStore,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.providers.claude_verifier import (
    ClaudeVerificationError,
    ClaudeVerifier,
)
from switch_core.providers.credentials import validate_provider_credential
from switch_core.providers.verification import ACTIVE, latest, queue, summary

OtherProvider = Literal["codex", "cursor", "opencode", "antigravity"]

router = APIRouter()


def get_connection_store() -> ProviderConnectionStore:
    return ProviderConnectionStore()


def get_verifier(request: Request) -> ClaudeVerifier:
    verifier = request.app.state.claude_verifier
    if verifier is None:
        raise HTTPException(503, "Claude connections are not enabled on this server.")
    return cast(ClaudeVerifier, verifier)


@router.get("/claude")
async def get_connection(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    store: Annotated[ProviderConnectionStore, Depends(get_connection_store)],
    _verifier: Annotated[ClaudeVerifier, Depends(get_verifier)],
) -> dict:
    connection = await store.get(session, user.id)
    if connection is None:
        return {"status": "not_connected"}
    return {
        "status": "connected",
        "kind": connection.kind,
        "verified_at": str(connection.verified_at),
    }


@router.put("/claude")
async def connect_claude(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    store: Annotated[ProviderConnectionStore, Depends(get_connection_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    verifier: Annotated[ClaudeVerifier, Depends(get_verifier)],
) -> dict:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20 * 1024:
            raise HTTPException(413, "The credential is too long.")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "Provide a credential and its type.") from None
    if not isinstance(payload, dict) or set(payload) != {"kind", "credential"}:
        raise HTTPException(400, "Provide a credential and its type.")
    kind = payload["kind"]
    credential = payload["credential"]
    if kind not in ("api-key", "setup-token") or not isinstance(credential, str):
        raise HTTPException(400, "Choose an API key or subscription setup token.")
    credential = credential.strip()
    prefix = "sk-ant-api" if kind == "api-key" else "sk-ant-oat"
    if (
        not credential.startswith(prefix)
        or len(credential) > 16 * 1024
        or any(not 33 <= ord(c) <= 126 for c in credential)
    ):
        raise HTTPException(
            400, "The credential format does not match the selected type."
        )
    try:
        await store.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    try:
        await verifier.verify(kind, credential)
    except ClaudeVerificationError as error:
        raise HTTPException(422, str(error)) from None
    now = datetime.now(UTC)
    await store.save(
        session, user.id, kind, encrypt_token(credential, config.jwt_secret_key), now
    )
    await session.commit()
    return {"status": "connected", "kind": kind, "verified_at": str(now)}


async def mark_disconnected_workers(
    session: AsyncSession, user_id: str, provider: str
) -> None:
    await session.execute(
        update(HostedLaunch)
        .where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.owner_id == user_id,
            HostedLaunch.desired_state == "running",
            func.coalesce(HostedLaunch.spec["provider"].astext, "claude") == provider,
        )
        .values(
            state="error",
            error="The provider was disconnected. Reconnect it, then retry this worker.",
            revision=HostedLaunch.revision + 1,
            updated_at=datetime.now(UTC),
        )
    )


@router.delete("/claude", status_code=204)
async def disconnect_claude(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    store: Annotated[ProviderConnectionStore, Depends(get_connection_store)],
) -> Response:
    try:
        await store.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    await store.delete(session, user.id)
    await mark_disconnected_workers(session, user.id, "claude")
    await session.commit()
    return Response(status_code=204)


@router.get("/{provider}")
async def get_other_connection(
    provider: OtherProvider,
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    if config.hosted_provider_verification_enabled:
        job = await latest(session, user.id, provider)
        if job and job.state not in ("cancelled", "succeeded"):
            return summary(job)
    row = await session.get(
        ProviderConnection,
        (require_tenant_id(), user.id, provider),
    )
    if row is None:
        return {"status": "not_connected"}
    return {
        "status": "connected"
        if row.verification_status == "verified"
        else "configured",
        "kind": row.kind,
        "verified_at": str(row.verified_at),
    }


@router.put("/{provider}")
async def connect_other_provider(
    provider: OtherProvider,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20 * 1024:
            raise HTTPException(413, "The credential is too long.")
    try:
        payload = json.loads(body)
        if (
            not isinstance(payload, dict)
            or set(payload) != {"kind", "credential"}
            or not isinstance(payload["kind"], str)
            or not isinstance(payload["credential"], str)
        ):
            raise ValueError("Provide a credential and its type.")
        credential = validate_provider_credential(
            provider, payload["kind"], payload["credential"]
        )
    except (ValueError, UnicodeError):
        raise HTTPException(
            400, "Provide a valid credential and supported type."
        ) from None
    store = ProviderConnectionStore()
    try:
        await store.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    if config.hosted_provider_verification_enabled:
        return await queue(
            session,
            user.id,
            provider,
            payload["kind"],
            credential,
            config.jwt_secret_key,
        )
    now = datetime.now(UTC)
    values = {
        "tenant_id": require_tenant_id(),
        "user_id": user.id,
        "provider": provider,
        "kind": payload["kind"],
        "encrypted_credential": encrypt_token(credential, config.jwt_secret_key),
        "verified_at": now,
        "verification_status": "configured",
    }
    await session.execute(
        insert(ProviderConnection)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["tenant_id", "user_id", "provider"],
            set_={
                key: value
                for key, value in values.items()
                if key not in {"tenant_id", "user_id", "provider"}
            },
        )
    )
    await session.commit()
    return {"status": "configured", "kind": payload["kind"], "verified_at": str(now)}


@router.delete("/{provider}", status_code=204)
async def disconnect_other_provider(
    provider: OtherProvider,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    try:
        await ProviderConnectionStore().lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    await session.execute(
        delete(ProviderConnection).where(
            ProviderConnection.tenant_id == require_tenant_id(),
            ProviderConnection.user_id == user.id,
            ProviderConnection.provider == provider,
        )
    )
    await session.execute(
        update(ProviderVerification)
        .where(
            ProviderVerification.tenant_id == require_tenant_id(),
            ProviderVerification.user_id == user.id,
            ProviderVerification.provider == provider,
        )
        .values(
            state="cancelled",
            encrypted_credential=None,
            encrypted_token=None,
            instance_id=case(
                (
                    ProviderVerification.state.in_(ACTIVE),
                    ProviderVerification.instance_id,
                ),
                else_=None,
            ),
        )
    )
    await mark_disconnected_workers(session, user.id, provider)
    await session.commit()
    return Response(status_code=204)

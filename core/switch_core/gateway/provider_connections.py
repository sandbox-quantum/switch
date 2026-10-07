import json
from datetime import UTC, datetime
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    ProviderConnection,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.db.stores.provider_connection_store import (
    ProviderConnectionBusy,
    ProviderConnectionStore,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import cloud_controllers
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.providers.claude_verifier import (
    ClaudeVerificationError,
    ClaudeVerifier,
)
from switch_core.providers.credentials import validate_provider_credential
from switch_core.providers.sealing import (
    SealedChange,
    reconnect_required,
    revoke_logins,
    seal_login,
)

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
        "status": "reconnect_required"
        if await reconnect_required(session, connection)
        else "connected",
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
    except (ValueError, UnicodeError, RecursionError):
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
    sealed = await seal_login(
        session,
        config,
        owner_id=user.id,
        provider="claude",
        kind=kind,
        credential=credential,
        now=now,
    )
    await store.save(
        session,
        user.id,
        kind,
        None if sealed else config.keyring.encrypt(credential),
        now,
    )
    await bump_machine_agents(session, user.id)
    await session.commit()
    ring_credential_change(sealed)
    return {"status": "connected", "kind": kind, "verified_at": str(now)}


def ring_credential_change(sealed: list[SealedChange]) -> None:
    """Tell each controller in `sealed` to fetch its envelope again.

    A doorbell only: the frame carries the revision, never the secret.
    """
    for change in sealed:
        cloud_controllers().provider_credential_changed(
            change.controller_id, change.provider, change.revision
        )


async def bump_machine_agents(session: AsyncSession, user_id: str) -> None:
    """Make the owner's machine re-read its agent list, which carries the credential kind."""
    machines = HostedMachineStore()
    live = await machines.live_for_owner(session, user_id)
    if live is None:
        return
    machine = await machines.locked(session, live.id)
    if machine is not None:
        machines.bump_agents(machine)


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
    revoked = await revoke_logins(session, user.id, "claude", datetime.now(UTC))
    await bump_machine_agents(session, user.id)
    await session.commit()
    ring_credential_change(revoked)
    return Response(status_code=204)


@router.get("/{provider}")
async def get_other_connection(
    provider: OtherProvider,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    row = await session.get(
        ProviderConnection,
        (require_tenant_id(), user.id, provider),
    )
    if row is None:
        return {"status": "not_connected"}
    if await reconnect_required(session, row):
        status = "reconnect_required"
    elif row.verification_status == "verified":
        status = "connected"
    else:
        status = "configured"
    return {
        "status": status,
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
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(
            400, "Provide a valid credential and supported type."
        ) from None
    store = ProviderConnectionStore()
    try:
        await store.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    now = datetime.now(UTC)
    sealed = await seal_login(
        session,
        config,
        owner_id=user.id,
        provider=provider,
        kind=payload["kind"],
        credential=credential,
        now=now,
    )
    values = {
        "tenant_id": require_tenant_id(),
        "user_id": user.id,
        "provider": provider,
        "kind": payload["kind"],
        "encrypted_credential": None if sealed else config.keyring.encrypt(credential),
        "verified_at": now,
        "verification_status": "configured",
    }
    await session.execute(
        insert(ProviderConnection)  # nosemgrep
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
    await bump_machine_agents(session, user.id)
    await session.commit()
    ring_credential_change(sealed)
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
    revoked = await revoke_logins(session, user.id, provider, datetime.now(UTC))
    await bump_machine_agents(session, user.id)
    await session.commit()
    ring_credential_change(revoked)
    return Response(status_code=204)

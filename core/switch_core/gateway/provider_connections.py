import json
from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.crypto import encrypt_token
from switch_core.db.models import User
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
    await session.commit()
    return Response(status_code=204)

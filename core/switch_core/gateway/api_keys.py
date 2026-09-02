from __future__ import annotations

import hashlib
import logging
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_api_key_store,
    get_config,
    get_protocol,
    get_session,
)
from switch_core.gateway.schemas import (
    ApiKeyDetail,
    CreateApiKeyRequest,
    CreateApiKeyResponse,
    RevealKeyResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_api_keys(
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ApiKeyDetail]:
    keys = await api_key_store.get_by_user(session, user.id)
    return [
        ApiKeyDetail(
            id=k.id,
            label=k.label,
            type=k.type,
            key_prefix=k.key_hash[:12],
            created_at=str(k.created_at),
        )
        for k in keys
    ]


@router.post("")
async def create_api_key(
    req: CreateApiKeyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> CreateApiKeyResponse:
    plaintext = secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()

    key = ApiKey(
        user_id=user.id,
        key_hash=key_hash,
        encrypted_key=encrypt_token(plaintext, config.jwt_secret_key),
        label=req.label,
        type="registration",
    )
    await api_key_store.create(session, key)
    await session.commit()

    logger.info("Created API key '%s' for user %s", req.label, user.email)
    return CreateApiKeyResponse(
        id=key.id,
        label=key.label,
        key=plaintext,
        created_at=str(key.created_at),
    )


@router.get("/{key_id}/reveal")
async def reveal_api_key(
    key_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> RevealKeyResponse:
    key = await api_key_store.get(session, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    if key.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to reveal this key")

    plaintext = decrypt_token(key.encrypted_key, config.jwt_secret_key)
    return RevealKeyResponse(key=plaintext)


@router.delete("/{key_id}")
async def delete_api_key(
    key_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    key = await api_key_store.get(session, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    if key.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this key")
    key_hash = key.key_hash
    await api_key_store.delete(session, key_id)
    await session.commit()
    get_protocol().api_key_cache.invalidate(key_hash)

    logger.info("Deleted API key '%s' for user %s", key.label, user.email)
    return {"ok": True}

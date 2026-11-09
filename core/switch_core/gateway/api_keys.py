from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, can_delete_api_key, owns
from switch_core.bridges.agent.registration_bootstrap import RETIRED_KEY_TYPE
from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import HASH_ONLY_KEY_TYPES, Agent, ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    current_telemetry,
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
from switch_core.telemetry import emit_safely
from switch_core.telemetry.ages import age_days

logger = logging.getLogger(__name__)


def _key_type(value: str) -> str:
    """A key's type as the catalogue spells it.

    The label an operator gave the key never goes anywhere near this — only
    what the key is *for*, which is a fixed set the code chooses.
    """
    return value if value in ("agent", "registration", "bootstrap") else "other"


router = APIRouter()


async def _held_by_an_agent(session: AsyncSession, keys: list[ApiKey]) -> set[str]:
    """Which of `keys` an agent's row still points at: its own key, which goes
    with it (`authz.can_delete_api_key`). A retired one too: its agent no
    longer signs in with it, but the row's reference would refuse the delete
    until the agent is gone."""
    if not keys:
        return set()
    return set(
        await session.scalars(
            select(Agent.api_key_id).where(Agent.api_key_id.in_([k.id for k in keys]))
        )
    )


@router.get("")
async def list_api_keys(
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ApiKeyDetail]:
    # Controller credentials and enrollment codes are managed through agent
    # management and hold only a hash; they are not the user's keys to see.
    keys = [
        k
        for k in await api_key_store.get_by_user(session, user.id)
        if k.type not in HASH_ONLY_KEY_TYPES
    ]
    held = await _held_by_an_agent(session, keys)
    # The caller's own keys, whatever their role: administering the workspace
    # gives no reach over anyone's keys here.
    principal = Principal(user.id, False)
    return [
        ApiKeyDetail(
            id=k.id,
            label=k.label,
            type=k.type,
            key_prefix=k.key_hash[:12],
            created_at=str(k.created_at),
            expires_at=k.expires_at,
            # A retired key authenticates as nothing, so there is nothing to copy.
            can_reveal=owns(principal, k.user_id) and k.type != RETIRED_KEY_TYPE,
            can_delete=can_delete_api_key(
                principal, k.user_id, an_agent_signs_in_with_it=k.id in held
            ),
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
    expires_at = (
        None
        if req.expires_in_days == "never"
        else datetime.now(UTC) + timedelta(days=req.expires_in_days)
    )

    key = ApiKey(
        user_id=user.id,
        key_hash=key_hash,
        encrypted_key=config.keyring.encrypt(plaintext),
        label=req.label,
        type="registration",
        expires_at=expires_at,
    )
    await api_key_store.create(session, key)
    await record_audit_event(
        session,
        tenant_id=key.tenant_id,
        actor_user_id=user.id,
        action=AuditAction.API_KEY_CREATED,
        target_type="api_key",
        target_id=key.id,
        details={
            "label": key.label,
            "type": key.type,
            "expires_at": None if expires_at is None else expires_at.isoformat(),
        },
    )
    await session.commit()

    logger.info("Created API key '%s' for user %s", req.label, user.id)
    emit_safely(
        current_telemetry(), "api_key_created", {"key_type": _key_type(key.type)}
    )
    return CreateApiKeyResponse(
        id=key.id,
        label=key.label,
        key=plaintext,
        created_at=str(key.created_at),
        expires_at=key.expires_at,
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
    if key is None or key.type in HASH_ONLY_KEY_TYPES:
        raise HTTPException(status_code=404, detail="API key not found")
    if key.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to reveal this key")
    if key.type == RETIRED_KEY_TYPE:
        raise HTTPException(
            status_code=409,
            detail="This key is retired and authenticates as nothing, so there is "
            "nothing to reveal.",
        )

    plaintext = config.keyring.decrypt(key.encrypted_key)
    await record_audit_event(
        session,
        tenant_id=key.tenant_id,
        actor_user_id=user.id,
        action=AuditAction.API_KEY_REVEALED,
        target_type="api_key",
        target_id=key.id,
        details={"label": key.label},
    )
    await session.commit()
    return RevealKeyResponse(key=plaintext)


@router.delete("/{key_id}")
async def delete_api_key(
    key_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    key = await api_key_store.get(session, key_id)
    if key is None or key.type in HASH_ONLY_KEY_TYPES:
        raise HTTPException(status_code=404, detail="API key not found")
    principal = Principal(user.id, False)
    if not owns(principal, key.user_id):
        raise HTTPException(status_code=403, detail="Not authorized to delete this key")
    if not can_delete_api_key(
        principal,
        key.user_id,
        an_agent_signs_in_with_it=key.id in await _held_by_an_agent(session, [key]),
    ):
        # The agent row refers to it, so deleting it would fail anyway.
        raise HTTPException(
            status_code=409,
            detail=(
                "This key still belongs to an agent. Delete the agent, and the "
                "key can go after it."
                if key.type == RETIRED_KEY_TYPE
                else "This is an agent's own key, which it still signs in with. "
                "Delete the agent to retire it."
            ),
        )
    key_hash = key.key_hash
    await record_audit_event(
        session,
        tenant_id=key.tenant_id,
        actor_user_id=user.id,
        action=AuditAction.API_KEY_DELETED,
        target_type="api_key",
        target_id=key.id,
        details={"label": key.label, "type": key.type},
    )
    await api_key_store.delete(session, key_id)
    await session.commit()
    get_protocol().api_key_cache.invalidate(key_hash)

    logger.info("Deleted API key '%s' for user %s", key.label, user.id)
    emit_safely(
        current_telemetry(),
        "api_key_revoked",
        {"key_type": _key_type(key.type), "age_days": age_days(key.created_at)},
    )
    return {"ok": True}

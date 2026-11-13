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
from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import HASH_ONLY_KEY_TYPES, Agent, ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_tenant_admin,
)
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_api_key_store,
    get_config,
    get_protocol,
    get_session,
    get_user_store,
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


async def _signing_in(session: AsyncSession, keys: list[ApiKey]) -> dict[str, Agent]:
    """The agent that still signs in with each of `keys`, by key id: its own
    key, which goes with it (`authz.can_delete_api_key`)."""
    agent_keys = [k.id for k in keys if k.type == "agent"]
    if not agent_keys:
        return {}
    agents = await session.scalars(
        select(Agent).where(Agent.api_key_id.in_(agent_keys))
    )
    return {agent.api_key_id: agent for agent in agents if agent.api_key_id is not None}


async def _details(
    session: AsyncSession,
    user_store: UserStore,
    keys: list[ApiKey],
    principal: Principal,
) -> list[ApiKeyDetail]:
    # Controller credentials and enrollment codes are managed through agent
    # management and hold only a hash; they are nobody's keys to see here.
    keys = [k for k in keys if k.type not in HASH_ONLY_KEY_TYPES]
    signing_in = await _signing_in(session, keys)
    owners = await user_store.names_by_id(session, {k.user_id for k in keys})
    details = []
    for k in keys:
        agent = signing_in.get(k.id)
        details.append(
            ApiKeyDetail(
                id=k.id,
                label=k.label,
                type=k.type,
                key_prefix=k.key_hash[:12],
                created_at=str(k.created_at),
                expires_at=k.expires_at,
                owner_id=k.user_id,
                # `user_id` names a user that exists: the key goes with them.
                owner_name=owners[k.user_id],
                agent_id=None if agent is None else agent.id,
                agent_name=None if agent is None else agent.name,
                can_reveal=owns(principal, k.user_id),
                can_delete=can_delete_api_key(
                    principal,
                    k.user_id,
                    k.type,
                    an_agent_signs_in_with_it=agent is not None,
                ),
            )
        )
    return details


@router.get("")
async def list_api_keys(
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ApiKeyDetail]:
    """The caller's own keys, whatever their role. Console reads this as the
    person's keys and nobody else's; an admin's view of the workspace is
    `GET /api-keys/workspace`."""
    # What anyone may do with their own keys does not turn on their role.
    return await _details(
        session,
        user_store,
        await api_key_store.get_by_user(session, user.id),
        Principal(user.id, False),
    )


@router.get("/workspace")
async def list_workspace_api_keys(
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> list[ApiKeyDetail]:
    """Every key in the workspace, for its admins: each with its owner, and
    nothing of the secret. Copying one is still its owner's alone
    (`GET /api-keys/{id}/reveal`)."""
    return await _details(
        session,
        user_store,
        await api_key_store.list_for_tenant(session),
        Principal(user.id, True),
    )


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
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> dict[str, bool]:
    key = await api_key_store.get(session, key_id)
    if key is None or key.type in HASH_ONLY_KEY_TYPES:
        raise HTTPException(status_code=404, detail="API key not found")
    if not can_delete_api_key(
        Principal(user.id, is_admin),
        key.user_id,
        key.type,
        an_agent_signs_in_with_it=False,
    ):
        raise HTTPException(status_code=403, detail="Not authorized to delete this key")
    if await _signing_in(session, [key]):
        # The agent row refers to it, so deleting it would fail anyway.
        raise HTTPException(
            status_code=409,
            detail=(
                "This is an agent's own key, which it still signs in with. "
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
        details={"label": key.label, "type": key.type, "owner_id": key.user_id},
    )
    await api_key_store.delete(session, key_id)
    await session.commit()
    get_protocol().api_key_cache.invalidate(key_hash)

    logger.info(
        "User %s deleted API key '%s' of user %s", user.id, key.label, key.user_id
    )
    emit_safely(
        current_telemetry(),
        "api_key_revoked",
        {"key_type": _key_type(key.type), "age_days": age_days(key.created_at)},
    )
    return {"ok": True}

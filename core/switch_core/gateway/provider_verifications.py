import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import (
    ProviderConnection,
    ProviderVerification,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import controller_session
from switch_core.gateway.hosted_launches import controller_settings
from switch_core.gateway.provider_connections import ring_credential_change
from switch_core.providers.credentials import validate_provider_credential
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.providers.verification import ACTIVE, latest
from switch_core.tenant_context import tenant_scope

router = APIRouter(prefix="/provider-verifications")


async def get_job(session: AsyncSession, job_id: UUID) -> ProviderVerification:
    job = await session.get(ProviderVerification, (require_tenant_id(), str(job_id)))
    if job is None:
        raise HTTPException(404, "Connection check not found.")
    return job


async def worker_session(
    job_id: UUID,
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    with tenant_scope(settings.tenant_id):
        async with factory() as session:
            job = await get_job(session, job_id)
            if (
                not secrets.compare_digest(
                    job.token_hash, hashlib.sha256(token.encode()).hexdigest()
                )
                or job.state not in ACTIVE
                or job.deadline <= datetime.now(UTC)
            ):
                raise HTTPException(403, "Connection check is expired or unauthorized.")
            if (
                await session.get(TenantMember, (require_tenant_id(), job.user_id))
                is None
            ):
                raise HTTPException(
                    403, "Connection check owner is no longer a member."
                )
            yield session


@router.get("")
async def pending(
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> list[dict]:
    jobs = await session.scalars(
        select(ProviderVerification)
        .where(
            ProviderVerification.tenant_id == require_tenant_id(),
            or_(
                ProviderVerification.state.in_(ACTIVE),
                and_(
                    ProviderVerification.state == "cancelled",
                    ProviderVerification.instance_id.is_not(None),
                ),
            ),
        )
        .order_by(ProviderVerification.created_at)
    )
    return [
        {
            "id": job.id,
            "state": job.state,
            "result": job.result,
            "instance_id": job.instance_id,
            "deadline": job.deadline.timestamp(),
        }
        for job in jobs
    ]


@router.post("/{job_id}/prepare")
async def prepare(
    job_id: UUID,
    response: Response,
    session: Annotated[AsyncSession, Depends(controller_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    job = await get_job(session, job_id)
    if (
        job.state not in ACTIVE
        or job.deadline <= datetime.now(UTC)
        or not job.encrypted_token
    ):
        raise HTTPException(409, "Connection check is no longer pending.")
    response.headers["Cache-Control"] = "no-store"
    return {"token": decrypt_token(job.encrypted_token, config.jwt_secret_key)}


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instance_id: str | None = Field(pattern=r"^i-[0-9a-f]+$")
    terminated: bool


@router.post("/{job_id}/observe")
async def observe(
    job_id: UUID,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> dict:
    job = await get_job(session, job_id)
    await ProviderConnectionStore().wait_user(session, job.user_id)
    await session.refresh(job, with_for_update=True)
    if job.state in ("succeeded", "failed"):
        return {"state": job.state}
    if job.instance_id and body.instance_id != job.instance_id:
        raise HTTPException(409, "Verification instance does not match.")
    job.instance_id = body.instance_id
    if body.terminated:
        if job.state != "cancelled":
            job.state = "succeeded" if job.result is True else "failed"
        if job.state == "cancelled":
            job.instance_id = None
        job.encrypted_credential = None
        job.encrypted_token = None
    elif job.state == "queued":
        job.state = "running"
    await session.commit()
    return {"state": job.state}


@router.get("/{job_id}/credential")
async def credential(
    job_id: UUID,
    response: Response,
    session: Annotated[AsyncSession, Depends(worker_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    job = await get_job(session, job_id)
    if job.result is not None or not job.encrypted_credential:
        raise HTTPException(409, "Connection check already finished.")
    response.headers["Cache-Control"] = "no-store"
    return {
        "provider": job.provider,
        "kind": job.kind,
        "credential": decrypt_token(job.encrypted_credential, config.jwt_secret_key),
    }


@router.post("/{job_id}/result")
async def result(
    job_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(worker_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 20 * 1024:
            raise HTTPException(413, "Verification result is too large.")
    job = await get_job(session, job_id)
    await ProviderConnectionStore().wait_user(session, job.user_id)
    await session.refresh(job, with_for_update=True)
    if job.state not in ACTIVE or job.deadline <= datetime.now(UTC):
        raise HTTPException(409, "Connection check is no longer pending.")
    if job.result is not None:
        return {"received": True}
    try:
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or set(value) - {"succeeded", "credential"}
            or type(value.get("succeeded")) is not bool
        ):
            raise ValueError()
        updated = value.get("credential")
        if updated is not None:
            if not isinstance(updated, str):
                raise ValueError()
            updated = validate_provider_credential(job.provider, job.kind, updated)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "Invalid verification result.") from None
    job.result = value["succeeded"]
    job.state = "finishing"
    if job.result and updated is not None:
        job.encrypted_credential = encrypt_token(updated, config.jwt_secret_key)
    current = await latest(session, job.user_id, job.provider)
    member = await session.get(TenantMember, (require_tenant_id(), job.user_id))
    if not current or current.id != job.id or not member:
        raise HTTPException(409, "Connection check is no longer current.")
    verified_at = datetime.now(UTC)
    if job.result is True:
        values = dict(
            tenant_id=require_tenant_id(),
            user_id=job.user_id,
            provider=job.provider,
            kind=job.kind,
            encrypted_credential=job.encrypted_credential,
            verified_at=verified_at,
            verification_status="verified",
        )
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
    job.encrypted_credential = None
    job.encrypted_token = None
    await session.commit()
    if job.result is True:
        await ring_credential_change(
            session, protocol.connections, job.user_id, job.provider, str(verified_at)
        )
    return {"received": True}

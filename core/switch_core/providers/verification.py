import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import ProviderVerification, require_tenant_id

ACTIVE = ("queued", "running", "finishing")
FAILURE = "The provider could not complete the connection check. Check your sign-in, plan or API billing, then retry."


def summary(job: ProviderVerification) -> dict:
    state = job.state
    if state in ACTIVE and job.deadline <= datetime.now(UTC):
        state = "failed"
    return {
        "status": "verifying"
        if state in ACTIVE
        else "connected"
        if state == "succeeded"
        else "failed",
        "verification_id": job.id,
        "kind": job.kind,
        "verified_at": str(job.created_at),
        "error": FAILURE if state in ("failed", "cancelled") else None,
    }


async def latest(
    session: AsyncSession, user_id: str, provider: str
) -> ProviderVerification | None:
    return await session.scalar(
        select(ProviderVerification)
        .where(
            ProviderVerification.tenant_id == require_tenant_id(),
            ProviderVerification.user_id == user_id,
            ProviderVerification.provider == provider,
        )
        .order_by(ProviderVerification.created_at.desc())
        .limit(1)
    )


async def queue(
    session: AsyncSession,
    user_id: str,
    provider: str,
    kind: str,
    credential: str,
    secret: str,
) -> dict:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"provider-verification:{require_tenant_id()}"},
    )
    previous = await latest(session, user_id, provider)
    now = datetime.now(UTC)
    if previous and previous.state in ACTIVE:
        if previous.deadline > now:
            if (
                previous.kind != kind
                or not previous.encrypted_credential
                or decrypt_token(previous.encrypted_credential, secret) != credential
            ):
                raise HTTPException(
                    409,
                    "A connection check is already running. Wait for it to finish before changing the credential.",
                )
            return summary(previous)
        previous.state = "failed"
        previous.encrypted_credential = None
        previous.encrypted_token = None
        await session.flush()
    count = await session.scalar(
        select(func.count())
        .select_from(ProviderVerification)
        .where(
            ProviderVerification.tenant_id == require_tenant_id(),
            ProviderVerification.state.in_(ACTIVE),
        )
    )
    if count and count >= 2:
        raise HTTPException(429, "Connection checks are busy. Please retry shortly.")
    token = secrets.token_urlsafe(32)
    job = ProviderVerification(
        tenant_id=require_tenant_id(),
        id=str(uuid4()),
        user_id=user_id,
        provider=provider,
        kind=kind,
        encrypted_credential=encrypt_token(credential, secret),
        encrypted_token=encrypt_token(token, secret),
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        state="queued",
        created_at=now,
        deadline=now + timedelta(minutes=10),
    )
    session.add(job)
    await session.commit()
    return summary(job)

"""Provider logins sealed with KMS for the ec2 controllers that run them.

A cloud machine on the shared agent controller never receives a login from
Core in the clear. Core asks KMS for a fresh AES-256 data key under an
encryption context naming the tenant, the owner, the controller and the
provider, encrypts the login with it (AES-256-GCM), and keeps only the
envelope: the data key as KMS encrypted it, and the ciphertext. Core holds no
permission to decrypt; the controller's instance role does, through a grant
constrained to its own tenant, owner and controller.

The envelope (`v` 1):

    {"v": 1, "provider", "revision", "status": "connected" | "revoked",
     "key_arn", "encrypted_key", "iv", "ciphertext", "tag", "context"}

`encrypted_key`, `iv`, `ciphertext` and `tag` are standard base64. The iv is
12 random bytes and the tag 16. The additional authenticated data is the
canonical JSON of the context and revision,
`json.dumps({"context": ctx, "revision": N}, sort_keys=True,
separators=(",", ":"))`, so an envelope cannot be replayed under another
revision or context. The plaintext is the JSON the hosted provider-credential
route returns: `{"status": "connected", "revision": "<N>", "provider", "kind",
"credential"}`. A revoked envelope carries no key material: those five fields
are null.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from typing import Any, Literal, cast

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    AgentController,
    HostedMachine,
    ProviderConnection,
    SealedProviderCredential,
    require_tenant_id,
)
from switch_core.keys import Keyring

ENVELOPE_VERSION = 1
SEALED_PROVIDERS = ("claude", "codex", "opencode", "cursor", "antigravity")
IV_BYTES = 12
TAG_BYTES = 16

CONTEXT_TENANT = "switch:tenant"
CONTEXT_OWNER = "switch:owner_id"
CONTEXT_CONTROLLER = "switch:controller_id"
CONTEXT_PROVIDER = "switch:provider"


@dataclass(frozen=True)
class SealedChange:
    """A controller's envelope of one login, sealed again or revoked, at `revision`."""

    controller_id: str
    provider: str
    revision: int


class SealingNotConfigured(RuntimeError):
    """A login has to be sealed, and the KMS key to seal it with is not configured."""


@dataclass(frozen=True)
class KmsSettings:
    key_arn: str
    region: str


def kms_settings(config: SwitchConfig) -> KmsSettings:
    if not config.hosted_login_kms_key_arn or not config.hosted_login_kms_region:
        raise SealingNotConfigured(
            "HOSTED_LOGIN_KMS_KEY_ARN and HOSTED_LOGIN_KMS_REGION must be set: a "
            "cloud machine runs the agent controller, and its provider logins "
            "are sealed with that key."
        )
    return KmsSettings(
        key_arn=config.hosted_login_kms_key_arn,
        region=config.hosted_login_kms_region,
    )


@lru_cache(maxsize=4)
def kms_client(region: str) -> Any:
    return boto3.client("kms", region_name=region)


def controller_context(
    tenant_id: str, owner_id: str, controller_id: str
) -> dict[str, str]:
    """The context every one of a controller's logins shares, and its grant's constraint."""
    return {
        CONTEXT_TENANT: tenant_id,
        CONTEXT_OWNER: owner_id,
        CONTEXT_CONTROLLER: controller_id,
    }


def login_context(
    tenant_id: str, owner_id: str, controller_id: str, provider: str
) -> dict[str, str]:
    return {
        **controller_context(tenant_id, owner_id, controller_id),
        CONTEXT_PROVIDER: provider,
    }


def additional_data(context: dict[str, str], revision: int) -> bytes:
    return json.dumps(
        {"context": context, "revision": revision},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def login_plaintext(provider: str, kind: str, credential: str, revision: int) -> bytes:
    return json.dumps(
        {
            "status": "connected",
            "revision": str(revision),
            "provider": provider,
            "kind": kind,
            "credential": credential,
        },
        separators=(",", ":"),
    ).encode()


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


def seal_with_key(
    *,
    data_key: bytes | bytearray,
    encrypted_key: bytes,
    iv: bytes,
    key_arn: str,
    provider: str,
    revision: int,
    context: dict[str, str],
    plaintext: bytes,
) -> dict[str, Any]:
    """The envelope for `plaintext` under a data key KMS already issued."""
    if len(iv) != IV_BYTES:
        raise ValueError(f"the iv must be {IV_BYTES} bytes, got {len(iv)}")
    sealed = AESGCM(bytes(data_key)).encrypt(
        iv, plaintext, additional_data(context, revision)
    )
    return {
        "v": ENVELOPE_VERSION,
        "provider": provider,
        "revision": revision,
        "status": "connected",
        "key_arn": key_arn,
        "encrypted_key": _b64(encrypted_key),
        "iv": _b64(iv),
        "ciphertext": _b64(sealed[:-TAG_BYTES]),
        "tag": _b64(sealed[-TAG_BYTES:]),
        "context": context,
    }


def revoked_envelope(
    provider: str, revision: int, context: dict[str, str]
) -> dict[str, Any]:
    return {
        "v": ENVELOPE_VERSION,
        "provider": provider,
        "revision": revision,
        "status": "revoked",
        "key_arn": None,
        "encrypted_key": None,
        "iv": None,
        "ciphertext": None,
        "tag": None,
        "context": context,
    }


async def seal(
    settings: KmsSettings,
    *,
    provider: str,
    revision: int,
    context: dict[str, str],
    plaintext: bytes,
) -> dict[str, Any]:
    """Seal `plaintext` under a data key KMS issues for `context` alone."""
    client = kms_client(settings.region)
    response = await asyncio.to_thread(
        client.generate_data_key,
        KeyId=settings.key_arn,
        KeySpec="AES_256",
        EncryptionContext=context,
    )
    data_key = bytearray(response.pop("Plaintext"))
    try:
        return seal_with_key(
            data_key=data_key,
            encrypted_key=response["CiphertextBlob"],
            iv=os.urandom(IV_BYTES),
            key_arn=settings.key_arn,
            provider=provider,
            revision=revision,
            context=context,
            plaintext=plaintext,
        )
    finally:
        data_key[:] = bytes(len(data_key))


# ── Stored envelopes ──────────────────────────────────────────────────────────


async def sealing_controllers(
    session: AsyncSession, owner_id: str
) -> list[AgentController]:
    """The ec2 controllers the owner's live cloud machine runs as, each of
    which gets its own envelope of every login. None for an owner whose
    machine runs the worker, or has not been prepared yet."""
    return list(
        await session.scalars(
            select(AgentController)
            .join(
                HostedMachine,
                (HostedMachine.tenant_id == AgentController.tenant_id)
                & (HostedMachine.controller_id == AgentController.id),
            )
            .where(
                AgentController.tenant_id == require_tenant_id(),
                AgentController.owner_id == owner_id,
                AgentController.kind == "ec2",
                AgentController.revoked_at.is_(None),
                HostedMachine.owner_id == owner_id,
                HostedMachine.runtime == "controller",
                HostedMachine.state != "deleted",
            )
            .order_by(AgentController.created_at)
            .distinct()
        )
    )


async def reusable_cloud_controller(
    session: AsyncSession, owner_id: str
) -> AgentController | None:
    """The oldest live ec2 controller any of the owner's machines ever ran as,
    which a machine whose own controller is revoked is linked to next."""
    return cast(
        AgentController | None,
        await session.scalar(
            select(AgentController)
            .join(
                HostedMachine,
                (HostedMachine.tenant_id == AgentController.tenant_id)
                & (HostedMachine.controller_id == AgentController.id),
            )
            .where(
                AgentController.tenant_id == require_tenant_id(),
                AgentController.owner_id == owner_id,
                AgentController.kind == "ec2",
                AgentController.revoked_at.is_(None),
            )
            .order_by(AgentController.created_at)
            .limit(1)
        ),
    )


async def _locked_row(
    session: AsyncSession, controller_id: str, provider: str
) -> SealedProviderCredential | None:
    return cast(
        SealedProviderCredential | None,
        await session.scalar(
            select(SealedProviderCredential)
            .where(
                SealedProviderCredential.tenant_id == require_tenant_id(),
                SealedProviderCredential.controller_id == controller_id,
                SealedProviderCredential.provider == provider,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ),
    )


async def _store(
    session: AsyncSession,
    controller: AgentController,
    provider: str,
    status: Literal["connected", "revoked"],
    envelope_for: Any,
    now: datetime,
) -> SealedChange:
    row = await _locked_row(session, controller.id, provider)
    revision = 1 if row is None else row.revision + 1
    envelope = await envelope_for(revision)
    if row is None:
        session.add(
            SealedProviderCredential(
                owner_id=controller.owner_id,
                controller_id=controller.id,
                provider=provider,
                revision=revision,
                status=status,
                envelope=envelope,
                updated_at=now,
            )
        )
    else:
        row.revision = revision
        row.status = status
        row.envelope = envelope
        row.updated_at = now
    await session.flush()
    return SealedChange(controller.id, provider, revision)


async def seal_for_controller(
    session: AsyncSession,
    settings: KmsSettings,
    controller: AgentController,
    *,
    provider: str,
    kind: str,
    credential: str,
    now: datetime,
) -> SealedChange:
    context = login_context(
        require_tenant_id(), controller.owner_id, controller.id, provider
    )

    async def envelope_for(revision: int) -> dict[str, Any]:
        return await seal(
            settings,
            provider=provider,
            revision=revision,
            context=context,
            plaintext=login_plaintext(provider, kind, credential, revision),
        )

    return await _store(session, controller, provider, "connected", envelope_for, now)


async def seal_login(
    session: AsyncSession,
    config: SwitchConfig,
    *,
    owner_id: str,
    provider: str,
    kind: str,
    credential: str,
    now: datetime,
) -> list[SealedChange]:
    """Seal a login for each ec2 controller the owner's cloud machine runs
    as. Returns the envelopes it sealed, none when it did not seal.

    Not sealed means the caller keeps the keyring copy, as for every owner on
    the worker runtime. So does an owner whose machine is on the controller
    runtime but not prepared yet: preparing it links the controller and seals
    every login stored then (`seal_stored_logins`).
    """
    controllers = await sealing_controllers(session, owner_id)
    if not controllers:
        return []
    settings = kms_settings(config)
    return [
        await seal_for_controller(
            session,
            settings,
            controller,
            provider=provider,
            kind=kind,
            credential=credential,
            now=now,
        )
        for controller in controllers
    ]


async def revoke_logins(
    session: AsyncSession, owner_id: str, provider: str, now: datetime
) -> list[SealedChange]:
    """Mark every envelope of the owner's login for `provider` revoked, and
    return them."""
    rows = await session.scalars(
        select(SealedProviderCredential.controller_id).where(
            SealedProviderCredential.tenant_id == require_tenant_id(),
            SealedProviderCredential.owner_id == owner_id,
            SealedProviderCredential.provider == provider,
        )
    )
    changes: list[SealedChange] = []
    for controller_id in list(rows):
        controller = await session.get(AgentController, controller_id)
        if controller is None:
            raise RuntimeError(
                f"a sealed login names controller {controller_id}, which does not exist"
            )
        context = login_context(
            require_tenant_id(), controller.owner_id, controller.id, provider
        )

        async def envelope_for(
            revision: int, context: dict[str, str] = context
        ) -> dict[str, Any]:
            return revoked_envelope(provider, revision, context)

        changes.append(
            await _store(session, controller, provider, "revoked", envelope_for, now)
        )
    return changes


async def seal_stored_logins(
    session: AsyncSession,
    config: SwitchConfig,
    keyring: Keyring,
    controller: AgentController,
    now: datetime,
) -> int:
    """Seal, for a controller just linked to its owner's machine, every login
    the owner holds a keyring copy of. Returns how many it sealed.

    A login held only sealed, for other controllers, cannot be sealed for this
    one; the owner has to connect it again (`reconnect_required`)."""
    connections = list(
        await session.scalars(
            select(ProviderConnection).where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == controller.owner_id,
                ProviderConnection.provider.in_(SEALED_PROVIDERS),
                ProviderConnection.encrypted_credential.is_not(None),
            )
        )
    )
    if not connections:
        return 0
    settings = kms_settings(config)
    for connection in connections:
        assert connection.encrypted_credential is not None
        await seal_for_controller(
            session,
            settings,
            controller,
            provider=connection.provider,
            kind=connection.kind,
            credential=keyring.decrypt(connection.encrypted_credential),
            now=now,
        )
    return len(connections)


async def reconnect_required(
    session: AsyncSession, connection: ProviderConnection
) -> bool:
    """Whether a login held only sealed cannot reach the controller the
    owner's cloud machine runs as, or will run as: one that holds no
    connected envelope of it, which Core cannot seal again without the login.

    The controllers are those the owner's live machine runs as; with none, the
    one preparing a machine would reuse (`Management.cloud_controller`); with
    none of those either, preparing creates a new controller.
    """
    if connection.encrypted_credential is not None:
        return False
    controllers = await sealing_controllers(session, connection.user_id)
    if not controllers:
        reused = await reusable_cloud_controller(session, connection.user_id)
        if reused is None:
            return True
        controllers = [reused]
    sealed = set(
        await session.scalars(
            select(SealedProviderCredential.controller_id).where(
                SealedProviderCredential.tenant_id == require_tenant_id(),
                SealedProviderCredential.controller_id.in_(
                    [controller.id for controller in controllers]
                ),
                SealedProviderCredential.provider == connection.provider,
                SealedProviderCredential.status == "connected",
            )
        )
    )
    return any(controller.id not in sealed for controller in controllers)


async def stored_envelope(
    session: AsyncSession, controller_id: str, provider: str
) -> dict[str, Any] | None:
    row = await session.scalar(
        select(SealedProviderCredential).where(
            SealedProviderCredential.tenant_id == require_tenant_id(),
            SealedProviderCredential.controller_id == controller_id,
            SealedProviderCredential.provider == provider,
        )
    )
    return None if row is None else row.envelope

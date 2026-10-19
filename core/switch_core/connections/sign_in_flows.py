"""Sign-ins under way, kept in Postgres so any switch-core process can take
any step of one.

A person connecting GitHub (`gateway/github_connections.py`) or a catalog
service (`connections/flows.py`) from Switch Console goes through half a dozen
requests: Console starts the flow, the browser leaves for the vendor and comes
back, Console hands over the code and reads the outcome. With
several processes behind one address each request may reach a different one,
so the flow is a row in `sign_in_flows` rather than an entry in one process's
memory.

Every step is a conditional update from the status it expects to the next,
so two requests racing for one step cannot both take it, and a step that
finds the flow already past it is refused as before. The flow's tenant is
bound for every read and write. Console's requests carry a signed-in person
and so their tenant; the browser's carry only the flow's state, and find the
tenant through `tenant_of_sign_in_flow` (`db/tenant_lookup.py`).

What would be secret is never stored in the clear. The PKCE verifier and the
vendor's credentials, once the code is exchanged, are keyring-encrypted; the
completion secret Console holds and the nonce the browser carries in a cookie
are stored as SHA-256 hashes and compared against what each presents.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import SignInFlow, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import tenant_of_sign_in_flow
from switch_core.keys import Keyring

FLOW_SECONDS = 600
# Per workspace. A person holds at most one flow of each kind, so this bounds
# what one workspace's members can have open at once, not a global queue.
MAX_FLOWS = 256


class FlowGoneError(Exception):
    """No flow under this state: never started, finished, cancelled, or
    expired."""


class FlowUsedError(Exception):
    """A flow under this state already exists or existed: a state is used once."""


class FlowsBusyError(Exception):
    """The workspace has as many sign-ins under way as it may."""


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class StoredFlow:
    """One flow as its row stands, with the verifier and any result opened."""

    state: str
    tenant_id: str
    kind: str
    service: str
    user_id: str
    status: str
    mode: str
    port: int
    redirect_uri: str
    owner_label: str
    details: Mapping[str, Any]
    verifier: str
    completion_secret_hash: str
    browser_nonce_hash: str | None
    result: Mapping[str, Any] | None
    account_label: str | None
    error: str | None
    warning: str | None

    def holds_secret(self, presented: str) -> bool:
        """Whether `presented` is the completion secret Console started with."""
        return secrets.compare_digest(self.completion_secret_hash, digest(presented))

    def holds_nonce(self, presented: str) -> bool:
        """Whether `presented` is the nonce set on the browser that left for
        the vendor through Core."""
        return self.browser_nonce_hash is not None and secrets.compare_digest(
            self.browser_nonce_hash, digest(presented)
        )


class SignInFlows:
    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], keyring: Keyring
    ) -> None:
        self._session_factory = session_factory
        self._keyring = keyring

    async def start(
        self,
        *,
        kind: str,
        service: str,
        tenant_id: str,
        user_id: str,
        state: str,
        mode: str,
        port: int,
        redirect_uri: str,
        owner_label: str,
        details: Mapping[str, Any],
        completion_secret: str,
    ) -> StoredFlow:
        """Record a new flow, replacing the person's earlier one of this kind.

        Raises `FlowUsedError` when the state has been used before, and
        `FlowsBusyError` when the workspace is at `MAX_FLOWS`. Expired flows
        in the workspace are deleted first, so a flow nobody finished is gone
        by the time anyone in its workspace starts another.
        """
        verifier = secrets.token_urlsafe(48)
        async with tenant_session(self._session_factory, tenant_id) as session:
            # One start at a time per workspace, held to the commit. The delete,
            # count and insert below see only committed rows, so two starts side
            # by side would otherwise both keep a flow for one person, or both
            # take the workspace's last place under `MAX_FLOWS`.
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"sign-in-flows:{tenant_id}"},
            )
            await session.execute(
                delete(SignInFlow).where(
                    SignInFlow.tenant_id == tenant_id,
                    SignInFlow.expires_at <= func.now(),
                )
            )
            if await session.scalar(
                select(SignInFlow.id).where(SignInFlow.id == state)
            ):
                await session.rollback()
                raise FlowUsedError
            await session.execute(
                delete(SignInFlow).where(
                    SignInFlow.tenant_id == tenant_id,
                    SignInFlow.user_id == user_id,
                    SignInFlow.kind == kind,
                )
            )
            open_flows = await session.scalar(
                select(func.count())
                .select_from(SignInFlow)
                .where(SignInFlow.tenant_id == tenant_id)
            )
            if (open_flows or 0) >= MAX_FLOWS:
                await session.rollback()
                raise FlowsBusyError
            inserted = await session.execute(
                insert(SignInFlow)
                .values(
                    id=state,
                    tenant_id=tenant_id,
                    kind=kind,
                    service=service,
                    user_id=user_id,
                    status="pending",
                    mode=mode,
                    port=port,
                    redirect_uri=redirect_uri,
                    owner_label=owner_label,
                    details=dict(details),
                    encrypted_verifier=self._keyring.encrypt(verifier),
                    completion_secret_hash=digest(completion_secret),
                    expires_at=func.now() + timedelta(seconds=FLOW_SECONDS),
                )
                .on_conflict_do_nothing(index_elements=[SignInFlow.id])
                .returning(SignInFlow)
            )
            row = inserted.scalar_one_or_none()
            if row is None:
                await session.rollback()
                raise FlowUsedError
            flow = self._open(row)
            await session.commit()
        return flow

    async def get(self, state: str, tenant_id: str) -> StoredFlow:
        """The flow under `state` in `tenant_id`. Raises `FlowGoneError`."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            row = await session.scalar(
                select(SignInFlow).where(
                    SignInFlow.tenant_id == tenant_id,
                    SignInFlow.id == state,
                    SignInFlow.expires_at > func.now(),
                )
            )
        if row is None:
            raise FlowGoneError
        return self._open(row)

    async def find(self, state: str) -> StoredFlow:
        """The flow under `state`, in whichever tenant holds it: for the
        browser's steps, which carry no tenant. Raises `FlowGoneError`."""
        if not state:
            raise FlowGoneError
        tenant_id = await tenant_of_sign_in_flow(self._session_factory, state)
        if tenant_id is None:
            raise FlowGoneError
        return await self.get(state, tenant_id)

    async def advance(
        self,
        flow: StoredFlow,
        *,
        expect: Collection[str],
        to: str,
        changes: Mapping[str, Any],
    ) -> StoredFlow | None:
        """Move the flow to status `to`, with the columns in `changes`, if it
        is still unexpired and in one of `expect`. None when it is not: another
        request took the step first, or the flow is gone."""
        async with tenant_session(self._session_factory, flow.tenant_id) as session:
            updated = await session.execute(
                update(SignInFlow)
                .where(
                    SignInFlow.tenant_id == flow.tenant_id,
                    SignInFlow.id == flow.state,
                    SignInFlow.status.in_(list(expect)),
                    SignInFlow.expires_at > func.now(),
                )
                .values(status=to, **changes)
                .returning(SignInFlow)
            )
            row = updated.scalar_one_or_none()
            await session.commit()
        return None if row is None else self._open(row)

    def seal(self, result: Mapping[str, Any]) -> str:
        """`result` as `advance` stores it in `encrypted_result`."""
        return self._keyring.encrypt(json.dumps(dict(result), separators=(",", ":")))

    async def discard(self, flow: StoredFlow) -> None:
        async with tenant_session(self._session_factory, flow.tenant_id) as session:
            await session.execute(
                delete(SignInFlow).where(
                    SignInFlow.tenant_id == flow.tenant_id,
                    SignInFlow.id == flow.state,
                )
            )
            await session.commit()

    async def discard_for_user(
        self, session: AsyncSession, user_id: str, kind: str | None
    ) -> None:
        """Delete the person's flows in the caller's tenant: of one kind, or
        of every kind when `kind` is None. In the caller's session, so it
        commits with whatever removed the person's connection."""
        query = delete(SignInFlow).where(
            SignInFlow.tenant_id == require_tenant_id(),
            SignInFlow.user_id == user_id,
        )
        if kind is not None:
            query = query.where(SignInFlow.kind == kind)
        await session.execute(query)

    def _open(self, row: SignInFlow) -> StoredFlow:
        return StoredFlow(
            state=row.id,
            tenant_id=row.tenant_id,
            kind=row.kind,
            service=row.service,
            user_id=row.user_id,
            status=row.status,
            mode=row.mode,
            port=row.port,
            redirect_uri=row.redirect_uri,
            owner_label=row.owner_label,
            details=row.details,
            verifier=self._keyring.decrypt(row.encrypted_verifier),
            completion_secret_hash=row.completion_secret_hash,
            browser_nonce_hash=row.browser_nonce_hash,
            result=(
                None
                if row.encrypted_result is None
                else json.loads(self._keyring.decrypt(row.encrypted_result))
            ),
            account_label=row.account_label,
            error=row.error,
            warning=row.warning,
        )

"""Erasing a person from a workspace.

A workspace owner queues a request naming one or more platform identities
(`ErasureStore.queue`). `erasure_loop` works the queue: for each identity it

1. deletes every message the identity sent, in every room, archived ones
   included, in batches with their attachments and bridge post mappings;
2. stops the client that stood in for them in rooms;
3. in one transaction, deletes anything they sent meanwhile, replaces their
   name on approval answers, and deletes their identity row (its claims go by
   cascade), their room memberships and their client;
4. tells the running bridge to forget them, so writing again provisions a
   new identity;
5. deletes the stored files that only their messages carried.

Every step is safe to repeat, so a request interrupted by a restart is simply
worked again. Kept: what other people wrote, including quotes and mentions of
them; copies on the chat platforms; their Switch account and membership,
which have their own actions. `docs/design/data-retention.md` covers why.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import PersonErasure, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.erasure_store import ErasureStore, Person
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.retention_store import RetentionStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)

ERASURE_INTERVAL_SECONDS = 5.0
MESSAGE_BATCH = 1000


class ClientControl(Protocol):
    async def stop(self, client_id: str) -> None: ...

    async def delete_record(self, session: AsyncSession, client_id: str) -> None: ...


class BridgeMemory(Protocol):
    async def forget_human(
        self, bridge_id: str, external_user_id: str, transport_user_id: str
    ) -> None: ...


class ErasureService:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        clients: ClientControl,
        bridges: BridgeMemory,
    ) -> None:
        self._sessions = session_factory
        self._clients = clients
        self._bridges = bridges
        self._erasures = ErasureStore()
        self._messages = MessageStore()
        self._retention = RetentionStore()

    async def work_once(self) -> PersonErasure | None:
        """Work the bound tenant's oldest pending request to its end, if any."""
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db:
            erasure = await self._erasures.next_pending(db)
        if erasure is None:
            return None

        messages = files = identities = 0
        try:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                await self._erasures.mark(
                    db,
                    erasure.id,
                    state="running",
                    messages_deleted=erasure.messages_deleted,
                    files_deleted=erasure.files_deleted,
                    identities_erased=erasure.identities_erased,
                    error=None,
                )
            messages, files, identities = (
                erasure.messages_deleted,
                erasure.files_deleted,
                erasure.identities_erased,
            )
            async with tenant_session(self._sessions, tenant_id) as db:
                people = await self._erasures.list_people(db, erasure.external_user_ids)
            for person in people:
                deleted, removed_files = await self._erase(tenant_id, person)
                messages += deleted
                files += removed_files
                identities += 1
                async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                    await self._erasures.mark(
                        db,
                        erasure.id,
                        state="running",
                        messages_deleted=messages,
                        files_deleted=files,
                        identities_erased=identities,
                        error=None,
                    )
        except Exception as exc:
            logger.exception(
                "Erasure %s in tenant %s failed after %d message(s)",
                erasure.id,
                tenant_id,
                messages,
            )
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                await self._erasures.mark(
                    db,
                    erasure.id,
                    state="failed",
                    messages_deleted=messages,
                    files_deleted=files,
                    identities_erased=identities,
                    error=f"{type(exc).__name__}: {exc}",
                )
            raise

        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            await self._erasures.mark(
                db,
                erasure.id,
                state="done",
                messages_deleted=messages,
                files_deleted=files,
                identities_erased=identities,
                error=None,
            )
            await record_audit_event(
                db,
                tenant_id=tenant_id,
                actor_user_id=erasure.requested_by_user_id,
                action=AuditAction.PERSON_ERASURE_COMPLETED,
                target_type="person_erasure",
                target_id=erasure.id,
                details={
                    "messages_deleted": messages,
                    "files_deleted": files,
                    "identities_erased": identities,
                },
            )
        logger.info(
            "Erasure %s in tenant %s done: %d identities, %d messages, %d files",
            erasure.id,
            tenant_id,
            identities,
            messages,
            files,
        )
        return erasure

    async def _erase(self, tenant_id: str, person: Person) -> tuple[int, int]:
        async with tenant_session(self._sessions, tenant_id) as db:
            uris = await self._messages.attachment_uris_sent_by(
                db, transport_user_id=person.transport_user_id
            )
        deleted = 0
        while True:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                event_ids = await self._messages.delete_sent_by(
                    db, transport_user_id=person.transport_user_id, limit=MESSAGE_BATCH
                )
                await self._retention.delete_bridge_mappings(db, event_ids)
            deleted += len(event_ids)
            if len(event_ids) < MESSAGE_BATCH:
                break

        await self._clients.stop(person.client_id)
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            while True:
                event_ids = await self._messages.delete_sent_by(
                    db, transport_user_id=person.transport_user_id, limit=MESSAGE_BATCH
                )
                await self._retention.delete_bridge_mappings(db, event_ids)
                deleted += len(event_ids)
                if len(event_ids) < MESSAGE_BATCH:
                    break
            await self._erasures.scrub_approval_answers(db, person.transport_user_id)
            await self._erasures.delete_identity(db, person.external_user_id)
            await self._clients.delete_record(db, person.client_id)
        await self._bridges.forget_human(
            person.bridge_id, person.external_user_id, person.transport_user_id
        )

        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            files = await self._erasures.delete_unreferenced_media(db, uris)
        return deleted, files


async def erase_once(service: ErasureService, tenant_ids: list[str]) -> None:
    for tenant_id in tenant_ids:
        with tenant_scope(tenant_id):
            try:
                while await service.work_once() is not None:
                    pass
            except Exception:
                # Recorded on the request as failed; one tenant's failure must
                # not stop the others' erasures.
                logger.exception("Erasure upkeep failed for tenant %s", tenant_id)


async def erasure_loop(
    session_factory: async_sessionmaker[AsyncSession], service: ErasureService
) -> None:
    """Work every tenant's erasure queue every few seconds."""
    with no_tenant():
        while True:
            try:
                await erase_once(service, await all_tenant_ids(session_factory))
            except Exception:
                logger.exception("Erasure upkeep could not list tenants")
            await asyncio.sleep(ERASURE_INTERVAL_SECONDS)

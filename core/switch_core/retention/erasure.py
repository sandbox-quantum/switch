"""Erasing a person from a workspace.

A workspace owner queues a request naming one or more platform identities
(`ErasureStore.queue`), and any former participants: people from a chat app
since disconnected, whose identity rows went with it. For those only their
messages, files, approval answers and direct-room names are left to erase
(`_erase_former`). `erasure_loop` works the queue: for each identity it

1. deletes every message the identity sent, in every room, archived ones
   included, in batches with their attachments, bridge post mappings and the
   copies held for hosted agents;
2. stops the client that stood in for them in rooms;
3. in one transaction, scrubs their name and words from approval answers and
   their name from direct rooms' names, deletes their identity row (its
   claims go by cascade), their room memberships and their client, and then
   anything they sent meanwhile;
4. tells the running bridge to forget them, so writing again provisions a
   new identity;
5. deletes the stored files that only their messages carried.

Every step is safe to repeat, and a request is claimed before it is worked,
so one interrupted by a restart is resumed by the next pass and two processes
never work the same one. Kept: what other people wrote, including quotes and mentions of
them; copies on the chat platforms; their Switch account and membership,
which have their own actions. `docs/design/data-retention.md` covers why.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import PersonErasure, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.erasure_store import (
    ErasureStore,
    FormerParticipant,
    Person,
)
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

    async def work_once(self, now: datetime) -> PersonErasure | None:
        """Claim the bound tenant's oldest pending request and work it to its
        end. Returns it as finished, done or failed, or None if there was none.

        A failure before an identity's rows are deleted marks the request
        failed, with the error, and leaves that identity in place to be queued
        again. Counts are added in the transaction that did the work, so a
        request resumed after a restart reports everything it deleted.
        """
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            erasure = await self._erasures.claim_next(db, now)
        if erasure is None:
            return None

        error: str | None = None
        try:
            async with tenant_session(self._sessions, tenant_id) as db:
                people = await self._erasures.people_with_ids(
                    db, erasure.external_user_ids
                )
            for person in people:
                await self._erase(tenant_id, erasure.id, person)
            if erasure.former_sender_ids:
                async with tenant_session(self._sessions, tenant_id) as db:
                    former = await self._erasures.former_with_ids(
                        db, erasure.former_sender_ids
                    )
                for participant in former:
                    await self._erase_former(tenant_id, erasure.id, participant)
        except Exception as exc:
            logger.exception("Erasure %s in tenant %s failed", erasure.id, tenant_id)
            error = f"{type(exc).__name__}: {exc}"

        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            finished = await self._erasures.finish(db, erasure.id, error=error)
            if error is None:
                await record_audit_event(
                    db,
                    tenant_id=tenant_id,
                    actor_user_id=finished.requested_by_user_id,
                    action=AuditAction.PERSON_ERASURE_COMPLETED,
                    target_type="person_erasure",
                    target_id=finished.id,
                    details={
                        "messages_deleted": finished.messages_deleted,
                        "files_deleted": finished.files_deleted,
                        "identities_erased": finished.identities_erased,
                    },
                )
        if error is None:
            logger.info(
                "Erasure %s in tenant %s done: %d identities, %d messages, %d files",
                finished.id,
                tenant_id,
                finished.identities_erased,
                finished.messages_deleted,
                finished.files_deleted,
            )
        return finished

    async def _erase(self, tenant_id: str, erasure_id: str, person: Person) -> None:
        uris: set[str] = set()
        room_ids: set[str] = set()
        while True:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                count = await self._delete_batch(
                    db, erasure_id, person.transport_user_id, uris, room_ids
                )
            if count < MESSAGE_BATCH:
                break

        # Stopping the client ends its delivery but not, by itself, a send
        # already under way. The final transaction deletes the client before
        # it looks for messages a last time: the delete waits for any insert
        # naming the client to commit, and once it has committed no insert can
        # name it, so nothing they send outlives this transaction.
        await self._clients.stop(person.client_id)
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            await self._erasures.scrub_approval_answers(db, person.transport_user_id)
            await self._erasures.scrub_direct_rooms(db, person)
            await self._erasures.delete_identity(db, person.external_user_id)
            await self._clients.delete_record(db, person.client_id)
            while (
                await self._delete_batch(
                    db, erasure_id, person.transport_user_id, uris, room_ids
                )
                == MESSAGE_BATCH
            ):
                pass
            await self._erasures.add_progress(
                db, erasure_id, messages=0, files=0, identities=1
            )

        # The identity is gone from here on, so a failure below cannot be put
        # right by queueing it again; it is logged rather than failing the
        # request. Files missed here are taken by the hourly sweep a day later.
        try:
            await self._bridges.forget_human(
                person.bridge_id, person.external_user_id, person.transport_user_id
            )
        except Exception:
            logger.warning(
                "Erasure %s: the bridge could not forget identity %s; it does "
                "when it next restarts",
                erasure_id,
                person.external_user_id,
                exc_info=True,
            )
        try:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                files = await self._erasures.delete_unreferenced_media(db, uris)
                await self._erasures.add_progress(
                    db, erasure_id, messages=0, files=files, identities=0
                )
        except Exception:
            logger.warning(
                "Erasure %s: could not delete the files of identity %s; the "
                "hourly sweep deletes them a day later",
                erasure_id,
                person.external_user_id,
                exc_info=True,
            )

    async def _erase_former(
        self, tenant_id: str, erasure_id: str, participant: FormerParticipant
    ) -> None:
        """Erase someone whose chat app was disconnected. Their identity, client
        and memberships went with the app; what is left is their messages,
        their name on approval answers, and their name on direct rooms."""
        uris: set[str] = set()
        room_ids: set[str] = set()
        while True:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                count = await self._delete_batch(
                    db, erasure_id, participant.sender_id, uris, room_ids
                )
            if count < MESSAGE_BATCH:
                break
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            await self._erasures.scrub_approval_answers(db, participant.sender_id)
            await self._erasures.scrub_former_direct_rooms(
                db, room_ids, participant.names
            )
            await self._erasures.add_progress(
                db, erasure_id, messages=0, files=0, identities=1
            )
        try:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                files = await self._erasures.delete_unreferenced_media(db, uris)
                await self._erasures.add_progress(
                    db, erasure_id, messages=0, files=files, identities=0
                )
        except Exception:
            logger.warning(
                "Erasure %s: could not delete a former participant's files; the "
                "hourly sweep deletes them a day later",
                erasure_id,
                exc_info=True,
            )

    async def _delete_batch(
        self,
        db: AsyncSession,
        erasure_id: str,
        transport_user_id: str,
        uris: set[str],
        room_ids: set[str],
    ) -> int:
        deleted = await self._messages.delete_sent_by(
            db, transport_user_id=transport_user_id, limit=MESSAGE_BATCH
        )
        await self._retention.delete_bridge_mappings(db, deleted.event_ids)
        await self._erasures.delete_hosted_copies(db, deleted.event_ids)
        await self._erasures.add_progress(
            db, erasure_id, messages=len(deleted.event_ids), files=0, identities=0
        )
        uris |= deleted.uris
        room_ids |= deleted.room_ids
        return len(deleted.event_ids)


async def erase_once(service: ErasureService, tenant_ids: list[str]) -> None:
    for tenant_id in tenant_ids:
        with tenant_scope(tenant_id):
            try:
                while await service.work_once(datetime.now(UTC)) is not None:
                    pass
            except Exception:
                # One tenant's failure must not stop the others' erasures.
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

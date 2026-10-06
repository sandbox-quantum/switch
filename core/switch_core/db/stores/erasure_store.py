"""Erasing a person: who can be erased, the request queue, and the deletions
that are not messages, for the bound tenant.

A person in a room is a chat-platform identity: an `external_users` row on
one bridge, standing behind a `clients` row that is the room participant.
One person seen on two platforms is two identities. Message deletion itself
is `MessageStore.delete_sent_by`, which keeps the room's numbering intact.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import (
    ARRAY,
    CursorResult,
    Result,
    Text,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy import cast as cast_
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    ApprovalRequest,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Message,
    PersonErasure,
    User,
    require_tenant_id,
)

#: What `answered_by` reads once the person who answered has been erased.
ERASED_ANSWERER = "erased"

ACTIVE_STATES = ("queued", "running")


class ErasureAlreadyQueued(Exception):
    """An identity named in a request already has an erasure queued or running."""


class UnknownIdentity(Exception):
    """An identity named in a request is not in this workspace."""


@dataclass(frozen=True)
class Claimant:
    user_id: str
    name: str


@dataclass(frozen=True)
class Person:
    """One platform identity, and what erasing it would delete."""

    external_user_id: str
    username: str
    bridge_id: str
    platform: str
    bridge_name: str
    client_id: str
    transport_user_id: str
    message_count: int
    claimed_by: list[Claimant]


def _rowcount(result: Result[Any]) -> int:
    return cast("CursorResult[Any]", result).rowcount


class ErasureStore:
    async def list_people(
        self,
        session: AsyncSession,
        external_user_ids: Collection[str] | None = None,
    ) -> list[Person]:
        """Every platform identity in the bound tenant, or the ones named."""
        tenant_id = require_tenant_id()
        counts = (
            select(Message.sender_id, func.count().label("n"))
            .where(Message.tenant_id == tenant_id)
            .group_by(Message.sender_id)
            .subquery()
        )
        query = (
            select(
                ExternalUser.id,
                ExternalUser.external_username,
                ExternalUser.bridge_id,
                CollaborationBridge.type,
                CollaborationBridge.display_name,
                Client.id,
                Client.transport_user_id,
                func.coalesce(counts.c.n, 0),
            )
            .join(
                CollaborationBridge,
                (CollaborationBridge.tenant_id == ExternalUser.tenant_id)
                & (CollaborationBridge.id == ExternalUser.bridge_id),
            )
            .join(
                Client,
                (Client.tenant_id == ExternalUser.tenant_id)
                & (Client.id == ExternalUser.client_id),
            )
            .outerjoin(counts, counts.c.sender_id == Client.transport_user_id)
            .where(ExternalUser.tenant_id == tenant_id)
            .order_by(func.lower(ExternalUser.external_username), ExternalUser.id)
        )
        if external_user_ids is not None:
            query = query.where(ExternalUser.id.in_(list(external_user_ids)))
        rows = (await session.execute(query)).all()

        claims: dict[str, list[Claimant]] = {}
        if rows:
            claim_rows = await session.execute(
                select(ExternalUserClaim.external_user_id, User.id, User.name)
                .join(User, User.id == ExternalUserClaim.user_id)
                .where(
                    ExternalUserClaim.tenant_id == tenant_id,
                    ExternalUserClaim.external_user_id.in_([r[0] for r in rows]),
                )
                .order_by(User.name)
            )
            for external_user_id, user_id, name in claim_rows.all():
                claims.setdefault(external_user_id, []).append(Claimant(user_id, name))

        return [
            Person(
                external_user_id=row[0],
                username=row[1],
                bridge_id=row[2],
                platform=row[3],
                bridge_name=row[4],
                client_id=row[5],
                transport_user_id=row[6],
                message_count=int(row[7]),
                claimed_by=claims.get(row[0], []),
            )
            for row in rows
        ]

    async def queue(
        self,
        session: AsyncSession,
        *,
        external_user_ids: list[str],
        requested_by_user_id: str,
    ) -> PersonErasure:
        """Queue the erasure of these identities, or raise.

        Locks the tenant's erasure queue for the transaction, so two owners
        asking at once cannot both pass the "nothing already queued" check.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('person_erasures:' || :t))"),
            {"t": require_tenant_id()},
        )
        known = {
            p.external_user_id
            for p in await self.list_people(session, external_user_ids)
        }
        unknown = set(external_user_ids) - known
        if unknown:
            raise UnknownIdentity(", ".join(sorted(unknown)))
        overlapping = await session.scalar(
            select(func.count())
            .select_from(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.state.in_(ACTIVE_STATES),
                PersonErasure.external_user_ids.op("?|")(
                    cast_(array(external_user_ids), ARRAY(Text))
                ),
            )
        )
        if overlapping:
            raise ErasureAlreadyQueued()
        erasure = PersonErasure(
            external_user_ids=list(external_user_ids),
            state="queued",
            requested_by_user_id=requested_by_user_id,
        )
        session.add(erasure)
        await session.flush()
        await session.refresh(erasure)
        return erasure

    async def list_erasures(
        self, session: AsyncSession, *, limit: int
    ) -> list[PersonErasure]:
        result = await session.execute(
            select(PersonErasure)
            .where(PersonErasure.tenant_id == require_tenant_id())
            .order_by(PersonErasure.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars())

    async def next_pending(self, session: AsyncSession) -> PersonErasure | None:
        """The oldest request still to finish. A `running` one is resumed: the
        work is safe to repeat, and one left running by a restart is otherwise
        never finished."""
        result = await session.execute(
            select(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.state.in_(ACTIVE_STATES),
            )
            .order_by(PersonErasure.created_at)
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def mark(
        self,
        session: AsyncSession,
        erasure_id: str,
        *,
        state: str,
        messages_deleted: int,
        files_deleted: int,
        identities_erased: int,
        error: str | None,
    ) -> None:
        finished = state in ("done", "failed")
        await session.execute(
            update(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
            .values(
                state=state,
                messages_deleted=messages_deleted,
                files_deleted=files_deleted,
                identities_erased=identities_erased,
                error=error,
                completed_at=datetime.now(UTC) if finished else None,
            )
        )

    async def scrub_approval_answers(
        self, session: AsyncSession, transport_user_id: str
    ) -> int:
        """Replace this participant's name on every approval answer they gave."""
        result = await session.execute(
            update(ApprovalRequest)
            .where(
                ApprovalRequest.tenant_id == require_tenant_id(),
                ApprovalRequest.answered_by == transport_user_id,
            )
            .values(answered_by=ERASED_ANSWERER)
        )
        return _rowcount(result)

    async def delete_identity(
        self, session: AsyncSession, external_user_id: str
    ) -> None:
        """Delete the identity row; its claims go with it by cascade. The
        client behind it is the caller's to delete afterwards, since the
        identity points at it."""
        await session.execute(
            delete(ExternalUser).where(
                ExternalUser.tenant_id == require_tenant_id(),
                ExternalUser.id == external_user_id,
            )
        )

    async def delete_unreferenced_media(
        self, session: AsyncSession, uris: Collection[str]
    ) -> int:
        """Delete the stored files among `uris` that no attachment refers to now.

        Unlike the hourly sweep this has no grace period: these files are known
        to have been attached to the erased person's messages, so none is an
        upload still waiting for its message.
        """
        if not uris:
            return 0
        result = await session.execute(
            text(
                """
                DELETE FROM media_blobs b
                WHERE b.tenant_id = :t AND b.uri = ANY(:uris)
                  AND NOT EXISTS (
                      SELECT 1 FROM message_attachments a
                      WHERE a.tenant_id = b.tenant_id AND a.uri = b.uri)
                """
            ),
            {"t": require_tenant_id(), "uris": list(uris)},
        )
        return _rowcount(result)

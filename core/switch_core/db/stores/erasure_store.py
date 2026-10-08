"""Erasing a person: who can be erased, the request queue, and the deletions
that are not messages, for the bound tenant.

A person in a room is a chat-platform identity: an `external_users` row on
one bridge, standing behind a `clients` row that is the room participant.
One person seen on two platforms is two identities. Message deletion itself
is `MessageStore.delete_sent_by`, which keeps the room's numbering intact.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import (
    ARRAY,
    CursorResult,
    Result,
    Text,
    delete,
    func,
    or_,
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
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    HostedCutoverItem,
    HostedWakeMailbox,
    Message,
    PersonErasure,
    Room,
    User,
    require_tenant_id,
)
from switch_core.db.stores.retention_store import UNREFERENCED_BLOB

#: What `answered_by` reads once the person who answered has been erased.
ERASED_ANSWERER = "erased"
#: What stands in for an erased person's name in a direct room's name.
ERASED_NAME = "erased person"

ACTIVE_STATES = ("queued", "running")
#: A `running` request whose progress has not moved for this long is taken to
#: belong to a process that died, and is resumed. Progress is recorded after
#: every batch, so a live one never looks this old.
STALE_RUNNING = timedelta(minutes=10)


#: The transport id a bridge gives the person behind a platform account
#: (`CollaborationCore._create_human_actor`): `@switch-<platform>-<bridge id>-
#: <username>:<server>`. Agents, bridges and system clients have other shapes,
#: so this tells a person's messages apart once their identity rows are gone.
HUMAN_SENDER_PATTERN = (
    r"^@switch-([a-z]+)-"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-"
)
_HUMAN_SENDER = re.compile(HUMAN_SENDER_PATTERN)


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


@dataclass(frozen=True)
class FormerParticipant:
    """Someone seen on a chat app that has since been disconnected.

    Disconnecting an app deletes its identity and client rows but keeps the
    messages, so all that is left of the person is the transport id and the
    display names on what they sent.
    """

    sender_id: str
    names: list[str]
    platform: str
    message_count: int


def _rowcount(result: Result[Any]) -> int:
    return cast("CursorResult[Any]", result).rowcount


class ErasureStore:
    async def list_people(self, session: AsyncSession) -> list[Person]:
        """Every platform identity in the bound tenant."""
        return await self._people(
            session, ExternalUser.tenant_id == require_tenant_id()
        )

    async def people_with_ids(
        self, session: AsyncSession, external_user_ids: Collection[str]
    ) -> list[Person]:
        """The named identities that are in the bound tenant."""
        return await self._people(
            session,
            (ExternalUser.tenant_id == require_tenant_id())
            & ExternalUser.id.in_(list(external_user_ids)),
        )

    async def _people(self, session: AsyncSession, condition: Any) -> list[Person]:
        tenant_id = require_tenant_id()
        # Correlated, so each identity's count is one lookup on
        # `ix_messages_tenant_sender` rather than a count of the whole tenant.
        message_count = (
            select(func.count())
            .select_from(Message)
            .where(
                Message.tenant_id == tenant_id,
                Message.sender_id == Client.transport_user_id,
            )
            .correlate(Client)
            .scalar_subquery()
        )
        rows = (
            await session.execute(
                select(
                    ExternalUser.id,
                    ExternalUser.external_username,
                    ExternalUser.bridge_id,
                    CollaborationBridge.type,
                    CollaborationBridge.display_name,
                    Client.id,
                    Client.transport_user_id,
                    message_count,
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
                .where(condition)
                .order_by(func.lower(ExternalUser.external_username), ExternalUser.id)
            )
        ).all()

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

    async def list_former_participants(
        self, session: AsyncSession
    ) -> list[FormerParticipant]:
        """Everyone in the bound tenant whose messages remain but whose identity
        went with a disconnected chat app."""
        return await self._former(session, None)

    async def former_with_ids(
        self, session: AsyncSession, sender_ids: Collection[str]
    ) -> list[FormerParticipant]:
        """The named former participants that are in the bound tenant."""
        return await self._former(session, list(sender_ids))

    async def _former(
        self, session: AsyncSession, sender_ids: list[str] | None
    ) -> list[FormerParticipant]:
        tenant_id = require_tenant_id()
        has_client = (
            select(Client.id)
            .where(Client.transport_user_id == Message.sender_id)
            .correlate(Message)
            .exists()
        )
        query = (
            select(
                Message.sender_id,
                func.count(),
                func.array_agg(func.distinct(Message.sender_name)),
            )
            .where(
                Message.tenant_id == tenant_id,
                Message.sender_id.regexp_match(HUMAN_SENDER_PATTERN),
                ~has_client,
            )
            .group_by(Message.sender_id)
            .order_by(Message.sender_id)
        )
        if sender_ids is not None:
            query = query.where(Message.sender_id.in_(sender_ids))
        rows = (await session.execute(query)).all()
        former = []
        for sender_id, count, names in rows:
            match = _HUMAN_SENDER.match(sender_id)
            assert match is not None
            former.append(
                FormerParticipant(
                    sender_id=sender_id,
                    names=sorted(n for n in names if n),
                    platform=match.group(1),
                    message_count=int(count),
                )
            )
        return former

    async def queue(
        self,
        session: AsyncSession,
        *,
        external_user_ids: list[str],
        former_sender_ids: list[str],
        requested_by_user_id: str,
    ) -> PersonErasure:
        """Queue the erasure of these identities, or raise.

        Locks the tenant's erasure queue for the transaction, so two owners
        asking at once cannot both pass the "nothing already queued" check.
        """
        tenant_id = require_tenant_id()
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('person_erasures:' || :t))"),
            {"t": tenant_id},
        )
        known = set(
            (
                await session.execute(
                    select(ExternalUser.id).where(
                        ExternalUser.tenant_id == tenant_id,
                        ExternalUser.id.in_(external_user_ids),
                    )
                )
            ).scalars()
        )
        if former_sender_ids:
            known |= {
                f.sender_id
                for f in await self.former_with_ids(session, former_sender_ids)
            }
        unknown = (set(external_user_ids) | set(former_sender_ids)) - known
        if unknown:
            raise UnknownIdentity(", ".join(sorted(unknown)))
        overlaps = []
        for column, ids in (
            (PersonErasure.external_user_ids, external_user_ids),
            (PersonErasure.former_sender_ids, former_sender_ids),
        ):
            if ids:
                overlaps.append(column.op("?|")(cast_(array(ids), ARRAY(Text))))
        overlapping = await session.scalar(
            select(func.count())
            .select_from(PersonErasure)
            .where(
                PersonErasure.tenant_id == tenant_id,
                PersonErasure.state.in_(ACTIVE_STATES),
                or_(*overlaps),
            )
        )
        if overlapping:
            raise ErasureAlreadyQueued()
        erasure = PersonErasure(
            external_user_ids=list(external_user_ids),
            former_sender_ids=list(former_sender_ids),
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

    async def claim_next(
        self, session: AsyncSession, now: datetime
    ) -> PersonErasure | None:
        """Claim the oldest request to work: a queued one, or a running one whose
        process stopped recording progress. Marks it running in the same
        statement, and skips a row another process holds, so two processes
        overlapping in a deploy cannot both work one request."""
        tenant_id = require_tenant_id()
        candidate = (
            select(PersonErasure.id)
            .where(
                PersonErasure.tenant_id == tenant_id,
                (PersonErasure.state == "queued")
                | (
                    (PersonErasure.state == "running")
                    & (PersonErasure.updated_at < now - STALE_RUNNING)
                ),
            )
            .order_by(PersonErasure.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
            .scalar_subquery()
        )
        result = await session.execute(
            update(PersonErasure)
            .where(PersonErasure.tenant_id == tenant_id, PersonErasure.id == candidate)
            .values(state="running", updated_at=now, error=None)
            .returning(PersonErasure),
            execution_options={"populate_existing": True},
        )
        return result.scalar_one_or_none()

    async def add_progress(
        self,
        session: AsyncSession,
        erasure_id: str,
        *,
        messages: int,
        files: int,
        identities: int,
    ) -> None:
        """Add to the request's counts, in the transaction that did the work, so
        a resumed request neither loses nor double-counts what was done."""
        await session.execute(
            update(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
            .values(
                messages_deleted=PersonErasure.messages_deleted + messages,
                files_deleted=PersonErasure.files_deleted + files,
                identities_erased=PersonErasure.identities_erased + identities,
                updated_at=func.now(),
            )
        )

    async def finish(
        self, session: AsyncSession, erasure_id: str, *, error: str | None
    ) -> PersonErasure:
        """Mark the request done, or failed with `error`."""
        result = await session.execute(
            update(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
            .values(
                state="failed" if error is not None else "done",
                error=error,
                completed_at=datetime.now(UTC),
            )
            .returning(PersonErasure),
            execution_options={"populate_existing": True},
        )
        return result.scalar_one()

    async def delete_hosted_copies(
        self, session: AsyncSession, transport_event_ids: Collection[str]
    ) -> None:
        """Delete the copies of these (deleted) messages held for hosted agents:
        deliveries not yet admitted, and items a cutover would import."""
        if not transport_event_ids:
            return
        ids = list(transport_event_ids)
        await session.execute(
            delete(HostedWakeMailbox).where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.message_id.in_(ids),
            )
        )
        await session.execute(
            delete(HostedCutoverItem).where(
                HostedCutoverItem.tenant_id == require_tenant_id(),
                HostedCutoverItem.message_id.in_(ids),
            )
        )

    async def scrub_approval_answers(
        self, session: AsyncSession, transport_user_id: str
    ) -> int:
        """Replace this participant's name on every approval answer they gave,
        and drop the words they typed into it. Which options they picked is
        kept: it is the agent's record of what it was told to do."""
        result = await session.execute(
            update(ApprovalRequest)
            .where(
                ApprovalRequest.tenant_id == require_tenant_id(),
                ApprovalRequest.answered_by == transport_user_id,
            )
            .values(
                answered_by=ERASED_ANSWERER,
                answers=text(
                    "(SELECT jsonb_agg(a - 'custom_text') "
                    "FROM jsonb_array_elements(answers) a)"
                ),
            )
        )
        return _rowcount(result)

    async def scrub_direct_rooms(self, session: AsyncSession, person: Person) -> int:
        """Take this person's name out of the direct rooms they were in.

        A direct room is named after the person and the agent when the bridge
        adopts it. Must run while their room memberships still stand.
        """
        member_of = select(ClientRoom.room_id).where(
            ClientRoom.tenant_id == require_tenant_id(),
            ClientRoom.client_id == person.client_id,
        )
        return await self._scrub_direct_rooms(
            session, Room.id.in_(member_of), [person.username]
        )

    async def scrub_former_direct_rooms(
        self, session: AsyncSession, room_ids: Collection[str], names: Collection[str]
    ) -> int:
        """Take a former participant's names out of the direct rooms among
        `room_ids`, the rooms their messages were deleted from. Their room
        memberships went with their client, so these are what is left to say
        which rooms were theirs."""
        if not room_ids or not names:
            return 0
        return await self._scrub_direct_rooms(
            session, Room.id.in_(list(room_ids)), list(names)
        )

    async def _scrub_direct_rooms(
        self, session: AsyncSession, which: Any, names: list[str]
    ) -> int:
        rooms = (
            await session.execute(
                select(Room).where(
                    Room.tenant_id == require_tenant_id(),
                    Room.channel_type == "direct",
                    which,
                )
            )
        ).scalars()
        scrubbed = 0
        # Longest first, so a name that contains another is replaced whole.
        ordered = sorted(names, key=len, reverse=True)
        for room in rooms:
            name, description = room.name, room.description
            for person_name in ordered:
                name = name.replace(person_name, ERASED_NAME)
                description = description.replace(person_name, ERASED_NAME)
            if (name, description) != (room.name, room.description):
                room.name, room.description = name, description
                scrubbed += 1
        await session.flush()
        return scrubbed

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
        """Delete the stored files among `uris` that nothing refers to now.

        Unlike the hourly sweep this has no grace period: these files are known
        to have been attached to the erased person's messages, so none is an
        upload still waiting for its message.
        """
        if not uris:
            return 0
        result = await session.execute(
            text(
                f"""
                DELETE FROM media_blobs b
                WHERE b.tenant_id = :t AND b.uri = ANY(:uris)
                  AND {UNREFERENCED_BLOB}
                """
            ),
            {"t": require_tenant_id(), "uris": list(uris)},
        )
        return _rowcount(result)

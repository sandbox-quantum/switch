"""Erasing a person: who can be erased, the request queue, and the deletions
that are not messages, for the bound tenant.

A person in a room is a chat-platform identity: an `external_users` row on
one bridge, standing behind a `clients` row that is the room participant.
One person seen on two platforms is two identities. Someone who takes part
from Switch Console does so through a member client instead, one per account
per workspace. Message deletion itself is `MessageStore.delete_sent_by`,
which keeps the room's numbering intact.

Also the renaming a deleted account's messages get (`FORMER_MEMBER_NAME`,
used by `accounts/deletion.py`).
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
    type_coerce,
    update,
)
from sqlalchemy import cast as cast_
from sqlalchemy.dialects.postgresql import JSONB, array
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    ApprovalRequest,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Message,
    PersonErasure,
    Room,
    User,
    require_tenant_id,
)
from switch_core.db.stores.retention_store import RetentionStore

#: What `answered_by` reads once the person who answered has been erased.
ERASED_ANSWERER = "erased"
#: What stands in for an erased person's name in a direct room's name.
ERASED_NAME = "erased person"
#: The name a deleted account's messages, and the member client that sent
#: them, carry from then on.
FORMER_MEMBER_NAME = "Former member"
#: The shortest name taken out of a direct room's name and description. A
#: single character, even as a whole word, is as likely to be something else
#: in the text as the person; the room keeps it rather than lose its sense.
MIN_SCRUBBED_NAME_LENGTH = 2
#: How Switch Console describes a chat it creates (`ChatService`): this,
#: then the agents and people in it, joined by `CONSOLE_CHAT_SEPARATOR`.
CONSOLE_CHAT_PREFIX = "Switch Console chat with "
CONSOLE_CHAT_SEPARATOR = ", "

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


@dataclass(frozen=True)
class Member:
    """Someone who took part in rooms from Switch Console, through their
    member client. `user_id` is None once their account has been deleted,
    and `name` is then `FORMER_MEMBER_NAME`."""

    client_id: str
    transport_user_id: str
    name: str
    user_id: str | None
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

    async def list_members(self, session: AsyncSession) -> list[Member]:
        """Every member client in the bound tenant."""
        return await self._members(session, None)

    async def members_with_ids(
        self, session: AsyncSession, client_ids: Collection[str]
    ) -> list[Member]:
        """The named member clients that are in the bound tenant."""
        return await self._members(session, list(client_ids))

    async def _members(
        self, session: AsyncSession, client_ids: list[str] | None
    ) -> list[Member]:
        tenant_id = require_tenant_id()
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
        query = (
            select(
                Client.id,
                Client.transport_user_id,
                Client.display_name,
                Client.user_id,
                message_count,
            )
            .where(Client.tenant_id == tenant_id, Client.type == MEMBER_CLIENT_TYPE)
            .order_by(func.lower(Client.display_name), Client.id)
        )
        if client_ids is not None:
            query = query.where(Client.id.in_(client_ids))
        return [
            Member(
                client_id=row[0],
                transport_user_id=row[1],
                name=row[2],
                user_id=row[3],
                message_count=int(row[4]),
            )
            for row in (await session.execute(query)).all()
        ]

    async def queue(
        self,
        session: AsyncSession,
        *,
        external_user_ids: list[str],
        former_sender_ids: list[str],
        member_client_ids: list[str],
        requested_by_user_id: str,
    ) -> PersonErasure:
        """Queue the erasure of these identities, or raise.

        Locks the tenant's erasure queue for the transaction, so two admins
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
        if member_client_ids:
            known |= {
                m.client_id
                for m in await self.members_with_ids(session, member_client_ids)
            }
        unknown = (
            set(external_user_ids) | set(former_sender_ids) | set(member_client_ids)
        ) - known
        if unknown:
            raise UnknownIdentity(", ".join(sorted(unknown)))
        overlaps = []
        for column, ids in (
            (PersonErasure.external_user_ids, external_user_ids),
            (PersonErasure.former_sender_ids, former_sender_ids),
            (PersonErasure.member_client_ids, member_client_ids),
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
            member_client_ids=list(member_client_ids),
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
        patterns = [
            _whole_name(person_name)
            for person_name in sorted(names, key=len, reverse=True)
            if len(person_name) >= MIN_SCRUBBED_NAME_LENGTH
        ]
        for room in rooms:
            name, description = room.name, room.description
            for pattern in patterns:
                name = pattern.sub(ERASED_NAME, name)
                description = pattern.sub(ERASED_NAME, description)
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

    async def remember_files(
        self, session: AsyncSession, erasure_id: str, uris: Collection[str]
    ) -> None:
        """Keep `uris`, the files of messages this request just deleted, on the
        request until `delete_remembered_files`, in the transaction that
        deleted the messages."""
        if not uris:
            return
        await session.execute(
            update(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
            .values(
                pending_file_uris=PersonErasure.pending_file_uris.op("||")(
                    type_coerce(sorted(uris), JSONB)
                )
            )
        )

    async def delete_remembered_files(
        self, session: AsyncSession, erasure_id: str
    ) -> int:
        """Delete the files the request remembered that nothing refers to now,
        and forget them all. Returns how many were deleted."""
        uris = await session.scalar(
            select(PersonErasure.pending_file_uris).where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
        )
        if not uris:
            return 0
        deleted = await self.delete_unreferenced_media(session, set(uris))
        await session.execute(
            update(PersonErasure)
            .where(
                PersonErasure.tenant_id == require_tenant_id(),
                PersonErasure.id == erasure_id,
            )
            .values(pending_file_uris=type_coerce([], JSONB))
        )
        return deleted

    async def rooms_sent_in(self, session: AsyncSession, sender_id: str) -> set[str]:
        """The bound tenant's rooms holding a message from `sender_id`."""
        return set(
            (
                await session.execute(
                    select(Message.room_id)
                    .where(
                        Message.tenant_id == require_tenant_id(),
                        Message.sender_id == sender_id,
                    )
                    .distinct()
                )
            ).scalars()
        )

    async def delete_unreferenced_media(
        self, session: AsyncSession, uris: Collection[str]
    ) -> int:
        """Delete the stored files among `uris` that nothing refers to now.

        Unlike the hourly sweep this has no grace period: these files are known
        to have been attached to the erased person's messages, so none is an
        upload still waiting for its message.
        """
        return await RetentionStore().delete_unreferenced_files(session, uris)

    async def member_client_of(
        self, session: AsyncSession, user_id: str
    ) -> Client | None:
        """The member client through which `user_id` takes part in the bound
        tenant's rooms from Switch Console, if they ever have."""
        return (
            await session.execute(
                select(Client).where(
                    Client.tenant_id == require_tenant_id(),
                    Client.user_id == user_id,
                    Client.type == MEMBER_CLIENT_TYPE,
                )
            )
        ).scalar_one_or_none()

    async def rename_sent_by(
        self, session: AsyncSession, *, transport_user_id: str, name: str, limit: int
    ) -> int:
        """Give up to `limit` of this sender's messages `name` as their sender's
        name, in the column and in the stored event (`sender_name`, and the
        `user_name` a command carries), and return how many changed.

        Rows already named so are skipped, so repeating this until it returns
        less than `limit` renames every one. Only the sender's own rows
        change: someone else quoting or mentioning them keeps their words.
        """
        result = await session.execute(
            text(
                """
                UPDATE messages m SET
                    sender_name = :name,
                    content = CASE WHEN m.content ? 'user_name'
                        THEN jsonb_set(named.content, '{user_name}', to_jsonb(CAST(:name AS text)))
                        ELSE named.content END
                FROM (
                    SELECT id, CASE WHEN content ? 'sender_name'
                        THEN jsonb_set(content, '{sender_name}', to_jsonb(CAST(:name AS text)))
                        ELSE content END AS content
                    FROM messages
                    WHERE tenant_id = :t AND sender_id = :sender
                      AND (sender_name IS DISTINCT FROM :name
                           OR (content ? 'sender_name' AND content->>'sender_name' IS DISTINCT FROM :name)
                           OR (content ? 'user_name' AND content->>'user_name' IS DISTINCT FROM :name))
                    ORDER BY id
                    LIMIT :limit
                ) named
                WHERE m.id = named.id
                """
            ),
            {
                "t": require_tenant_id(),
                "sender": transport_user_id,
                "name": name,
                "limit": limit,
            },
        )
        return _rowcount(result)

    async def rename_agent_copies(
        self, session: AsyncSession, *, transport_user_id: str, name: str
    ) -> int:
        """Give this participant `name` in the copies of events stored for
        agents (`agent_events`): as the sender of a message, the issuer of a
        command, or the member who joined."""
        result = await session.execute(
            text(
                """
                UPDATE agent_events SET payload = CASE
                    WHEN payload->'payload'->>'sender' = :who
                         AND payload->'payload' ? 'sender_name'
                        THEN jsonb_set(payload, '{payload,sender_name}', to_jsonb(CAST(:name AS text)))
                    WHEN payload->'payload'->>'user_id' = :who
                         AND payload->'payload' ? 'user_name'
                        THEN jsonb_set(payload, '{payload,user_name}', to_jsonb(CAST(:name AS text)))
                    WHEN payload->'payload'->>'member' = :who
                         AND payload->'payload' ? 'member_name'
                        THEN jsonb_set(payload, '{payload,member_name}', to_jsonb(CAST(:name AS text)))
                    ELSE payload END
                WHERE tenant_id = :t
                  AND (payload->'payload'->>'sender' = :who
                       OR payload->'payload'->>'user_id' = :who
                       OR payload->'payload'->>'member' = :who)
                """
            ),
            {"t": require_tenant_id(), "who": transport_user_id, "name": name},
        )
        return _rowcount(result)

    async def rename_in_console_chats(
        self,
        session: AsyncSession,
        *,
        client_id: str,
        old_names: Collection[str],
        name: str,
    ) -> int:
        """Replace `old_names` with `name` in the descriptions Switch Console
        gave the chats this client is in, which list who was in each. Must
        run while the client's room memberships still stand. A name is
        replaced only as a whole entry of that list, never inside another
        name or anything a person wrote."""
        member_of = select(ClientRoom.room_id).where(
            ClientRoom.tenant_id == require_tenant_id(),
            ClientRoom.client_id == client_id,
        )
        rooms = (
            await session.execute(
                select(Room).where(
                    Room.tenant_id == require_tenant_id(),
                    Room.id.in_(member_of),
                    Room.description.startswith(CONSOLE_CHAT_PREFIX, autoescape=True),
                )
            )
        ).scalars()
        replaced = set(old_names)
        renamed = 0
        for room in rooms:
            entries = room.description.removeprefix(CONSOLE_CHAT_PREFIX).split(
                CONSOLE_CHAT_SEPARATOR
            )
            updated = [name if entry in replaced else entry for entry in entries]
            if updated != entries:
                room.description = CONSOLE_CHAT_PREFIX + CONSOLE_CHAT_SEPARATOR.join(
                    updated
                )
                renamed += 1
        await session.flush()
        return renamed

    async def retire_member_client(
        self, session: AsyncSession, client_id: str, name: str
    ) -> None:
        """Rename a deleted account's member client to `name` and unlink it
        from the account. The client stays, as the sender its messages name."""
        await session.execute(
            update(Client)
            .where(Client.tenant_id == require_tenant_id(), Client.id == client_id)
            .values(display_name=name, user_id=None)
        )


def _whole_name(name: str) -> re.Pattern[str]:
    """`name` where it stands as a word of its own, so "al" leaves "Albert"
    and "dial" alone."""
    return re.compile(rf"(?<!\w){re.escape(name)}(?!\w)")

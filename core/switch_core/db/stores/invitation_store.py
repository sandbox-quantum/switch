from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Invitation

_TOKEN_BYTES = 32


class InvitationNotUsableError(Exception):
    """An invitation was asked to grant membership and could not.

    Raised rather than returned as `None`, because the three ways to get here
    — revoked, expired, spent — are all states a caller has to answer for
    rather than states it can usefully retry or ignore. Also raised when the
    invitation does not exist at all, or belongs to a tenant this session is
    not bound to: the row-level-security policy makes those indistinguishable
    from the outside, which is the point of it.
    """


def _usable() -> ColumnElement[bool]:
    """The three independent gates on an invitation, as one predicate.

    Written once and shared by everything that asks the question, because
    three gates hand-rolled per call site is how the second call site ends up
    checking two. Postgres evaluates it — expiry against the database's clock,
    not the caller's — so `consume` can decide and decrement in one statement.
    """
    return and_(
        Invitation.revoked_at.is_(None),
        Invitation.expires_at > func.now(),
        Invitation.uses_remaining > 0,
    )


def generate_invitation_token() -> tuple[str, str]:
    """A fresh invitation token and the hash that is all Switch ever stores.

    The plaintext lives only in the tuple this returns. Nothing keeps a
    second copy of it: `Invitation` has no column for it, so there is nothing
    on the row — and therefore nothing a query, a log line, or a repr of that
    row could leak — beyond the hash. A caller that loses the plaintext has
    to revoke and mint again, the same as a lost API key.
    """
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    return token, hashlib.sha256(token.encode()).hexdigest()


class InvitationStore:
    async def create(
        self,
        session: AsyncSession,
        *,
        role: str,
        email: str | None,
        expires_at: datetime,
        uses_remaining: int,
        created_by: str,
    ) -> tuple[Invitation, str]:
        """Mint an invitation, returning the row and its plaintext token.

        The token is generated here, inside the one call that can hand it
        back — never before, never separately, and never assigned to the row
        that persists. A caller that needs to show the token to whoever it
        invited must do so from this call's return value; there is no later
        read that will give it back.
        """
        token, token_hash = generate_invitation_token()
        invitation = Invitation(
            role=role,
            email=email,
            token_hash=token_hash,
            expires_at=expires_at,
            uses_remaining=uses_remaining,
            created_by=created_by,
        )
        session.add(invitation)
        await session.flush()
        return invitation, token

    async def get_by_token_hash(
        self, session: AsyncSession, token_hash: str
    ) -> Invitation | None:
        """The invitation named by a token's hash.

        Called on a session already bound to the invitation's tenant —
        resolved first through `db/tenant_lookup.py`'s `tenant_of_invitation`,
        the same two-step shape a bearer token's own resolution takes. Row-
        level security refuses this read on a session with nothing bound.
        """
        result = await session.execute(
            select(Invitation).where(Invitation.token_hash == token_hash)
        )
        return result.scalar_one_or_none()

    async def get_valid_by_token_hash(
        self, session: AsyncSession, token_hash: str
    ) -> Invitation | None:
        """The invitation named by a token's hash, if it is still usable.

        What `get_by_token_hash` finds says nothing about whether the token
        still works: a revoked, expired or spent invitation is an ordinary row
        and reads back like any other. This is the read for anyone about to
        act on one — showing the invitee what they were invited to, say —
        and it answers with the same predicate `consume` enforces.

        A `None` here is not permission to skip `consume`'s own check. The row
        can be spent between the two by whoever else holds the same link;
        `consume` is where that race is settled.
        """
        result = await session.execute(
            select(Invitation).where(Invitation.token_hash == token_hash, _usable())
        )
        return result.scalar_one_or_none()

    async def consume(self, session: AsyncSession, invitation_id: str) -> Invitation:
        """Spend one use of an invitation, or refuse.

        One conditional `UPDATE`: the gates are in the `WHERE`, so the row is
        checked and decremented in the same statement and Postgres arbitrates
        between concurrent acceptances. Read-then-write cannot do that — two
        acceptances of a single-use invitation both read `1`, both write `0`,
        both commit, and one invite grants two memberships.

        No row updated means no usable invitation was there to update, which
        is what `InvitationNotUsableError` reports.
        """
        result = await session.execute(
            update(Invitation)
            .where(Invitation.id == invitation_id, _usable())
            .values(uses_remaining=Invitation.uses_remaining - 1)
            .returning(Invitation)
            .execution_options(populate_existing=True)
        )
        invitation = result.scalar_one_or_none()
        if invitation is None:
            raise InvitationNotUsableError(
                f"Invitation {invitation_id} is revoked, expired, spent, or not "
                "visible to this session"
            )
        return invitation

    async def list_for_tenant(self, session: AsyncSession) -> list[Invitation]:
        """Every invitation of the session's bound tenant.

        No `WHERE tenant_id = …` of its own: the policy is what narrows this,
        the same as every other listing in this package.
        """
        result = await session.execute(
            select(Invitation).order_by(Invitation.created_at)
        )
        return list(result.scalars().all())

    async def count_addressed_since(
        self, session: AsyncSession, since: datetime
    ) -> int:
        """How many of the bound tenant's invitations named an e-mail and were
        minted after `since` — the measure the daily e-mail cap is kept on.
        Per tenant through the policy, like `list_for_tenant`."""
        result = await session.execute(
            select(func.count())
            .select_from(Invitation)
            .where(Invitation.email.is_not(None), Invitation.created_at > since)
        )
        return int(result.scalar_one())

    async def revoke(self, session: AsyncSession, invitation_id: str) -> Invitation:
        invitation = await session.get(Invitation, invitation_id)
        if invitation is None:
            raise ValueError(f"Invitation not found: {invitation_id}")
        invitation.revoked_at = datetime.now(UTC)
        await session.flush()
        return invitation

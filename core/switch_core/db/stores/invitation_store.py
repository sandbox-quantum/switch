from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Invitation

_TOKEN_BYTES = 32


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

    async def list_for_tenant(self, session: AsyncSession) -> list[Invitation]:
        """Every invitation of the session's bound tenant.

        No `WHERE tenant_id = …` of its own: the policy is what narrows this,
        the same as every other listing in this package.
        """
        result = await session.execute(
            select(Invitation).order_by(Invitation.created_at)
        )
        return list(result.scalars().all())

    async def revoke(self, session: AsyncSession, invitation_id: str) -> Invitation:
        invitation = await session.get(Invitation, invitation_id)
        if invitation is None:
            raise ValueError(f"Invitation not found: {invitation_id}")
        invitation.revoked_at = datetime.now(UTC)  # type: ignore[assignment]
        await session.flush()
        return invitation

    async def consume(
        self, session: AsyncSession, invitation: Invitation
    ) -> Invitation:
        """Record one use of `invitation`.

        Called only after every validity check (expiry, revocation, email,
        remaining uses) has already passed; it does not repeat any of them.
        """
        invitation.uses_remaining -= 1
        await session.flush()
        return invitation

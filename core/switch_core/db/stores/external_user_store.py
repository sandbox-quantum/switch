from typing import Any, cast

from sqlalchemy import CursorResult, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ClientRoom, ExternalUser, ExternalUserClaim


class ExternalUserStore:
    async def create(self, session: AsyncSession, user: ExternalUser) -> ExternalUser:
        session.add(user)
        await session.flush()
        return user

    async def get(self, session: AsyncSession, user_id: str) -> ExternalUser | None:
        return await session.get(ExternalUser, user_id)

    async def get_by_external_id(
        self, session: AsyncSession, bridge_id: str, external_user_id: str
    ) -> ExternalUser | None:
        result = await session.execute(
            select(ExternalUser).where(
                ExternalUser.bridge_id == bridge_id,
                ExternalUser.external_user_id == external_user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_bridge(
        self, session: AsyncSession, bridge_id: str
    ) -> list[ExternalUser]:
        result = await session.execute(
            select(ExternalUser).where(ExternalUser.bridge_id == bridge_id)
        )
        return list(result.scalars().all())

    async def get_by_bridge_and_names(
        self, session: AsyncSession, bridge_id: str, usernames: list[str]
    ) -> list[ExternalUser]:
        if not usernames:
            return []
        result = await session.execute(
            select(ExternalUser).where(
                ExternalUser.bridge_id == bridge_id,
                ExternalUser.external_username.in_(usernames),
            )
        )
        return list(result.scalars().all())

    async def get_by_client_id(
        self, session: AsyncSession, client_id: str
    ) -> ExternalUser | None:
        result = await session.execute(
            select(ExternalUser).where(ExternalUser.client_id == client_id)
        )
        return result.scalar_one_or_none()

    async def get_by_room(
        self, session: AsyncSession, room_id: str
    ) -> list[ExternalUser]:
        result = await session.execute(
            select(ExternalUser)
            .join(ClientRoom, ClientRoom.client_id == ExternalUser.client_id)
            .where(ClientRoom.room_id == room_id)
        )
        return list(result.scalars().all())

    async def get_by_user(
        self, session: AsyncSession, switch_user_id: str
    ) -> list[ExternalUser]:
        """Every platform identity claimed by this Switch user, across bridges."""
        result = await session.execute(
            select(ExternalUser)
            .join(
                ExternalUserClaim,
                ExternalUserClaim.external_user_id == ExternalUser.id,
            )
            .where(ExternalUserClaim.user_id == switch_user_id)
        )
        return list(result.scalars().all())

    async def claimant_ids(
        self, session: AsyncSession, external_user_id: str
    ) -> list[str]:
        """The Switch users who have claimed this platform identity.

        More than one is allowed and expected: see `ExternalUserClaim`.
        """
        result = await session.execute(
            select(ExternalUserClaim.user_id).where(
                ExternalUserClaim.external_user_id == external_user_id
            )
        )
        return list(result.scalars().all())

    async def claimant_ids_for(
        self, session: AsyncSession, external_user_ids: list[str]
    ) -> dict[str, list[str]]:
        """`claimant_ids` for several identities at once, to avoid a query per
        row when listing a bridge's users."""
        if not external_user_ids:
            return {}
        result = await session.execute(
            select(ExternalUserClaim.external_user_id, ExternalUserClaim.user_id).where(
                ExternalUserClaim.external_user_id.in_(external_user_ids)
            )
        )
        claims: dict[str, list[str]] = {}
        for external_user_id, user_id in result.all():
            claims.setdefault(external_user_id, []).append(user_id)
        return claims

    async def claim(
        self, session: AsyncSession, external_user: ExternalUser, switch_user_id: str
    ) -> None:
        """Record that a Switch user considers this platform account theirs.

        Idempotent, and never a conflict: claiming an account someone else has
        also claimed is allowed by design. Left to the database rather than a
        read-then-write, so a double-clicked button races to the same row
        instead of to a primary-key violation.
        """
        await session.execute(
            pg_insert(ExternalUserClaim)
            .values(external_user_id=external_user.id, user_id=switch_user_id)
            .on_conflict_do_nothing(index_elements=["external_user_id", "user_id"])
        )
        await session.flush()

    async def release(
        self, session: AsyncSession, external_user: ExternalUser, switch_user_id: str
    ) -> bool:
        """Drop one Switch user's claim, leaving anyone else's in place.

        Returns whether there was a claim to drop, so a caller can tell a real
        unlink from a no-op rather than reporting success either way.
        """
        result = await session.execute(
            delete(ExternalUserClaim).where(
                ExternalUserClaim.external_user_id == external_user.id,
                ExternalUserClaim.user_id == switch_user_id,
            )
        )
        await session.flush()
        return cast("CursorResult[Any]", result).rowcount > 0

    async def delete(self, session: AsyncSession, user_id: str) -> None:
        user = await session.get(ExternalUser, user_id)
        if user:
            await session.delete(user)
            await session.flush()

    async def delete_by_bridge(self, session: AsyncSession, bridge_id: str) -> None:
        await session.execute(
            delete(ExternalUser).where(ExternalUser.bridge_id == bridge_id)
        )
        await session.flush()

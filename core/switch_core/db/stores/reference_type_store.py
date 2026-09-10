from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TENANT_ZERO_ID, Reference, ReferenceType


class ReferenceTypeStore:
    async def create(
        self, session: AsyncSession, reference_type: ReferenceType
    ) -> ReferenceType:
        try:
            # Savepoint: a duplicate slug must not poison the caller's transaction.
            async with session.begin_nested():
                session.add(reference_type)
                await session.flush()
        except IntegrityError as exc:
            # TODO(next PR): scope to the request's tenant instead of matching
            # across all of them.
            clash = await session.execute(
                select(ReferenceType.type).where(
                    ReferenceType.type == reference_type.type
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise ValueError(
                    f"Reference type '{reference_type.type}' already exists"
                ) from exc
            raise
        return reference_type

    async def get(self, session: AsyncSession, type_: str) -> ReferenceType | None:
        # TODO(next PR): use the request's tenant instead of TENANT_ZERO_ID.
        return await session.get(ReferenceType, (TENANT_ZERO_ID, type_))

    async def get_many(
        self, session: AsyncSession, types: list[str]
    ) -> list[ReferenceType]:
        # TODO(next PR): scope to the request's tenant instead of matching
        # across all of them.
        if not types:
            return []
        result = await session.execute(
            select(ReferenceType).where(ReferenceType.type.in_(types))
        )
        return list(result.scalars().all())

    async def list_for_user(
        self, session: AsyncSession, user_id: str | None
    ) -> list[ReferenceType]:
        """Return the types the principal may read.

        An ownerless principal (``user_id is None``) reads public types only: an
        ``owner_id = NULL`` comparison is never true in SQL, so it is left out
        rather than relied on.
        """
        # TODO(next PR): scope to the request's tenant instead of matching
        # across all of them.
        condition: ColumnElement[bool]
        if user_id is None:
            condition = ReferenceType.read_visibility == "public"
        else:
            condition = or_(
                ReferenceType.owner_id == user_id,
                ReferenceType.read_visibility == "public",
            )
        result = await session.execute(select(ReferenceType).where(condition))
        return list(result.scalars().all())

    async def list_all(self, session: AsyncSession) -> list[ReferenceType]:
        # TODO(next PR): scope to the request's tenant instead of matching
        # across all of them.
        result = await session.execute(select(ReferenceType))
        return list(result.scalars().all())

    async def update_fields(
        self,
        session: AsyncSession,
        type_: str,
        *,
        display_name: str | None = None,
        instructions: str | None = None,
        value_hint: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> ReferenceType:
        # TODO(next PR): use the request's tenant instead of TENANT_ZERO_ID.
        rt = await session.get(ReferenceType, (TENANT_ZERO_ID, type_))
        if rt is None:
            raise ValueError(f"Reference type not found: {type_}")
        if display_name is not None:
            rt.display_name = display_name
        if instructions is not None:
            rt.instructions = instructions
        if value_hint is not None:
            rt.value_hint = value_hint
        if read_visibility is not None:
            rt.read_visibility = read_visibility
        if write_visibility is not None:
            rt.write_visibility = write_visibility
        await session.flush()
        return rt

    async def delete(self, session: AsyncSession, type_: str) -> None:
        # TODO(next PR): use the request's tenant instead of TENANT_ZERO_ID.
        rt = await session.get(ReferenceType, (TENANT_ZERO_ID, type_))
        if rt is None:
            raise ValueError(f"Reference type not found: {type_}")
        await session.delete(rt)
        await session.flush()

    async def count_references_of_type(self, session: AsyncSession, type_: str) -> int:
        result = await session.execute(
            select(func.count()).select_from(Reference).where(Reference.type == type_)
        )
        return int(result.scalar_one())

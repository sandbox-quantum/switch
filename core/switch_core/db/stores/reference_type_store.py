"""Customer-defined reference types, which are per tenant and read as such.

Every method here names the bound tenant rather than leaving the filter to
row-level security, and that is deliberate rather than belt-and-braces.
`reference_types` is the one scoped table whose primary key *is* `(tenant_id,
type)`, so a `session.get` has to supply the tenant to address a row at all;
having only some of the methods name it, and the rest inherit a policy that
is still inert against the owner connection every environment uses today (see
`docs/old/multi-tenancy-phase1-db.md`, "The runtime role"), is how a read and
a write end up disagreeing about which rows exist.
"""

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Reference, ReferenceType, require_tenant_id


class ReferenceTypeStore:
    async def create(
        self, session: AsyncSession, reference_type: ReferenceType
    ) -> ReferenceType:
        if reference_type.tenant_id is None:
            # Named here rather than left to the column default, because the
            # savepoint below undoes the default too: rolling it back restores
            # the instance to its pre-flush state, and the clash lookup would
            # then have no tenant to look in and report a real duplicate as an
            # unexplained IntegrityError.
            reference_type.tenant_id = require_tenant_id()
        try:
            # Savepoint: a duplicate slug must not poison the caller's transaction.
            async with session.begin_nested():
                session.add(reference_type)
                await session.flush()
        except IntegrityError as exc:
            # The row's own tenant, not the bound one: a caller may pass a
            # `ReferenceType` it addressed explicitly, and reporting a clash
            # against some other tenant's slug would be a lie either way.
            clash = await session.execute(
                select(ReferenceType.type).where(
                    ReferenceType.tenant_id == reference_type.tenant_id,
                    ReferenceType.type == reference_type.type,
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise ValueError(
                    f"Reference type '{reference_type.type}' already exists"
                ) from exc
            raise
        return reference_type

    async def get(self, session: AsyncSession, type_: str) -> ReferenceType | None:
        return await session.get(ReferenceType, (require_tenant_id(), type_))

    async def get_many(
        self, session: AsyncSession, types: list[str]
    ) -> list[ReferenceType]:
        if not types:
            return []
        result = await session.execute(
            select(ReferenceType).where(
                ReferenceType.tenant_id == require_tenant_id(),
                ReferenceType.type.in_(types),
            )
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
        condition: ColumnElement[bool]
        if user_id is None:
            condition = ReferenceType.read_visibility == "public"
        else:
            condition = or_(
                ReferenceType.owner_id == user_id,
                ReferenceType.read_visibility == "public",
            )
        result = await session.execute(
            select(ReferenceType).where(
                ReferenceType.tenant_id == require_tenant_id(), condition
            )
        )
        return list(result.scalars().all())

    async def list_all(self, session: AsyncSession) -> list[ReferenceType]:
        """Every type in the bound tenant — "all" as an admin means it, not
        every customer's."""
        result = await session.execute(
            select(ReferenceType).where(ReferenceType.tenant_id == require_tenant_id())
        )
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
        rt = await session.get(ReferenceType, (require_tenant_id(), type_))
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
        rt = await session.get(ReferenceType, (require_tenant_id(), type_))
        if rt is None:
            raise ValueError(f"Reference type not found: {type_}")
        await session.delete(rt)
        await session.flush()

    async def count_references_of_type(self, session: AsyncSession, type_: str) -> int:
        """How many references of this slug the bound tenant holds.

        Scoped for the same reason the reads above are: this decides whether a
        type may be deleted, and counting another tenant's references would
        refuse a deletion that is perfectly safe here.
        """
        result = await session.execute(
            select(func.count())
            .select_from(Reference)
            .where(Reference.tenant_id == require_tenant_id(), Reference.type == type_)
        )
        return int(result.scalar_one())

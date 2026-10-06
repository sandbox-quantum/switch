from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Package,
    Room,
    package_documents,
    package_references,
    room_documents,
    room_packages,
    room_references,
)


class PackageStore:
    async def create(self, session: AsyncSession, package: Package) -> Package:
        session.add(package)
        await session.flush()
        return package

    async def get(self, session: AsyncSession, package_id: str) -> Package | None:
        return await session.get(Package, package_id)

    async def list_for_user(self, session: AsyncSession, user_id: str) -> list[Package]:
        result = await session.execute(
            select(Package).where(
                or_(
                    Package.owner_id == user_id,
                    Package.read_visibility == "public",
                )
            )
        )
        return list(result.scalars().all())

    async def update_fields(
        self,
        session: AsyncSession,
        package_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> Package:
        pkg = await session.get(Package, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        if name is not None:
            pkg.name = name
        if description is not None:
            pkg.description = description
        if instructions is not None:
            pkg.instructions = instructions
        if read_visibility is not None:
            pkg.read_visibility = read_visibility
        if write_visibility is not None:
            pkg.write_visibility = write_visibility
        await session.flush()
        return pkg

    async def delete(self, session: AsyncSession, package_id: str) -> list[str]:
        room_id_result = await session.execute(
            select(room_packages.c.room_id).where(
                room_packages.c.package_id == package_id
            )
        )
        affected_rooms = list(room_id_result.scalars().all())
        await session.execute(
            delete(room_packages).where(room_packages.c.package_id == package_id)
        )
        await session.execute(
            delete(package_references).where(
                package_references.c.package_id == package_id
            )
        )
        await session.execute(
            delete(package_documents).where(
                package_documents.c.package_id == package_id
            )
        )
        pkg = await session.get(Package, package_id)
        if pkg:
            await session.delete(pkg)
        await session.flush()
        return affected_rooms

    async def attach_to_room(
        self, session: AsyncSession, room_id: str, package_id: str
    ) -> None:
        await session.execute(
            insert(room_packages).values(room_id=room_id, package_id=package_id)
        )
        await session.flush()

    async def detach_from_room(
        self, session: AsyncSession, room_id: str, package_id: str
    ) -> None:
        await session.execute(
            delete(room_packages).where(
                room_packages.c.room_id == room_id,
                room_packages.c.package_id == package_id,
            )
        )
        await session.flush()

    async def list_for_room(self, session: AsyncSession, room_id: str) -> list[Package]:
        result = await session.execute(
            select(Package)
            .join(room_packages, Package.id == room_packages.c.package_id)
            .where(room_packages.c.room_id == room_id)
        )
        return list(result.scalars().all())

    async def is_attached_to_room(
        self, session: AsyncSession, room_id: str, package_id: str
    ) -> bool:
        result = await session.execute(
            select(room_packages.c.room_id).where(
                room_packages.c.room_id == room_id,
                room_packages.c.package_id == package_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def get_attached_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        if not package_ids:
            return {}
        result = await session.execute(
            select(
                room_packages.c.package_id,
                func.count(room_packages.c.room_id),
            )
            .where(room_packages.c.package_id.in_(package_ids))
            .group_by(room_packages.c.package_id)
        )
        counts = {pid: int(c) for pid, c in result.all()}
        return {pid: counts.get(pid, 0) for pid in package_ids}

    async def get_reference_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        if not package_ids:
            return {}
        result = await session.execute(
            select(
                package_references.c.package_id,
                func.count(package_references.c.reference_id),
            )
            .where(package_references.c.package_id.in_(package_ids))
            .group_by(package_references.c.package_id)
        )
        counts = {pid: int(c) for pid, c in result.all()}
        return {pid: counts.get(pid, 0) for pid in package_ids}

    async def get_document_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        if not package_ids:
            return {}
        result = await session.execute(
            select(
                package_documents.c.package_id,
                func.count(package_documents.c.document_id),
            )
            .where(package_documents.c.package_id.in_(package_ids))
            .group_by(package_documents.c.package_id)
        )
        counts = {pid: int(c) for pid, c in result.all()}
        return {pid: counts.get(pid, 0) for pid in package_ids}

    async def list_rooms_for_package(
        self, session: AsyncSession, package_id: str
    ) -> list[tuple[str, str]]:
        result = await session.execute(
            select(Room.id, Room.name)
            .join(room_packages, Room.id == room_packages.c.room_id)
            .where(room_packages.c.package_id == package_id)
        )
        return [(rid, name) for rid, name in result.all()]

    # ── Membership ────────────────────────────────────────────────────────

    async def add_reference(
        self, session: AsyncSession, package_id: str, reference_id: str
    ) -> None:
        await session.execute(
            insert(package_references).values(
                package_id=package_id, reference_id=reference_id
            )
        )
        await session.flush()

    async def remove_reference(
        self, session: AsyncSession, package_id: str, reference_id: str
    ) -> None:
        await session.execute(
            delete(package_references).where(
                package_references.c.package_id == package_id,
                package_references.c.reference_id == reference_id,
            )
        )
        await session.flush()

    async def add_document(
        self, session: AsyncSession, package_id: str, document_id: str
    ) -> None:
        await session.execute(
            insert(package_documents).values(
                package_id=package_id, document_id=document_id
            )
        )
        await session.flush()

    async def remove_document(
        self, session: AsyncSession, package_id: str, document_id: str
    ) -> None:
        await session.execute(
            delete(package_documents).where(
                package_documents.c.package_id == package_id,
                package_documents.c.document_id == document_id,
            )
        )
        await session.flush()

    async def list_reference_ids_for_package(
        self, session: AsyncSession, package_id: str
    ) -> list[str]:
        result = await session.execute(
            select(package_references.c.reference_id).where(
                package_references.c.package_id == package_id
            )
        )
        return list(result.scalars().all())

    async def list_document_ids_for_package(
        self, session: AsyncSession, package_id: str
    ) -> list[str]:
        result = await session.execute(
            select(package_documents.c.document_id).where(
                package_documents.c.package_id == package_id
            )
        )
        return list(result.scalars().all())

    async def list_document_ids_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[str]:
        result = await session.execute(
            select(package_documents.c.document_id)
            .join(
                room_packages,
                room_packages.c.package_id == package_documents.c.package_id,
            )
            .where(room_packages.c.room_id == room_id)
        )
        return list(result.scalars().all())

    # ── Reverse lookups (for ref/doc list responses) ──────────────────────

    async def get_packages_for_references(
        self, session: AsyncSession, reference_ids: list[str]
    ) -> dict[str, list[str]]:
        if not reference_ids:
            return {}
        result = await session.execute(
            select(
                package_references.c.reference_id,
                package_references.c.package_id,
            ).where(package_references.c.reference_id.in_(reference_ids))
        )
        out: dict[str, list[str]] = {rid: [] for rid in reference_ids}
        for rid, pid in result.all():
            out.setdefault(rid, []).append(pid)
        return out

    async def get_packages_for_documents(
        self, session: AsyncSession, document_ids: list[str]
    ) -> dict[str, list[str]]:
        if not document_ids:
            return {}
        result = await session.execute(
            select(
                package_documents.c.document_id,
                package_documents.c.package_id,
            ).where(package_documents.c.document_id.in_(document_ids))
        )
        out: dict[str, list[str]] = {did: [] for did in document_ids}
        for did, pid in result.all():
            out.setdefault(did, []).append(pid)
        return out

    # ── Removal warnings ──────────────────────────────────────────────────

    async def list_rooms_for_packages_containing_reference(
        self, session: AsyncSession, package_id: str, reference_id: str
    ) -> list[tuple[str, str]]:
        """Rooms that would lose visibility of this reference if removed from this package
        (i.e. the package is attached to those rooms, and the reference isn't directly
        attached to those rooms either)."""
        result = await session.execute(
            select(Room.id, Room.name)
            .join(room_packages, Room.id == room_packages.c.room_id)
            .where(room_packages.c.package_id == package_id)
            .where(
                ~select(room_references.c.room_id)
                .where(
                    room_references.c.room_id == Room.id,
                    room_references.c.reference_id == reference_id,
                )
                .exists()
            )
        )
        return [(rid, name) for rid, name in result.all()]

    async def list_rooms_for_packages_containing_document(
        self, session: AsyncSession, package_id: str, document_id: str
    ) -> list[tuple[str, str]]:
        result = await session.execute(
            select(Room.id, Room.name)
            .join(room_packages, Room.id == room_packages.c.room_id)
            .where(room_packages.c.package_id == package_id)
            .where(
                ~select(room_documents.c.room_id)
                .where(
                    room_documents.c.room_id == Room.id,
                    room_documents.c.document_id == document_id,
                )
                .exists()
            )
        )
        return [(rid, name) for rid, name in result.all()]

    # ── Affected packages on member-delete ────────────────────────────────

    async def list_packages_for_reference(
        self, session: AsyncSession, reference_id: str
    ) -> list[str]:
        result = await session.execute(
            select(package_references.c.package_id).where(
                package_references.c.reference_id == reference_id
            )
        )
        return list(result.scalars().all())

    async def list_packages_for_document(
        self, session: AsyncSession, document_id: str
    ) -> list[str]:
        result = await session.execute(
            select(package_documents.c.package_id).where(
                package_documents.c.document_id == document_id
            )
        )
        return list(result.scalars().all())

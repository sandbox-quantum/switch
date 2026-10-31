from sqlalchemy import and_, delete, func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Document, Room, room_documents


class DocumentStore:
    async def create(self, session: AsyncSession, document: Document) -> Document:
        session.add(document)
        await session.flush()
        return document

    async def get(self, session: AsyncSession, document_id: str) -> Document | None:
        return await session.get(Document, document_id)

    async def get_for_update(
        self, session: AsyncSession, document_id: str
    ) -> Document | None:
        """Load the row locked until the transaction ends, for a caller that
        checks it and then writes it.

        ``populate_existing`` refreshes a copy already in the session, so the
        check sees the committed row rather than an earlier read of it.
        """
        return await session.get(
            Document, document_id, with_for_update=True, populate_existing=True
        )

    async def get_many(
        self, session: AsyncSession, document_ids: list[str]
    ) -> list[Document]:
        if not document_ids:
            return []
        result = await session.execute(
            select(Document).where(Document.id.in_(document_ids))
        )
        return list(result.scalars().all())

    async def list_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[Document]:
        result = await session.execute(
            select(Document).where(
                Document.room_id.is_(None),
                or_(
                    Document.owner_id == user_id,
                    Document.read_visibility == "public",
                ),
            )
        )
        return list(result.scalars().all())

    async def update_fields(
        self,
        session: AsyncSession,
        document_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
        content: str | None = None,
    ) -> Document:
        doc = await session.get(Document, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        if name is not None:
            doc.name = name
        if description is not None:
            doc.description = description
        if instructions is not None:
            doc.instructions = instructions
        if read_visibility is not None:
            doc.read_visibility = read_visibility
        if write_visibility is not None:
            doc.write_visibility = write_visibility
        if content is not None:
            doc.content = content
        await session.flush()
        return doc

    async def delete(self, session: AsyncSession, document_id: str) -> list[str]:
        room_id_result = await session.execute(
            select(room_documents.c.room_id).where(
                room_documents.c.document_id == document_id
            )
        )
        affected_rooms = list(room_id_result.scalars().all())
        await session.execute(
            delete(room_documents).where(room_documents.c.document_id == document_id)
        )
        doc = await session.get(Document, document_id)
        if doc:
            await session.delete(doc)
        await session.flush()
        return affected_rooms

    async def attach_to_room(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> None:
        await session.execute(
            insert(room_documents).values(room_id=room_id, document_id=document_id)
        )
        await session.flush()

    async def detach_from_room(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> None:
        await session.execute(
            delete(room_documents).where(
                room_documents.c.room_id == room_id,
                room_documents.c.document_id == document_id,
            )
        )
        await session.flush()

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[Document]:
        attached_ids = select(room_documents.c.document_id).where(
            room_documents.c.room_id == room_id
        )
        result = await session.execute(
            select(Document).where(
                or_(
                    Document.id.in_(attached_ids),
                    Document.room_id == room_id,
                )
            )
        )
        return list(result.scalars().all())

    async def list_ids_for_room(self, session: AsyncSession, room_id: str) -> list[str]:
        attached = await session.execute(
            select(room_documents.c.document_id).where(
                room_documents.c.room_id == room_id
            )
        )
        scoped = await session.execute(
            select(Document.id).where(Document.room_id == room_id)
        )
        return [*attached.scalars().all(), *scoped.scalars().all()]

    async def get_room_scoped(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> Document | None:
        result = await session.execute(
            select(Document).where(
                Document.id == document_id,
                Document.room_id == room_id,
            )
        )
        return result.scalar_one_or_none()

    async def exists_room_scoped_name(
        self,
        session: AsyncSession,
        room_id: str,
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> bool:
        where = [Document.room_id == room_id, Document.name == name]
        if exclude_id is not None:
            where.append(Document.id != exclude_id)
        result = await session.execute(select(Document.id).where(and_(*where)).limit(1))
        return result.first() is not None

    async def get_attached_counts(
        self, session: AsyncSession, document_ids: list[str]
    ) -> dict[str, int]:
        if not document_ids:
            return {}
        result = await session.execute(
            select(
                room_documents.c.document_id,
                func.count(room_documents.c.room_id),
            )
            .where(room_documents.c.document_id.in_(document_ids))
            .group_by(room_documents.c.document_id)
        )
        counts = {did: int(c) for did, c in result.all()}
        return {did: counts.get(did, 0) for did in document_ids}

    async def list_rooms_for_document(
        self, session: AsyncSession, document_id: str
    ) -> list[tuple[str, str]]:
        result = await session.execute(
            select(Room.id, Room.name)
            .join(room_documents, Room.id == room_documents.c.room_id)
            .where(room_documents.c.document_id == document_id)
        )
        return [(rid, name) for rid, name in result.all()]

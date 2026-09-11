from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import MediaBlob


class MediaStore:
    async def put(self, session: AsyncSession, blob: MediaBlob) -> MediaBlob:
        session.add(blob)
        await session.flush()
        return blob

    async def get(self, session: AsyncSession, uri: str) -> MediaBlob | None:
        result = await session.execute(select(MediaBlob).where(MediaBlob.uri == uri))
        return result.scalar_one_or_none()

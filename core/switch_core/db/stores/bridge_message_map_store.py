from datetime import timedelta

from sqlalchemy import delete, func, null, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import BridgeMessageMap


class BridgeMessageMapStore:
    async def claim(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        external_channel_id: str,
        transport_event_id: str,
        unposted_after: timedelta,
    ) -> bool:
        """Claim a room message for posting to the platform: a row with no
        external post yet. False when the message has a row already, posted,
        or claimed within `unposted_after` and not posted yet. A claim older
        than that with no post is claimed again, from now and for
        `external_channel_id`, the channel the post goes to: the room may
        have moved to another channel since the first claim."""
        statement = insert(BridgeMessageMap).values(
            bridge_id=bridge_id,
            external_channel_id=external_channel_id,
            transport_event_id=transport_event_id,
            external_post_id=None,
        )
        result = await session.execute(
            statement.on_conflict_do_update(
                index_elements=[
                    BridgeMessageMap.bridge_id,
                    BridgeMessageMap.transport_event_id,
                ],
                set_={
                    "created_at": func.now(),
                    "external_channel_id": statement.excluded.external_channel_id,
                },
                where=(
                    BridgeMessageMap.external_post_id.is_(None)
                    & (BridgeMessageMap.created_at < func.now() - unposted_after)
                ),
            ).returning(BridgeMessageMap.id)
        )
        return result.scalar_one_or_none() is not None

    async def fill(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        transport_event_id: str,
        external_post_id: str,
    ) -> None:
        """Record the post a claimed message became on the platform."""
        await session.execute(
            update(BridgeMessageMap)
            .where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
                BridgeMessageMap.external_post_id.is_(None),
            )
            .values(external_post_id=external_post_id)
        )

    async def release_claim(
        self, session: AsyncSession, *, bridge_id: str, transport_event_id: str
    ) -> None:
        """Drop a claim the platform never turned into a post."""
        await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
                BridgeMessageMap.external_post_id.is_(None),
            )
        )

    async def answer_card(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        external_post_id: str,
        answer: dict[str, str],
    ) -> dict | None:
        """Record `answer` as the answer to the card posted as
        `external_post_id`, unless it has one. Returns the answer it already
        had, or None when `answer` was recorded. One conditional UPDATE, so of
        two presses at once only one is recorded."""
        result = await session.execute(
            update(BridgeMessageMap)
            .where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.external_post_id == external_post_id,
                BridgeMessageMap.card_answer.is_(None),
            )
            .values(card_answer=answer)
            .returning(BridgeMessageMap.id)
        )
        if result.scalar_one_or_none() is not None:
            return None
        mapping = await self.get_by_external_post_id(
            session, bridge_id, external_post_id
        )
        if mapping is None or mapping.card_answer is None:
            raise LookupError(
                f"No message posted as {external_post_id} on bridge {bridge_id}"
            )
        return mapping.card_answer

    async def clear_card_answer(
        self, session: AsyncSession, *, bridge_id: str, external_post_id: str
    ) -> None:
        """Drop a recorded answer whose press was never delivered."""
        await session.execute(
            update(BridgeMessageMap)
            .where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.external_post_id == external_post_id,
            )
            # SQL NULL: a Python None would be stored as JSON null.
            .values(card_answer=null())
        )

    async def create(
        self, session: AsyncSession, mapping: BridgeMessageMap
    ) -> BridgeMessageMap:
        session.add(mapping)
        await session.flush()
        return mapping

    async def get_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_external_post_id(
        self, session: AsyncSession, bridge_id: str, external_post_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.external_post_id == external_post_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> None:
        await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        await session.flush()

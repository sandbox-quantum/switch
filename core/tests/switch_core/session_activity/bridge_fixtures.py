"""A bridged room and a platform that records what it was asked to draw."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import insert

from switch_core.bridges.collaboration.adapter import (
    RichContent,
    RichContentFailed,
    RichContentThrottledAfterPost,
    TurnActivity,
)
from switch_core.db.models import Client, CollaborationBridge, Room, room_agents


@dataclass
class BridgedRoom:
    bridge_id: str
    room_id: str
    channel_id: str


async def make_bridged_room(db, *, member: str) -> BridgedRoom:
    suffix = uuid.uuid4().hex[:8]
    workspace_consumer = Client(
        transport_user_id=f"@bridge-{suffix}:test", display_name="bridge", type="bridge"
    )
    db.add(workspace_consumer)
    await db.flush()
    bridge = CollaborationBridge(
        type="slack",
        display_name="Slack",
        client_id=workspace_consumer.id,
        status="active",
    )
    db.add(bridge)
    await db.flush()
    channel_id = f"C{suffix}"
    room = Room(
        transport_room_id=f"!{suffix}:test",
        name=f"room-{suffix}",
        description="",
        bridge_id=bridge.id,
        external_channel_id=channel_id,
    )
    db.add(room)
    await db.flush()
    await db.execute(insert(room_agents).values(room_id=room.id, agent_id=member))
    return BridgedRoom(bridge_id=bridge.id, room_id=room.id, channel_id=channel_id)


@dataclass
class Drawn:
    call: str
    channel_id: str
    ref: str
    thread_ref: str | None
    content: Any


@dataclass
class RecordingPlatform:
    """Duck-typed `PlatformAdapter`: only what the publisher calls."""

    platform_name: str = "Test"
    draws_session_activity: bool = True
    separate_attention_slot: bool = True
    notifies_only_by_mention: bool = False
    redraws_for_elapsed_time: bool = False
    closes_activity_after: float | None = None
    supports_activity_reactions: bool = True
    supports_queue_reaction: bool = True
    activity_reactions_per_agent: bool = False
    renders_custom_url_schemes: bool = True
    recovers_uncertain_posts: bool = True
    discloses_unconfirmed_posts: bool = False
    removes_answered_cards: bool = False
    drawn: list[Drawn] = field(default_factory=list)
    marks: list[tuple[str, str, bool]] = field(default_factory=list)
    refuse_posts: bool = False
    # Raised for every post of a turn's activity while its turn id is here.
    turn_post_errors: dict[str, RichContentFailed] = field(default_factory=dict)
    # Turns whose next post opens a message, then is asked to wait before
    # drawing into it.
    open_undrawn: set[str] = field(default_factory=set)
    held_for: float = 0.0
    found_card: str | None = None
    first_reply: bool = True
    _next: int = 0

    def _ref(self) -> str:
        self._next += 1
        return f"post-{self._next}"

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        if self.refuse_posts:
            raise RichContentFailed("refused", text="")
        turn_id = (
            content.turn.turn_id
            if isinstance(content, TurnActivity) and not content.status_only
            else None
        )
        if turn_id in self.turn_post_errors:
            raise self.turn_post_errors[turn_id]
        ref = self._ref()
        if turn_id in self.open_undrawn:
            self.open_undrawn.discard(turn_id)
            self.drawn.append(Drawn("opened", channel_id, ref, thread_root_id, None))
            raise RichContentThrottledAfterPost(ref=ref, retry_after=0.2, text="")
        self.drawn.append(Drawn("post_rich", channel_id, ref, thread_root_id, content))
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        self.drawn.append(
            Drawn("update_rich", channel_id, message_ref, thread_root_id, content)
        )

    def rich_updates_held_for(self) -> float:
        return self.held_for

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        ref = self._ref()
        self.drawn.append(
            Drawn("send_message", channel_id, ref, thread_root_id, content)
        )
        return ref

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        ref = self._ref()
        self.drawn.append(
            Drawn("admin_message", channel_id, ref, thread_root_id, content)
        )
        return ref

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        self.drawn.append(
            Drawn("remove_publication", channel_id, message_ref, None, None)
        )

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: str,
        on: bool,
        force: bool = False,
    ) -> None:
        self.marks.append((message_ref, mark, on))

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        return None

    def notice_address(self, message_ref: str, thread_root_id: str | None) -> str:
        return thread_root_id or message_ref

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        return self.found_card

    def translate_outbound(self, content: str) -> str:
        return content

    async def is_first_reply(self, channel_id: str, root: str, message: str) -> bool:
        return self.first_reply

    def of(self, call: str) -> list[Drawn]:
        return [drawn for drawn in self.drawn if drawn.call == call]

    async def wait_until(self, check: Callable[[], bool]) -> None:
        deadline = asyncio.get_running_loop().time() + 5
        while not check():
            assert asyncio.get_running_loop().time() < deadline, (
                self.drawn,
                self.marks,
            )
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.2)

    async def wait_for(self, count: int) -> list[Drawn]:
        await self.wait_until(lambda: len(self.drawn) >= count)
        return self.drawn

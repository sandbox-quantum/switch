"""Teams deletes differently in its two channel layouts, so the status retires
differently too.

In a **posts** channel Teams substitutes *"This message has been deleted."* and
keeps it in the post. A status line that appears and vanishes every turn
therefore leaves one tombstone per turn per agent, and repositioning it leaves
another per move — which is what a channel talking to agents actually looked
like. Nothing turns that off, so the answer is not to delete: the status is
edited into a terminal marker and left as the record of a finished turn, the
way Mattermost already does it for the same reason.

A **chat**-layout channel drops a deleted message cleanly, so it keeps the
original behaviour: the status disappears when the turn ends.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CHANNEL = "19:abc@thread.tacv2"
_AGENT = "worker"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Connector:
    def __init__(self) -> None:
        self.updates: list[dict[str, Any]] = []
        self.deletes: list[str] = []
        self.posted: list[str] = []
        self._n = 0

    def _next(self) -> str:
        self._n += 1
        return f"M{self._n}"

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        mid = self._next()
        self.posted.append(mid)
        return f"{channel_id};messageid={mid}", mid

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        mid = self._next()
        self.posted.append(mid)
        return mid

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        self.updates.append({"activity_id": activity_id, "activity": activity})

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        self.deletes.append(activity_id)


class _Graph:
    def __init__(self, layout: str) -> None:
        self._layout = layout

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        return {"id": channel_id, "displayName": "general", "layoutType": self._layout}


def _adapter(layout: str) -> tuple[TeamsAdapter, _Connector]:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    connector = _Connector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._graph = _Graph(layout)  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example"
    adapter._channel_type[_CHANNEL] = "channel_public"
    return adapter, connector


def _text(activity: dict[str, Any]) -> str:
    card = activity["attachments"][0]["content"]
    return "\n".join(str(block.get("text", "")) for block in card["body"])


def _work(adapter: TeamsAdapter, **kw: Any) -> None:
    _run(
        adapter.apply_runtime_state(
            _CHANNEL, _AGENT, "working", mention_handle=None, thread_root_id=None, **kw
        )
    )


def _idle(adapter: TeamsAdapter) -> None:
    _run(
        adapter.apply_runtime_state(
            _CHANNEL, _AGENT, "idle", mention_handle=None, thread_root_id=None
        )
    )


# ── posts layout: nothing is ever deleted ─────────────────────────────────────


def test_a_finished_turn_edits_the_status_rather_than_deleting_it() -> None:
    adapter, connector = _adapter("post")

    _work(adapter)
    _idle(adapter)

    assert connector.deletes == []
    assert [u["activity_id"] for u in connector.updates] == ["M1"]
    assert "Done" in _text(connector.updates[-1]["activity"])


def test_the_marker_says_how_long_the_turn_took() -> None:
    adapter, connector = _adapter("post")

    _work(adapter)
    _idle(adapter)

    # Format is "✓ Done · 0s" — the duration matters more than the exact word.
    assert "·" in _text(connector.updates[-1]["activity"])


def test_the_marker_drops_the_session_link() -> None:
    # The link is worth following while an agent is working. On the record of a
    # turn that is over it is clutter, and this line stays for good.
    adapter, connector = _adapter("post")

    _work(adapter, deeplink_url="https://switch.example/deeplink/session?x=1")
    _idle(adapter)

    assert "deeplink" not in _text(connector.updates[-1]["activity"])


def test_an_operator_ping_is_resolved_by_editing_too() -> None:
    adapter, connector = _adapter("post")

    _work(adapter)
    _run(
        adapter.apply_runtime_state(
            _CHANNEL,
            _AGENT,
            "awaiting-input",
            mention_handle="ada",
            thread_root_id=None,
        )
    )
    _idle(adapter)

    assert connector.deletes == []
    assert {u["activity_id"] for u in connector.updates} == {"M1", "M2"}


def test_the_status_does_not_move_to_follow_the_conversation() -> None:
    # A move is a repost plus a delete, and that delete scars once per move —
    # so the busier the channel, the more of them.
    adapter, connector = _adapter("post")

    _work(adapter)
    posted_before = list(connector.posted)

    _run(adapter.reposition_runtime_state(_CHANNEL, _AGENT, "post-9"))

    assert connector.posted == posted_before
    assert connector.deletes == []
    assert adapter._working_msg[(_CHANNEL, _AGENT)].message_ref == "M1"


# ── chat layout: unchanged, the status disappears ─────────────────────────────


def test_a_chat_channel_still_removes_the_status_when_the_turn_ends() -> None:
    adapter, connector = _adapter("chat")

    _work(adapter)
    _idle(adapter)

    assert connector.deletes == ["M1"]
    assert (_CHANNEL, _AGENT) not in adapter._working_msg


def test_a_chat_channel_still_moves_the_status_to_follow_the_conversation() -> None:
    adapter, connector = _adapter("chat")

    _work(adapter)
    _run(adapter.reposition_runtime_state(_CHANNEL, _AGENT, "msg-9"))

    # Reposted first, then the original removed — never briefly absent.
    assert connector.deletes == ["M1"]
    assert adapter._working_msg[(_CHANNEL, _AGENT)].message_ref == "M2"


def test_a_chat_channel_still_removes_an_operator_ping() -> None:
    adapter, connector = _adapter("chat")

    _work(adapter)
    _run(
        adapter.apply_runtime_state(
            _CHANNEL,
            _AGENT,
            "awaiting-input",
            mention_handle="ada",
            thread_root_id=None,
        )
    )
    _idle(adapter)

    assert set(connector.deletes) == {"M1", "M2"}

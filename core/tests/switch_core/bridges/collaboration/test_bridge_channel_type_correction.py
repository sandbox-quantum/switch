from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore

# The adapter reports each channel type it learns from the platform, and the
# bridge corrects rooms saved with the other one. A private channel's room
# saved as public is the case that matters: moving that room to another bridge
# keeps the saved type, and so opens a public channel there. On startup the
# bridge has the adapter re-read every channel, so the correction reaches rooms
# whose channel is quiet.


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def commit(self) -> None:
        self.commits += 1


def _room(
    external_channel_id: str | None,
    channel_type: str | None,
    *,
    archived: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        external_channel_id=external_channel_id,
        channel_type=channel_type,
        archived_at="2026-01-01T00:00:00Z" if archived else None,
    )


class _RoomStore:
    def __init__(
        self,
        rooms: list[SimpleNamespace] | None = None,
        corrected: list[str] | None = None,
    ) -> None:
        self._rooms = rooms or []
        self._corrected = corrected or []
        self.corrections: list[dict[str, str]] = []

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        assert bridge_id == "bridge-1"
        return self._rooms

    async def correct_channel_type(
        self,
        session: Any,
        *,
        bridge_id: str,
        external_channel_id: str,
        channel_type: str,
    ) -> list[str]:
        self.corrections.append(
            {
                "bridge_id": bridge_id,
                "external_channel_id": external_channel_id,
                "channel_type": channel_type,
            }
        )
        return self._corrected


class _Adapter:
    def __init__(self) -> None:
        self.refreshed: list[list[str]] = []

    async def refresh_channel_types(self, channel_ids: list[str]) -> None:
        self.refreshed.append(channel_ids)


def _bridge(store: _RoomStore, adapter: _Adapter | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        _session_factory=_FakeSession,
        _room_store=store,
        _adapter=adapter or _Adapter(),
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="teams",
    )


# ── Recording what the adapter learned ───────────────────────────────────────


async def test_a_learned_type_is_recorded_on_this_bridges_rooms(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = _RoomStore(corrected=["room-1"])

    with caplog.at_level(logging.WARNING):
        await BridgeCore._record_channel_type(
            _bridge(store), "19:p@thread.tacv2", "channel_private"
        )

    assert store.corrections == [
        {
            "bridge_id": "bridge-1",
            "external_channel_id": "19:p@thread.tacv2",
            "channel_type": "channel_private",
        }
    ]
    assert "room-1" in caplog.text


async def test_nothing_is_logged_when_no_room_needed_correcting(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = _RoomStore(corrected=[])

    with caplog.at_level(logging.WARNING):
        await BridgeCore._record_channel_type(
            _bridge(store), "19:p@thread.tacv2", "channel_private"
        )

    assert caplog.text == ""


async def test_a_chat_type_is_not_recorded() -> None:
    store = _RoomStore(corrected=["room-1"])

    await BridgeCore._record_channel_type(_bridge(store), "a:dm", "direct")

    assert store.corrections == []


# ── The startup pass ─────────────────────────────────────────────────────────


async def test_startup_rereads_every_live_channel_room() -> None:
    store = _RoomStore(
        [
            _room("19:b@thread.tacv2", "channel_private"),
            _room("19:a@thread.tacv2", "channel_public"),
            _room("19:a@thread.tacv2", "channel_public"),  # two rooms, one read
            _room("19:old@thread.tacv2", "channel_public", archived=True),
            _room("a:dm", "direct"),
            _room("19:g@thread.v2", "group"),
            _room(None, "channel_public"),
            _room("19:c@thread.tacv2", None),
        ]
    )
    adapter = _Adapter()

    await BridgeCore._refresh_channel_types(_bridge(store, adapter))

    assert adapter.refreshed == [["19:a@thread.tacv2", "19:b@thread.tacv2"]]


async def test_startup_asks_nothing_without_channel_rooms() -> None:
    store = _RoomStore([_room("a:dm", "direct")])
    adapter = _Adapter()

    await BridgeCore._refresh_channel_types(_bridge(store, adapter))

    assert adapter.refreshed == []


async def test_adapters_have_nothing_to_refresh_by_default() -> None:
    result = await CollaborationAdapter.refresh_channel_types(
        SimpleNamespace(),  # type: ignore[arg-type]
        ["C1"],
    )
    assert result is None


# ── Wiring in start() and stop() ─────────────────────────────────────────────


class _StartableAdapter:
    def __init__(self) -> None:
        self.channel_type_handler: Any = None
        self.handler_set_before_start = False

    def set_channel_migration_handler(self, handler: Any) -> None:
        return None

    def set_channel_type_handler(self, handler: Any) -> None:
        self.channel_type_handler = handler

    def set_agent_presentation_resolver(self, resolver: Any) -> None:
        return None

    def set_activity_resolver(self, resolver: Any) -> None:
        return None

    async def start(self, **kwargs: Any) -> None:
        self.handler_set_before_start = self.channel_type_handler is not None

    async def stop(self) -> None:
        return None


def _startable_core(refresh: Any) -> tuple[BridgeCore, _StartableAdapter]:
    core = object.__new__(BridgeCore)
    adapter = _StartableAdapter()
    core._bridge_type = "teams"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[attr-defined]
    core._identity_task = None  # type: ignore[attr-defined]
    core._channel_type_refresh_task = None  # type: ignore[attr-defined]

    async def _noop() -> None:
        return None

    core._load_channel_map = _noop  # type: ignore[method-assign]
    core._load_existing_puppets = _noop  # type: ignore[method-assign]
    core._ensure_channel_captures = _noop  # type: ignore[method-assign]
    core._create_agent_identities = _noop  # type: ignore[method-assign]
    core._refresh_channel_types = refresh  # type: ignore[method-assign]
    core._handle_channel_migrated = None  # type: ignore[assignment]
    core._agent_presentation = None  # type: ignore[assignment]
    core._handle_inbound_message = None  # type: ignore[assignment]
    core._handle_inbound_command = None  # type: ignore[assignment]
    core._handle_agent_joined_channel = None  # type: ignore[assignment]
    core._handle_user_joined_channel = None  # type: ignore[assignment]
    core._handle_app_joined_channel = None  # type: ignore[assignment]
    return core, adapter


async def test_start_hands_the_adapter_the_room_correction_before_starting_it() -> None:
    # Without this, a type learned at runtime corrects nothing, and a room
    # saved with the wrong privacy is only fixed at the next start.
    async def _noop() -> None:
        return None

    core, adapter = _startable_core(_noop)

    await core.start()
    await core.stop()

    assert adapter.channel_type_handler == core._record_channel_type
    assert adapter.handler_set_before_start


async def test_a_failed_refresh_is_logged_rather_than_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def _explode() -> None:
        raise RuntimeError("refresh blew up")

    core, _ = _startable_core(_explode)

    with caplog.at_level(logging.ERROR):
        await core.start()
        task = core._channel_type_refresh_task
        assert task is not None
        await task

    assert any(
        "channel type refresh stopped unexpectedly" in r.getMessage()
        for r in caplog.records
    )
    await core.stop()


async def test_stop_cancels_a_refresh_in_flight() -> None:
    started = asyncio.Event()

    async def _slow() -> None:
        started.set()
        await asyncio.sleep(30)

    core, _ = _startable_core(_slow)

    await core.start()
    task = core._channel_type_refresh_task
    await asyncio.wait_for(started.wait(), timeout=1)
    await core.stop()
    await asyncio.sleep(0)

    assert task is not None
    assert task.cancelled() or task.done()
    assert core._channel_type_refresh_task is None

"""A post the bridge hands to Core that doesn't reach its room leaves one
warning, with ids only.

A test once lost a Mattermost post with no line in Core's log. Where Core's side of
the hand-in fails (the handler raises) or drops the post (no room, no sender
identity), it now logs one WARN naming the platform, the channel and the post
by id. Never the message, the sender's name, or the error's text.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration import (
    collaboration_core as collaboration_core_module,
)
from switch_core.bridges.collaboration.collaboration_core import (
    CollaborationCore,
    _log_id,
)
from switch_core.bridges.collaboration.models import InboundMessage

LOGGER = "switch_core.bridges.collaboration.collaboration_core"
SECRET_TEXT = "my password is hunter2"


def _msg(**overrides: Any) -> InboundMessage:
    fields: dict[str, Any] = {
        "channel_id": "chan-123",
        "channel_type": "channel_public",
        "sender_id": "user-9",
        "sender_name": "Alice <alice@example.com>",
        "content": SECRET_TEXT,
        "message_ref": "post-abc",
    }
    fields.update(overrides)
    return InboundMessage(**fields)


def _warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == LOGGER and r.levelno == logging.WARNING
    ]


async def test_a_failed_hand_in_logs_one_warning_with_ids_and_the_error_type_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger=LOGGER)

    async def handler(_event: InboundMessage) -> None:
        raise RuntimeError(f"boom while relaying {SECRET_TEXT}")

    async def room_tenant(_room_id: str) -> str:
        return "tenant-1"

    bridge = SimpleNamespace(
        _bridge_type="mattermost",
        _channel_to_room={"chan-123": ("room-1", "!room:switch.local")},
        _bridge_tenant_id="tenant-1",
        _room_tenant=room_tenant,
    )
    traced = CollaborationCore._traced(bridge, "message", handler)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError):
        await traced(_msg())

    assert _warnings(caplog) == [
        "[BRIDGE-IN] hand-in failed: platform=mattermost event=message channel=chan-123 "
        "post=post-abc error=RuntimeError"
    ]
    assert SECRET_TEXT not in "\n".join(r.getMessage() for r in caplog.records)


async def test_a_post_dropped_for_want_of_a_sender_identity_logs_one_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger=LOGGER)

    async def no(*_a: object, **_k: object) -> bool:
        return False

    async def nothing(*_a: object, **_k: object) -> None:
        return None

    bridge = SimpleNamespace(
        _bridge_type="mattermost",
        _channel_to_room={"chan-123": ("room-1", "!room:switch.local")},
        _is_registered_agent=no,
        _already_handed_in=no,  # no copy of the post is in its room yet
        _handle_text_answer=nothing,
        _repair_placeholder_username=nothing,
        _ensure_human_in_room=nothing,  # the sender never got an identity in the room
    )

    await CollaborationCore._handle_inbound_message(bridge, _msg())  # type: ignore[arg-type]

    assert _warnings(caplog) == [
        "[BRIDGE-IN] hand-in dropped: platform=mattermost channel=chan-123 post=post-abc "
        "room=room-1 reason=no_sender_identity"
    ]
    everything = "\n".join(r.getMessage() for r in caplog.records)
    assert SECRET_TEXT not in everything and "alice@example.com" not in everything


async def test_the_warning_never_breaks_a_core_built_without_its_platform(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Tests elsewhere build the core with `__new__` and only the fields they
    use; the hand-in failure line must log, not raise, when `_bridge_type` isn't set."""
    caplog.set_level(logging.WARNING, logger=LOGGER)

    async def no(*_a: object, **_k: object) -> bool:
        return False

    async def nothing(*_a: object, **_k: object) -> None:
        return None

    core = CollaborationCore.__new__(CollaborationCore)
    core._channel_to_room = {"chan-123": ("room-1", "!room:switch.local")}  # type: ignore[assignment]
    core._is_registered_agent = no  # type: ignore[method-assign]
    core._already_handed_in = no  # type: ignore[method-assign]
    core._handle_text_answer = nothing  # type: ignore[method-assign]
    core._repair_placeholder_username = nothing  # type: ignore[method-assign]
    core._ensure_human_in_room = nothing  # type: ignore[method-assign]

    await core._handle_inbound_message(_msg())

    assert _warnings(caplog) == [
        "[BRIDGE-IN] hand-in dropped: platform=<unknown> channel=chan-123 post=post-abc "
        "room=room-1 reason=no_sender_identity"
    ]


async def test_a_post_dropped_for_want_of_a_room_warns_at_most_once_an_hour_per_channel(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.WARNING, logger=LOGGER)
    collaboration_core_module._no_room_seen.clear()
    now = [5000.0]
    monkeypatch.setattr(collaboration_core_module.time, "monotonic", lambda: now[0])

    async def no(*_a: object, **_k: object) -> bool:
        return False

    async def nothing(*_a: object, **_k: object) -> None:
        return None

    bridge = SimpleNamespace(
        _bridge_type="slack",
        _channel_to_room={},
        _channel_locks={},
        _is_registered_agent=no,
        _already_handed_in=no,  # no copy of the post is in its room yet
        _handle_text_answer=nothing,
        _create_room_for_channel=nothing,  # no room could be made for the channel
    )

    for _ in range(3):
        await CollaborationCore._handle_inbound_message(
            bridge,  # type: ignore[arg-type]
            _msg(channel_id="C0123"),
        )
        now[0] += 60
    now[0] += 3600
    await CollaborationCore._handle_inbound_message(bridge, _msg(channel_id="C0123"))  # type: ignore[arg-type]

    assert _warnings(caplog) == [
        "[BRIDGE-IN] hand-in dropped: platform=slack channel=C0123 post=post-abc "
        "reason=no_room dropped_since_last=0",
        "[BRIDGE-IN] hand-in dropped: platform=slack channel=C0123 post=post-abc "
        "reason=no_room dropped_since_last=2",
    ]


def test_ids_that_dont_look_like_ids_are_never_logged() -> None:
    assert _log_id("post-abc_1.2:3@x") == "post-abc_1.2:3@x"
    assert _log_id("has spaces and text") == "<other>"
    assert _log_id("x" * 200) == "<other>"
    assert _log_id(None) == "<none>"
    assert _log_id(42) == "<other>"

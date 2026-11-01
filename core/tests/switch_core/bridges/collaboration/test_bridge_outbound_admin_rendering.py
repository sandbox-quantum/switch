"""Who renders an admin/system message on its way out of Matrix.

`admin_message` takes Switch Markdown and renders it itself, because most of
its callers are notices composed in `collaboration_core` with no adapter in reach. The
relay path here has to respect that and pass the body unrendered.

It did not, and the two halves each did the conversion: a `!list-agents` reply
reached Telegram reading `&lt;b&gt;Agents in this room:&lt;/b&gt;`, because the
second pass escaped the markup the first one had produced. Nothing covered the
relay path at the time, so nothing caught it.

The other half of the same contract is the adapter side, and it failed too:
Slack's `admin_message` posted the body as written under a comment promising it
rendered, so a `!agents-status` reply reached the channel showing its asterisks
and its link syntax (#676). `test_every_admin_message_override_renders_its_own_body`
holds every override on disk to that promise.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import switch_core
from switch_core.bridges.collaboration.collaboration_core import (
    ADMIN_MARKER,
    CollaborationCore,
)
from switch_core.transport import InboundMessage, RoomRef
from tests.switch_core.bridges.collaboration.outbound_fakes import (
    posting_without_a_database,
)

BODY = "**Agents in this room:**\n- **scout** — Claude Code"

_ADAPTERS_ROOT = (
    Path(switch_core.__file__).resolve().parent / "bridges" / "collaboration"
)


class _RecordingAdapter:
    """Records what each send path was handed, and renders like a real adapter.

    `translate_outbound` escapes first, exactly as the HTML-producing adapters
    do, so a body run through it twice comes back with visible entities — which
    is what makes the double conversion detectable here rather than merely
    counted.
    """

    def __init__(self) -> None:
        self.admin_calls: list[str] = []
        self.message_calls: list[str] = []

    def translate_outbound(self, content: str) -> str:
        escaped = (
            content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        out, parts = "", escaped.split("**")
        for index, part in enumerate(parts):
            out += part if index % 2 == 0 else f"<b>{part}</b>"
        return out

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        self.admin_calls.append(content)
        return "ref-admin"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self.message_calls.append(content)
        return "ref-msg"


def _bridge(adapter: _RecordingAdapter) -> CollaborationCore:
    core = object.__new__(CollaborationCore)
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[assignment]
    core._human_user_ids = set()  # type: ignore[assignment]
    core._workspace_consumer_transport_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    posting_without_a_database(core)
    core._outbound_thread_root_ref = _none  # type: ignore[assignment]
    return core


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _event(*, admin: bool) -> InboundMessage:
    content: dict[str, Any] = {}
    if admin:
        content[ADMIN_MARKER] = {"type": "command_result"}
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e1",
        sender="@someone:switch.local",
        timestamp=1700000000000,
        content=content,
        body=BODY,
        sender_name=None if admin else "scout",
    )


async def test_an_admin_event_reaches_the_adapter_unrendered() -> None:
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=True)
    )

    # Handed on as written, for admin_message to render once.
    assert adapter.admin_calls == [BODY]
    assert adapter.message_calls == []


async def test_an_admin_event_is_not_rendered_twice() -> None:
    # The failure this file exists for, stated as its symptom: whatever the
    # adapter renders must not contain escaped tags.
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=True)
    )

    rendered = adapter.translate_outbound(adapter.admin_calls[0])
    assert "<b>Agents in this room:</b>" in rendered
    assert "&lt;b&gt;" not in rendered


async def test_an_agent_message_is_still_rendered_by_the_relay() -> None:
    # The other half of the contract, and the reason this is not simply
    # "never render in the relay": send_message takes rendered content.
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=False)
    )

    assert adapter.admin_calls == []
    assert adapter.message_calls == [
        "<b>Agents in this room:</b>\n- <b>scout</b> — Claude Code"
    ]


def _admin_message_overrides(path: Path) -> list[ast.AsyncFunctionDef]:
    """Every `admin_message` defined in this adapter module."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "admin_message"
    ]


def _renders_itself(method: ast.AsyncFunctionDef) -> bool:
    """The override runs the body through `translate_outbound`."""
    return any(
        isinstance(call.func, ast.Attribute) and call.func.attr == "translate_outbound"
        for call in ast.walk(method)
        if isinstance(call, ast.Call)
    )


def _hands_on_to_the_base(method: ast.AsyncFunctionDef) -> bool:
    """The override defers to `super().admin_message(…)`, which renders."""
    return any(
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "admin_message"
        and isinstance(call.func.value, ast.Call)
        and isinstance(call.func.value.func, ast.Name)
        and call.func.value.func.id == "super"
        for call in ast.walk(method)
        if isinstance(call, ast.Call)
    )


def test_every_admin_message_override_renders_its_own_body() -> None:
    """The promise in `admin_message`'s docstring, held to on every override.

    Each override takes Switch Markdown and renders it itself, because callers
    pass an unrendered body. Slack's override said exactly that in a comment
    above the call, and posted the body as written anyway: `!agents-status`
    reached the channel showing its asterisks and its link syntax (#676). A
    comment cannot enforce itself, so this reads the adapters' source and
    requires the conversion of every override — a new adapter that forgets it
    fails here rather than in a customer's channel.

    Rendering in the base implementation, or handing the body to
    `super().admin_message`, both satisfy the contract.
    """
    paths = sorted(_ADAPTERS_ROOT.glob("*/adapter.py"))
    assert paths, "no adapter modules found — the glob no longer matches"

    overrides = [
        (path, method) for path in paths for method in _admin_message_overrides(path)
    ]
    # Slack, Discord, Mattermost, Teams and Telegram each override it. Pinned so
    # a rename that stops this test from seeing an override fails loudly instead
    # of leaving the contract unchecked.
    assert len(overrides) >= 5

    unrendered = [
        f"{path.relative_to(_ADAPTERS_ROOT)}:{method.lineno}"
        for path, method in overrides
        if not (_renders_itself(method) or _hands_on_to_the_base(method))
    ]
    assert unrendered == []

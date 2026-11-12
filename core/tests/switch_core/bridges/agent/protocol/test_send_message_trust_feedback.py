"""An agent learns from its own send what Switch Trust did to it: the result
of `send_message` (and the `post_message` / `send_targeted_message` tools
over it) carries `trust` when Switch Trust redacted or flagged the message,
and nothing when it let it through untouched."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.protocol.agent_core import AgentCore, _trust_feedback
from switch_core.bridges.agent.protocol.types import (
    SendTargetedResult,
    SentMessage,
    TrustFeedback,
)
from switch_core.clients.actor import SystemActor
from switch_core.tenant_context import tenant_scope
from switch_core.trust.client import (
    GuardrailBlockedError,
    TrustCheckResult,
    TrustFinding,
)
from switch_core.ui_spec import UI_CONTENT_KEY, UISpecError, parse_ui_spec

_FINDING = (TrustFinding(category="secrets", detector_name="s", severity="high"),)


class _ContentTrustClient:
    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        if "forbidden" in content:
            return TrustCheckResult("blocked", "p", "policy", _FINDING)
        if "nothing-to-cut" in content:
            return TrustCheckResult("redacted", "p", "policy", _FINDING, content)
        if "token-123" in content:
            return TrustCheckResult(
                "redacted",
                "p",
                "policy",
                _FINDING,
                content.replace("token-123", "[redacted]"),
            )
        if "suspicious" in content:
            return TrustCheckResult("alerted", "p", "policy", _FINDING)
        return TrustCheckResult("ok", "p", "policy")


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.extra: list[Any] = []
        self.agent = SimpleNamespace(name="helper")

    async def send_message(self, room_id: str, content: str, **kw: Any) -> str:
        self.sent.append(content)
        self.extra.append(kw.get("extra_content"))
        return f"$event-{len(self.sent)}"


def _build(
    notice_error: str | None = None,
) -> tuple[AgentCore, _FakeClient, list[Any]]:
    """`notice_error` is what the alert notice answers: None when it was
    posted, else why it was not."""
    client = _FakeClient()
    notices: list[Any] = []

    async def _require(agent_id: str, room_id: str) -> SimpleNamespace:
        return SimpleNamespace(id=room_id, transport_room_id="!room", bridge_id=None)

    async def _alert_notice(room, event_id, annotation, outcome) -> str | None:  # noqa: ANN001
        notices.append((event_id, annotation, outcome))
        return notice_error

    async def _set_typing(*_args: object) -> None:
        return None

    svc = object.__new__(AgentCore)
    svc.require_room_poster = _require  # type: ignore[assignment]
    svc.require_room_member = _require  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda agent_id: client
    )
    svc.trust_client = _ContentTrustClient()  # type: ignore[assignment]
    svc._post_trust_alert_notice = _alert_notice  # type: ignore[method-assign]
    svc._set_typing = _set_typing  # type: ignore[method-assign]
    return svc, client, notices


async def test_a_redacted_message_reports_what_the_room_received() -> None:
    svc, client, _ = _build()

    sent = await svc.send_message("agent-1", "room-1", "the key is token-123")

    assert client.sent == ["the key is [redacted]"]
    assert sent == SentMessage(
        event_id="$event-1",
        trust=TrustFeedback(
            outcome="redacted",
            delivered="the key is [redacted]",
            note=None,
            notice_error=None,
        ),
    )


async def test_a_redaction_that_changed_nothing_is_still_reported() -> None:
    """A redacted verdict with nothing it could cut sends the words as they
    were; the agent is told all the same."""
    svc, client, _ = _build()

    sent = await svc.send_message("agent-1", "room-1", "nothing-to-cut here")

    assert client.sent == ["nothing-to-cut here"]
    assert sent.trust == TrustFeedback(
        outcome="redacted",
        delivered="nothing-to-cut here",
        note=None,
        notice_error=None,
    )


def test_a_redaction_does_not_hide_a_file_that_was_flagged_or_not_checked() -> None:
    """A caption redacted beside a file Switch Trust could not check: the
    outcome is the redaction, and `alert` keeps the file's side visible."""
    feedback = _trust_feedback(
        "redacted",
        "see [redacted]",
        ("the file was not checked", "errored"),
        None,
        False,
    )

    assert feedback is not None
    assert feedback.to_result() == {
        "outcome": "redacted",
        "delivered": "see [redacted]",
        "alert": "errored",
        "note": "the file was not checked",
    }


async def test_a_redacted_status_update_reports_what_the_room_received() -> None:
    svc, client, _ = _build()

    feedback = await svc.update_status("agent-1", "room-1", "reading token-123")

    assert client.sent == ["*reading [redacted]*"]
    assert feedback == TrustFeedback(
        outcome="redacted",
        delivered="reading [redacted]",
        note=None,
        notice_error=None,
    )


async def test_a_flagged_status_update_reports_the_notice_posted_under_it() -> None:
    svc, _, notices = _build()

    feedback = await svc.update_status("agent-1", "room-1", "something suspicious")

    assert feedback is not None
    assert feedback.outcome == "alerted"
    assert feedback.note == notices[0][1]


async def test_a_clean_status_update_reports_nothing_about_trust() -> None:
    svc, _, _ = _build()

    assert await svc.update_status("agent-1", "room-1", "working on it") is None


async def test_a_flagged_message_reports_the_notice_posted_under_it() -> None:
    svc, client, notices = _build()

    sent = await svc.send_message("agent-1", "room-1", "something suspicious")

    assert client.sent == ["something suspicious"]
    assert sent.trust is not None
    assert sent.trust.outcome == "alerted"
    assert sent.trust.delivered is None
    assert sent.trust.note == notices[0][1]


async def test_a_flagged_message_whose_notice_failed_says_so() -> None:
    svc, client, notices = _build(notice_error="no admin client is running to post it")

    sent = await svc.send_message("agent-1", "room-1", "something suspicious")

    assert client.sent == ["something suspicious"]
    assert len(notices) == 1
    assert sent.trust == TrustFeedback(
        outcome="alerted",
        delivered=None,
        note=None,
        notice_error="no admin client is running to post it",
    )
    assert sent.trust.to_result() == {
        "outcome": "alerted",
        "notice_error": "no admin client is running to post it",
    }


class _Admin(SystemActor):
    def __init__(self, event_id: str | None) -> None:
        self._event_id = event_id
        self.posted: list[str] = []

    async def send_admin(self, room_id: str, body: str, **_kw: Any) -> str | None:
        self.posted.append(body)
        return self._event_id


def _core_with_admins(*admins: SystemActor) -> AgentCore:
    svc = object.__new__(AgentCore)
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_type=lambda kind, tenant_id: list(admins)
    )
    return svc


_ROOM = SimpleNamespace(id="room-1", transport_room_id="!room")


async def test_an_alert_notice_posted_reports_no_error() -> None:
    admin = _Admin("$notice")
    with tenant_scope("tenant-a"):
        error = await _core_with_admins(admin)._post_trust_alert_notice(
            _ROOM,  # type: ignore[arg-type]
            "$event",
            "flagged",
            "alerted",
        )

    assert error is None
    assert admin.posted == ["flagged"]


@pytest.mark.parametrize("admin_running", [False, True])
async def test_an_alert_notice_not_posted_says_why(
    admin_running: bool, caplog: pytest.LogCaptureFixture
) -> None:
    """With no admin client to post it, or one whose post the transport
    refused, the notice is reported as not posted."""
    admins = (_Admin(None),) if admin_running else ()
    with tenant_scope("tenant-a"):
        error = await _core_with_admins(*admins)._post_trust_alert_notice(
            _ROOM,  # type: ignore[arg-type]
            "$event",
            "flagged",
            "alerted",
        )

    assert error is not None
    assert "Switch Trust" in caplog.text


async def test_a_clean_message_reports_nothing_about_trust() -> None:
    svc, _, _ = _build()

    sent = await svc.send_message("agent-1", "room-1", "hello")

    assert sent == SentMessage(event_id="$event-1", trust=None)


class _Protocol:
    def __init__(self, sent: SentMessage) -> None:
        self._sent = sent

    async def send_message(self, *_args: Any, **_kwargs: Any) -> SentMessage:
        return self._sent

    async def send_targeted_message(
        self, *_args: Any, **_kwargs: Any
    ) -> SendTargetedResult:
        return SendTargetedResult(
            event_id=self._sent.event_id,
            target_statuses={},
            trust=self._sent.trust,
        )


def _connected(monkeypatch: pytest.MonkeyPatch, protocol: _Protocol) -> None:
    async def _room() -> str:
        return "room-1"

    monkeypatch.setattr(definitions, "get_agent_id", lambda: "agent-1")
    monkeypatch.setattr(definitions, "require_connected_room", _room)
    monkeypatch.setattr(definitions, "get_protocol", lambda: protocol)


async def test_post_message_result_carries_the_redaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _connected(
        monkeypatch,
        _Protocol(
            SentMessage(
                event_id="$e",
                trust=TrustFeedback(
                    outcome="redacted",
                    delivered="the key is [redacted]",
                    note=None,
                    notice_error=None,
                ),
            )
        ),
    )

    result = await definitions.post_message("the key is token-123")

    assert result == {
        "event_id": "$e",
        "trust": {"outcome": "redacted", "delivered": "the key is [redacted]"},
    }


async def test_post_message_result_is_unchanged_when_trust_did_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _connected(monkeypatch, _Protocol(SentMessage(event_id="$e", trust=None)))

    assert await definitions.post_message("hello") == {"event_id": "$e"}


async def test_send_targeted_message_result_carries_the_redaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _connected(
        monkeypatch,
        _Protocol(
            SentMessage(
                event_id="$e",
                trust=TrustFeedback(
                    outcome="redacted",
                    delivered="@bob [redacted]",
                    note=None,
                    notice_error=None,
                ),
            )
        ),
    )

    result = await definitions.send_targeted_message("token-123", target_names=["bob"])

    assert result["trust"] == {"outcome": "redacted", "delivered": "@bob [redacted]"}


# ── A message carrying a card ────────────────────────────────────────────────


def _card(text: str) -> dict[str, Any]:
    return {
        "root": "c",
        "elements": {
            "c": {"type": "Card", "props": {"title": "Status"}, "children": ["t"]},
            "t": {"type": "Text", "props": {"content": text}, "children": []},
        },
    }


async def test_a_clean_card_is_sent_with_the_body() -> None:
    svc, client, _ = _build()
    spec = parse_ui_spec(_card("all good"))

    sent = await svc.send_message("agent-1", "room-1", "status", ui=spec)

    assert client.sent == ["status"]
    assert parse_ui_spec(client.extra[0][UI_CONTENT_KEY]) == spec
    assert sent.trust is None


async def test_a_blocked_card_blocks_the_send() -> None:
    svc, client, _ = _build()
    blocked: list[Any] = []

    async def _blocked_notice(*args: Any) -> None:
        blocked.append(args)

    svc._post_trust_blocked_notice = _blocked_notice  # type: ignore[method-assign]

    with pytest.raises(GuardrailBlockedError):
        await svc.send_message(
            "agent-1", "room-1", "status", ui=parse_ui_spec(_card("forbidden"))
        )

    assert client.sent == []
    assert len(blocked) == 1


async def test_a_redacted_card_is_dropped_and_the_body_sent_alone() -> None:
    svc, client, _ = _build()

    sent = await svc.send_message(
        "agent-1", "room-1", "status", ui=parse_ui_spec(_card("key token-123"))
    )

    assert client.sent == ["status"]
    assert client.extra == [None]
    assert sent.trust is not None
    assert sent.trust.to_result() == {
        "outcome": "redacted",
        "delivered": "status",
        "card": "dropped",
    }


def _button_card(button_id: str) -> dict[str, Any]:
    return {
        "root": "c",
        "elements": {
            "c": {"type": "Card", "props": {"title": "Status"}, "children": ["a"]},
            "a": {"type": "Actions", "props": {}, "children": ["b"]},
            "b": {
                "type": "Button",
                "props": {"id": button_id, "label": "Approve"},
                "children": [],
            },
        },
    }


async def test_a_card_redacted_only_in_a_button_id_is_dropped() -> None:
    """A button's id goes out as its action, and as its value when it has none."""
    svc, client, _ = _build()

    sent = await svc.send_message(
        "agent-1", "room-1", "status", ui=parse_ui_spec(_button_card("token-123"))
    )

    assert client.extra == [None]
    assert sent.trust is not None
    assert sent.trust.to_result()["card"] == "dropped"


async def test_a_card_blocked_only_in_a_button_id_blocks_the_send() -> None:
    svc, client, _ = _build()

    async def _blocked_notice(*args: Any) -> None:
        return None

    svc._post_trust_blocked_notice = _blocked_notice  # type: ignore[method-assign]

    with pytest.raises(GuardrailBlockedError):
        await svc.send_message(
            "agent-1", "room-1", "status", ui=parse_ui_spec(_button_card("forbidden"))
        )

    assert client.sent == []


async def test_a_flagged_card_is_sent_with_a_notice() -> None:
    svc, client, notices = _build()

    sent = await svc.send_message(
        "agent-1", "room-1", "status", ui=parse_ui_spec(_card("suspicious"))
    )

    assert UI_CONTENT_KEY in client.extra[0]
    assert sent.trust is not None and sent.trust.outcome == "alerted"
    assert notices[0][2] == "alerted"


async def test_a_card_rides_beside_the_room_wide_marker() -> None:
    svc, client, _ = _build()

    await svc.send_message(
        "agent-1",
        "room-1",
        "status",
        extra_content={"com.switch.room_wide_mention": True},
        ui=parse_ui_spec(_card("ok")),
    )

    assert set(client.extra[0]) == {"com.switch.room_wide_mention", UI_CONTENT_KEY}


class _RecordingProtocol(_Protocol):
    def __init__(self) -> None:
        super().__init__(SentMessage(event_id="$e", trust=None))
        self.kwargs: list[dict[str, Any]] = []

    async def send_message(self, *_args: Any, **kwargs: Any) -> SentMessage:
        self.kwargs.append(kwargs)
        return self._sent

    async def send_targeted_message(
        self, *_args: Any, **kwargs: Any
    ) -> SendTargetedResult:
        self.kwargs.append(kwargs)
        return await super().send_targeted_message()


async def test_an_invalid_card_fails_the_call_and_posts_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    protocol = _RecordingProtocol()
    _connected(monkeypatch, protocol)
    bad = _card("x")
    bad["elements"]["t"]["props"] = {}

    with pytest.raises(UISpecError, match="elements.t.props.content: Field required"):
        await definitions.post_message("status", ui=bad)
    with pytest.raises(UISpecError):
        await definitions.send_targeted_message("status", target_names=["bob"], ui=bad)

    assert protocol.kwargs == []


async def test_a_valid_card_reaches_the_protocol_parsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    protocol = _RecordingProtocol()
    _connected(monkeypatch, protocol)

    await definitions.post_message("status", ui=_card("ok"))
    await definitions.send_targeted_message(
        "status", target_names=["bob"], ui=_card("ok")
    )
    await definitions.post_message("plain")

    assert [k["ui"] for k in protocol.kwargs] == [
        parse_ui_spec(_card("ok")),
        parse_ui_spec(_card("ok")),
        None,
    ]

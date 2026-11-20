"""A Teams post deleted or edited, or a channel deleted, is reported to the
bridge in the form the post came in under, whichever path heard it."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.models import (
    InboundChannelRemoved,
    InboundMessage,
    InboundMessageDeleted,
    InboundMessageEdited,
)
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.graph import SUBSCRIPTION_CHANGE_TYPES

from .test_teams_capture import (
    _adapter,
    _capture,
    _encrypt_like_graph,
    _FakeGraph,
    _FakeRequest,
    _make_key_and_cert,
    _run,
)

CHANNEL = "19:c@thread.tacv2"


class _Reports:
    def __init__(self, adapter: TeamsAdapter) -> None:
        self.deleted: list[InboundMessageDeleted] = []
        self.edited: list[InboundMessageEdited] = []
        self.removed: list[InboundChannelRemoved] = []

        async def on_deleted(event: InboundMessageDeleted) -> None:
            self.deleted.append(event)

        async def on_edited(event: InboundMessageEdited) -> None:
            self.edited.append(event)

        async def on_removed(event: InboundChannelRemoved) -> None:
            self.removed.append(event)

        adapter.set_takeback_handlers(
            on_message_deleted=on_deleted,
            on_message_edited=on_edited,
            on_channel_removed=on_removed,
        )


def _setup() -> tuple[TeamsAdapter, Any, _Reports, list[InboundMessage]]:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    adapter._channel_type[CHANNEL] = "channel_public"
    return adapter, cert, _Reports(adapter), _capture(adapter)


def _message(message_id: str, **fields: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "id": message_id,
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": CHANNEL},
        "body": {"contentType": "html", "content": "<p>hello <at>Bot</at></p>"},
        "lastEditedDateTime": None,
        "deletedDateTime": None,
    }
    message.update(fields)
    return message


def _notification(
    change_type: str, message: dict[str, Any], cert: Any
) -> dict[str, Any]:
    return {
        "clientState": "s3cr3t",
        "changeType": change_type,
        "resource": f"teams('t1')/channels('{CHANNEL}')/messages('{message['id']}')",
        "encryptedContent": _encrypt_like_graph(message, cert),
    }


def _activity(activity_type: str, message_id: str, **fields: Any) -> dict[str, Any]:
    activity: dict[str, Any] = {
        "type": activity_type,
        "id": message_id,
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "from": {"aadObjectId": "aad-u", "name": "Alice"},
        "conversation": {
            "id": f"{CHANNEL};messageid={message_id}",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": CHANNEL}},
    }
    activity.update(fields)
    return activity


# ── Graph change notifications ───────────────────────────────────────────────


def test_a_soft_delete_reported_as_an_update_deletes_the_post() -> None:
    adapter, cert, reports, captured = _setup()

    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message("m1", deletedDateTime="2026-01-01T00:00:00Z"),
                cert,
            )
        )
    )

    assert reports.deleted == [
        InboundMessageDeleted(channel_id=CHANNEL, message_ref="m1")
    ]
    assert captured == []


def test_a_deleted_notification_names_the_post_by_its_resource_path() -> None:
    adapter, _, reports, _ = _setup()

    _run(
        adapter.receive_notification(
            {
                "clientState": "s3cr3t",
                "changeType": "deleted",
                "resource": f"teams('t1')/channels('{CHANNEL}')/messages('root')/replies('m2')",
                "resourceData": {"id": "m2"},
            }
        )
    )

    assert reports.deleted == [
        InboundMessageDeleted(channel_id=CHANNEL, message_ref="m2")
    ]


def test_a_deleted_notification_in_the_slash_form_is_read_too() -> None:
    adapter, _, reports, _ = _setup()

    _run(
        adapter.receive_notification(
            {
                "clientState": "s3cr3t",
                "changeType": "deleted",
                "resource": f"teams/t1/channels/{CHANNEL}/messages/m3",
            }
        )
    )

    assert reports.deleted == [
        InboundMessageDeleted(channel_id=CHANNEL, message_ref="m3")
    ]


def test_an_edit_never_seen_before_is_an_edit_and_not_a_new_message() -> None:
    """The dedupe of new messages remembers only so many ids; an edit to one it
    has forgotten, or never heard, is still only an edit."""
    adapter, cert, reports, captured = _setup()

    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message(
                    "never-seen",
                    lastEditedDateTime="2026-01-01T00:00:00Z",
                    body={"contentType": "html", "content": "<p>new <b>words</b></p>"},
                ),
                cert,
            )
        )
    )

    assert captured == []
    assert reports.edited == [
        InboundMessageEdited(
            channel_id=CHANNEL, message_ref="never-seen", content="new words"
        )
    ]


def test_an_edit_to_a_message_seen_when_it_was_created_is_reported() -> None:
    adapter, cert, reports, captured = _setup()

    _run(adapter.receive_notification(_notification("created", _message("m4"), cert)))
    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message(
                    "m4",
                    lastEditedDateTime="2026-01-01T00:00:00Z",
                    body={"contentType": "text", "content": "changed"},
                ),
                cert,
            )
        )
    )

    assert [m.message_ref for m in captured] == ["m4"]
    assert [(e.message_ref, e.content) for e in reports.edited] == [("m4", "changed")]


def test_a_reaction_is_not_an_edit() -> None:
    adapter, cert, reports, captured = _setup()

    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message("m5", reactions=[{"reactionType": "like"}]),
                cert,
            )
        )
    )

    assert reports.edited == [] and reports.deleted == [] and captured == []


def test_a_reaction_to_an_edited_message_is_not_reported_again() -> None:
    adapter, cert, reports, _ = _setup()
    edited = _message(
        "m6",
        lastEditedDateTime="2026-01-01T00:00:00Z",
        body={"contentType": "text", "content": "changed"},
    )

    _run(adapter.receive_notification(_notification("updated", edited, cert)))
    edited["reactions"] = [{"reactionType": "like"}]
    _run(adapter.receive_notification(_notification("updated", edited, cert)))

    assert len(reports.edited) == 1


def test_the_bots_own_post_changing_is_not_reported() -> None:
    adapter, cert, reports, _ = _setup()
    own = {"application": {"id": "app-123", "displayName": "Switch"}}

    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message(
                    "m7", **{"from": own, "lastEditedDateTime": "2026-01-01T00:00:00Z"}
                ),
                cert,
            )
        )
    )

    assert reports.edited == []


def test_a_change_type_it_does_not_know_is_dropped_loudly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, cert, reports, captured = _setup()
    caplog.set_level("WARNING")

    _run(adapter.receive_notification(_notification("mystery", _message("m8"), cert)))

    assert captured == [] and reports.edited == [] and reports.deleted == []
    assert "change type 'mystery'" in caplog.text


# ── Subscriptions ────────────────────────────────────────────────────────────


def test_a_new_subscription_is_notified_of_deleted_posts() -> None:
    assert set(SUBSCRIPTION_CHANGE_TYPES.split(",")) == {
        "created",
        "updated",
        "deleted",
    }


def test_an_adopted_subscription_without_deletions_is_replaced_before_it_is_deleted() -> (
    None
):
    """Graph cannot add a change type to a subscription, and a renewed one never
    runs out: one made before deletions were followed is replaced at start."""
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    resource = f"teams/t/channels/{CHANNEL}/messages"
    order: list[str] = []

    class _Graph(_FakeGraph):
        async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
            order.append("create")
            return await super().create_subscription(**kwargs)

        async def delete_subscription(self, *, subscription_id: str) -> None:
            order.append("delete")
            await super().delete_subscription(subscription_id=subscription_id)

    fake = _Graph(
        existing=[
            {
                "id": "OLD",
                "resource": resource,
                "notificationUrl": adapter._me.notification_url,
                "changeType": "created,updated",
            }
        ]
    )
    adapter._graph = fake  # type: ignore[assignment]

    _run(adapter._adopt_existing_subscriptions())

    assert order == ["create", "delete"]
    assert fake.created[0]["resource"] == resource
    assert fake.deleted == ["OLD"]
    assert adapter._subscriptions == {CHANNEL: "SUB-1"}


def test_an_old_subscription_that_cannot_be_replaced_is_kept(
    caplog: pytest.LogCaptureFixture,
) -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    caplog.set_level("WARNING")

    class _Refusing(_FakeGraph):
        async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("refused")

    fake = _Refusing(
        existing=[
            {
                "id": "OLD",
                "resource": f"teams/t/channels/{CHANNEL}/messages",
                "notificationUrl": adapter._me.notification_url,
                "changeType": "created,updated",
            }
        ]
    )
    adapter._graph = fake  # type: ignore[assignment]

    _run(adapter._adopt_existing_subscriptions())

    assert adapter._subscriptions == {CHANNEL: "OLD"}
    assert fake.deleted == []
    assert "not notified of deleted posts" in caplog.text


def test_a_quiet_copy_leaves_an_old_subscription_to_the_holder() -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    adapter.set_listening(False)
    fake = _FakeGraph(
        existing=[
            {
                "id": "OLD",
                "resource": f"teams/t/channels/{CHANNEL}/messages",
                "notificationUrl": adapter._me.notification_url,
                "changeType": "created,updated",
            }
        ]
    )
    adapter._graph = fake  # type: ignore[assignment]

    _run(adapter._adopt_existing_subscriptions())

    assert fake.created == [] and fake.deleted == []
    assert adapter._subscriptions == {CHANNEL: "OLD"}


# ── Bot Framework activities ─────────────────────────────────────────────────


def test_a_message_delete_activity_deletes_the_post() -> None:
    adapter, _, reports, _ = _setup()

    _run(
        adapter._dispatch_activity(
            _activity(
                "messageDelete",
                "m9",
                channelData={
                    "eventType": "softDeleteMessage",
                    "channel": {"id": CHANNEL},
                },
            )
        )
    )

    assert reports.deleted == [
        InboundMessageDeleted(channel_id=CHANNEL, message_ref="m9")
    ]


def test_a_message_deleted_in_a_chat_is_reported_under_the_chat() -> None:
    adapter, _, reports, _ = _setup()

    _run(
        adapter._dispatch_activity(
            {
                "type": "messageDelete",
                "id": "m10",
                "serviceUrl": "https://smba.trafficmanager.net/amer/",
                "conversation": {"id": "a:1dmchat", "conversationType": "personal"},
                "channelData": {"eventType": "softDeleteMessage"},
            }
        )
    )

    assert reports.deleted == [
        InboundMessageDeleted(channel_id="a:1dmchat", message_ref="m10")
    ]


def test_an_edit_activity_reports_the_whole_new_text() -> None:
    adapter, _, reports, captured = _setup()

    _run(
        adapter._dispatch_activity(
            _activity(
                "messageUpdate",
                "m11",
                text="<at>Switch</at> new words",
                channelData={"eventType": "editMessage", "channel": {"id": CHANNEL}},
            )
        )
    )

    assert captured == []
    assert reports.edited == [
        InboundMessageEdited(
            channel_id=CHANNEL, message_ref="m11", content="@Switch new words"
        )
    ]


def test_an_edit_heard_both_ways_is_reported_once() -> None:
    adapter, cert, reports, _ = _setup()

    _run(
        adapter._dispatch_activity(
            _activity(
                "messageUpdate",
                "m12",
                text="changed",
                channelData={"eventType": "editMessage", "channel": {"id": CHANNEL}},
            )
        )
    )
    _run(
        adapter.receive_notification(
            _notification(
                "updated",
                _message(
                    "m12",
                    lastEditedDateTime="2026-01-01T00:00:00Z",
                    body={"contentType": "text", "content": "changed"},
                ),
                cert,
            )
        )
    )

    assert len(reports.edited) == 1


def test_an_undelete_is_not_followed() -> None:
    adapter, _, reports, captured = _setup()

    _run(
        adapter._dispatch_activity(
            _activity(
                "messageUpdate",
                "m13",
                text="back again",
                channelData={
                    "eventType": "undeleteMessage",
                    "channel": {"id": CHANNEL},
                },
            )
        )
    )

    assert reports.edited == [] and reports.deleted == [] and captured == []


def test_a_deleted_channel_is_reported_deleted_and_no_longer_captured() -> None:
    adapter, _, reports, _ = _setup()
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._subscriptions[CHANNEL] = "SUB-C"
    adapter._capture_wanted.add(CHANNEL)

    _run(
        adapter._dispatch_activity(
            {
                "type": "conversationUpdate",
                "serviceUrl": "https://smba.trafficmanager.net/amer/",
                "conversation": {
                    "id": "19:general@thread.tacv2",
                    "conversationType": "channel",
                },
                "channelData": {
                    "eventType": "channelDeleted",
                    "channel": {"id": CHANNEL, "name": "gone"},
                    "team": {"id": "19:general@thread.tacv2"},
                },
            }
        )
    )

    assert reports.removed == [InboundChannelRemoved(channel_id=CHANNEL, deleted=True)]
    assert fake.deleted == ["SUB-C"]
    assert CHANNEL not in adapter._capture_wanted


def test_a_quiet_copy_hands_a_deleted_channels_capture_to_the_holder() -> None:
    adapter, _, reports, _ = _setup()
    adapter.set_listening(False)
    relayed: list[dict[str, str]] = []
    adapter.set_holder_relay(relayed.append)

    _run(
        adapter._dispatch_activity(
            {
                "type": "conversationUpdate",
                "conversation": {"id": CHANNEL, "conversationType": "channel"},
                "channelData": {
                    "eventType": "channelDeleted",
                    "channel": {"id": CHANNEL},
                },
            }
        )
    )

    assert relayed == [{"action": "release", "channel_id": CHANNEL}]
    assert reports.removed == [InboundChannelRemoved(channel_id=CHANNEL, deleted=True)]


def test_a_failing_report_is_logged_and_the_activity_still_answered(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _, _, _ = _setup()
    caplog.set_level("ERROR")

    async def _raise(event: InboundMessageDeleted) -> None:
        raise RuntimeError("boom")

    adapter._on_message_deleted = _raise

    resp = _run(
        adapter._handle_http_messages(
            _FakeRequest(body=_activity("messageDelete", "m14"))  # type: ignore[arg-type]
        )
    )

    assert resp.status == 200
    assert "Failed to handle inbound Teams activity" in caplog.text

"""Direct tests for the real Teams HTTP clients (GraphClient, BotConnectorClient).

Everywhere else the adapter tests substitute fakes for these clients, so the
actual URL construction, request bodies, response parsing, and — crucially — the
special-cased status codes (404-swallow on delete, 409-swallow on member add,
``>=300`` → error) are exercised here against an in-process ``httpx.MockTransport``
(no network).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.teams import graph as graph_module
from switch_core.bridges.collaboration.teams.connector import (
    ACTIVITY_SIZE_LIMIT,
    BotConnectorClient,
    BotConnectorConflict,
    BotConnectorError,
    BotConnectorGone,
    BotConnectorRefused,
    BotConnectorThrottled,
    BotConnectorUnaddressable,
    BotConnectorUnavailable,
)
from switch_core.bridges.collaboration.teams.graph import GraphClient, GraphError


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeTokens:
    """A token provider with nothing cached, so an authorization refusal has no
    stale token to blame and is not retried. The retry itself is exercised by
    `_StaleTokens` below."""

    def __init__(self) -> None:
        self.tokens = ["graph-tok"]

    async def graph_token(self) -> str:
        return self.tokens[-1]

    async def bot_token(self) -> str:
        return "bot-tok"

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool:
        return False


class _StaleTokens(_FakeTokens):
    """A provider holding one token old enough to predate a recent grant."""

    def __init__(self) -> None:
        super().__init__()
        self.invalidations = 0

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool:
        self.invalidations += 1
        if self.invalidations > 1:
            return False
        self.tokens.append("graph-tok-fresh")
        return True


class _Recorder:
    """Captures each request and replies with a scripted status/body."""

    def __init__(self, status: int = 200, body: Any = None) -> None:
        self.status = status
        self.body = {} if body is None else body
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def last_json(self) -> Any:
        return json.loads(self.requests[-1].content)


def _client(recorder: _Recorder) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(recorder.handler))


def _graph(recorder: _Recorder, tokens: _FakeTokens | None = None) -> GraphClient:
    return GraphClient(tokens=tokens or _FakeTokens(), http=_client(recorder))  # type: ignore[arg-type]


def _connector(
    recorder: _Recorder,
    *,
    allowed_hosts: frozenset[str] | None = None,
    on_bot_disabled: Any = None,
) -> BotConnectorClient:
    return BotConnectorClient(
        tokens=_FakeTokens(),  # type: ignore[arg-type]
        http=_client(recorder),
        allowed_hosts=allowed_hosts,
        on_bot_disabled=on_bot_disabled or (lambda: None),
    )


# ── GraphClient ───────────────────────────────────────────────────────────────


def test_create_subscription_sends_expected_body() -> None:
    rec = _Recorder(201, {"id": "SUB-1"})
    graph = _graph(rec)

    result = _run(
        graph.create_subscription(
            resource="teams/t1/channels/c1/messages",
            notification_url="https://x/api/teams/notifications",
            lifecycle_notification_url="https://x/api/teams/notifications",
            client_state="s3cr3t",
            expiration_iso="2026-01-01T00:00:00Z",
            encryption_certificate="CERT",
            encryption_certificate_id="cert-1",
        )
    )

    assert result == {"id": "SUB-1"}
    assert str(rec.last.url) == "https://graph.microsoft.com/v1.0/subscriptions"
    assert rec.last.headers["Authorization"] == "Bearer graph-tok"
    body = rec.last_json()
    assert body["changeType"] == "created,updated"
    assert body["includeResourceData"] is True
    assert body["resource"] == "teams/t1/channels/c1/messages"
    assert body["encryptionCertificate"] == "CERT"
    assert body["clientState"] == "s3cr3t"


def test_create_subscription_error_raises() -> None:
    graph = _graph(_Recorder(403, {"error": "forbidden"}))

    with pytest.raises(GraphError):
        _run(
            graph.create_subscription(
                resource="teams/t1/channels/c1/messages",
                notification_url="https://x/n",
                lifecycle_notification_url="https://x/n",
                client_state="s",
                expiration_iso="2026-01-01T00:00:00Z",
                encryption_certificate="CERT",
                encryption_certificate_id="cert-1",
            )
        )


def test_delete_subscription_swallows_404() -> None:
    # An already-gone subscription is not an error.
    graph = _graph(_Recorder(404, {"error": "not found"}))
    _run(graph.delete_subscription(subscription_id="SUB-gone"))


def test_delete_subscription_raises_on_other_error() -> None:
    graph = _graph(_Recorder(500, {"error": "boom"}))
    with pytest.raises(GraphError):
        _run(graph.delete_subscription(subscription_id="SUB-1"))


def test_add_channel_member_swallows_409_conflict() -> None:
    # Already a member → 409 is idempotent, not an error.
    rec = _Recorder(409, {"error": "conflict"})
    graph = _graph(rec)
    _run(graph.add_channel_member(team_id="t1", channel_id="c1", user_aad_id="u1"))
    assert (
        str(rec.last.url)
        == "https://graph.microsoft.com/v1.0/teams/t1/channels/c1/members"
    )


def test_add_channel_member_raises_on_other_error() -> None:
    graph = _graph(_Recorder(500, {"error": "boom"}))
    with pytest.raises(GraphError):
        _run(graph.add_channel_member(team_id="t1", channel_id="c1", user_aad_id="u1"))


def test_add_team_member_swallows_409_conflict() -> None:
    graph = _graph(_Recorder(409, {"error": "conflict"}))
    _run(graph.add_team_member(team_id="t1", user_aad_id="u1"))


def test_add_team_member_raises_on_other_error() -> None:
    graph = _graph(_Recorder(500, {"error": "boom"}))
    with pytest.raises(GraphError):
        _run(graph.add_team_member(team_id="t1", user_aad_id="u1"))


def test_create_channel_sends_body_and_returns_channel() -> None:
    rec = _Recorder(201, {"id": "19:new@thread.tacv2", "membershipType": "private"})
    graph = _graph(rec)

    channel = _run(
        graph.create_channel(
            team_id="t1",
            display_name="My Room",
            description="topic",
            membership_type="private",
        )
    )

    assert channel["id"] == "19:new@thread.tacv2"
    assert str(rec.last.url) == "https://graph.microsoft.com/v1.0/teams/t1/channels"
    body = rec.last_json()
    assert body["displayName"] == "My Room"
    assert body["membershipType"] == "private"


def test_list_subscriptions_returns_value_array() -> None:
    graph = _graph(_Recorder(200, {"value": [{"id": "S1"}, {"id": "S2"}]}))
    subs = _run(graph.list_subscriptions())
    assert [s["id"] for s in subs] == ["S1", "S2"]


def test_renew_subscription_error_raises() -> None:
    graph = _graph(_Recorder(404, {"error": "gone"}))
    with pytest.raises(GraphError):
        _run(
            graph.renew_subscription(
                subscription_id="S1", expiration_iso="2026-01-01T00:00:00Z"
            )
        )


# ── BotConnectorClient ────────────────────────────────────────────────────────


def test_create_channel_thread_builds_body_and_parses_ids() -> None:
    rec = _Recorder(201, {"id": "conv-1", "activityId": "act-1"})
    connector = _connector(rec)

    conversation_id, activity_id = _run(
        connector.create_channel_thread(
            service_url="https://smba.example/amer/",
            channel_id="19:c@thread.tacv2",
            tenant_id="tenant-1",
            activity={"type": "message", "text": "hi"},
        )
    )

    assert conversation_id == "conv-1"
    assert activity_id == "act-1"
    assert str(rec.last.url) == "https://smba.example/amer/v3/conversations"
    assert rec.last.headers["Authorization"] == "Bearer bot-tok"
    body = rec.last_json()
    assert body["isGroup"] is True
    assert body["channelData"]["channel"]["id"] == "19:c@thread.tacv2"
    # Microsoft asks a proactive message to name the organisation, and with one
    # app serving many the channel id alone does not.
    assert body["channelData"]["tenant"]["id"] == "tenant-1"


def test_create_channel_thread_refuses_to_invent_an_activity_id() -> None:
    # A response carrying only ``id`` names the conversation, not the message
    # in it. Handing that back as the activity id addressed every later edit
    # to the wrong thing, and the edit that failed looked like a platform
    # fault rather than an id we made up.
    rec = _Recorder(201, {"id": "conv-1"})
    connector = _connector(rec)

    with pytest.raises(BotConnectorUnaddressable) as raised:
        _run(
            connector.create_channel_thread(
                service_url="https://smba.example/amer/",
                channel_id="19:c@thread.tacv2",
                tenant_id="tenant-1",
                activity={"type": "message"},
            )
        )

    # Not a refusal: the post is presumably in the channel, so whoever
    # reserved it keeps the reservation rather than sending a second copy.
    assert not isinstance(raised.value, BotConnectorRefused)


def test_create_channel_thread_error_raises() -> None:
    connector = _connector(_Recorder(500, {"error": "boom"}))
    with pytest.raises(BotConnectorError):
        _run(
            connector.create_channel_thread(
                service_url="https://smba.example/amer/",
                channel_id="19:c@thread.tacv2",
                tenant_id="tenant-1",
                activity={"type": "message"},
            )
        )


def test_send_to_conversation_returns_id_and_builds_url() -> None:
    rec = _Recorder(201, {"id": "msg-9"})
    connector = _connector(rec)

    msg_id = _run(
        connector.send_to_conversation(
            service_url="https://smba.example/amer/",
            conversation_id="conv-1",
            activity={"type": "message", "text": "hi"},
        )
    )

    assert msg_id == "msg-9"
    assert str(rec.last.url) == (
        "https://smba.example/amer/v3/conversations/conv-1/activities"
    )


def test_send_to_conversation_error_raises() -> None:
    connector = _connector(_Recorder(502, {"error": "bad gateway"}))
    with pytest.raises(BotConnectorError):
        _run(
            connector.send_to_conversation(
                service_url="https://smba.example/amer/",
                conversation_id="conv-1",
                activity={"type": "message"},
            )
        )


def test_update_activity_error_raises() -> None:
    connector = _connector(_Recorder(404, {"error": "gone"}))
    with pytest.raises(BotConnectorError):
        _run(
            connector.update_activity(
                service_url="https://smba.example/amer/",
                conversation_id="conv-1",
                activity_id="act-1",
                activity={"type": "message"},
            )
        )


def test_delete_activity_error_raises() -> None:
    connector = _connector(_Recorder(403, {"error": "forbidden"}))
    with pytest.raises(BotConnectorError):
        _run(
            connector.delete_activity(
                service_url="https://smba.example/amer/",
                conversation_id="conv-1",
                activity_id="act-1",
            )
        )


def test_delete_activity_success_is_silent() -> None:
    rec = _Recorder(200, {})
    connector = _connector(rec)
    _run(
        connector.delete_activity(
            service_url="https://smba.example/amer/",
            conversation_id="conv-1",
            activity_id="act-1",
        )
    )
    assert rec.last.method == "DELETE"


# ── a permission granted while we hold a token ───────────────────────────────


class _RelentingRecorder(_Recorder):
    """Refuses the first call and accepts the second, the way Graph behaves
    once the caller presents a token minted after the grant."""

    def __init__(self, body: Any) -> None:
        super().__init__(403, body)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if len(self.requests) == 1:
            return httpx.Response(403, json=self.body)
        return httpx.Response(200, json={"value": []})


def _denied() -> dict[str, Any]:
    return {
        "error": {
            "code": "Authorization_RequestDenied",
            "message": "Insufficient privileges to complete the operation.",
        }
    }


def test_a_403_is_retried_once_with_a_freshly_minted_token() -> None:
    # An app's Graph roles are fixed when its token is issued, so a permission
    # consented while the bridge runs does nothing until the token is replaced.
    # Left alone, that is an hour of Graph reporting a permission the operator
    # can see is granted.
    recorder = _RelentingRecorder(_denied())
    tokens = _StaleTokens()

    result = _run(_graph(recorder, tokens).list_subscriptions())

    assert result == []
    assert len(recorder.requests) == 2
    assert recorder.requests[0].headers["Authorization"] == "Bearer graph-tok"
    assert recorder.requests[1].headers["Authorization"] == "Bearer graph-tok-fresh"


def test_a_403_that_survives_the_retry_still_raises() -> None:
    recorder = _Recorder(403, _denied())

    with pytest.raises(GraphError, match="Authorization_RequestDenied"):
        _run(_graph(recorder, _StaleTokens()).list_subscriptions())

    # Exactly twice: retrying a genuine denial in a loop helps nobody.
    assert len(recorder.requests) == 2


def test_a_401_is_retried_too() -> None:
    # An expired or revoked token looks like this rather than a 403.
    recorder = _RelentingRecorder({"error": {"code": "InvalidAuthenticationToken"}})
    recorder.status = 401

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.requests.append(request)
        if len(recorder.requests) == 1:
            return httpx.Response(401, json=recorder.body)
        return httpx.Response(200, json={"value": []})

    recorder.handler = handler  # type: ignore[method-assign]

    _run(_graph(recorder, _StaleTokens()).list_subscriptions())

    assert len(recorder.requests) == 2


def test_a_freshly_minted_token_is_not_re_minted() -> None:
    # `_FakeTokens.invalidate` reports nothing droppable, standing in for a
    # token issued moments ago — which cannot have missed a grant, so retrying
    # would only add a round trip to every genuine denial.
    recorder = _Recorder(403, _denied())

    with pytest.raises(GraphError):
        _run(_graph(recorder).list_subscriptions())

    assert len(recorder.requests) == 1


def test_a_non_authorization_failure_is_not_retried() -> None:
    # A 400 says the request was wrong, and asking again with a new token
    # cannot make it right.
    recorder = _Recorder(400, {"error": {"code": "ValidationError"}})

    with pytest.raises(GraphError):
        _run(_graph(recorder, _StaleTokens()).list_subscriptions())

    assert len(recorder.requests) == 1


# ── The Bot Connector failure contract ───────────────────────────────────────
#
# Every method used to flatten `status >= 300` into one `BotConnectorError`
# carrying a formatted string, and let raw `httpx` exceptions past. Nothing
# above it could tell "Teams said no" from "Teams never answered", which is the
# difference between discarding a reservation and keeping it.


def _send(connector: BotConnectorClient) -> Any:
    return connector.send_to_conversation(
        service_url="https://smba.example/amer/",
        conversation_id="19:c@thread.tacv2",
        activity={"type": "message", "text": "hi"},
    )


def test_a_429_is_throttling_and_carries_the_wait_teams_asked_for() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={}, headers={"Retry-After": "17"})

    connector = BotConnectorClient(
        tokens=_FakeTokens(),  # type: ignore[arg-type]
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        allowed_hosts=None,
        on_bot_disabled=lambda: None,
    )

    with pytest.raises(BotConnectorThrottled) as raised:
        _run(_send(connector))

    assert raised.value.retry_after == 17
    # Throttling is a refusal: the activity was rejected, not half-written.
    assert isinstance(raised.value, BotConnectorRefused)


def test_an_unreadable_retry_after_leaves_the_wait_unstated() -> None:
    # An HTTP-date rather than seconds. Reporting a made-up number as Teams'
    # own would be worse than saying nothing and backing off locally.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429, json={}, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}
        )

    connector = BotConnectorClient(
        tokens=_FakeTokens(),  # type: ignore[arg-type]
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        allowed_hosts=None,
        on_bot_disabled=lambda: None,
    )

    with pytest.raises(BotConnectorThrottled) as raised:
        _run(_send(connector))

    assert raised.value.retry_after is None


def test_a_404_says_the_target_is_gone() -> None:
    with pytest.raises(BotConnectorGone):
        _run(_send(_connector(_Recorder(404, {"error": "no such conversation"}))))


def test_a_412_says_the_activity_moved_under_the_edit() -> None:
    connector = _connector(_Recorder(412, {"error": "precondition"}))
    with pytest.raises(BotConnectorConflict):
        _run(
            connector.update_activity(
                service_url="https://smba.example/amer/",
                conversation_id="19:c@thread.tacv2",
                activity_id="act-1",
                activity={"type": "message"},
            )
        )


def test_a_400_is_a_refusal_nothing_was_written_for() -> None:
    with pytest.raises(BotConnectorRefused) as raised:
        _run(_send(_connector(_Recorder(400, {"error": "bad request"}))))

    assert not isinstance(raised.value, BotConnectorUnavailable)


def test_a_500_leaves_the_outcome_unknown() -> None:
    # The message may be in the channel. Calling this a refusal is what
    # throws away a reservation for a publication that actually happened.
    with pytest.raises(BotConnectorUnavailable) as raised:
        _run(_send(_connector(_Recorder(500, {"error": "boom"}))))

    assert not isinstance(raised.value, BotConnectorRefused)


def test_a_408_leaves_the_outcome_unknown_despite_being_a_4xx() -> None:
    with pytest.raises(BotConnectorUnavailable):
        _run(_send(_connector(_Recorder(408, {"error": "timeout"}))))


def test_a_transport_failure_never_escapes_as_httpx() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    connector = BotConnectorClient(
        tokens=_FakeTokens(),  # type: ignore[arg-type]
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        allowed_hosts=None,
        on_bot_disabled=lambda: None,
    )

    with pytest.raises(BotConnectorUnavailable) as raised:
        _run(_send(connector))

    assert isinstance(raised.value.__cause__, httpx.ConnectError)
    assert raised.value.status is None


def test_an_accepted_send_with_no_id_is_not_reported_as_success() -> None:
    with pytest.raises(BotConnectorUnaddressable):
        _run(_send(_connector(_Recorder(200, {}))))


def test_an_ephemeral_signal_does_not_need_an_id() -> None:
    # A typing indicator is never addressed again, so the missing id that
    # makes a message unusable says nothing about this one.
    rec = _Recorder(200, {})
    _run(
        _connector(rec).send_signal(
            service_url="https://smba.example/amer/",
            conversation_id="19:c@thread.tacv2",
            activity={"type": "typing"},
        )
    )
    assert rec.last_json() == {"type": "typing"}


def test_an_oversized_activity_is_refused_before_it_is_sent() -> None:
    # Teams answers this with a 413 and the sender learns nothing it could not
    # have worked out first. Refusing locally names the size instead, and the
    # request is not made at all.
    rec = _Recorder(200, {"id": "m1"})
    connector = _connector(rec)

    with pytest.raises(BotConnectorRefused, match="UTF-16"):
        _run(
            connector.send_to_conversation(
                service_url="https://smba.example/amer/",
                conversation_id="19:c@thread.tacv2",
                activity={"type": "message", "text": "x" * ACTIVITY_SIZE_LIMIT},
            )
        )

    assert rec.requests == []


def test_the_guard_counts_utf16_rather_than_characters() -> None:
    # An emoji is one character and four UTF-16 bytes, which is the unit
    # Microsoft states the limit in. Counting characters would let a payload
    # through at nearly four times the size it really is.
    rec = _Recorder(200, {"id": "m1"})
    connector = _connector(rec)
    text = "😀" * (ACTIVITY_SIZE_LIMIT // 4)

    with pytest.raises(BotConnectorRefused):
        _run(
            connector.send_to_conversation(
                service_url="https://smba.example/amer/",
                conversation_id="19:c@thread.tacv2",
                activity={"type": "message", "text": text},
            )
        )

    assert rec.requests == []


def test_what_the_guard_measured_is_what_goes_on_the_wire() -> None:
    # Serialised once. A second `json.dumps` with different options would send
    # bytes the guard never saw — and non-ASCII is exactly where the two
    # disagree.
    rec = _Recorder(200, {"id": "m1"})
    _run(
        _connector(rec).send_to_conversation(
            service_url="https://smba.example/amer/",
            conversation_id="19:c@thread.tacv2",
            activity={"type": "message", "text": "héllo 😀"},
        )
    )

    assert rec.last_json()["text"] == "héllo 😀"
    assert rec.last.headers["Content-Type"] == "application/json"


def test_the_token_is_never_sent_to_a_host_outside_the_allowlist() -> None:
    """Under the distributed app the token posts into every organisation's
    Teams, so a learned or stored address that is not Microsoft's is refused
    before the token is attached."""
    rec = _Recorder(201, {"id": "msg-1"})
    connector = _connector(rec, allowed_hosts=frozenset({"smba.trafficmanager.net"}))

    with pytest.raises(BotConnectorRefused, match="not a Bot Connector host"):
        _run(
            connector.send_to_conversation(
                service_url="https://attacker.example/amer/",
                conversation_id="19:c@thread.tacv2",
                activity={"type": "message"},
            )
        )

    assert rec.requests == []


def test_an_allowed_host_over_plain_http_is_still_refused() -> None:
    rec = _Recorder(201, {"id": "msg-1"})
    connector = _connector(rec, allowed_hosts=frozenset({"smba.trafficmanager.net"}))

    with pytest.raises(BotConnectorRefused):
        _run(
            connector.send_to_conversation(
                service_url="http://smba.trafficmanager.net/amer/",
                conversation_id="19:c@thread.tacv2",
                activity={"type": "message"},
            )
        )


def test_an_allowed_host_is_called() -> None:
    rec = _Recorder(201, {"id": "msg-1"})
    connector = _connector(rec, allowed_hosts=frozenset({"smba.trafficmanager.net"}))

    _run(
        connector.send_to_conversation(
            service_url="https://smba.trafficmanager.net/amer/",
            conversation_id="19:c@thread.tacv2",
            activity={"type": "message"},
        )
    )

    assert len(rec.requests) == 1


def test_a_blocked_app_is_reported() -> None:
    told: list[bool] = []
    rec = _Recorder(403, {"error": {"code": "BotDisabledByAdmin"}})
    connector = _connector(rec, on_bot_disabled=lambda: told.append(True))

    with pytest.raises(BotConnectorRefused):
        _run(
            connector.send_to_conversation(
                service_url="https://smba.example/amer/",
                conversation_id="19:c@thread.tacv2",
                activity={"type": "message"},
            )
        )

    assert told == [True]


# ── Paging, and the app's own installation in a team ─────────────────────────


class _PagedRecorder(_Recorder):
    """Answers each request with the next of a list of pages."""

    def __init__(self, pages: list[dict[str, Any]]) -> None:
        super().__init__()
        self._pages = list(pages)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(200, json=self._pages.pop(0))


def test_every_page_of_subscriptions_is_read() -> None:
    """An organisation with many captured channels has more subscriptions than
    one page holds; one left unread at start would be made a second time."""
    recorder = _PagedRecorder(
        [
            {
                "value": [{"id": "S1"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=2",
            },
            {"value": [{"id": "S2"}]},
        ]
    )

    subs = _run(_graph(recorder).list_subscriptions())

    assert [s["id"] for s in subs] == ["S1", "S2"]
    assert str(recorder.requests[1].url).endswith("$skiptoken=2")


def test_every_page_of_teams_is_read_and_the_query_is_sent_once() -> None:
    recorder = _PagedRecorder(
        [
            {
                "value": [{"id": "T1", "displayName": "One"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams?$skiptoken=2",
            },
            {"value": [{"id": "T2", "displayName": "Two"}]},
        ]
    )

    teams = _run(_graph(recorder).list_teams())

    assert [t["id"] for t in teams] == ["T1", "T2"]
    assert recorder.requests[0].url.params["$select"] == "id,displayName"
    assert "$select" not in recorder.requests[1].url.params


def test_a_next_page_off_graph_is_not_sent_the_token() -> None:
    recorder = _PagedRecorder(
        [
            {
                "value": [{"id": "S1"}],
                "@odata.nextLink": "https://elsewhere.example/v1.0/subscriptions?$skiptoken=2",
            },
            {"value": [{"id": "S2"}]},
        ]
    )

    with pytest.raises(BridgeOperationError, match="not on graph.microsoft.com"):
        _run(_graph(recorder).list_subscriptions())

    assert len(recorder.requests) == 1


def test_channel_and_installation_ids_stay_one_path_segment() -> None:
    recorder = _Recorder(200, {"id": "x"})
    graph = _graph(recorder)

    _run(graph.get_channel(team_id="t1", channel_id="19:a/b?c@thread.tacv2"))
    assert recorder.last.url.raw_path.split(b"?")[0] == (
        b"/v1.0/teams/t1/channels/19:a%2Fb%3Fc@thread.tacv2"
    )

    _run(graph.uninstall_app(team_id="t1", installation_id="NmRi/Mw=="))
    assert recorder.last.url.raw_path == b"/v1.0/teams/t1/installedApps/NmRi%2FMw%3D%3D"


def test_a_real_channel_id_is_sent_as_it_is() -> None:
    recorder = _Recorder(200, {"id": "x"})

    _run(
        _graph(recorder).get_channel(team_id="t1", channel_id="19:abc_1-2@thread.tacv2")
    )

    assert (
        recorder.last.url.raw_path.split(b"?")[0]
        == b"/v1.0/teams/t1/channels/19:abc_1-2@thread.tacv2"
    )


def test_a_failed_page_raises() -> None:
    with pytest.raises(GraphError) as failed:
        _run(_graph(_Recorder(503, {"error": {"message": "busy"}})).list_teams())
    assert failed.value.status == 503


def test_the_app_is_added_to_a_team_by_its_catalogue_id() -> None:
    recorder = _Recorder(201)

    _run(_graph(recorder).install_app(team_id="team-1", catalog_app_id="cat-1"))

    assert recorder.last.method == "POST"
    assert recorder.last.url.path == "/v1.0/teams/team-1/installedApps"
    assert recorder.last_json() == {
        "teamsApp@odata.bind": "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/cat-1"
    }


def test_adding_the_app_where_it_already_is_is_not_an_error() -> None:
    _run(_graph(_Recorder(409)).install_app(team_id="team-1", catalog_app_id="cat-1"))


def test_a_refused_addition_raises() -> None:
    with pytest.raises(GraphError):
        _run(_graph(_Recorder(403)).install_app(team_id="team-1", catalog_app_id="c"))


def test_the_apps_installations_are_found_by_its_manifest_id() -> None:
    recorder = _Recorder(
        200,
        {
            "value": [
                {"id": "INST-1", "teamsApp": {"id": "cat-1"}},
                {"id": "INST-2", "teamsApp": None},
                {"teamsApp": {"id": "no-installation-id"}},
            ]
        },
    )

    found = _run(
        _graph(recorder).find_app_installations(team_id="team-1", external_id="app-1")
    )

    assert [(i.installation_id, i.catalog_app_id) for i in found] == [
        ("INST-1", "cat-1"),
        ("INST-2", None),
    ]
    assert recorder.last.url.params["$filter"] == "teamsApp/externalId eq 'app-1'"
    assert recorder.last.url.params["$expand"] == "teamsApp"


def test_a_team_whose_apps_cannot_be_read_raises() -> None:
    with pytest.raises(GraphError) as failed:
        _run(
            _graph(_Recorder(404)).find_app_installations(
                team_id="team-1", external_id="app-1"
            )
        )
    assert failed.value.status == 404


def test_removing_the_app_from_a_team_it_has_left_is_not_an_error() -> None:
    recorder = _Recorder(404)

    _run(_graph(recorder).uninstall_app(team_id="team-1", installation_id="INST-1"))

    assert recorder.last.method == "DELETE"
    assert recorder.last.url.path == "/v1.0/teams/team-1/installedApps/INST-1"


def test_a_refused_removal_raises() -> None:
    with pytest.raises(GraphError):
        _run(
            _graph(_Recorder(500)).uninstall_app(
                team_id="team-1", installation_id="INST-1"
            )
        )


def test_a_team_id_cannot_move_the_rest_of_the_url() -> None:
    """A team id comes from a request; a `?` or `/` in it must not turn the
    path after it into a query, or into somewhere else."""
    recorder = _Recorder(201)

    _run(_graph(recorder).install_app(team_id="x?y=1/../../users", catalog_app_id="c"))

    assert recorder.last.url.raw_path.startswith(
        b"/v1.0/teams/x%3Fy%3D1%2F..%2F..%2Fusers/installedApps"
    )
    assert recorder.last.url.query == b""


# ── Throttling ───────────────────────────────────────────────────────────────


class _ThrottlingRecorder(_Recorder):
    """Throttles the first `times` requests, naming `retry_after` if given."""

    def __init__(self, *, times: int, retry_after: str | None) -> None:
        super().__init__(200, {"value": []})
        self._times = times
        self._retry_after = retry_after

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._times > 0:
            self._times -= 1
            headers = {"Retry-After": self._retry_after} if self._retry_after else {}
            return httpx.Response(
                429, json={"error": {"message": "slow down"}}, headers=headers
            )
        return httpx.Response(200, json=self.body)


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(graph_module.asyncio, "sleep", fake_sleep)
    return slept


def test_a_throttled_call_waits_as_long_as_graph_asks_and_tries_again(
    waits: list[float],
) -> None:
    recorder = _ThrottlingRecorder(times=2, retry_after="3")

    teams = _run(_graph(recorder).list_teams())

    assert teams == []
    assert len(recorder.requests) == 3
    assert waits == [3.0, 3.0]


def test_without_a_named_wait_the_wait_grows(waits: list[float]) -> None:
    recorder = _ThrottlingRecorder(times=2, retry_after=None)

    _run(_graph(recorder).list_teams())

    assert waits == [1.0, 2.0]


def test_throttling_that_outlasts_the_retries_is_raised(waits: list[float]) -> None:
    recorder = _ThrottlingRecorder(times=5, retry_after="1")

    with pytest.raises(GraphError) as failed:
        _run(_graph(recorder).list_teams())

    assert failed.value.status == 429
    assert len(recorder.requests) == 3


def test_a_wait_longer_than_is_worth_sitting_through_is_raised_at_once(
    waits: list[float],
) -> None:
    recorder = _ThrottlingRecorder(times=1, retry_after="120")

    with pytest.raises(GraphError) as failed:
        _run(_graph(recorder).list_teams())

    assert failed.value.status == 429
    assert waits == []
    assert len(recorder.requests) == 1


def test_a_user_is_read_by_their_escaped_id() -> None:
    recorder = _Recorder(200, {"id": "u/1", "displayName": "Alice"})

    user = _run(_graph(recorder).get_user(user_id="u/1"))

    assert user["displayName"] == "Alice"
    assert recorder.last.url.raw_path.startswith(b"/v1.0/users/u%2F1?")


def test_a_user_graph_cannot_find_raises() -> None:
    with pytest.raises(GraphError) as failed:
        _run(_graph(_Recorder(404)).get_user(user_id="u-1"))
    assert failed.value.status == 404


def test_a_channel_graph_will_not_show_raises() -> None:
    with pytest.raises(GraphError) as failed:
        _run(
            _graph(_Recorder(403)).get_channel(
                team_id="team-1", channel_id="19:abc@thread.tacv2"
            )
        )
    assert failed.value.status == 403

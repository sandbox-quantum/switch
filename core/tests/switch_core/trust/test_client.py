"""Switch Trust's wire format and fail-open behaviour are ours to keep
correct, so they are tested directly rather than only through the two call
sites that use them.
"""

import json
import uuid

import httpx
import pytest

from switch_core.trust.client import (
    GuardrailBlockedError,
    GuardrailsCheckError,
    HttpTrustClient,
    NullTrustClient,
    TrustCheckResult,
    TrustFinding,
    check_message,
    trust_annotation,
)


def _client(handler) -> HttpTrustClient:
    return HttpTrustClient(
        base_url="https://trust.example",
        api_key="k",
        policy_id="pol_123",
        timeout_seconds=1.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


@pytest.mark.asyncio
async def test_posts_the_one_message_with_the_expected_headers():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["policy"] = request.headers.get("x-guardrails-policy-id")
        seen["key"] = request.headers.get("x-flintai-api-key")
        seen["agent_name"] = request.headers.get("x-agent-name")
        seen["session_id"] = request.headers.get("x-agent-session-id")
        seen["turn_id"] = request.headers.get("x-agent-turn-id")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    client = _client(handler)
    result = await client.check(role="user", content="hi", room_id="room-1")

    assert seen["url"] == "https://trust.example/guardrails/check"
    assert seen["policy"] == "pol_123"
    assert seen["key"] == "k"
    # Always the same constant agent identity (Switch has no single "agent" to
    # attribute a check to); the room and a fresh per-check id carry the
    # per-call distinction instead.
    assert seen["agent_name"] == "Switch Rooms"
    assert seen["session_id"] == "room-1"
    assert uuid.UUID(str(seen["turn_id"]))  # a fresh, well-formed UUID
    assert seen["body"] == {"messages": [{"role": "user", "content": "hi"}]}
    assert result.blocked is False


@pytest.mark.asyncio
async def test_each_check_gets_its_own_turn_id():
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-agent-turn-id"))
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    client = _client(handler)
    await client.check(role="user", content="hi", room_id="room-1")
    await client.check(role="user", content="hi", room_id="room-1")

    assert len(seen) == 2
    assert seen[0] != seen[1]


@pytest.mark.asyncio
async def test_a_trailing_slash_on_the_base_url_does_not_double_up():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    client = HttpTrustClient(
        base_url="https://trust.example/",
        api_key="k",
        policy_id="pol_123",
        timeout_seconds=1.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await client.check(role="user", content="hi", room_id="room-1")
    assert seen["url"] == "https://trust.example/guardrails/check"


@pytest.mark.asyncio
async def test_a_blocked_outcome_carries_its_findings():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "outcome": "GUARDRAIL_RESULT_OUTCOME_BLOCKED",
                "policy_id": "pol_123",
                "policy_name": "Default Policy",
                "findings": [
                    {
                        "category": "pii/email",
                        "detector_name": "PiiDetector",
                        "detected_string": "user@example.com",
                        "severity": "high",
                    }
                ],
            },
        )

    client = _client(handler)
    result = await client.check(
        role="user", content="my email is user@example.com", room_id="room-1"
    )

    assert result.blocked is True
    assert result.policy_name == "Default Policy"
    finding = result.findings[0]
    assert finding.category == "pii/email"
    assert finding.severity == "high"
    # The raw detected text never travels past the wire client.
    assert not hasattr(finding, "detected_string")


@pytest.mark.asyncio
async def test_an_error_response_raises_rather_than_allowing_silently():
    client = _client(lambda request: httpx.Response(503, text="unavailable"))
    with pytest.raises(GuardrailsCheckError, match="503"):
        await client.check(role="user", content="hi", room_id="room-1")


@pytest.mark.asyncio
async def test_a_network_failure_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = _client(handler)
    with pytest.raises(GuardrailsCheckError, match="failed"):
        await client.check(role="user", content="hi", room_id="room-1")


@pytest.mark.asyncio
async def test_null_client_always_allows():
    result = await NullTrustClient().check(
        role="user", content="anything", room_id="room-1"
    )
    assert result.blocked is False


@pytest.mark.asyncio
async def test_check_message_fails_open_on_error():
    client = _client(lambda request: httpx.Response(500, text="boom"))
    result = await check_message(client, role="user", content="hi", room_id="room-1")
    assert result == TrustCheckResult(
        outcome="errored", policy_id=None, policy_name=None
    )


@pytest.mark.asyncio
async def test_check_message_passes_through_a_block():
    client = _client(
        lambda request: httpx.Response(
            200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_BLOCKED"}
        )
    )
    result = await check_message(
        client, role="assistant", content="hi", room_id="room-1"
    )
    assert result.blocked is True


def test_guardrail_blocked_error_names_the_categories():
    result = TrustCheckResult(
        outcome="blocked",
        policy_id="pol_123",
        policy_name="Default",
        findings=(
            TrustFinding(
                category="pii/email", detector_name="PiiDetector", severity="high"
            ),
        ),
    )
    assert "pii/email" in str(GuardrailBlockedError(result))


@pytest.mark.asyncio
async def test_a_redacted_outcome_swaps_the_detected_text():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "outcome": "GUARDRAIL_RESULT_OUTCOME_REDACTED",
                "findings": [
                    {
                        "category": "pii/email",
                        "detector_name": "PiiDetector",
                        "detected_string": "user@example.com",
                        "severity": "high",
                    }
                ],
            },
        )

    client = _client(handler)
    result = await client.check(
        role="user",
        content="email me at user@example.com please",
        room_id="room-1",
    )

    assert result.outcome == "redacted"
    assert result.redacted_content == "email me at [redacted] please"
    # Same guarantee as the blocked path: the raw text isn't exposed on the finding.
    assert not hasattr(result.findings[0], "detected_string")


@pytest.mark.asyncio
async def test_a_redacted_outcome_with_no_detected_text_redacts_nothing():
    client = _client(
        lambda request: httpx.Response(
            200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_REDACTED", "findings": []}
        )
    )
    result = await client.check(role="user", content="hello", room_id="room-1")
    assert result.outcome == "redacted"
    assert result.redacted_content == "hello"


@pytest.mark.asyncio
async def test_an_alerted_outcome_is_not_blocked():
    client = _client(
        lambda request: httpx.Response(
            200,
            json={
                "outcome": "GUARDRAIL_RESULT_OUTCOME_ALERTED",
                "findings": [{"category": "pii/email", "detector_name": "PiiDetector"}],
            },
        )
    )
    result = await client.check(role="user", content="hi", room_id="room-1")
    assert result.outcome == "alerted"
    assert result.blocked is False
    assert result.redacted_content is None


@pytest.mark.asyncio
async def test_an_unrecognised_outcome_is_treated_as_errored_not_allowed_silently():
    client = _client(
        lambda request: httpx.Response(200, json={"outcome": "SOMETHING_NEW"})
    )
    result = await client.check(role="user", content="hi", room_id="room-1")
    assert result.outcome == "errored"


def test_trust_annotation_names_the_categories_for_an_alert():
    result = TrustCheckResult(
        outcome="alerted",
        policy_id=None,
        policy_name=None,
        findings=(
            TrustFinding(
                category="pii/email", detector_name="PiiDetector", severity=None
            ),
        ),
    )
    annotation = trust_annotation(result)
    assert annotation is not None
    assert "pii/email" in annotation


def test_trust_annotation_covers_errored_the_same_way_as_degraded():
    errored = TrustCheckResult(outcome="errored", policy_id=None, policy_name=None)
    assert trust_annotation(errored) is not None


def test_trust_annotation_is_none_for_ok_blocked_and_redacted():
    for outcome in ("ok", "blocked", "redacted"):
        result = TrustCheckResult(outcome=outcome, policy_id=None, policy_name=None)
        assert trust_annotation(result) is None

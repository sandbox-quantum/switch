"""Switch Trust: a guardrails service checked before a message is sent.

Calls the check-only endpoint added in
https://github.com/sandbox-quantum/hoot/pull/2397 — a provider-agnostic
`messages` array in, a block/allow verdict out, no LLM provider in the loop.
`NullTrustClient` is what runs when the feature is off (`SwitchConfig.
trust_enabled` is False): a client that always allows, so no call site has to
ask whether the feature is on — the same shape as `telemetry/sink.py`'s
`NullSink`.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

Role = Literal["user", "assistant"]

# Every check is reported under one constant agent identity: Switch has no
# single "agent" to attribute a check to (a room can hold several, and a
# human-authored message has none at all), so this collapses all of Switch's
# traffic onto one Switch Trust agent rather than inventing a per-sender
# identity Switch Trust has no use for. `x-agent-session-id` (the room) and
# `x-agent-turn-id` (one per check) carry the per-call distinction instead.
_AGENT_NAME = "Switch Rooms"

# The outcome a check settles on. "errored" covers both what the wire protocol
# calls GUARDRAIL_RESULT_OUTCOME_ERRORED (a detector itself failed, but the
# engine still answered) and what `check_message` reports when the HTTP call
# never completed at all — from a caller's perspective both are "this message
# was not cleanly checked," and both get the same non-blocking annotation.
#
# The wire values below follow the GUARDRAIL_RESULT_OUTCOME_<NAME> convention
# confirmed for OK and BLOCKED in the endpoint's README; REDACTED/ALERTED/
# ERRORED are inferred from the same naming and the documented severity order
# (Blocked > Redacted > Alerted > Errored > OK) — worth confirming once
# sandbox-quantum/hoot#2397 lands.
TrustOutcome = Literal["ok", "blocked", "redacted", "alerted", "errored"]

_OUTCOME_BY_WIRE_VALUE: dict[str, TrustOutcome] = {
    "GUARDRAIL_RESULT_OUTCOME_OK": "ok",
    "GUARDRAIL_RESULT_OUTCOME_BLOCKED": "blocked",
    "GUARDRAIL_RESULT_OUTCOME_REDACTED": "redacted",
    "GUARDRAIL_RESULT_OUTCOME_ALERTED": "alerted",
    "GUARDRAIL_RESULT_OUTCOME_ERRORED": "errored",
}

_REDACTION_PLACEHOLDER = "[redacted]"


class GuardrailsCheckError(RuntimeError):
    """A check did not complete: network error, timeout, or a non-2xx answer."""


class GuardrailBlockedError(Exception):
    """A message was refused by the guardrails policy.

    Carries the verdict so a caller can tell the room or the agent why,
    without re-deriving it.
    """

    def __init__(self, result: TrustCheckResult) -> None:
        self.result = result
        categories = (
            ", ".join(f.category for f in result.findings) or "policy violation"
        )
        super().__init__(f"blocked by Switch Trust ({categories})")


@dataclass(frozen=True)
class TrustFinding:
    """One detector hit. Deliberately narrower than the wire shape: no
    `detected_string` — that is often the sensitive text itself (an email, a
    secret), and this travels into log lines and blocked-message notices.
    (A REDACTED verdict's `detected_string`s are used once, inside
    `HttpTrustClient.check`, to build `redacted_content`, and never stored
    here.)"""

    category: str
    detector_name: str
    severity: str | None


@dataclass(frozen=True)
class TrustCheckResult:
    outcome: TrustOutcome
    policy_id: str | None
    policy_name: str | None
    findings: tuple[TrustFinding, ...] = ()
    # Set only when `outcome == "redacted"`: the checked content with each
    # finding's detected text swapped for a placeholder. `None` otherwise,
    # including when a REDACTED verdict carried no usable detected text to
    # redact — callers must not send the original content in that case either,
    # but that situation has not come up against the real endpoint yet.
    redacted_content: str | None = None

    @property
    def blocked(self) -> bool:
        return self.outcome == "blocked"


class TrustClient(Protocol):
    async def check(
        self, *, role: Role, content: str, room_id: str
    ) -> TrustCheckResult: ...


class NullTrustClient:
    """Off: every message is allowed, and no request is made."""

    async def check(
        self, *, role: Role, content: str, room_id: str
    ) -> TrustCheckResult:
        return TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)


class DynamicTrustClient:
    """Reads the one server-global ``trust_settings`` row on every call.

    Unlike `HttpTrustClient`, built once at boot from fixed arguments, this
    resolves its settings fresh each check — so a change made through the
    gateway's settings endpoint (`gateway/trust_settings.py`) takes effect on
    the next message, with no restart. Behaves exactly like `NullTrustClient`
    when no row exists yet, or one is missing `policy_id`/`api_key_encrypted`.
    """

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        store: TrustSettingsStore,
        keyring: Keyring,
        client: httpx.AsyncClient,
        timeout_seconds: float,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
        self._keyring = keyring
        self._client = client
        self._timeout_seconds = timeout_seconds

    async def check(
        self, *, role: Role, content: str, room_id: str
    ) -> TrustCheckResult:
        async with self._session_factory() as session:
            settings = await self._store.get(session)
        if settings is None or not settings.policy_id or not settings.api_key_encrypted:
            return TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)
        http_client = HttpTrustClient(
            base_url=settings.endpoint,
            api_key=self._keyring.decrypt(settings.api_key_encrypted),
            policy_id=settings.policy_id,
            timeout_seconds=self._timeout_seconds,
            client=self._client,
        )
        return await http_client.check(role=role, content=content, room_id=room_id)


class HttpTrustClient:
    """Posts to `{base_url}/guardrails/check`. One client, reused.

    No history, no tool calls: v1 checks the one message being sent, as a
    `messages` array of length one. Raises `GuardrailsCheckError` on any
    failure — whether that is treated as blocking or fail-open is a decision
    for the caller (`check_message` below), not this client.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        policy_id: str,
        timeout_seconds: float,
        client: httpx.AsyncClient,
    ) -> None:
        self._url = base_url.rstrip("/") + "/guardrails/check"
        self._headers = {
            "Content-Type": "application/json",
            "x-guardrails-policy-id": policy_id,
            "x-flintai-api-key": api_key,
            "x-agent-name": _AGENT_NAME,
        }
        self._timeout_seconds = timeout_seconds
        self._client = client

    async def check(
        self, *, role: Role, content: str, room_id: str
    ) -> TrustCheckResult:
        payload = {"messages": [{"role": role, "content": content}]}
        headers = {
            **self._headers,
            "x-agent-session-id": room_id,
            # One per check, not per logical "turn" a host might recognise —
            # Switch has no such id to hand it (see `TrustClient.check`'s
            # callers). Lets Switch Trust tell two checks apart; nothing here
            # relies on it being stable across retries.
            "x-agent-turn-id": str(uuid.uuid4()),
        }
        try:
            response = await self._client.post(
                self._url,
                json=payload,
                headers=headers,
                timeout=self._timeout_seconds,
            )
        except httpx.HTTPError as error:
            raise GuardrailsCheckError(f"POST {self._url} failed: {error}") from error
        if response.status_code >= 400:
            raise GuardrailsCheckError(
                f"POST {self._url} answered {response.status_code}: "
                f"{response.text[:200]}"
            )
        try:
            body: dict[str, Any] = response.json()
        except ValueError as error:
            raise GuardrailsCheckError(
                f"POST {self._url} answered a non-JSON body"
            ) from error

        wire_outcome = str(body.get("outcome"))
        outcome = _OUTCOME_BY_WIRE_VALUE.get(wire_outcome)
        if outcome is None:
            logger.warning(
                "Switch Trust returned an unrecognised outcome %r; treating as "
                "'errored' rather than silently allowing it through",
                wire_outcome,
            )
            outcome = "errored"

        raw_findings = body.get("findings") or []
        findings = tuple(
            TrustFinding(
                category=finding.get("category", ""),
                detector_name=finding.get("detector_name", ""),
                severity=finding.get("severity"),
            )
            for finding in raw_findings
        )

        redacted_content = None
        if outcome == "redacted":
            redacted_content = content
            for finding in raw_findings:
                detected = finding.get("detected_string")
                if detected:
                    redacted_content = redacted_content.replace(
                        detected, _REDACTION_PLACEHOLDER
                    )

        return TrustCheckResult(
            outcome=outcome,
            policy_id=body.get("policy_id"),
            policy_name=body.get("policy_name"),
            findings=findings,
            redacted_content=redacted_content,
        )


def trust_annotation(result: TrustCheckResult) -> str | None:
    """A short, non-blocking note to append to a message's body — the
    in-chat indicator for ALERTED and a degraded/errored check. Reuses the
    message's own body rather than a separate notice or a platform reaction:
    `mark_activity` (the existing "working"/"queued" badge) is scoped to a
    specific agent's identity on platforms that track per-agent reactions, and
    a Switch Trust verdict belongs to no agent — retrofitting it would mean a
    new cross-adapter primitive, out of proportion to a quiet heads-up.
    `None` for every other outcome, including BLOCKED (handled separately) and
    REDACTED (the redaction itself is the signal)."""
    if result.outcome == "alerted":
        categories = ", ".join(sorted({f.category for f in result.findings}))
        detail = categories or "policy alert"
        return f"⚠️ _Switch Trust: {detail} (not blocked)_"
    if result.outcome == "errored":
        return "⚠️ _Switch Trust could not fully check this message_"
    return None


def trust_redaction_notice(result: TrustCheckResult) -> str | None:
    """A notice for whoever sent a message Switch Trust redacted — without
    it, they have no way to know their own words were altered before anyone
    else saw them. `None` for every other outcome."""
    if result.outcome != "redacted":
        return None
    categories = ", ".join(sorted({f.category for f in result.findings}))
    detail = categories or "policy violation"
    return (
        f"⚠️ Part of your message ({detail}) was redacted by Switch Trust "
        "before it was delivered."
    )


async def check_message(
    client: TrustClient, *, role: Role, content: str, room_id: str
) -> TrustCheckResult:
    """`client.check`, failing open: a Switch Trust outage degrades to
    unchecked messages rather than to no messaging at all. Logged loudly
    either way, since this is the one place that gap is visible. Reported as
    `outcome="errored"` rather than `"ok"`, so callers give it the same
    quiet in-chat annotation as an engine-side error."""
    try:
        return await client.check(role=role, content=content, room_id=room_id)
    except GuardrailsCheckError:
        logger.warning(
            "Switch Trust check failed; message allowed through unchecked",
            exc_info=True,
        )
        return TrustCheckResult(outcome="errored", policy_id=None, policy_name=None)

"""Switch Trust: a guardrails service checked before a message is sent.

Calls the guardrails external processor's check-only endpoint — a
provider-agnostic `messages` array in, a block/allow verdict out, no LLM
provider in the loop. `NullTrustClient` is what runs when the feature is off
(`SwitchConfig.trust_enabled` is False): a client that always allows, so no
call site has to ask whether the feature is on — the same shape as
`telemetry/sink.py`'s `NullSink`.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any, Literal, Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)
from switch_core.file_text import TRUST_FILE_TEXT_LIMIT
from switch_core.keys import Keyring
from switch_core.observability.catalogue import TRUST_CHECK_FAILURES
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

# The most of one message sent to Switch Trust, for the reason a file's text
# is capped (`TRUST_FILE_TEXT_LIMIT`): a check must answer within
# `switch_trust_timeout_seconds`, and a check that times out lets the message
# through. Without the cap, padding a message would make its check time out
# on purpose. A message cut here carries a visible note that only the start
# of it was checked, and a WARNING is logged.
TRUST_MESSAGE_TEXT_LIMIT = TRUST_FILE_TEXT_LIMIT

Role = Literal["user", "assistant"]

# Every check is reported under one constant agent identity: Switch has no
# single "agent" to attribute a check to (a room can hold several, and a
# human-authored message has none at all), so this collapses all of Switch's
# traffic onto one Switch Trust agent rather than inventing a per-sender
# identity Switch Trust has no use for. `x-agent-session-id` (the room) and
# `x-agent-turn-id` (one per check) carry the per-call distinction instead.
_AGENT_NAME = "Switch Rooms Agents"

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
# the external processor's REDACTED/ALERTED/ERRORED outcomes ship.
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
    """A check did not complete: network error, timeout, non-2xx answer, or a
    settings read/decrypt failure before the request was even made."""


class GuardrailsRefusedError(GuardrailsCheckError):
    """Switch Trust answered, with an error status: `status_code`."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class GuardrailsTimeoutError(GuardrailsCheckError):
    """Switch Trust did not answer within the timeout."""


class GuardrailBlockedError(Exception):
    """A message was refused by the guardrails policy.

    Carries the verdict so a caller can tell the room or the agent why,
    without re-deriving it.
    """

    def __init__(self, result: TrustCheckResult, detail: str | None = None) -> None:
        self.result = result
        categories = (
            ", ".join(f.category for f in result.findings) or "policy violation"
        )
        message = f"blocked by Switch Trust ({categories})"
        if detail is not None:
            message = f"{message}: {detail}"
        super().__init__(message)


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
    # Set when only the start of the message was checked ("the first 20,000
    # characters"): the rest reached the room unchecked (`check_message`).
    checked_part: str | None = None

    @property
    def blocked(self) -> bool:
        return self.outcome == "blocked"


class TrustClient(Protocol):
    """Checks a message sent in workspace `tenant_id` against the policy its
    organization connected, if it connected one."""

    async def check(
        self, *, tenant_id: str, role: Role, content: str, room_id: str
    ) -> TrustCheckResult: ...

    async def is_active(self, tenant_id: str) -> bool:
        """Whether a check in `tenant_id` would reach Switch Trust at all.
        Lets a caller skip work that only matters when it does, such as
        reading text out of attached files. Raises `GuardrailsCheckError` when
        that cannot be told; `trust_is_active` below is the fail-open
        wrapper."""
        ...


class NullTrustClient:
    """Off: every message is allowed, and no request is made."""

    async def is_active(self, tenant_id: str) -> bool:
        return False

    async def check(
        self, *, tenant_id: str, role: Role, content: str, room_id: str
    ) -> TrustCheckResult:
        return TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)


# How long settings read for a check are kept at most. A change made through
# the gateway reaches every process at once (`trust/signals.py`); this is for
# one whose signal was lost.
SETTINGS_MAX_AGE_SECONDS = 30.0


@dataclass(frozen=True)
class _Kept:
    # The client the organization's settings make, None for no check.
    checker: HttpTrustClient | None
    read_at: float


class DynamicTrustClient:
    """Checks each message against the policy its workspace's organization
    connected (`OrganizationTrustSettings`), read once per organization and
    kept until it changes.

    Unlike `HttpTrustClient`, built from fixed arguments, this follows each
    organization's settings as they change: a change made through the
    gateway (`gateway/organization_guardrails.py`) makes every process read
    that organization's settings again before its next check there (`forget`,
    `trust/signals.py`), with no restart. Settings older than
    `max_age_seconds` are read again too. A workspace in an organization with
    no policy, or in no organization at all, is not checked: `check` answers
    "ok" without a request, as `NullTrustClient` does.

    Every message an agent sends is checked, and reading the settings for each
    one was a transaction per message for a row that hardly ever changes.
    Which organization a workspace is in is kept for good: a workspace never
    moves to another. That it is in none is read again as settings are, since
    the revision that gives every workspace an organization may run while
    this process does.
    """

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        store: OrganizationTrustSettingsStore,
        keyring: Keyring,
        client: httpx.AsyncClient,
        timeout_seconds: float,
        max_age_seconds: float = SETTINGS_MAX_AGE_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
        self._keyring = keyring
        self._client = client
        self._timeout_seconds = timeout_seconds
        self._max_age_seconds = max_age_seconds
        # Each workspace's organization, kept for good.
        self._organization_of: dict[str, str] = {}
        # When each workspace found in no organization was read so, and those
        # already logged as unchecked.
        self._no_organization: dict[str, float] = {}
        self._said_unchecked: set[str] = set()
        self._kept: dict[str, _Kept] = {}
        # Bumped for an organization by each `forget`, and the epoch by each
        # `forget_all`, so a read begun before either does not keep what it
        # read.
        self._generation: dict[str, int] = {}
        self._epoch = 0

    def forget(self, organization_id: str) -> None:
        """Read the organization's settings again before its next check: they
        changed."""
        self._kept.pop(organization_id, None)
        self._generation[organization_id] = self._generation.get(organization_id, 0) + 1

    def forget_all(self) -> None:
        """Read every organization's settings again: this process may have
        missed a change, as on reconnecting to the database."""
        self._kept.clear()
        self._no_organization.clear()
        self._epoch += 1

    async def is_active(self, tenant_id: str) -> bool:
        """True when `tenant_id`'s organization holds a policy `check` would
        call Switch Trust with."""
        return await self._current(tenant_id) is not None

    async def check(
        self, *, tenant_id: str, role: Role, content: str, room_id: str
    ) -> TrustCheckResult:
        checker = await self._current(tenant_id)
        if checker is None:
            return TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)
        return await checker.check(role=role, content=content, room_id=room_id)

    async def _current(self, tenant_id: str) -> HttpTrustClient | None:
        organization_id = self._organization_of.get(tenant_id)
        if organization_id is not None:
            kept = self._kept.get(organization_id)
            if (
                kept is not None
                and time.monotonic() - kept.read_at < self._max_age_seconds
            ):
                return kept.checker
        else:
            read_at = self._no_organization.get(tenant_id)
            if (
                read_at is not None
                and time.monotonic() - read_at < self._max_age_seconds
            ):
                return None
        # The reads and the decrypt below are not network calls to Switch
        # Trust, so neither raises `GuardrailsCheckError` on its own — but a
        # stuck pool or an `UndecryptableError` from a key rotated out too
        # soon is exactly the kind of failure `check_message` exists to fail
        # open on, so anything either raises is folded into the same error.
        # Nothing is kept then, so the next check reads again.
        try:
            async with tenant_session(self._session_factory, tenant_id) as session:
                if organization_id is None:
                    epoch = self._epoch
                    read_at = time.monotonic()
                    organization_id = await self._store.organization_of(
                        session, tenant_id
                    )
                    if organization_id is None:
                        if self._epoch == epoch:
                            self._no_organization[tenant_id] = read_at
                        if tenant_id not in self._said_unchecked:
                            self._said_unchecked.add(tenant_id)
                            logger.warning(
                                "Workspace %s belongs to no organization, so no "
                                "Switch Trust policy checks its messages",
                                tenant_id,
                            )
                        return None
                    self._organization_of[tenant_id] = organization_id
                    self._no_organization.pop(tenant_id, None)
                generation = self._generation.get(organization_id, 0)
                epoch = self._epoch
                read_at = time.monotonic()
                settings = await self._store.get(session, organization_id)
            checker = (
                None
                if settings is None
                else HttpTrustClient(
                    base_url=settings.endpoint,
                    api_key=self._keyring.decrypt(settings.api_key_encrypted),
                    policy_id=settings.policy_id,
                    timeout_seconds=self._timeout_seconds,
                    client=self._client,
                )
            )
        except Exception as error:
            raise GuardrailsCheckError(
                f"Could not read Switch Trust settings: {error}"
            ) from error
        if (
            self._generation.get(organization_id, 0) == generation
            and self._epoch == epoch
        ):
            self._kept[organization_id] = _Kept(checker, read_at)
        return checker


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
        except httpx.TimeoutException as error:
            raise GuardrailsTimeoutError(
                f"POST {self._url} did not answer within {self._timeout_seconds}s"
            ) from error
        except httpx.HTTPError as error:
            raise GuardrailsCheckError(f"POST {self._url} failed: {error}") from error
        if response.status_code >= 400:
            raise GuardrailsRefusedError(
                f"POST {self._url} answered {response.status_code}: "
                f"{response.text[:200]}",
                response.status_code,
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
    """A short, non-blocking note — the in-chat indicator for ALERTED and a
    degraded/errored check. A person's message carries it appended to its own
    body; an agent's send gets it as a separate notice threaded under the send
    (`AgentCore._post_trust_alert_notice`). Text rather than a platform
    reaction: `mark_activity` (the "working"/"queued" badge) is scoped to a
    specific agent's identity on platforms that track per-agent reactions, and
    a Switch Trust verdict belongs to no agent.
    A message checked only in part says so, whatever the verdict on the part
    checked. `None` for every other outcome, including BLOCKED (handled
    separately) and REDACTED (the redaction itself is the signal)."""
    if result.outcome == "blocked":
        return None
    if result.outcome == "errored":
        return "⚠️ _Switch Trust could not check this message_"
    notes = []
    if result.outcome == "alerted":
        categories = ", ".join(sorted({f.category for f in result.findings}))
        detail = categories or "policy alert"
        notes.append(
            f"⚠️  _Switch Trust flagged this message (not blocked - {detail})._"
        )
    if result.checked_part is not None:
        notes.append(
            f"⚠️ _Switch Trust checked only {result.checked_part} of this message; "
            "the rest was not checked._"
        )
    return "\n".join(notes) or None


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
    client: TrustClient, *, tenant_id: str, role: Role, content: str, room_id: str
) -> TrustCheckResult:
    """`client.check`, failing open: a Switch Trust outage degrades to
    unchecked messages rather than to no messaging at all. Logged loudly
    either way, since this is the one place that gap is visible, and counted
    by why (`TRUST_CHECK_FAILURES`): a timeout apart from other failures.
    Reported as `outcome="errored"` rather than `"ok"`, so callers give it
    the same quiet in-chat annotation as an engine-side error.

    Only the first `TRUST_MESSAGE_TEXT_LIMIT` characters are sent. The result
    then says so (`checked_part`, which `trust_annotation` turns into a note),
    and a redaction keeps the unchecked rest after the redacted start."""
    checked = content[:TRUST_MESSAGE_TEXT_LIMIT]
    try:
        result = await client.check(
            tenant_id=tenant_id, role=role, content=checked, room_id=room_id
        )
    except GuardrailsTimeoutError:
        metrics().increment(TRUST_CHECK_FAILURES, {"reason": "timeout"})
        logger.warning(
            "Switch Trust did not answer in time; message allowed through "
            "unchecked in room %s",
            room_id,
            exc_info=True,
        )
        return TrustCheckResult(outcome="errored", policy_id=None, policy_name=None)
    except GuardrailsCheckError as error:
        reason = "refused" if isinstance(error, GuardrailsRefusedError) else "error"
        metrics().increment(TRUST_CHECK_FAILURES, {"reason": reason})
        logger.warning(
            "Switch Trust check failed (%s); message allowed through unchecked "
            "in room %s",
            reason,
            room_id,
            exc_info=True,
        )
        return TrustCheckResult(outcome="errored", policy_id=None, policy_name=None)
    if len(checked) == len(content):
        return result
    checked_part = f"the first {TRUST_MESSAGE_TEXT_LIMIT:,} characters"
    logger.warning(
        "Switch Trust checked only %s of a %d-character message in room %s; the "
        "rest reaches the room unchecked",
        checked_part,
        len(content),
        room_id,
    )
    return replace(
        result,
        checked_part=checked_part,
        redacted_content=(
            None
            if result.redacted_content is None
            else result.redacted_content + content[len(checked) :]
        ),
    )


async def trust_is_active(client: TrustClient, tenant_id: str) -> bool:
    """`client.is_active`, failing towards checking: when the settings cannot
    be read, the caller goes on to check, and each check then fails open with
    the usual visible "could not check" annotation rather than the message
    quietly skipping Switch Trust."""
    try:
        return await client.is_active(tenant_id)
    except GuardrailsCheckError:
        logger.warning(
            "Could not tell whether Switch Trust is on; checking anyway",
            exc_info=True,
        )
        return True

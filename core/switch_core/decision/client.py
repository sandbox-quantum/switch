"""The decision service: asked which agent, if any, should answer a person's
message that no rule delivered to anyone.

Switch posts the room's context to the backend the room's workspace resolves
to (`decision/settings.py`) and the service names one of the candidate
agents, or nobody. Which model decides, and how it is asked, is the service's
business: Switch depends only on the contract below, so the model behind it
can change without a Switch release.

Request::

    room:    {name, instructions}
    message: {sender, text, thread_id}
    agents:  [{name, description, role}]
    thread:  [{sender, sender_kind, text, addressed}]   oldest first
    recent:  [{sender, sender_kind, text, addressed}]   oldest first
    confidence_threshold                                 only when the workspace set one

Response::

    {agent, model_choice, confidence, threshold, reason?, model, backend?, latency_ms}

Where it goes (a URL with no path of its own gets the service's `/decide`
route, so either the service's base URL or its `/decide` URL works):

- the server default: `DECISION_ENDPOINT_URL`, with `DECISION_API_KEY` as the
  bearer token;
- a workspace's own endpoint, with the workspace's key as the bearer token;
- Haiku: the server's decision service, told the backend per request in
  `X-Decision-Backend` (`anthropic` with the workspace's key in
  `X-Decision-Anthropic-Key`, or `bedrock`).

A decision never holds up the room or breaks it, so every way of not getting
an answer means nobody answers (or the room's triage agent, see
`delivery/decision.py`): a timeout, a connection error, a response other than
200, a body that is not the response above, or one naming an agent that was
not a candidate. Each is logged, and reported without identifiers
(`decision_failed`).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from switch_core.db.session_scope import tenant_session
from switch_core.decision.settings import (
    Backend,
    DecisionAvailability,
    ResolvedSettings,
    ServerDefault,
)
from switch_core.keys import UndecryptableError
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
from switch_core.telemetry import emit_safely

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.keys import Keyring
    from switch_core.telemetry import TelemetryService

logger = logging.getLogger(__name__)

# How long a workspace's resolved settings are kept before they are read
# again: short, so a save in another process applies within seconds without a
# restart. A save in this process applies at once (`forget`).
SETTINGS_CACHE_SECONDS = 5.0


class DecisionRoom(BaseModel):
    name: str
    instructions: str | None


class DecisionMessage(BaseModel):
    sender: str
    text: str
    thread_id: str | None


class DecisionAgent(BaseModel):
    name: str
    description: str
    role: str | None


class ContextMessage(BaseModel):
    """An earlier message in the room or the thread: who sent it, whether a
    person or an agent, and whom it addressed by name."""

    sender: str
    sender_kind: Literal["person", "agent"]
    text: str
    addressed: list[str]


class DecisionRequest(BaseModel):
    room: DecisionRoom
    message: DecisionMessage
    agents: list[DecisionAgent]
    thread: list[ContextMessage]
    recent: list[ContextMessage]


class DecisionAnswer(BaseModel):
    """What the service decided. `agent` is None when it picked nobody, or
    its pick fell below its confidence threshold; `model_choice` and
    `confidence` still say what the model chose."""

    model_config = ConfigDict(strict=True, frozen=True)

    agent: str | None
    model_choice: str | None
    confidence: float | None
    threshold: float
    reason: str | None = None
    model: str
    backend: str | None = None
    latency_ms: float


FailureReason = Literal[
    "timeout",
    "unreachable",
    "error_status",
    "bad_answer",
    "key_unreadable",
    "endpoint_refused",
]
# A backend as telemetry and the log name it: the server default is told apart
# from a workspace's own endpoint.
BackendLabel = Literal["server_default", "endpoint", "haiku_anthropic", "haiku_bedrock"]


class DecisionServiceError(Exception):
    """The service gave no usable answer: it could not be reached, did not
    answer in time, answered with an error, or answered something else than
    a decision."""

    def __init__(
        self,
        reason: FailureReason,
        message: str,
        *,
        status: int | None = None,
        body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.reason: FailureReason = reason
        self.status = status
        self.body = body


@dataclass(frozen=True)
class DecisionTarget:
    """Where one decision is posted and how."""

    url: str
    headers: Mapping[str, str]
    backend: BackendLabel
    threshold: float | None
    # A URL a workspace admin chose, reached only within the server's
    # outbound policy (`switch_core/outbound.py`). The server's own decision
    # service, which the operator set and Haiku runs in, is not.
    guarded: bool


def decide_url(url: str) -> str:
    """Where a decision is posted: `url` itself when it names a path (the
    `/decide` route, or wherever a proxy puts it), else the service's
    `/decide` route under it, so the service's base URL works as well."""
    parts = urlsplit(url)
    if parts.path.strip("/"):
        return url
    return urlunsplit(parts._replace(path="/decide"))


def decision_target(
    *,
    server: ServerDefault,
    source: Literal["workspace", "server_default"],
    backend: Backend,
    endpoint: str | None,
    api_key: str | None,
    threshold: float | None,
) -> DecisionTarget:
    """The request for a backend. `api_key` is the workspace's key, in the
    clear; the server default's is the server's own. Raises ValueError for a
    backend with nowhere to go (none, or Haiku without a server default)."""
    headers = {"Content-Type": "application/json"}
    if source == "server_default":
        if server.endpoint_url is None:
            raise ValueError("The server has no decision service configured.")
        if server.api_key is not None:
            headers["Authorization"] = f"Bearer {server.api_key}"
        return DecisionTarget(
            decide_url(server.endpoint_url),
            headers,
            "server_default",
            threshold,
            guarded=False,
        )
    if backend == "endpoint":
        if endpoint is None:
            raise ValueError("A self-hosted endpoint needs a URL.")
        if api_key is not None:
            headers["Authorization"] = f"Bearer {api_key}"
        return DecisionTarget(
            decide_url(endpoint), headers, "endpoint", threshold, guarded=True
        )
    if backend in ("haiku_anthropic", "haiku_bedrock"):
        if server.endpoint_url is None:
            raise ValueError(
                "Haiku runs in the server's decision service, and this server has none."
            )
        if server.api_key is not None:
            headers["Authorization"] = f"Bearer {server.api_key}"
        if backend == "haiku_anthropic":
            if api_key is None:
                raise ValueError("Haiku on the Anthropic API needs an Anthropic key.")
            headers["X-Decision-Backend"] = "anthropic"
            headers["X-Decision-Anthropic-Key"] = api_key
        else:
            headers["X-Decision-Backend"] = "bedrock"
        return DecisionTarget(
            decide_url(server.endpoint_url), headers, backend, threshold, guarded=False
        )
    raise ValueError("No decision service is chosen.")


async def post_decision(
    client: httpx.AsyncClient,
    target: DecisionTarget,
    request: DecisionRequest,
    *,
    timeout_seconds: float,
    policy: OutboundPolicy,
) -> DecisionAnswer:
    """Post `request` to `target` and return the answer, or raise
    `DecisionServiceError` saying why there is none. Headers are never
    logged: they can carry a key.

    For a guarded target, `client` must be a guarded one
    (`guarded_async_client`), which checks the resolved addresses again and
    connects only to one it checked; the check here first makes a refusal a
    failure of its own, `endpoint_refused`."""
    url = target.url
    body = request.model_dump(mode="json")
    if target.threshold is not None:
        body["confidence_threshold"] = target.threshold
    try:
        if target.guarded:
            await policy.check_url(url)
        response = await client.post(
            url, json=body, headers=dict(target.headers), timeout=timeout_seconds
        )
    except OutboundURLRefused as error:
        raise DecisionServiceError(
            "endpoint_refused",
            f"POST {url} refused by the server's outbound policy: {error}",
        ) from error
    except httpx.TimeoutException as error:
        raise DecisionServiceError(
            "timeout",
            f"POST {url} did not answer within {timeout_seconds}s "
            f"({type(error).__name__})",
        ) from error
    except httpx.HTTPError as error:
        raise DecisionServiceError(
            "unreachable",
            f"POST {url} could not be reached: {type(error).__name__}: {error}",
        ) from error
    if response.status_code != 200:
        raise DecisionServiceError(
            "error_status",
            f"POST {url} answered {response.status_code}: {response.text[:200]}",
            status=response.status_code,
            body=response.text[:2000],
        )
    try:
        return DecisionAnswer.model_validate_json(response.content)
    except ValidationError as error:
        raise DecisionServiceError(
            "bad_answer",
            f"POST {url} answered something other than a decision: "
            f"{error.error_count()} problem(s), first: "
            f"{error.errors()[0]['loc']} {error.errors()[0]['msg']}",
        ) from error


@dataclass(frozen=True)
class Decided:
    """The service answered: `answer.agent` is the candidate it picked, or
    None for nobody."""

    answer: DecisionAnswer
    backend: BackendLabel
    latency_ms: int


@dataclass(frozen=True)
class Failed:
    """The backend gave no usable answer."""

    reason: FailureReason
    backend: BackendLabel
    message: str


@dataclass(frozen=True)
class Unavailable:
    """The workspace has no backend now (it chose none since, or the server
    lost its default): nobody is asked, and it is not a failure."""

    reason: str | None


DecisionOutcome = Decided | Failed | Unavailable


def confidence_bucket(confidence: float | None) -> str:
    if confidence is None:
        return "none"
    if confidence < 0.5:
        return "lt_0.5"
    for upper, bucket in (
        (0.6, "0.5_0.6"),
        (0.7, "0.6_0.7"),
        (0.8, "0.7_0.8"),
        (0.9, "0.8_0.9"),
    ):
        if confidence < upper:
            return bucket
    return "0.9_1.0"


@dataclass(frozen=True)
class TestOutcome:
    """What the admin's Test button shows: the sample's pick, or why there
    was none. `error_code` is one of `unreachable`, `timeout`,
    `unauthorized`, `key_refused`, `bad_answer`, `backend_unavailable`,
    `not_configured` and `refused` (an endpoint the server's outbound policy
    does not allow)."""

    ok: bool
    agent: str | None
    model_choice: str | None
    confidence: float | None
    latency_ms: int | None
    backend: str | None
    error_code: str | None
    error_message: str | None


# The one decision the Test button asks about: three agents and a question
# only one of them covers. Nothing from any room.
SAMPLE_REQUEST = DecisionRequest(
    room=DecisionRoom(name="sample", instructions=None),
    message=DecisionMessage(
        sender="sam",
        text="The deploy to staging failed with a timeout. Can someone look at it?",
        thread_id=None,
    ),
    agents=[
        DecisionAgent(
            name="deploy-bot",
            description="Runs and troubleshoots deploys and the CI pipeline.",
            role=None,
        ),
        DecisionAgent(
            name="billing-bot",
            description="Answers questions about invoices, plans and payments.",
            role=None,
        ),
        DecisionAgent(
            name="docs-bot",
            description="Finds and explains the product documentation.",
            role=None,
        ),
    ],
    thread=[],
    recent=[],
)


class DynamicDecisionClient:
    """Asks each room's workspace's decision backend, resolved per decision
    (`decision/settings.py`) through a short per-workspace cache, so a saved
    setting applies without a restart. One per process, over one shared HTTP
    client."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        availability: DecisionAvailability,
        keyring: Keyring,
        client: httpx.AsyncClient,
        guarded_client: httpx.AsyncClient,
        outbound_policy: OutboundPolicy,
        timeout_seconds: float,
        telemetry: TelemetryService | None,
        cache_seconds: float,
    ) -> None:
        """`client` reaches the server's own decision service; a workspace's
        endpoint is reached only through `guarded_client`, a
        `guarded_async_client` over `outbound_policy`."""
        self._session_factory = session_factory
        self.availability = availability
        self._keyring = keyring
        self._client = client
        self._guarded_client = guarded_client
        self.outbound_policy = outbound_policy
        self.timeout_seconds = timeout_seconds
        self._telemetry = telemetry
        self._cache_seconds = cache_seconds
        self._cache: dict[str, tuple[float, ResolvedSettings]] = {}

    @property
    def server(self) -> ServerDefault:
        return self.availability.server

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._guarded_client.aclose()

    async def _post(
        self, target: DecisionTarget, request: DecisionRequest
    ) -> DecisionAnswer:
        return await post_decision(
            self._guarded_client if target.guarded else self._client,
            target,
            request,
            timeout_seconds=self.timeout_seconds,
            policy=self.outbound_policy,
        )

    async def settings(self, session: AsyncSession, tenant_id: str) -> ResolvedSettings:
        """The workspace's resolved settings, read through `session` when the
        cache has none fresh."""
        cached = self._cache.get(tenant_id)
        now = time.monotonic()
        if cached is not None and cached[0] > now:
            return cached[1]
        resolved = await self.availability.settings(session, tenant_id)
        self._cache[tenant_id] = (now + self._cache_seconds, resolved)
        return resolved

    async def available(self, session: AsyncSession, tenant_id: str) -> bool:
        """Whether the workspace's rooms route by decision: the server's flag,
        and a backend for the workspace."""
        if not self.availability.enabled:
            return False
        return (await self.settings(session, tenant_id)).has_backend

    def forget(self, tenant_id: str) -> None:
        """Drop the workspace's cached settings, after a save here."""
        self._cache.pop(tenant_id, None)

    async def decide(
        self, request: DecisionRequest, *, tenant_id: str, room_id: str
    ) -> DecisionOutcome:
        """Ask the workspace's backend about `request`. A failure is logged
        here; so is an answer naming an agent that was not a candidate, which
        counts as a bad answer."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            settings = await self.settings(session, tenant_id)
        if not self.availability.enabled or not settings.has_backend:
            return Unavailable(reason=settings.reason)
        label: BackendLabel = (
            "server_default"
            if settings.source == "server_default"
            else settings.backend  # type: ignore[assignment]
        )
        try:
            api_key = (
                self._keyring.decrypt(settings.api_key_encrypted)
                if settings.api_key_encrypted is not None
                else None
            )
        except UndecryptableError:
            return self._failed(
                room_id,
                label,
                "key_unreadable",
                "the workspace's decision key is encrypted under a secret this "
                "server no longer holds; a workspace admin has to save it again",
            )
        target = decision_target(
            server=self.server,
            source=settings.source,
            backend=settings.backend,
            endpoint=settings.endpoint,
            api_key=api_key,
            threshold=settings.threshold,
        )
        started = time.monotonic()
        try:
            answer = await self._post(target, request)
        except DecisionServiceError as error:
            return self._failed(room_id, label, error.reason, str(error))
        latency_ms = round((time.monotonic() - started) * 1000)
        candidates = [agent.name for agent in request.agents]
        if answer.agent is not None and answer.agent not in candidates:
            logger.error(
                "Decision service (%s) named %r for a message in room %s, which "
                "is not one of the candidates %s; no agent receives it",
                label,
                answer.agent,
                room_id,
                candidates,
            )
            emit_safely(
                self._telemetry,
                "decision_failed",
                {"backend": label, "reason": "bad_answer"},
            )
            return Failed(
                reason="bad_answer",
                backend=label,
                message=f"named {answer.agent!r}, not a candidate",
            )
        emit_safely(
            self._telemetry,
            "decision_made",
            {
                "backend": label,
                "outcome": "agent" if answer.agent is not None else "none",
                "confidence": confidence_bucket(answer.confidence),
                "latency_ms": latency_ms,
            },
        )
        return Decided(answer=answer, backend=label, latency_ms=latency_ms)

    def _failed(
        self, room_id: str, label: BackendLabel, reason: FailureReason, message: str
    ) -> Failed:
        logger.warning(
            "Decision service (%s) gave no answer for a message in room %s: %s",
            label,
            room_id,
            message,
        )
        emit_safely(
            self._telemetry, "decision_failed", {"backend": label, "reason": reason}
        )
        return Failed(reason=reason, backend=label, message=message)

    async def test(
        self,
        *,
        backend: Backend | Literal["default"],
        endpoint: str | None,
        api_key: str | None,
        threshold: float | None,
    ) -> TestOutcome:
        """Ask `backend` about the sample decision, with unsaved values, and
        say what it picked or why it could not. `api_key` is in the clear.
        `default` is the server default, asked with the server's own key;
        `api_key` is ignored for it."""

        def error(code: str, message: str, latency: int | None = None) -> TestOutcome:
            return TestOutcome(
                ok=False,
                agent=None,
                model_choice=None,
                confidence=None,
                latency_ms=latency,
                backend=backend,
                error_code=code,
                error_message=message,
            )

        if backend == "haiku_bedrock" and not self.server.haiku_bedrock:
            return error(
                "backend_unavailable",
                "Haiku on Bedrock isn't offered on this server: it needs the "
                "server's decision service and DECISION_BEDROCK_ENABLED.",
            )
        try:
            target = (
                decision_target(
                    server=self.server,
                    source="server_default",
                    backend="endpoint",
                    endpoint=None,
                    api_key=None,
                    threshold=threshold,
                )
                if backend == "default"
                else decision_target(
                    server=self.server,
                    source="workspace",
                    backend=backend,
                    endpoint=endpoint,
                    api_key=api_key,
                    threshold=threshold,
                )
            )
        except ValueError as refused:
            return error("not_configured", str(refused))
        started = time.monotonic()
        try:
            answer = await self._post(target, SAMPLE_REQUEST)
        except DecisionServiceError as failure:
            latency = round((time.monotonic() - started) * 1000)
            code = _test_error_code(backend, failure)
            return error(code, _test_error_message(code, failure), latency)
        return TestOutcome(
            ok=True,
            agent=answer.agent,
            model_choice=answer.model_choice,
            confidence=answer.confidence,
            latency_ms=round((time.monotonic() - started) * 1000),
            backend=backend,
            error_code=None,
            error_message=None,
        )


def _test_error_code(
    backend: Backend | Literal["default"], failure: DecisionServiceError
) -> str:
    if failure.reason == "endpoint_refused":
        return "refused"
    if failure.reason in ("timeout", "unreachable", "bad_answer"):
        return failure.reason
    status = failure.status
    body = (failure.body or "").lower()
    if status in (401, 403):
        return "unauthorized"
    if status == 400 and "backend_unavailable" in body:
        return "backend_unavailable"
    if (
        backend == "haiku_anthropic"
        and status == 502
        and any(
            word in body for word in ("401", "auth", "api key", "api_key", "x-api-key")
        )
    ):
        return "key_refused"
    return "bad_answer"


def _test_error_message(code: str, failure: DecisionServiceError) -> str:
    return {
        "timeout": f"The decision service did not answer in time. {failure}",
        "unreachable": f"The decision service could not be reached. {failure}",
        "unauthorized": f"The decision service refused the key. {failure}",
        "refused": (
            "Switch won't connect to that address: a workspace's endpoint must "
            "be a public address, or a private host the server's operator lists "
            f"in OUTBOUND_ALLOWED_PRIVATE_HOSTS. {failure}"
        ),
        "key_refused": f"The Anthropic API refused the key. {failure}",
        "backend_unavailable": f"The decision service can't run that backend. {failure}",
    }.get(code, f"The decision service did not answer with a decision. {failure}")

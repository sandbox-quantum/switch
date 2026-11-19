"""The decision service: POST /decide picks which agent in a room should answer
an untagged message, GET /health reports the backend and its model server.

The HTTP contract is fixed in the decision-routing-setup change (contracts.md,
section 1); see decision/README.md."""

import hmac
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from functools import partial
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from switch_decision.backends import (
    ErrorKind,
    InvalidChoiceError,
    ModelAnswer,
    ModelServerError,
    ask,
    check,
    model_server,
)
from switch_decision.config import (
    DEFAULT_ANTHROPIC_MODEL,
    Settings,
    fallback_settings,
    load_settings,
)
from switch_decision.fallback import BothFailed, Raced, race
from switch_decision.logging_setup import (
    RequestIdMiddleware,
    adopt_uvicorn_loggers,
    configure_logging,
    load_log_settings,
    new_process_id,
    service_version,
)
from switch_decision.models import DecideRequest, DecideResponse
from switch_decision.otlp_logs import load_otlp_settings, start_log_shipping
from switch_decision.prompt import NONE, conversation_state

logger = logging.getLogger("switch_decision")

log_settings = load_log_settings()
process_id = new_process_id(log_settings.pod_name)
version = service_version()
configure_logging(log_settings, version, process_id)
otlp_settings = load_otlp_settings()

BACKEND_HEADER = "X-Decision-Backend"
ANTHROPIC_KEY_HEADER = "X-Decision-Anthropic-Key"
GEMINI_KEY_HEADER = "X-Decision-Gemini-Key"
MODEL_HEADER = "X-Decision-Model"

settings = load_settings()
client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client
    adopt_uvicorn_loggers()
    shipping = start_log_shipping(
        otlp_settings,
        service_name=log_settings.service_name,
        service_version=version,
        environment=log_settings.environment,
        instance_id=process_id,
    )
    client = httpx.AsyncClient()
    try:
        yield
    finally:
        await client.aclose()
        if shipping is not None:
            await shipping.aclose()


app = FastAPI(title="Switch decision service", lifespan=lifespan)


def _client() -> httpx.AsyncClient:
    assert client is not None
    return client


class BackendUnavailable(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


@app.exception_handler(BackendUnavailable)
async def _backend_unavailable(_: Request, exc: BackendUnavailable) -> JSONResponse:
    return JSONResponse(
        status_code=400, content={"detail": exc.detail, "code": "backend_unavailable"}
    )


class DecideFailed(Exception):
    def __init__(self, detail: str, kind: ErrorKind):
        super().__init__(detail)
        self.detail = detail
        self.kind = kind


@app.exception_handler(DecideFailed)
async def _decide_failed(_: Request, exc: DecideFailed) -> JSONResponse:
    return JSONResponse(
        status_code=502, content={"detail": exc.detail, "error_kind": exc.kind}
    )


@app.middleware("http")
async def require_token(request: Request, call_next):
    """With DECISION_SERVICE_TOKEN set, everything but GET /health needs the bearer token."""
    token = settings.service_token
    if token and not (request.method == "GET" and request.url.path == "/health"):
        scheme, _, given = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            given.strip().encode(), token.encode()
        ):
            return JSONResponse(
                status_code=401,
                content={"detail": "missing or wrong bearer token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
    return await call_next(request)


# Added last, so it is outermost: everything logged for a request, including
# the 401 above and uvicorn's access line, carries its id.
app.add_middleware(RequestIdMiddleware)


def backends_available(s: Settings) -> list[str]:
    return (
        ["default", "anthropic"]
        + (["bedrock"] if s.bedrock_enabled else [])
        + (["gemini_decision"] if s.gemini_decision_api_key else [])
    )


def resolve_backend(request: Request) -> tuple[Settings, str | None]:
    """The settings for this request (after any X-Decision-Backend override) and
    the per-request Anthropic or Gemini key, if any. Header values are never logged."""
    name = (request.headers.get(BACKEND_HEADER) or "default").strip().lower()
    model = (request.headers.get(MODEL_HEADER) or "").strip() or None
    if name == "default":
        return settings, None
    if name == "anthropic":
        key = (request.headers.get(ANTHROPIC_KEY_HEADER) or "").strip()
        if not key:
            raise BackendUnavailable(
                f"the anthropic backend needs an {ANTHROPIC_KEY_HEADER} header"
            )
        return replace(
            settings, backend="anthropic", model=model or DEFAULT_ANTHROPIC_MODEL
        ), key
    if name == "bedrock":
        if not settings.bedrock_enabled:
            raise BackendUnavailable(
                "the bedrock backend is not enabled on this service (DECISION_BEDROCK_ENABLED)"
            )
        return replace(
            settings, backend="bedrock", model=model or settings.bedrock_model
        ), None
    if name == "gemini_decision":
        # The request's own key, else the service's: setting
        # GEMINI_DECISION_API_KEY is what makes the backend available.
        gemini_key = (request.headers.get(GEMINI_KEY_HEADER) or "").strip() or None
        if gemini_key is None and not settings.gemini_decision_api_key:
            raise BackendUnavailable(
                "the gemini_decision backend needs GEMINI_DECISION_API_KEY on the "
                f"service or an {GEMINI_KEY_HEADER} header"
            )
        return replace(
            settings,
            backend="gemini_decision",
            model=model or settings.gemini_decision_model,
        ), gemini_key
    raise BackendUnavailable(
        f"unknown backend {name[:40]!r}; use one of {backends_available(settings)}"
    )


@app.get("/health")
async def health() -> dict:
    try:
        server = await check(_client(), settings)
    except ModelServerError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    fallback = fallback_settings(settings)
    return {
        "ok": True,
        "backend": settings.backend,
        "model": settings.model,
        "model_server": model_server(settings),
        "model_server_status": server,
        "confidence_threshold": settings.confidence_threshold,
        "min_lead": settings.min_lead,
        "backends_available": backends_available(settings),
        "fallback_backend": fallback.backend if fallback else None,
        "fallback_model": fallback.model if fallback else None,
        "fallback_after_s": settings.fallback_after_s if fallback else None,
    }


@app.post("/decide")
async def decide(req: DecideRequest, request: Request) -> DecideResponse:
    if not req.agents:
        raise HTTPException(
            status_code=422, detail="agents must list at least one agent"
        )
    used, api_key = resolve_backend(request)
    # A request that chose its backend gets that backend alone.
    fallback = fallback_settings(settings) if used is settings else None
    threshold = (
        req.confidence_threshold
        if req.confidence_threshold is not None
        else used.confidence_threshold
    )
    candidates = len(req.agents)
    started = time.monotonic()
    try:
        raced = await race(
            partial(ask, _client(), used, req, api_key),
            None if fallback is None else partial(ask, _client(), fallback, req, None),
            settings.fallback_after_s,
        )
    except BothFailed as exc:
        assert fallback is not None
        primary = exc.primary_error
        logger.warning(
            "decide failed backend=%s model=%s candidates=%d latency_ms=%d error_kind=%s error=%s "
            "fallback=failed fallback_reason=%s fallback_backend=%s fallback_model=%s "
            "fallback_error_kind=%s fallback_error=%s total_ms=%d",
            used.backend,
            used.model,
            candidates,
            int(exc.primary_seconds * 1000),
            primary.kind,
            primary.log_text,
            exc.reason,
            fallback.backend,
            fallback.model,
            exc.fallback_error.kind,
            exc.fallback_error.log_text,
            int((time.monotonic() - started) * 1000),
        )
        raise DecideFailed(str(primary), primary.kind) from primary
    except ModelServerError as exc:
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.warning(
            "decide failed backend=%s model=%s candidates=%d latency_ms=%d error_kind=%s error=%s",
            used.backend,
            used.model,
            candidates,
            latency_ms,
            exc.kind,
            exc.log_text,
        )
        raise DecideFailed(str(exc), exc.kind) from exc
    total_ms = int((time.monotonic() - started) * 1000)
    answered = fallback if raced.by_fallback and fallback is not None else used
    latency_ms = int(raced.seconds * 1000)
    race_fields, race_args = _race_log(raced, total_ms)
    answer = raced.answer
    if isinstance(answer, InvalidChoiceError):
        # The backend answered but named no candidate: route to nobody.
        logger.error(
            "decide invalid_choice backend=%s model=%s candidates=%d choice=%.60r confidence=%.2f "
            "threshold=%.2f picked=None latency_ms=%d" + race_fields,
            answered.backend,
            answered.model,
            candidates,
            answer.choice,
            answer.confidence,
            threshold,
            latency_ms,
            *race_args,
        )
        return DecideResponse(
            agent=None,
            model_choice=answer.choice,
            confidence=answer.confidence,
            threshold=threshold,
            reason="the model named an agent that is not a candidate",
            model=answered.model,
            backend=answered.backend,
            latency_ms=latency_ms,
        )
    min_lead = None if req.confidence_threshold is not None else answered.min_lead
    picked, rule, lead = pick(answer, threshold, min_lead)
    failed = raced.primary_error is not None or raced.fallback_error is not None
    logger.log(
        logging.WARNING if failed else logging.INFO,
        "decide backend=%s model=%s candidates=%d choice=%s confidence=%.2f threshold=%.2f picked=%s latency_ms=%d "
        "rule=%s lead=%s context=%s" + race_fields,
        answered.backend,
        answered.model,
        candidates,
        answer.choice,
        answer.confidence,
        threshold,
        picked,
        latency_ms,
        rule,
        "-" if lead is None else f"{lead:.2f}",
        "exchange" if conversation_state(req, answered.history_limit) else "none",
        *race_args,
    )
    return DecideResponse(
        agent=picked,
        model_choice=answer.choice,
        confidence=answer.confidence,
        threshold=threshold,
        rule=rule,
        min_lead=min_lead if rule == "lead" else None,
        lead=lead,
        reason=answer.reason,
        model=answered.model,
        backend=answered.backend,
        latency_ms=latency_ms,
    )


def _race_log(raced: Raced, total_ms: int) -> tuple[str, list[object]]:
    """The decide line's fallback fields and their values; none without a
    fallback. A failure on either side is named, without the backend's body."""
    if raced.outcome is None:
        return "", []
    fields = " fallback=%s fallback_reason=%s total_ms=%d"
    args: list[object] = [raced.outcome, raced.reason or "-", total_ms]
    if raced.primary_error is not None:
        fields += " primary_error=%s"
        args.append(raced.primary_error.log_text)
    if raced.fallback_error is not None:
        fields += " fallback_error_kind=%s fallback_error=%s"
        args += [raced.fallback_error.kind, raced.fallback_error.log_text]
    return fields, args


# Probabilities arrive as floats: 0.48 - 0.43 can come out a hair under 0.05.
_LEAD_EPSILON = 1e-9


def pick(
    answer: ModelAnswer, threshold: float, min_lead: float | None
) -> tuple[str | None, Literal["threshold", "lead"], float | None]:
    """Who the answer delivers to, by which rule, and the chosen option's lead
    over the next one (None when the backend gave a single confidence).

    With min_lead set and a backend that scores every option, the top option
    wins when it leads the next one, another agent or "none", by at least
    min_lead; "none" on top picks nobody. Otherwise the chosen agent needs a
    confidence of at least threshold."""
    lead = None if answer.runner_up is None else answer.confidence - answer.runner_up
    if answer.choice == NONE:
        return (
            None,
            ("lead" if min_lead is not None and lead is not None else "threshold"),
            lead,
        )
    if min_lead is not None and lead is not None:
        return (
            answer.choice if lead >= min_lead - _LEAD_EPSILON else None,
            "lead",
            lead,
        )
    return (
        answer.choice if answer.confidence >= threshold else None,
        "threshold",
        lead,
    )

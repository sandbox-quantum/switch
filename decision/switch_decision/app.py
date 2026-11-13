"""The decision service: POST /decide picks which agent in a room should answer
an untagged message, GET /health reports the backend and its model server.

The HTTP contract is fixed in the decision-routing-setup change (contracts.md,
section 1); see decision/README.md."""

import hmac
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import replace
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
from switch_decision.config import DEFAULT_ANTHROPIC_MODEL, Settings, load_settings
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
from switch_decision.prompt import NONE

logger = logging.getLogger("switch_decision")

log_settings = load_log_settings()
process_id = new_process_id(log_settings.pod_name)
version = service_version()
configure_logging(log_settings, version, process_id)
otlp_settings = load_otlp_settings()

BACKEND_HEADER = "X-Decision-Backend"
ANTHROPIC_KEY_HEADER = "X-Decision-Anthropic-Key"
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
    return ["default", "anthropic"] + (["bedrock"] if s.bedrock_enabled else [])


def resolve_backend(request: Request) -> tuple[Settings, str | None]:
    """The settings for this request (after any X-Decision-Backend override) and
    the per-request Anthropic key, if any. Header values are never logged."""
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
    raise BackendUnavailable(
        f"unknown backend {name[:40]!r}; use one of {backends_available(settings)}"
    )


@app.get("/health")
async def health() -> dict:
    try:
        server = await check(_client(), settings)
    except ModelServerError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "ok": True,
        "backend": settings.backend,
        "model": settings.model,
        "model_server": model_server(settings),
        "model_server_status": server,
        "confidence_threshold": settings.confidence_threshold,
        "min_lead": settings.min_lead,
        "backends_available": backends_available(settings),
    }


@app.post("/decide")
async def decide(req: DecideRequest, request: Request) -> DecideResponse:
    if not req.agents:
        raise HTTPException(
            status_code=422, detail="agents must list at least one agent"
        )
    used, anthropic_key = resolve_backend(request)
    threshold = (
        req.confidence_threshold
        if req.confidence_threshold is not None
        else used.confidence_threshold
    )
    candidates = len(req.agents)
    started = time.monotonic()
    try:
        answer = await ask(_client(), used, req, anthropic_key)
    except InvalidChoiceError as exc:
        # The backend answered but named no candidate: route to nobody.
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.error(
            "decide invalid_choice backend=%s model=%s candidates=%d choice=%.60r confidence=%.2f "
            "threshold=%.2f picked=None latency_ms=%d",
            used.backend,
            used.model,
            candidates,
            exc.choice,
            exc.confidence,
            threshold,
            latency_ms,
        )
        return DecideResponse(
            agent=None,
            model_choice=exc.choice,
            confidence=exc.confidence,
            threshold=threshold,
            reason="the model named an agent that is not a candidate",
            model=used.model,
            backend=used.backend,
            latency_ms=latency_ms,
        )
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
    latency_ms = int((time.monotonic() - started) * 1000)
    min_lead = None if req.confidence_threshold is not None else used.min_lead
    picked, rule, lead = pick(answer, threshold, min_lead)
    logger.info(
        "decide backend=%s model=%s candidates=%d choice=%s confidence=%.2f threshold=%.2f picked=%s latency_ms=%d "
        "rule=%s lead=%s",
        used.backend,
        used.model,
        candidates,
        answer.choice,
        answer.confidence,
        threshold,
        picked,
        latency_ms,
        rule,
        "-" if lead is None else f"{lead:.2f}",
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
        model=used.model,
        backend=used.backend,
        latency_ms=latency_ms,
    )


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

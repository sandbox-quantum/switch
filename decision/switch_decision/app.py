"""The decision service: POST /decide picks which agent in a room should answer
an untagged message, GET /health reports the backend and its model server.

The HTTP contract is fixed in the decision-routing-setup change (contracts.md,
section 1); see decision/README.md."""

import hmac
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from switch_decision.backends import (
    InvalidChoiceError,
    ModelServerError,
    ask,
    check,
    model_server,
)
from switch_decision.config import DEFAULT_ANTHROPIC_MODEL, Settings, load_settings
from switch_decision.models import DecideRequest, DecideResponse
from switch_decision.prompt import NONE

logger = logging.getLogger("switch_decision")
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)

BACKEND_HEADER = "X-Decision-Backend"
ANTHROPIC_KEY_HEADER = "X-Decision-Anthropic-Key"
MODEL_HEADER = "X-Decision-Model"

settings = load_settings()
client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client
    client = httpx.AsyncClient()
    yield
    await client.aclose()


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
            "decide failed backend=%s model=%s candidates=%d latency_ms=%d error=%s",
            used.backend,
            used.model,
            candidates,
            latency_ms,
            exc.log_text,
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    latency_ms = int((time.monotonic() - started) * 1000)
    picked = (
        None
        if answer.choice == NONE or answer.confidence < threshold
        else answer.choice
    )
    logger.info(
        "decide backend=%s model=%s candidates=%d choice=%s confidence=%.2f threshold=%.2f picked=%s latency_ms=%d",
        used.backend,
        used.model,
        candidates,
        answer.choice,
        answer.confidence,
        threshold,
        picked,
        latency_ms,
    )
    return DecideResponse(
        agent=picked,
        model_choice=answer.choice,
        confidence=answer.confidence,
        threshold=threshold,
        reason=answer.reason,
        model=used.model,
        backend=used.backend,
        latency_ms=latency_ms,
    )

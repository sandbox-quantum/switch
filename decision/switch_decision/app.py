"""The decision service: POST /decide picks which agent in a room should answer
an untagged message, GET /health reports the backend and its model server.

The HTTP contract is fixed in the decision-routing-setup change (contracts.md,
section 1); see decision/README.md."""

import hmac
import logging
import time
from contextlib import asynccontextmanager
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
    DEFAULT_BEDROCK_OPENAI_MODEL,
    Settings,
    backend_settings,
    default_settings,
    fallback_settings,
    load_settings,
    nameable_backends,
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
    return nameable_backends(s)


def named_settings(s: Settings, name: str, model: str | None) -> Settings:
    """The settings for a request that names `name` (and maybe a model), or
    BackendUnavailable when the service does not offer it. Keys are checked
    by the caller."""
    if name == "default":
        return default_settings(s)
    if name not in nameable_backends(s) and name != "gemini_decision":
        if name in ("bedrock", "bedrock_openai", "systemone"):
            flag = {
                "bedrock": "DECISION_BEDROCK_ENABLED",
                "bedrock_openai": "DECISION_BEDROCK_OPENAI_ENABLED",
                "systemone": "DECISION_SYSTEMONE_ENABLED",
            }[name]
            raise BackendUnavailable(
                f"the {name} backend is not enabled on this service ({flag})"
            )
        raise BackendUnavailable(
            f"unknown backend {name[:40]!r}; use one of {nameable_backends(s)}"
        )
    default_model = {
        "anthropic": DEFAULT_ANTHROPIC_MODEL,
        "bedrock": s.bedrock_model,
        "gemini_decision": s.gemini_decision_model,
        "bedrock_openai": s.bedrock_openai_model,
        "systemone": s.systemone_model
        or (s.model if s.backend == "systemone" else None),
    }[name]
    assert default_model is not None, "load_settings requires DECISION_SYSTEMONE_MODEL"
    return backend_settings(s, name, model or default_model)


def resolve_backend(request: Request) -> tuple[Settings, str | None]:
    """The settings for this request (after any X-Decision-Backend override) and
    the per-request Anthropic or Gemini key, if any. Header values are never logged."""
    name = (request.headers.get(BACKEND_HEADER) or "default").strip().lower()
    model = (request.headers.get(MODEL_HEADER) or "").strip() or None
    key: str | None = None
    if name == "anthropic":
        key = (request.headers.get(ANTHROPIC_KEY_HEADER) or "").strip()
        if not key:
            raise BackendUnavailable(
                f"the anthropic backend needs an {ANTHROPIC_KEY_HEADER} header"
            )
    if name == "gemini_decision":
        # The request's own key, else the service's: setting
        # GEMINI_DECISION_API_KEY is what makes the backend available.
        key = (request.headers.get(GEMINI_KEY_HEADER) or "").strip() or None
        if key is None and not settings.gemini_decision_api_key:
            raise BackendUnavailable(
                "the gemini_decision backend needs GEMINI_DECISION_API_KEY on the "
                f"service or an {GEMINI_KEY_HEADER} header"
            )
    return named_settings(settings, name, model), key


# What Console shows for each backend and model; any other model shows its id.
def backend_label(backend: str, model: str) -> str:
    if backend == "bedrock_openai" and model == DEFAULT_BEDROCK_OPENAI_MODEL:
        return "Qwen3 235B (Bedrock)"
    if backend == "systemone" and model == "vllm-sr/d3-mini":
        return "vllm-sr d3-mini (self-hosted)"
    if backend == "gemini_decision":
        return f"Gemini ({model})"
    if backend == "bedrock" and "claude-haiku" in model:
        return "Claude Haiku (Bedrock)"
    if backend == "anthropic" and "claude-haiku" in model:
        return "Claude Haiku (Anthropic)"
    return model


def backend_entry(s: Settings, name: str) -> dict:
    """/health's description of what a request naming `name` gets."""
    used = named_settings(s, name, None)
    fallback = fallback_settings(s, used)
    entry: dict = {
        "backend": used.backend,
        "model": used.model,
        "label": backend_label(used.backend, used.model),
        "threshold": used.confidence_threshold,
        "fallback": None
        if fallback is None
        else {
            "backend": fallback.backend,
            "model": fallback.model,
            "after_s": s.fallback_after_s,
        },
    }
    if name == "default":
        entry["is_default"] = True
    return entry


@app.get("/health")
async def health() -> dict:
    used = default_settings(settings)
    try:
        server = await check(_client(), used)
    except ModelServerError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    fallback = fallback_settings(settings, used)
    names = backends_available(settings)
    return {
        "ok": True,
        "backend": used.backend,
        "model": used.model,
        "model_server": model_server(used),
        "model_server_status": server,
        "confidence_threshold": used.confidence_threshold,
        "min_lead": used.min_lead,
        "backends_available": names,
        "fallback_backend": fallback.backend if fallback else None,
        "fallback_model": fallback.model if fallback else None,
        "fallback_after_s": settings.fallback_after_s if fallback else None,
        "fallback_confidence_threshold": settings.fallback_confidence_threshold
        if fallback
        else None,
        "backends": {name: backend_entry(settings, name) for name in names},
    }


@app.post("/decide")
async def decide(req: DecideRequest, request: Request) -> DecideResponse:
    if not req.agents:
        raise HTTPException(
            status_code=422, detail="agents must list at least one agent"
        )
    used, api_key = resolve_backend(request)
    fallback = fallback_settings(settings, used)
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
    # A request's own threshold (a workspace's) holds for either backend.
    threshold = (
        req.confidence_threshold
        if req.confidence_threshold is not None
        else answered.confidence_threshold
    )
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

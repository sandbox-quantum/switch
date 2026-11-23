import os
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Literal, get_args

Backend = Literal[
    "systemone",
    "ollama",
    "bedrock",
    "llamacpp",
    "anthropic",
    "gemini_decision",
    "bedrock_openai",
]
BACKENDS: tuple[str, ...] = get_args(Backend)

# Bedrock's cross-region inference profiles: `us.` for US regions (the
# default AWS_REGION), `eu.anthropic.claude-haiku-5-5` for EU regions.
DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-haiku-5-5"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"
DEFAULT_GEMINI_DECISION_MODEL = "gemini-decision-1"
DEFAULT_GEMINI_DECISION_URL = (
    "https://generativelanguage.googleapis.com/v1beta/decisions"
)
# Open-weights models on Bedrock, called with InvokeModel and an OpenAI chat
# body; Converse returns no logprobs.
DEFAULT_BEDROCK_OPENAI_MODEL = "qwen.qwen3-235b-a22b-2507-v1:0"
DEFAULT_BEDROCK_OPENAI_REGION = "eu-central-1"

DEFAULT_MODELS: dict[str, str] = {
    "systemone": "clef-flash",
    "ollama": "qwen3.5:9b",
    "bedrock": DEFAULT_BEDROCK_MODEL,
    "llamacpp": "qwen3.5-4b-q4_k_m",
    "anthropic": DEFAULT_ANTHROPIC_MODEL,
    "gemini_decision": DEFAULT_GEMINI_DECISION_MODEL,
    "bedrock_openai": DEFAULT_BEDROCK_OPENAI_MODEL,
}

# The backends that can race another one, answering with the service's own
# credentials.
FallbackBackend = Literal["bedrock", "bedrock_openai"]
FALLBACK_BACKENDS: tuple[str, ...] = get_args(FallbackBackend)
DEFAULT_FALLBACK_AFTER_S = 2.0

THRESHOLD_PREFIX = "DECISION_THRESHOLD_"


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _unit(name: str, raw: str) -> float:
    """A setting that must be a number from 0 to 1."""
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(
            f"{name} must be a number between 0 and 1, got {raw!r}"
        ) from None
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    backend: Backend
    model: str
    systemone_url: str
    ollama_url: str
    llamacpp_url: str
    aws_region: str
    aws_profile: str | None
    confidence_threshold: float
    timeout_s: float
    history_limit: int
    with_reason: bool = True
    # Bearer token every request but GET /health must carry; None means no auth.
    service_token: str | None = None
    # Bearer token sent to the llama.cpp and SystemOne (Strands) model servers,
    # which then refuse everything but /health without it; None sends none.
    model_server_token: str | None = None
    # Whether a request may choose Bedrock with X-Decision-Backend (it spends
    # the service's own AWS credentials).
    bedrock_enabled: bool = False
    bedrock_model: str = DEFAULT_BEDROCK_MODEL
    # When set, a backend that scores every option picks its top agent only if
    # it leads the next option (another agent or "none") by at least this
    # much, instead of applying confidence_threshold. None: the threshold.
    min_lead: float | None = None
    # Google's Decisions API: the key (GEMINI_DECISION_API_KEY, never logged),
    # the endpoint, and the model a per-request override to it uses.
    gemini_decision_api_key: str | None = field(default=None, repr=False)
    gemini_decision_url: str = DEFAULT_GEMINI_DECISION_URL
    gemini_decision_model: str = DEFAULT_GEMINI_DECISION_MODEL
    # Bedrock open-weights models (InvokeModel, letter logprobs): whether a
    # request may choose them, the model, and the region, which is separate
    # from AWS_REGION (Haiku's).
    bedrock_openai_enabled: bool = False
    bedrock_openai_model: str = DEFAULT_BEDROCK_OPENAI_MODEL
    bedrock_openai_region: str = DEFAULT_BEDROCK_OPENAI_REGION
    # Whether a request may choose the service's own SystemOne model server
    # (SYSTEMONE_URL), and the model it names there.
    systemone_enabled: bool = False
    systemone_model: str | None = None
    # A threshold of its own for each backend named here
    # (DECISION_THRESHOLD_<BACKEND>), by the plain threshold rule. A backend
    # not named keeps confidence_threshold and min_lead.
    thresholds: Mapping[str, float] = field(default_factory=dict)
    # The backend asked too when a primary backend, by name, has not
    # answered after fallback_after_s seconds, or failed. A primary not named
    # has no fallback.
    fallbacks: Mapping[str, FallbackBackend] = field(default_factory=dict)
    fallback_after_s: float = DEFAULT_FALLBACK_AFTER_S
    # The threshold an answer from any fallback is held to, by the plain
    # threshold rule. None: the fallback backend's own threshold, else the
    # primary's rule.
    fallback_confidence_threshold: float | None = None


def backend_settings(s: Settings, backend: str, model: str) -> Settings:
    """The settings a call to `backend` with `model` is made with, and its
    answer judged by: the backend's own threshold when it has one."""
    out = replace(s, backend=backend, model=model)  # type: ignore[arg-type]
    if backend in s.thresholds:
        out = replace(out, confidence_threshold=s.thresholds[backend], min_lead=None)
    return out


def default_settings(s: Settings) -> Settings:
    return backend_settings(s, s.backend, s.model)


def fallback_settings(s: Settings, primary: Settings) -> Settings | None:
    """The settings the fallback for `primary` (a backend's resolved
    settings) is asked with, and its answer judged by, or None without one."""
    name = s.fallbacks.get(primary.backend)
    if name is None:
        return None
    if name == "bedrock":
        model = s.bedrock_model
    elif name == "bedrock_openai":
        model = s.bedrock_openai_model
    else:
        raise ValueError(f"unknown fallback backend {name!r}")
    fallback = replace(primary, backend=name, model=model)
    if s.fallback_confidence_threshold is not None:
        return replace(
            fallback,
            confidence_threshold=s.fallback_confidence_threshold,
            min_lead=None,
        )
    if name in s.thresholds:
        return replace(fallback, confidence_threshold=s.thresholds[name], min_lead=None)
    return fallback


def nameable_backends(s: Settings) -> list[str]:
    """The backends a request may name with X-Decision-Backend, `default`
    first. A backend that spends the service's own credentials or model server
    needs its flag, unless it is the default."""
    names = ["default", "anthropic"]
    if s.bedrock_enabled or s.backend == "bedrock":
        names.append("bedrock")
    if s.gemini_decision_api_key:
        names.append("gemini_decision")
    if s.bedrock_openai_enabled or s.backend == "bedrock_openai":
        names.append("bedrock_openai")
    if s.systemone_enabled or s.backend == "systemone":
        names.append("systemone")
    return names


def _thresholds() -> dict[str, float]:
    known = {f"{THRESHOLD_PREFIX}{b.upper()}": b for b in BACKENDS}
    out: dict[str, float] = {}
    for name, raw in os.environ.items():
        if not name.startswith(THRESHOLD_PREFIX) or not raw.strip():
            continue
        if name not in known:
            raise ValueError(f"{name} names no backend; use one of {sorted(known)}")
        out[known[name]] = _unit(name, raw.strip())
    return out


def _fallback_name(var: str, name: str) -> FallbackBackend:
    if name not in FALLBACK_BACKENDS:
        raise ValueError(
            f"{var}: the fallback must be one of {list(FALLBACK_BACKENDS)}, got {name!r}"
        )
    return name  # type: ignore[return-value]


def _fallbacks(backend: str) -> dict[str, FallbackBackend]:
    """DECISION_FALLBACKS (`primary:fallback`, comma-separated) merged with
    DECISION_FALLBACK_BACKEND, the default backend's fallback."""
    out: dict[str, FallbackBackend] = {}
    for entry in os.environ.get("DECISION_FALLBACKS", "").split(","):
        entry = entry.strip().lower()
        if not entry:
            continue
        primary, sep, fallback = (part.strip() for part in entry.partition(":"))
        if not sep or not primary or not fallback:
            raise ValueError(
                f"DECISION_FALLBACKS entries are primary:fallback, got {entry!r}"
            )
        if primary not in BACKENDS:
            raise ValueError(
                f"DECISION_FALLBACKS: {primary!r} is not a backend; "
                f"use one of {sorted(BACKENDS)}"
            )
        if primary in out:
            raise ValueError(f"DECISION_FALLBACKS names {primary} twice")
        out[primary] = _fallback_name("DECISION_FALLBACKS", fallback)
    legacy = os.environ.get("DECISION_FALLBACK_BACKEND", "").strip().lower()
    if legacy:
        if legacy not in FALLBACK_BACKENDS:
            raise ValueError(
                f"DECISION_FALLBACK_BACKEND must be one of {list(FALLBACK_BACKENDS)} "
                f"or empty, got {legacy!r}"
            )
        if out.get(backend, legacy) != legacy:
            raise ValueError(
                f"DECISION_FALLBACK_BACKEND={legacy} and DECISION_FALLBACKS "
                f"({backend}:{out[backend]}) disagree about {backend}'s fallback"
            )
        out[backend] = legacy  # type: ignore[assignment]
    for primary, fallback in out.items():
        if primary == fallback:
            raise ValueError(
                f"{primary}'s fallback is {fallback} itself; "
                "a fallback must be another backend"
            )
    return out


def _fallback_timing(timeout_s: float) -> tuple[float, float | None]:
    after_raw = os.environ.get("DECISION_FALLBACK_AFTER_S", "").strip()
    after_s = float(after_raw) if after_raw else DEFAULT_FALLBACK_AFTER_S
    if not 0.0 < after_s < timeout_s:
        raise ValueError(
            f"DECISION_FALLBACK_AFTER_S must be more than 0 and less than "
            f"DECISION_TIMEOUT_S ({timeout_s}), got {after_s}"
        )
    threshold_raw = os.environ.get("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", "").strip()
    threshold = (
        _unit("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", threshold_raw)
        if threshold_raw
        else None
    )
    return after_s, threshold


def _check_fallback_primaries(s: Settings) -> None:
    """Every primary in DECISION_FALLBACKS must be a backend a request can
    get: the default, or one it may name. gemini_decision can always be named
    with the request's own key."""
    usable = set(nameable_backends(s)) | {s.backend, "gemini_decision"}
    for primary in s.fallbacks:
        if primary not in usable:
            raise ValueError(
                f"DECISION_FALLBACKS names {primary}, which is neither "
                "DECISION_BACKEND nor enabled per request"
            )


def load_settings() -> Settings:
    backend = os.environ.get("DECISION_BACKEND", "llamacpp")
    if backend not in DEFAULT_MODELS:
        raise ValueError(
            f"DECISION_BACKEND must be one of {sorted(DEFAULT_MODELS)}, got {backend!r}"
        )
    threshold = float(os.environ.get("DECISION_CONFIDENCE_THRESHOLD", "0.6"))
    if not 0.0 <= threshold <= 1.0:
        raise ValueError(
            f"DECISION_CONFIDENCE_THRESHOLD must be between 0 and 1, got {threshold}"
        )
    min_lead_raw = os.environ.get("DECISION_MIN_LEAD", "").strip()
    min_lead = float(min_lead_raw) if min_lead_raw else None
    if min_lead is not None and not 0.0 <= min_lead <= 1.0:
        raise ValueError(f"DECISION_MIN_LEAD must be between 0 and 1, got {min_lead}")
    bedrock_model = os.environ.get("DECISION_BEDROCK_MODEL") or DEFAULT_BEDROCK_MODEL
    gemini_model = (
        os.environ.get("DECISION_GEMINI_MODEL") or DEFAULT_GEMINI_DECISION_MODEL
    )
    gemini_key = os.environ.get("GEMINI_DECISION_API_KEY", "").strip() or None
    if backend == "gemini_decision" and gemini_key is None:
        raise ValueError(
            "DECISION_BACKEND=gemini_decision needs GEMINI_DECISION_API_KEY"
        )
    bedrock_openai_model = (
        os.environ.get("DECISION_BEDROCK_OPENAI_MODEL") or DEFAULT_BEDROCK_OPENAI_MODEL
    )
    systemone_url = os.environ.get("SYSTEMONE_URL", "").strip()
    systemone_enabled = _flag("DECISION_SYSTEMONE_ENABLED")
    systemone_model = os.environ.get("DECISION_SYSTEMONE_MODEL", "").strip() or None
    if systemone_enabled and backend != "systemone":
        if not systemone_url:
            raise ValueError("DECISION_SYSTEMONE_ENABLED=1 needs SYSTEMONE_URL")
        if systemone_model is None:
            raise ValueError(
                "DECISION_SYSTEMONE_ENABLED=1 needs DECISION_SYSTEMONE_MODEL, "
                "the model name the SystemOne server serves"
            )
    timeout_s = float(os.environ.get("DECISION_TIMEOUT_S", "30"))
    fallbacks = _fallbacks(backend)
    fallback_after_s, fallback_threshold = (
        _fallback_timing(timeout_s) if fallbacks else (DEFAULT_FALLBACK_AFTER_S, None)
    )
    default_model = {
        "bedrock": bedrock_model,
        "gemini_decision": gemini_model,
        "bedrock_openai": bedrock_openai_model,
        "systemone": systemone_model or DEFAULT_MODELS["systemone"],
    }.get(backend, DEFAULT_MODELS[backend])
    model = os.environ.get("DECISION_MODEL") or default_model
    settings = Settings(
        backend=backend,  # type: ignore[arg-type]
        model=model,
        systemone_url=systemone_url or "http://127.0.0.1:8100/v1/systemone",
        ollama_url=os.environ.get("OLLAMA_URL", "http://localhost:11434"),
        llamacpp_url=os.environ.get("LLAMACPP_URL", "http://127.0.0.1:8300"),
        aws_region=os.environ.get("AWS_REGION", "us-east-1"),
        aws_profile=os.environ.get("AWS_PROFILE") or None,
        confidence_threshold=threshold,
        timeout_s=timeout_s,
        history_limit=int(os.environ.get("DECISION_HISTORY_LIMIT", "8")),
        with_reason=os.environ.get("DECISION_WITH_REASON", "1") != "0",
        service_token=os.environ.get("DECISION_SERVICE_TOKEN") or None,
        model_server_token=os.environ.get("MODEL_SERVER_TOKEN") or None,
        bedrock_enabled=_flag("DECISION_BEDROCK_ENABLED"),
        bedrock_model=bedrock_model,
        min_lead=min_lead,
        gemini_decision_api_key=gemini_key,
        gemini_decision_url=os.environ.get("GEMINI_DECISION_URL")
        or DEFAULT_GEMINI_DECISION_URL,
        gemini_decision_model=gemini_model,
        bedrock_openai_enabled=_flag("DECISION_BEDROCK_OPENAI_ENABLED"),
        bedrock_openai_model=bedrock_openai_model,
        bedrock_openai_region=os.environ.get(
            "DECISION_BEDROCK_OPENAI_REGION", ""
        ).strip()
        or DEFAULT_BEDROCK_OPENAI_REGION,
        systemone_enabled=systemone_enabled,
        systemone_model=model if backend == "systemone" else systemone_model,
        thresholds=_thresholds(),
        fallbacks=fallbacks,
        fallback_after_s=fallback_after_s,
        fallback_confidence_threshold=fallback_threshold,
    )
    _check_fallback_primaries(settings)
    return settings

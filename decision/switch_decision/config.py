import os
from dataclasses import dataclass, field, replace
from typing import Literal, get_args

Backend = Literal[
    "systemone", "ollama", "bedrock", "llamacpp", "anthropic", "gemini_decision"
]

# Bedrock's cross-region inference profiles: `us.` for US regions (the
# default AWS_REGION), `eu.anthropic.claude-haiku-5-5` for EU regions.
DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-haiku-5-5"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"
DEFAULT_GEMINI_DECISION_MODEL = "gemini-decision-1"
DEFAULT_GEMINI_DECISION_URL = (
    "https://generativelanguage.googleapis.com/v1beta/decisions"
)

DEFAULT_MODELS: dict[str, str] = {
    "systemone": "clef-flash",
    "ollama": "qwen3.5:9b",
    "bedrock": DEFAULT_BEDROCK_MODEL,
    "llamacpp": "qwen3.5-4b-q4_k_m",
    "anthropic": DEFAULT_ANTHROPIC_MODEL,
    "gemini_decision": DEFAULT_GEMINI_DECISION_MODEL,
}

# The backends that can race the default one, answering with the service's
# own credentials.
FallbackBackend = Literal["bedrock"]
FALLBACK_BACKENDS: tuple[str, ...] = get_args(FallbackBackend)
DEFAULT_FALLBACK_AFTER_S = 2.0


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


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
    # The backend asked too when the default backend has not answered after
    # fallback_after_s seconds, or failed; None: no fallback.
    fallback_backend: FallbackBackend | None = None
    fallback_after_s: float = DEFAULT_FALLBACK_AFTER_S
    # The threshold an answer from the fallback is held to, by the plain
    # threshold rule. None: the same rule as the default backend's.
    fallback_confidence_threshold: float | None = None


def fallback_settings(s: Settings) -> Settings | None:
    """The settings the fallback backend is asked with, and its answer
    judged by, or None without one."""
    if s.fallback_backend is None:
        return None
    fallback = s
    if s.fallback_confidence_threshold is not None:
        fallback = replace(
            s, confidence_threshold=s.fallback_confidence_threshold, min_lead=None
        )
    if s.fallback_backend == "bedrock":
        return replace(fallback, backend="bedrock", model=s.bedrock_model)
    raise ValueError(f"unknown fallback backend {s.fallback_backend!r}")


def _fallback(
    backend: str, timeout_s: float
) -> tuple[FallbackBackend | None, float, float | None]:
    name = os.environ.get("DECISION_FALLBACK_BACKEND", "").strip().lower()
    if not name:
        return None, DEFAULT_FALLBACK_AFTER_S, None
    if name not in FALLBACK_BACKENDS:
        raise ValueError(
            f"DECISION_FALLBACK_BACKEND must be one of {list(FALLBACK_BACKENDS)} "
            f"or empty, got {name!r}"
        )
    if name == backend:
        raise ValueError(
            f"DECISION_FALLBACK_BACKEND={name} is DECISION_BACKEND too; "
            "a fallback must be another backend"
        )
    after_raw = os.environ.get("DECISION_FALLBACK_AFTER_S", "").strip()
    after_s = float(after_raw) if after_raw else DEFAULT_FALLBACK_AFTER_S
    if not 0.0 < after_s < timeout_s:
        raise ValueError(
            f"DECISION_FALLBACK_AFTER_S must be more than 0 and less than "
            f"DECISION_TIMEOUT_S ({timeout_s}), got {after_s}"
        )
    threshold_raw = os.environ.get("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", "").strip()
    threshold = float(threshold_raw) if threshold_raw else None
    if threshold is not None and not 0.0 <= threshold <= 1.0:
        raise ValueError(
            "DECISION_FALLBACK_CONFIDENCE_THRESHOLD must be between 0 and 1, "
            f"got {threshold}"
        )
    return name, after_s, threshold  # type: ignore[return-value]


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
    timeout_s = float(os.environ.get("DECISION_TIMEOUT_S", "30"))
    fallback_backend, fallback_after_s, fallback_threshold = _fallback(
        backend, timeout_s
    )
    default_model = {"bedrock": bedrock_model, "gemini_decision": gemini_model}.get(
        backend, DEFAULT_MODELS[backend]
    )
    return Settings(
        backend=backend,  # type: ignore[arg-type]
        model=os.environ.get("DECISION_MODEL") or default_model,
        systemone_url=os.environ.get(
            "SYSTEMONE_URL", "http://127.0.0.1:8100/v1/systemone"
        ),
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
        fallback_backend=fallback_backend,
        fallback_after_s=fallback_after_s,
        fallback_confidence_threshold=fallback_threshold,
    )

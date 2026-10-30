import os
from dataclasses import dataclass
from typing import Literal

from switch_decision.prompt import DEFAULT_HISTORY_LIMIT
from switch_decision.readers import DEFAULT_CONFIDENCE_THRESHOLD

Backend = Literal["systemone", "ollama", "bedrock", "llamacpp", "anthropic"]

DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-haiku-5-5-v1:0"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"

DEFAULT_MODELS: dict[str, str] = {
    "systemone": "clef-flash",
    "ollama": "qwen3.5:9b",
    "bedrock": DEFAULT_BEDROCK_MODEL,
    "llamacpp": "qwen3.5-4b-q4_k_m",
    "anthropic": DEFAULT_ANTHROPIC_MODEL,
}


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
    # Whether a request may choose Bedrock with X-Decision-Backend (it spends
    # the service's own AWS credentials).
    bedrock_enabled: bool = False
    bedrock_model: str = DEFAULT_BEDROCK_MODEL


def load_settings() -> Settings:
    backend = os.environ.get("DECISION_BACKEND", "llamacpp")
    if backend not in DEFAULT_MODELS:
        raise ValueError(
            f"DECISION_BACKEND must be one of {sorted(DEFAULT_MODELS)}, got {backend!r}"
        )
    threshold = float(
        os.environ.get(
            "DECISION_CONFIDENCE_THRESHOLD", str(DEFAULT_CONFIDENCE_THRESHOLD)
        )
    )
    if not 0.0 <= threshold <= 1.0:
        raise ValueError(
            f"DECISION_CONFIDENCE_THRESHOLD must be between 0 and 1, got {threshold}"
        )
    bedrock_model = os.environ.get("DECISION_BEDROCK_MODEL") or DEFAULT_BEDROCK_MODEL
    default_model = bedrock_model if backend == "bedrock" else DEFAULT_MODELS[backend]
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
        timeout_s=float(os.environ.get("DECISION_TIMEOUT_S", "30")),
        history_limit=int(
            os.environ.get("DECISION_HISTORY_LIMIT", str(DEFAULT_HISTORY_LIMIT))
        ),
        with_reason=os.environ.get("DECISION_WITH_REASON", "1") != "0",
        service_token=os.environ.get("DECISION_SERVICE_TOKEN") or None,
        bedrock_enabled=_flag("DECISION_BEDROCK_ENABLED"),
        bedrock_model=bedrock_model,
    )

import pytest

from switch_decision.config import load_settings


def test_defaults(monkeypatch):
    for k in (
        "DECISION_BACKEND",
        "DECISION_MODEL",
        "DECISION_CONFIDENCE_THRESHOLD",
        "LLAMACPP_URL",
        "DECISION_SERVICE_TOKEN",
        "DECISION_BEDROCK_ENABLED",
    ):
        monkeypatch.delenv(k, raising=False)
    s = load_settings()
    assert (s.backend, s.model, s.confidence_threshold) == (
        "llamacpp",
        "qwen3.5-4b-q4_k_m",
        0.6,
    )
    assert s.llamacpp_url == "http://127.0.0.1:8300"
    assert (s.service_token, s.bedrock_enabled) == (None, False)


def test_ollama_backend_default_model(monkeypatch):
    monkeypatch.setenv("DECISION_BACKEND", "ollama")
    monkeypatch.delenv("DECISION_MODEL", raising=False)
    assert load_settings().model == "qwen3.5:9b"


@pytest.mark.parametrize("value", ["-0.1", "1.5"])
def test_threshold_out_of_range_refused(monkeypatch, value):
    monkeypatch.setenv("DECISION_CONFIDENCE_THRESHOLD", value)
    with pytest.raises(ValueError, match="between 0 and 1"):
        load_settings()


def test_unknown_backend_refused(monkeypatch):
    monkeypatch.setenv("DECISION_BACKEND", "vertex")
    with pytest.raises(ValueError, match="DECISION_BACKEND"):
        load_settings()


def test_bedrock_backend_defaults(monkeypatch):
    monkeypatch.setenv("DECISION_BACKEND", "bedrock")
    for k in ("DECISION_MODEL", "DECISION_BEDROCK_MODEL", "AWS_REGION", "AWS_PROFILE"):
        monkeypatch.delenv(k, raising=False)
    s = load_settings()
    assert (s.model, s.aws_region, s.aws_profile) == (
        "us.anthropic.claude-haiku-5-5-v1:0",
        "us-east-1",
        None,
    )


def test_bedrock_model_setting_is_the_bedrock_default(monkeypatch):
    monkeypatch.setenv("DECISION_BACKEND", "bedrock")
    monkeypatch.setenv("DECISION_BEDROCK_MODEL", "us.anthropic.some-other-v1:0")
    monkeypatch.delenv("DECISION_MODEL", raising=False)
    assert load_settings().model == "us.anthropic.some-other-v1:0"


@pytest.mark.parametrize(
    ("value", "enabled"), [("1", True), ("true", True), ("0", False), ("", False)]
)
def test_bedrock_enabled_flag(monkeypatch, value, enabled):
    monkeypatch.setenv("DECISION_BEDROCK_ENABLED", value)
    assert load_settings().bedrock_enabled is enabled


def test_history_limit_defaults_to_eight(monkeypatch):
    monkeypatch.delenv("DECISION_HISTORY_LIMIT", raising=False)
    assert load_settings().history_limit == 8

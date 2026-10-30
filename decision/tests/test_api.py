"""The HTTP surface: per-request backend override, service token, and what the logs keep."""

import logging
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from switch_decision import app as app_module
from switch_decision import backends
from switch_decision.config import Settings
from switch_decision.prompt import NONE

SECRET_TEXT = "zebra-quartz-7731 rollback the purple cluster"
ROOM_RULES = "never-log-these-room-rules-4412"
ANTHROPIC_KEY = "fake-key-0001"

BODY = {
    "room": {"name": "eng-secret-room", "instructions": ROOM_RULES},
    "message": {"sender": "sara", "text": SECRET_TEXT},
    "agents": [
        {"name": "deploy-bot", "description": "CI and deploys"},
        {"name": "billing-bot", "description": "invoices"},
    ],
    "recent": [{"sender": "tom", "text": f"earlier: {SECRET_TEXT}"}],
}


def _settings(**kw) -> Settings:
    base = dict(
        backend="llamacpp",
        model="qwen3.5-4b-q4_k_m",
        systemone_url="http://s",
        ollama_url="http://o",
        llamacpp_url="http://llama.test",
        aws_region="us-east-1",
        aws_profile=None,
        confidence_threshold=0.6,
        timeout_s=5,
        history_limit=30,
    )
    base.update(kw)
    return Settings(**base)


def _logprobs(letter: str):
    top = [{"token": letter, "logprob": -0.05}, {"token": "N", "logprob": -3.0}]
    return {"choices": [{"logprobs": {"content": [{"top_logprobs": top}]}}]}


class FakeAnthropic:
    """Stands in for anthropic.AsyncAnthropic: records each call, answers with a pick."""

    def __init__(self, agent: str, confidence: float = 0.9):
        self.agent, self.confidence = agent, confidence
        self.calls: list[dict] = []
        self.messages = self

    async def create(self, **kw):
        self.calls.append(kw)
        block = SimpleNamespace(
            type="tool_use",
            name="pick_speaker",
            input={"reason": "r", "agent": self.agent, "confidence": self.confidence},
        )
        return SimpleNamespace(stop_reason="tool_use", content=[block])


@pytest.fixture
def make_client(monkeypatch):
    def make(settings: Settings | None = None, handler=None) -> TestClient:
        monkeypatch.setattr(app_module, "settings", settings or _settings())
        tc = TestClient(app_module.app)
        tc.__enter__()
        transport = httpx.MockTransport(
            handler or (lambda r: httpx.Response(200, json=_logprobs("A")))
        )
        monkeypatch.setattr(
            app_module, "client", httpx.AsyncClient(transport=transport)
        )
        return tc

    return make


@pytest.fixture
def fake_anthropic(monkeypatch):
    holder: dict = {}

    def install(agent: str, confidence: float = 0.9) -> FakeAnthropic:
        fake = FakeAnthropic(agent, confidence)

        def factory(settings, api_key=None):
            holder.setdefault("keys", []).append(api_key)
            return fake

        monkeypatch.setattr(backends, "anthropic_client", factory)
        holder["fake"] = fake
        return fake

    install.holder = holder  # type: ignore[attr-defined]
    return install


# ── default backend ─────────────────────────────────────────────────────────


def test_default_backend_answers_and_names_itself(make_client):
    r = make_client().post("/decide", json=BODY)
    assert r.status_code == 200
    body = r.json()
    assert (
        body["agent"] == "deploy-bot"
        and body["backend"] == "llamacpp"
        and body["model"] == "qwen3.5-4b-q4_k_m"
    )


def test_explicit_default_header_uses_configured_backend(make_client):
    r = make_client().post(
        "/decide",
        json=BODY,
        headers={"X-Decision-Backend": "default", "X-Decision-Model": "x"},
    )
    assert (
        r.status_code == 200
        and r.json()["backend"] == "llamacpp"
        and r.json()["model"] == "qwen3.5-4b-q4_k_m"
    )


# ── per-request override ────────────────────────────────────────────────────


def test_override_to_anthropic_uses_the_request_key(make_client, fake_anthropic):
    fake = fake_anthropic("billing-bot", 0.8)
    tc = make_client(
        handler=lambda r: pytest.fail("the default backend must not be called")
    )
    r = tc.post(
        "/decide",
        json=BODY,
        headers={
            "X-Decision-Backend": "anthropic",
            "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert (
        body["agent"] == "billing-bot"
        and body["backend"] == "anthropic"
        and body["model"] == "claude-haiku-5-5"
    )
    assert fake_anthropic.holder["keys"] == [ANTHROPIC_KEY]
    assert fake.calls[0]["model"] == "claude-haiku-5-5"


def test_override_model_header(make_client, fake_anthropic):
    fake = fake_anthropic("deploy-bot")
    r = make_client().post(
        "/decide",
        json=BODY,
        headers={
            "X-Decision-Backend": "anthropic",
            "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
            "X-Decision-Model": "claude-sonnet-5-5",
        },
    )
    assert r.status_code == 200 and r.json()["model"] == "claude-sonnet-5-5"
    assert fake.calls[0]["model"] == "claude-sonnet-5-5"


def test_anthropic_without_key_is_backend_unavailable(make_client, fake_anthropic):
    fake = fake_anthropic("deploy-bot")
    r = make_client().post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "anthropic"}
    )
    assert r.status_code == 400
    assert (
        r.json()["code"] == "backend_unavailable"
        and "X-Decision-Anthropic-Key" in r.json()["detail"]
    )
    assert fake.calls == []


def test_bedrock_disabled_is_backend_unavailable(make_client, monkeypatch):
    monkeypatch.setattr(
        backends, "bedrock_client", lambda s: pytest.fail("bedrock must not be called")
    )
    r = make_client().post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "bedrock"}
    )
    assert r.status_code == 400 and r.json()["code"] == "backend_unavailable"


def test_bedrock_enabled_override_uses_bedrock_model(make_client, monkeypatch):
    calls = []

    class FakeBedrock:
        def converse(self, **kw):
            calls.append(kw)
            return {
                "output": {
                    "message": {
                        "content": [
                            {
                                "toolUse": {
                                    "name": "pick_speaker",
                                    "input": {
                                        "reason": "r",
                                        "agent": "deploy-bot",
                                        "confidence": 0.9,
                                    },
                                }
                            }
                        ]
                    }
                }
            }

    monkeypatch.setattr(backends, "bedrock_client", lambda s: FakeBedrock())
    tc = make_client(_settings(bedrock_enabled=True))
    r = tc.post("/decide", json=BODY, headers={"X-Decision-Backend": "bedrock"})
    assert r.status_code == 200
    assert (
        r.json()["backend"] == "bedrock"
        and r.json()["model"] == "us.anthropic.claude-haiku-5-5-v1:0"
    )
    assert calls[0]["modelId"] == "us.anthropic.claude-haiku-5-5-v1:0"
    assert "temperature" not in calls[0]["inferenceConfig"]
    assert make_client(_settings(bedrock_enabled=True)).get("/health").json()[
        "backends_available"
    ] == ["default", "anthropic", "bedrock"]


def test_unknown_backend_is_backend_unavailable(make_client):
    r = make_client().post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "vertex"}
    )
    assert r.status_code == 400 and r.json()["code"] == "backend_unavailable"


def test_haiku_naming_a_non_candidate_is_no_agent(make_client, fake_anthropic, caplog):
    fake_anthropic("ghost-bot", 0.95)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        r = make_client().post(
            "/decide",
            json=BODY,
            headers={
                "X-Decision-Backend": "anthropic",
                "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert (
        body["agent"] is None
        and body["model_choice"] == "ghost-bot"
        and body["backend"] == "anthropic"
    )
    errors = [rec for rec in caplog.records if rec.levelno == logging.ERROR]
    assert errors and "invalid_choice" in errors[0].getMessage()


def test_anthropic_api_failure_is_502(make_client, monkeypatch):
    class Failing:
        def __init__(self):
            self.messages = self

        async def create(self, **kw):
            raise backends.anthropic.APIConnectionError(
                request=httpx.Request("POST", "https://api.anthropic.test")
            )

    monkeypatch.setattr(backends, "anthropic_client", lambda s, k=None: Failing())
    r = make_client().post(
        "/decide",
        json=BODY,
        headers={
            "X-Decision-Backend": "anthropic",
            "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
        },
    )
    assert r.status_code == 502 and "unreachable" in r.json()["detail"]


def test_anthropic_clients_are_cached_by_key_hash(monkeypatch):
    monkeypatch.setattr(backends, "_anthropic_clients", {})
    s = replace(_settings(), backend="anthropic", model="claude-haiku-5-5")
    a = backends.anthropic_client(s, ANTHROPIC_KEY)
    assert backends.anthropic_client(s, ANTHROPIC_KEY) is a
    assert backends.anthropic_client(s, "fake-key-0002") is not a
    assert ANTHROPIC_KEY not in backends._anthropic_clients
    assert backends.key_fingerprint(ANTHROPIC_KEY) in backends._anthropic_clients


# ── service token ───────────────────────────────────────────────────────────


def test_token_required_when_configured(make_client):
    tc = make_client(_settings(service_token="placeholder-service-token"))
    assert tc.post("/decide", json=BODY).status_code == 401
    assert (
        tc.post(
            "/decide", json=BODY, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    assert (
        tc.post(
            "/decide",
            json=BODY,
            headers={"Authorization": "Basic placeholder-service-token"},
        ).status_code
        == 401
    )
    ok = tc.post(
        "/decide",
        json=BODY,
        headers={"Authorization": "Bearer placeholder-service-token"},
    )
    assert ok.status_code == 200 and ok.json()["agent"] == "deploy-bot"


def test_health_needs_no_token(make_client):
    tc = make_client(
        _settings(service_token="placeholder-service-token"),
        handler=lambda r: httpx.Response(200, json={"status": "ok"}),
    )
    r = tc.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_no_token_configured_means_no_auth(make_client):
    assert make_client().post("/decide", json=BODY).status_code == 200


# ── logs ────────────────────────────────────────────────────────────────────


def _assert_clean(caplog):
    text = "\n".join(rec.getMessage() for rec in caplog.records)
    for secret in (
        SECRET_TEXT,
        "zebra-quartz",
        ROOM_RULES,
        ANTHROPIC_KEY,
        "eng-secret-room",
    ):
        assert secret not in text, f"{secret!r} leaked into the logs"
    return text


def test_logs_keep_no_message_text_room_rules_or_key(
    make_client, fake_anthropic, caplog
):
    fake_anthropic("deploy-bot")
    tc = make_client()
    with caplog.at_level(logging.DEBUG):
        assert tc.post("/decide", json=BODY).status_code == 200
        assert (
            tc.post(
                "/decide",
                json=BODY,
                headers={
                    "X-Decision-Backend": "anthropic",
                    "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
                },
            ).status_code
            == 200
        )
    text = _assert_clean(caplog)
    assert "backend=llamacpp" in text and "backend=anthropic" in text
    assert (
        "candidates=2" in text and "choice=deploy-bot" in text and "latency_ms=" in text
    )


def test_failure_logs_keep_no_backend_error_body(make_client, caplog):
    tc = make_client(
        handler=lambda r: httpx.Response(500, text=f"context too long: {SECRET_TEXT}")
    )
    with caplog.at_level(logging.DEBUG):
        r = tc.post("/decide", json=BODY)
    assert r.status_code == 502
    text = _assert_clean(caplog)
    assert "decide failed" in text and "returned 500" in text


def test_none_answer_is_nobody(make_client):
    r = make_client(handler=lambda r: httpx.Response(200, json=_logprobs("N"))).post(
        "/decide", json=BODY
    )
    assert (
        r.status_code == 200
        and r.json()["agent"] is None
        and r.json()["model_choice"] == NONE
    )

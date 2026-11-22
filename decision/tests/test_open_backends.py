"""Bedrock open-weights models (bedrock_openai), the service's own SystemOne
model per request, per-backend thresholds, fallbacks per primary backend, and
/health's backends map."""

import asyncio
import io
import json
import logging
import os
import threading

import httpx
import pytest
from botocore.exceptions import (
    ClientError,
    EndpointConnectionError,
    NoCredentialsError,
    ReadTimeoutError,
)

from switch_decision import app as app_module
from switch_decision import backends
from switch_decision.backends import ERROR_KINDS, ModelAnswer
from switch_decision.config import (
    backend_settings,
    default_settings,
    fallback_settings,
    load_settings,
)
from tests.helpers import BODY, GEMINI_KEY, SECRET_TEXT, settings_for

QWEN = "qwen.qwen3-235b-a22b-2507-v1:0"
D3 = "vllm-sr/d3-mini"
HAIKU_MODEL = "eu.anthropic.claude-haiku-5-5"
SYSTEMONE_URL = "http://d3.test/v1/systemone"


# ── settings ────────────────────────────────────────────────────────────────

ENV = (
    "DECISION_BACKEND",
    "DECISION_MODEL",
    "DECISION_CONFIDENCE_THRESHOLD",
    "DECISION_MIN_LEAD",
    "DECISION_TIMEOUT_S",
    "DECISION_BEDROCK_ENABLED",
    "DECISION_BEDROCK_MODEL",
    "DECISION_BEDROCK_OPENAI_ENABLED",
    "DECISION_BEDROCK_OPENAI_MODEL",
    "DECISION_BEDROCK_OPENAI_REGION",
    "DECISION_SYSTEMONE_ENABLED",
    "DECISION_SYSTEMONE_MODEL",
    "SYSTEMONE_URL",
    "DECISION_FALLBACKS",
    "DECISION_FALLBACK_BACKEND",
    "DECISION_FALLBACK_AFTER_S",
    "DECISION_FALLBACK_CONFIDENCE_THRESHOLD",
    "GEMINI_DECISION_API_KEY",
    "AWS_REGION",
)


@pytest.fixture
def env(monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    for k in list(os.environ):
        if k.startswith("DECISION_THRESHOLD_"):
            monkeypatch.delenv(k)
    return monkeypatch


def test_bedrock_openai_defaults(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("AWS_REGION", "eu-west-3")
    s = load_settings()
    assert (s.backend, s.model) == ("bedrock_openai", QWEN)
    # Its own region, not AWS_REGION (Haiku's).
    assert (s.bedrock_openai_region, s.aws_region) == ("eu-central-1", "eu-west-3")
    assert s.bedrock_openai_enabled is False


def test_bedrock_openai_model_and_region_settings(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("DECISION_BEDROCK_OPENAI_MODEL", "qwen.qwen3-32b-v1:0")
    env.setenv("DECISION_BEDROCK_OPENAI_REGION", "us-east-1")
    env.setenv("DECISION_BEDROCK_OPENAI_ENABLED", "1")
    s = load_settings()
    assert (s.model, s.bedrock_openai_model, s.bedrock_openai_region) == (
        "qwen.qwen3-32b-v1:0",
        "qwen.qwen3-32b-v1:0",
        "us-east-1",
    )
    assert s.bedrock_openai_enabled is True


def test_systemone_per_request_settings(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("DECISION_SYSTEMONE_ENABLED", "1")
    env.setenv("SYSTEMONE_URL", SYSTEMONE_URL)
    env.setenv("DECISION_SYSTEMONE_MODEL", D3)
    s = load_settings()
    assert (s.systemone_enabled, s.systemone_url, s.systemone_model) == (
        True,
        SYSTEMONE_URL,
        D3,
    )
    assert "systemone" in app_module.backends_available(s)


def test_systemone_enabled_needs_its_url(env):
    env.setenv("DECISION_SYSTEMONE_ENABLED", "1")
    env.setenv("DECISION_SYSTEMONE_MODEL", D3)
    with pytest.raises(
        ValueError, match="DECISION_SYSTEMONE_ENABLED=1 needs SYSTEMONE_URL"
    ):
        load_settings()


def test_systemone_enabled_needs_its_model(env):
    env.setenv("DECISION_SYSTEMONE_ENABLED", "1")
    env.setenv("SYSTEMONE_URL", SYSTEMONE_URL)
    with pytest.raises(ValueError, match="needs DECISION_SYSTEMONE_MODEL"):
        load_settings()


def test_systemone_as_the_default_needs_neither_flag_nor_model(env):
    env.setenv("DECISION_BACKEND", "systemone")
    env.setenv("DECISION_MODEL", D3)
    s = load_settings()
    assert (s.model, s.systemone_model, s.systemone_enabled) == (D3, D3, False)
    assert "systemone" in app_module.backends_available(s)


def test_systemone_model_is_the_default_model_for_the_systemone_backend(env):
    env.setenv("DECISION_BACKEND", "systemone")
    env.setenv("DECISION_SYSTEMONE_MODEL", D3)
    s = load_settings()
    assert (s.model, s.systemone_model) == (D3, D3)


def test_per_backend_thresholds(env):
    env.setenv("DECISION_THRESHOLD_BEDROCK_OPENAI", "0.89")
    env.setenv("DECISION_THRESHOLD_SYSTEMONE", "0.56")
    env.setenv("DECISION_THRESHOLD_GEMINI_DECISION", " ")
    assert load_settings().thresholds == {"bedrock_openai": 0.89, "systemone": 0.56}


@pytest.mark.parametrize(
    ("value", "match"),
    [
        ("1.5", "DECISION_THRESHOLD_BEDROCK must be between 0 and 1"),
        ("-0.1", "DECISION_THRESHOLD_BEDROCK must be between 0 and 1"),
        ("high", "DECISION_THRESHOLD_BEDROCK must be a number between 0 and 1"),
    ],
)
def test_per_backend_threshold_out_of_range_refused(env, value, match):
    env.setenv("DECISION_THRESHOLD_BEDROCK", value)
    with pytest.raises(ValueError, match=match):
        load_settings()


def test_a_threshold_for_no_backend_is_refused(env):
    env.setenv("DECISION_THRESHOLD_QWEN", "0.9")
    with pytest.raises(ValueError, match="DECISION_THRESHOLD_QWEN names no backend"):
        load_settings()


def test_a_backend_threshold_replaces_the_rule_and_an_unset_one_keeps_it():
    s = settings_for(
        confidence_threshold=0.6, min_lead=0.1, thresholds={"bedrock_openai": 0.89}
    )
    qwen = backend_settings(s, "bedrock_openai", QWEN)
    assert (qwen.confidence_threshold, qwen.min_lead) == (0.89, None)
    llama = default_settings(s)
    assert (llama.confidence_threshold, llama.min_lead) == (0.6, 0.1)


def test_fallbacks_per_primary(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("GEMINI_DECISION_API_KEY", "g-key")
    env.setenv(
        "DECISION_FALLBACKS", " gemini_decision:bedrock , Bedrock_OpenAI:bedrock,"
    )
    s = load_settings()
    assert s.fallbacks == {"gemini_decision": "bedrock", "bedrock_openai": "bedrock"}
    assert s.fallback_after_s == 2.0


def test_the_old_fallback_setting_is_the_default_backends_fallback(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    env.setenv("DECISION_FALLBACKS", "bedrock_openai:bedrock")
    assert load_settings().fallbacks == {"bedrock_openai": "bedrock"}


def test_bedrock_openai_can_be_a_fallback(env):
    env.setenv("DECISION_BACKEND", "gemini_decision")
    env.setenv("GEMINI_DECISION_API_KEY", "g-key")
    env.setenv("DECISION_FALLBACK_BACKEND", "bedrock_openai")
    s = load_settings()
    fb = fallback_settings(s, default_settings(s))
    assert fb is not None and (fb.backend, fb.model) == ("bedrock_openai", QWEN)


def test_fallback_timing_is_read_for_fallbacks_per_primary(env):
    env.setenv("GEMINI_DECISION_API_KEY", "g-key")
    env.setenv("DECISION_FALLBACKS", "gemini_decision:bedrock")
    env.setenv("DECISION_FALLBACK_AFTER_S", "0")
    with pytest.raises(ValueError, match="DECISION_FALLBACK_AFTER_S"):
        load_settings()
    env.setenv("DECISION_FALLBACK_AFTER_S", "1.5")
    env.setenv("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", "2")
    with pytest.raises(
        ValueError, match="DECISION_FALLBACK_CONFIDENCE_THRESHOLD must be between"
    ):
        load_settings()


@pytest.mark.parametrize(
    ("value", "match"),
    [
        ("gemini_decision", "entries are primary:fallback"),
        ("gemini_decision:", "entries are primary:fallback"),
        (":bedrock", "entries are primary:fallback"),
        ("vertex:bedrock", "'vertex' is not a backend"),
        ("gemini_decision:anthropic", "the fallback must be one of"),
        ("gemini_decision:gemini_decision", "the fallback must be one of"),
        ("bedrock:bedrock", "a fallback must be another backend"),
        (
            "gemini_decision:bedrock,gemini_decision:bedrock_openai",
            "names gemini_decision twice",
        ),
        ("bedrock_openai:bedrock", "neither DECISION_BACKEND nor enabled per request"),
        ("systemone:bedrock", "neither DECISION_BACKEND nor enabled per request"),
        ("ollama:bedrock", "neither DECISION_BACKEND nor enabled per request"),
    ],
)
def test_bad_fallbacks_are_refused(env, value, match):
    env.setenv("DECISION_FALLBACKS", value)
    with pytest.raises(ValueError, match=match):
        load_settings()


def test_the_old_and_new_fallback_settings_must_agree(env):
    env.setenv("DECISION_BACKEND", "bedrock_openai")
    env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    env.setenv("DECISION_FALLBACKS", "bedrock_openai:bedrock_openai")
    with pytest.raises(ValueError, match="disagree"):
        load_settings()


def test_a_fallback_for_an_enabled_backend_is_accepted(env):
    env.setenv("DECISION_BEDROCK_ENABLED", "1")
    env.setenv("DECISION_FALLBACKS", "bedrock:bedrock_openai")
    assert load_settings().fallbacks == {"bedrock": "bedrock_openai"}


def test_the_fallback_threshold_order():
    """DECISION_FALLBACK_CONFIDENCE_THRESHOLD, else the fallback backend's own
    threshold, else the primary's rule."""
    base = dict(
        backend="gemini_decision",
        model="gemini-decision-1",
        confidence_threshold=0.8,
        min_lead=0.1,
        fallbacks={"gemini_decision": "bedrock"},
    )
    s = settings_for(**base)
    fb = fallback_settings(s, default_settings(s))
    assert fb is not None and (fb.confidence_threshold, fb.min_lead) == (0.8, 0.1)
    s = settings_for(**base, thresholds={"bedrock": 0.65})
    fb = fallback_settings(s, default_settings(s))
    assert fb is not None and (fb.confidence_threshold, fb.min_lead) == (0.65, None)
    s = settings_for(
        **base, thresholds={"bedrock": 0.65}, fallback_confidence_threshold=0.7
    )
    fb = fallback_settings(s, default_settings(s))
    assert fb is not None and (fb.confidence_threshold, fb.min_lead) == (0.7, None)


# ── the bedrock_openai backend ──────────────────────────────────────────────


def _openai_answer(top: list[tuple[str, float]], finish: str = "length") -> dict:
    return {
        "id": "x",
        "object": "chat.completion",
        "model": QWEN,
        "choices": [
            {
                "index": 0,
                "finish_reason": finish,
                "message": {"role": "assistant", "content": top[0][0] if top else ""},
                "logprobs": {
                    "content": [
                        {
                            "token": top[0][0] if top else "",
                            "logprob": top[0][1] if top else 0.0,
                            "top_logprobs": [
                                {"token": t, "logprob": lp} for t, lp in top
                            ],
                        }
                    ]
                },
            }
        ],
        "usage": {"prompt_tokens": 900, "completion_tokens": 1},
    }


class FakeInvoke:
    """A bedrock-runtime client that answers InvokeModel with `outcome` (a
    body dict, raw bytes, or an exception) and records each call and the thread
    it was made on."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.calls: list[dict] = []
        self.threads: list[str] = []

    def invoke_model(self, **kw):
        self.calls.append(kw)
        self.threads.append(threading.current_thread().name)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        raw = (
            self.outcome
            if isinstance(self.outcome, bytes)
            else json.dumps(self.outcome).encode()
        )
        return {"body": io.BytesIO(raw)}


def _qwen_settings(**kw):
    base = dict(
        backend="bedrock_openai",
        model=QWEN,
        bedrock_openai_model=QWEN,
        bedrock_openai_region="eu-central-1",
        confidence_threshold=0.6,
        thresholds={"bedrock_openai": 0.89},
    )
    base.update(kw)
    return settings_for(**base)


@pytest.fixture
def fake_qwen(monkeypatch):
    def install(outcome) -> FakeInvoke:
        fake = FakeInvoke(outcome)
        made_on: list[str] = []

        def client(settings):
            made_on.append(threading.current_thread().name)
            return fake

        monkeypatch.setattr(backends, "bedrock_openai_client", client)
        fake.made_on = made_on  # type: ignore[attr-defined]
        return fake

    return install


def test_bedrock_openai_asks_invoke_model_for_letter_logprobs(make_client, fake_qwen):
    # A is deploy-bot, B billing-bot, N none.
    fake = fake_qwen(_openai_answer([("A", -0.05), ("N", -3.2), ("B", -4.0)]))
    body = make_client(_qwen_settings()).post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["model"]) == (
        "deploy-bot",
        "bedrock_openai",
        QWEN,
    )
    assert body["threshold"] == 0.89 and body["rule"] == "threshold"
    assert body["confidence"] > 0.9 and body["lead"] is not None
    assert body["reason"].startswith("probabilities: deploy-bot=")
    [call] = fake.calls
    assert (call["modelId"], call["contentType"], call["accept"]) == (
        QWEN,
        "application/json",
        "application/json",
    )
    sent = json.loads(call["body"])
    assert {k: v for k, v in sent.items() if k != "messages"} == {
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": 20,
    }
    assert [m["role"] for m in sent["messages"]] == ["system", "user"]
    user = sent["messages"][1]["content"]
    assert "A) deploy-bot" in user and "B) billing-bot" in user and "N) none" in user


def test_bedrock_openai_client_is_made_off_the_event_loop(make_client, fake_qwen):
    fake = fake_qwen(_openai_answer([("B", -0.01)]))
    make_client(_qwen_settings()).post("/decide", json=BODY)
    loop_thread = threading.main_thread().name
    assert fake.made_on and all(t != loop_thread for t in fake.made_on)  # type: ignore[attr-defined]
    assert all(t != loop_thread for t in fake.threads)


def test_bedrock_openai_threshold_turns_down_an_unsure_pick(make_client, fake_qwen):
    fake_qwen(_openai_answer([("A", -0.3), ("N", -1.4)]))
    body = make_client(_qwen_settings()).post("/decide", json=BODY).json()
    assert (body["agent"], body["model_choice"], body["threshold"]) == (
        None,
        "deploy-bot",
        0.89,
    )
    assert 0.7 < body["confidence"] < 0.89


def test_bedrock_openai_uses_its_own_region(monkeypatch):
    regions: list[str] = []

    class Session:
        def __init__(self, profile_name=None, region_name=None):
            regions.append(region_name)

        def client(self, *a, **kw):
            return object()

    monkeypatch.setattr(backends.boto3, "Session", Session)
    monkeypatch.setattr(backends, "_aws_clients", {})
    s = _qwen_settings(aws_region="eu-west-3", bedrock_openai_region="eu-central-1")
    backends.bedrock_openai_client(s)
    backends.bedrock_client(s)
    assert regions == ["eu-central-1", "eu-west-3"]


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": SECRET_TEXT}}, "InvokeModel")


@pytest.mark.parametrize(
    ("outcome", "kind"),
    [
        (NoCredentialsError(), "credentials_missing"),
        (
            EndpointConnectionError(endpoint_url="https://bedrock.test"),
            "model_server_unreachable",
        ),
        (ReadTimeoutError(endpoint_url="https://bedrock.test"), "model_server_timeout"),
        (_client_error("AccessDeniedException"), "backend_refused"),
        (_client_error("ThrottlingException"), "backend_refused"),
        (_client_error("ResourceNotFoundException"), "model_unavailable"),
        (_client_error("ModelNotReadyException"), "model_unavailable"),
        (_client_error("ModelTimeoutException"), "model_server_timeout"),
        (_client_error("ValidationException"), "model_server_error"),
        (_client_error("InternalServerException"), "model_server_error"),
        (b"<html>not json</html>", "model_server_error"),
        ({"choices": [{"finish_reason": "stop"}]}, "model_server_error"),
        (_openai_answer([("Hello", -0.01)]), "model_server_error"),
        (_openai_answer([], finish="content_filter"), "backend_refused"),
    ],
    ids=[
        "no-credentials",
        "unreachable",
        "read-timeout",
        "access-denied",
        "throttled",
        "model-not-found",
        "model-not-ready",
        "model-timeout",
        "validation",
        "internal",
        "not-json",
        "no-logprobs",
        "no-option-letter",
        "content-filter",
    ],
)
def test_bedrock_openai_failure_kinds(make_client, fake_qwen, caplog, outcome, kind):
    fake_qwen(outcome)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        r = make_client(_qwen_settings()).post("/decide", json=BODY)
    assert r.status_code == 502, r.text
    assert r.json()["error_kind"] == kind and kind in ERROR_KINDS
    # The error body (here the room's text) never reaches the log.
    assert SECRET_TEXT not in caplog.text


def test_more_agents_than_letters_is_a_classified_failure(make_client, fake_qwen):
    fake = fake_qwen(_openai_answer([("A", -0.01)]))
    agents = [{"name": f"bot-{i}", "description": "d"} for i in range(14)]
    r = make_client(_qwen_settings()).post("/decide", json={**BODY, "agents": agents})
    assert r.status_code == 502
    assert r.json()["error_kind"] == "model_server_error"
    assert "at most 13 agents" in r.json()["detail"]
    assert fake.calls == []


def test_llamacpp_keeps_its_thinking_switch_and_twenty_logprobs(make_client):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=_openai_answer([("A", -0.01)]))

    make_client(settings_for(), handler=handler).post("/decide", json=BODY)
    [sent] = seen
    assert sent["top_logprobs"] == 20
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}


# ── per-request bedrock_openai and systemone ────────────────────────────────


def test_bedrock_openai_per_request_needs_its_flag(make_client, fake_qwen):
    fake = fake_qwen(_openai_answer([("A", -0.01)]))
    r = make_client(settings_for()).post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "bedrock_openai"}
    )
    assert r.status_code == 400 and r.json()["code"] == "backend_unavailable"
    assert "DECISION_BEDROCK_OPENAI_ENABLED" in r.json()["detail"]
    assert fake.calls == []


def test_bedrock_openai_per_request_when_enabled(make_client, fake_qwen):
    fake = fake_qwen(_openai_answer([("B", -0.01)]))
    tc = make_client(
        settings_for(
            bedrock_openai_enabled=True,
            bedrock_openai_model=QWEN,
            thresholds={"bedrock_openai": 0.89},
        )
    )
    body = tc.post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "bedrock_openai"}
    ).json()
    assert (body["agent"], body["backend"], body["model"], body["threshold"]) == (
        "billing-bot",
        "bedrock_openai",
        QWEN,
        0.89,
    )
    assert fake.calls[0]["modelId"] == QWEN
    other = tc.post(
        "/decide",
        json=BODY,
        headers={
            "X-Decision-Backend": "bedrock_openai",
            "X-Decision-Model": "qwen.qwen3-32b-v1:0",
        },
    ).json()
    assert other["model"] == "qwen.qwen3-32b-v1:0"


def test_the_default_backend_can_be_named_without_its_flag(make_client, fake_qwen):
    fake_qwen(_openai_answer([("A", -0.01)]))
    r = make_client(_qwen_settings()).post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "bedrock_openai"}
    )
    assert r.status_code == 200 and r.json()["backend"] == "bedrock_openai"


def _systemone_answer(choice: str, probabilities: dict) -> dict:
    return {"answers": {"speaker": {"choice": choice, "probabilities": probabilities}}}


def test_systemone_per_request_needs_its_flag(make_client):
    r = make_client(_qwen_settings(systemone_url=SYSTEMONE_URL)).post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "systemone"}
    )
    assert r.status_code == 400 and r.json()["code"] == "backend_unavailable"
    assert "DECISION_SYSTEMONE_ENABLED" in r.json()["detail"]


def test_systemone_per_request_when_enabled(make_client):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=_systemone_answer(
                "billing-bot", {"billing-bot": 0.6, "deploy-bot": 0.1, "none": 0.3}
            ),
        )

    tc = make_client(
        _qwen_settings(
            systemone_url=SYSTEMONE_URL,
            systemone_enabled=True,
            systemone_model=D3,
            model_server_token="model-token",
            thresholds={"bedrock_openai": 0.89, "systemone": 0.56},
        ),
        handler=handler,
    )
    body = tc.post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "systemone"}
    ).json()
    assert (body["agent"], body["backend"], body["model"], body["threshold"]) == (
        "billing-bot",
        "systemone",
        D3,
        0.56,
    )
    [request] = seen
    assert str(request.url) == SYSTEMONE_URL
    assert json.loads(request.content)["model"] == D3
    assert request.headers["authorization"] == "Bearer model-token"


def test_unknown_backend_lists_the_new_ones(make_client):
    tc = make_client(
        _qwen_settings(systemone_enabled=True, systemone_model=D3, bedrock_enabled=True)
    )
    r = tc.post("/decide", json=BODY, headers={"X-Decision-Backend": "vertex"})
    assert r.status_code == 400
    assert "bedrock_openai" in r.json()["detail"] and "systemone" in r.json()["detail"]


# ── thresholds by the backend that answered ─────────────────────────────────


@pytest.fixture
def plan(monkeypatch):
    """Stands in for `ask`: each backend answers (or fails) after its delay."""
    calls: list[tuple[str, str]] = []
    plan: dict[str, tuple[float, ModelAnswer | Exception]] = {}

    async def fake_ask(client, settings, req, api_key=None):
        calls.append((settings.backend, settings.model))
        delay, result = plan[settings.backend]
        await asyncio.sleep(delay)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(app_module, "ask", fake_ask)
    return plan, calls


ALL = dict(
    backend="bedrock_openai",
    model=QWEN,
    bedrock_openai_model=QWEN,
    confidence_threshold=0.6,
    min_lead=None,
    systemone_url=SYSTEMONE_URL,
    systemone_enabled=True,
    systemone_model=D3,
    gemini_decision_api_key=GEMINI_KEY,
    bedrock_enabled=True,
    bedrock_model=HAIKU_MODEL,
    aws_region="eu-west-3",
    thresholds={
        "bedrock_openai": 0.89,
        "systemone": 0.56,
        "gemini_decision": 0.80,
        "bedrock": 0.65,
        "anthropic": 0.65,
    },
    fallbacks={"gemini_decision": "bedrock"},
    fallback_after_s=0.05,
)


@pytest.mark.parametrize(
    ("header", "backend", "threshold"),
    [
        (None, "bedrock_openai", 0.89),
        ("systemone", "systemone", 0.56),
        ("bedrock", "bedrock", 0.65),
        ("bedrock_openai", "bedrock_openai", 0.89),
    ],
)
def test_each_backend_is_held_to_its_own_threshold(
    make_client, plan, header, backend, threshold
):
    answers, _ = plan
    answers[backend] = (0.0, ModelAnswer("deploy-bot", 0.7, "", runner_up=0.2))
    headers = {"X-Decision-Backend": header} if header else {}
    body = (
        make_client(settings_for(**ALL))
        .post("/decide", json=BODY, headers=headers)
        .json()
    )
    assert (body["backend"], body["threshold"]) == (backend, threshold)
    assert body["agent"] == ("deploy-bot" if threshold <= 0.7 else None)


def test_a_backend_without_its_own_threshold_keeps_the_service_rule(make_client, plan):
    answers, _ = plan
    answers["systemone"] = (0.0, ModelAnswer("deploy-bot", 0.45, "", runner_up=0.3))
    tc = make_client(settings_for(**{**ALL, "thresholds": {}, "min_lead": 0.1}))
    body = tc.post(
        "/decide", json=BODY, headers={"X-Decision-Backend": "systemone"}
    ).json()
    assert (body["agent"], body["rule"], body["threshold"]) == (
        "deploy-bot",
        "lead",
        0.6,
    )


def test_a_request_threshold_wins_over_every_backend_threshold(make_client, plan):
    answers, _ = plan
    answers["systemone"] = (0.0, ModelAnswer("deploy-bot", 0.6, "", runner_up=0.2))
    body = (
        make_client(settings_for(**ALL))
        .post(
            "/decide",
            json={**BODY, "confidence_threshold": 0.7},
            headers={"X-Decision-Backend": "systemone"},
        )
        .json()
    )
    assert (body["agent"], body["threshold"]) == (None, 0.7)


def test_a_per_request_gemini_falls_back_to_haiku_held_to_haikus_threshold(
    make_client, plan, caplog
):
    answers, calls = plan
    answers["gemini_decision"] = (1.0, ModelAnswer("deploy-bot", 0.95, ""))
    answers["bedrock"] = (0.0, ModelAnswer("billing-bot", 0.7, "invoices"))
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = (
            make_client(settings_for(**ALL))
            .post(
                "/decide", json=BODY, headers={"X-Decision-Backend": "gemini_decision"}
            )
            .json()
        )
    assert (body["agent"], body["backend"], body["model"], body["threshold"]) == (
        "billing-bot",
        "bedrock",
        HAIKU_MODEL,
        0.65,
    )
    assert calls == [("gemini_decision", "gemini-decision-1"), ("bedrock", HAIKU_MODEL)]
    [line] = [r for r in caplog.records if r.getMessage().startswith("decide ")]
    assert "backend=bedrock" in line.getMessage()
    assert "threshold=0.65 picked=billing-bot" in line.getMessage()
    assert "fallback=won fallback_reason=slow" in line.getMessage()


def test_a_gemini_answer_in_time_is_held_to_geminis_threshold(make_client, plan):
    answers, calls = plan
    answers["gemini_decision"] = (
        0.0,
        ModelAnswer("deploy-bot", 0.75, "", runner_up=0.1),
    )
    body = (
        make_client(settings_for(**{**ALL, "fallback_after_s": 1.0}))
        .post("/decide", json=BODY, headers={"X-Decision-Backend": "gemini_decision"})
        .json()
    )
    assert (body["agent"], body["backend"], body["threshold"]) == (
        None,
        "gemini_decision",
        0.8,
    )
    assert len(calls) == 1


def test_the_default_backends_fallback_through_the_real_backends(
    make_client, fake_qwen, monkeypatch
):
    """A slow Qwen on Bedrock, with Haiku on a stand-in Converse client."""

    class SlowInvoke(FakeInvoke):
        def invoke_model(self, **kw):
            threading.Event().wait(1.0)
            return super().invoke_model(**kw)

    slow = SlowInvoke(_openai_answer([("A", -0.01)]))
    monkeypatch.setattr(backends, "bedrock_openai_client", lambda s: slow)

    class Haiku:
        def converse(self, **kw):
            pick = {"reason": "r", "agent": "billing-bot", "confidence": 0.7}
            return {
                "output": {
                    "message": {
                        "content": [
                            {"toolUse": {"name": "pick_speaker", "input": pick}}
                        ]
                    }
                }
            }

    monkeypatch.setattr(backends, "bedrock_client", lambda s: Haiku())
    s = settings_for(**{**ALL, "fallbacks": {"bedrock_openai": "bedrock"}})
    body = make_client(s).post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["threshold"]) == (
        "billing-bot",
        "bedrock",
        0.65,
    )


# ── /health ─────────────────────────────────────────────────────────────────


def test_health_lists_every_backend_a_request_may_name(make_client, monkeypatch):
    async def creds(client, settings):
        return {"status": "credentials found", "region": "eu-central-1"}

    monkeypatch.setattr(app_module, "check", creds)
    s = settings_for(**{**ALL, "fallback_after_s": 2.0})
    body = make_client(s).get("/health").json()
    assert body["backends_available"] == [
        "default",
        "anthropic",
        "bedrock",
        "gemini_decision",
        "bedrock_openai",
        "systemone",
    ]
    assert list(body["backends"]) == body["backends_available"]
    qwen = {
        "backend": "bedrock_openai",
        "model": QWEN,
        "label": "Qwen3 235B (Bedrock)",
        "threshold": 0.89,
        "fallback": None,
    }
    assert body["backends"] == {
        "default": {**qwen, "is_default": True},
        "anthropic": {
            "backend": "anthropic",
            "model": "claude-haiku-5-5",
            "label": "Claude Haiku (Anthropic)",
            "threshold": 0.65,
            "fallback": None,
        },
        "bedrock": {
            "backend": "bedrock",
            "model": HAIKU_MODEL,
            "label": "Claude Haiku (Bedrock)",
            "threshold": 0.65,
            "fallback": None,
        },
        "gemini_decision": {
            "backend": "gemini_decision",
            "model": "gemini-decision-1",
            "label": "Gemini (gemini-decision-1)",
            "threshold": 0.8,
            "fallback": {"backend": "bedrock", "model": HAIKU_MODEL, "after_s": 2.0},
        },
        "bedrock_openai": qwen,
        "systemone": {
            "backend": "systemone",
            "model": D3,
            "label": "vllm-sr d3-mini (self-hosted)",
            "threshold": 0.56,
            "fallback": None,
        },
    }
    # The fields from before keep describing the default backend.
    assert (body["backend"], body["model"], body["confidence_threshold"]) == (
        "bedrock_openai",
        QWEN,
        0.89,
    )
    assert body["model_server"] == "bedrock:eu-central-1"
    assert body["fallback_backend"] is None


def test_health_names_the_default_backends_fallback(make_client, monkeypatch):
    async def ok(client, settings):
        return {"status": "api key set"}

    monkeypatch.setattr(app_module, "check", ok)
    s = settings_for(
        backend="gemini_decision",
        model="gemini-decision-1",
        gemini_decision_api_key=GEMINI_KEY,
        bedrock_openai_model=QWEN,
        fallbacks={"gemini_decision": "bedrock_openai"},
        fallback_after_s=2.0,
        thresholds={"bedrock_openai": 0.89},
    )
    body = make_client(s).get("/health").json()
    assert body["backends_available"] == ["default", "anthropic", "gemini_decision"]
    fallback = {"backend": "bedrock_openai", "model": QWEN, "after_s": 2.0}
    assert body["backends"]["default"]["fallback"] == fallback
    assert body["backends"]["gemini_decision"]["fallback"] == fallback
    assert body["backends"]["default"]["is_default"] is True
    assert "is_default" not in body["backends"]["gemini_decision"]
    assert (body["fallback_backend"], body["fallback_model"]) == (
        "bedrock_openai",
        QWEN,
    )


def test_a_model_without_a_label_is_labelled_by_its_id(make_client):
    body = make_client(settings_for()).get("/health").json()
    assert body["backends"]["default"]["label"] == "qwen3.5-4b-q4_k_m"
    assert app_module.backend_label("bedrock_openai", "qwen.qwen3-32b-v1:0") == (
        "qwen.qwen3-32b-v1:0"
    )
    assert app_module.backend_label("systemone", "strands-decider-E4B") == (
        "strands-decider-E4B"
    )


@pytest.mark.parametrize(
    ("backend", "kw"),
    [
        ("systemone", {"systemone_url": SYSTEMONE_URL, "model": D3}),
        ("llamacpp", {}),
    ],
)
@pytest.mark.parametrize("content", [b"", b"  ", b"OK"])
def test_a_model_server_health_with_no_json_body_is_healthy(
    make_client, backend, kw, content
):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=content)

    r = make_client(settings_for(backend=backend, **kw), handler=handler).get("/health")
    assert r.status_code == 200, r.text
    assert r.json()["model_server_status"]["status"] == "ok"
    assert seen[0].endswith("/health")


def test_a_model_server_health_error_is_still_unhealthy(make_client):
    r = make_client(
        settings_for(backend="systemone", systemone_url=SYSTEMONE_URL, model=D3),
        handler=lambda request: httpx.Response(503, content=b""),
    ).get("/health")
    assert r.status_code == 503 and "http://d3.test/health" in r.json()["detail"]


def test_bedrock_openai_health_checks_credentials_in_its_region(
    make_client, monkeypatch
):
    class Session:
        def __init__(self, profile_name=None, region_name=None):
            pass

        def get_credentials(self):
            return object()

    monkeypatch.setattr(backends.boto3, "Session", Session)
    body = make_client(_qwen_settings(aws_region="eu-west-3")).get("/health").json()
    assert body["model_server_status"] == {
        "status": "credentials found",
        "region": "eu-central-1",
    }

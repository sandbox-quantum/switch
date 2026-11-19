"""The fallback race: the default backend first, the fallback after a delay or a failure."""

import asyncio
import logging
import time

import httpx
import pytest

from switch_decision import app as app_module
from switch_decision import backends
from switch_decision.backends import InvalidChoiceError, ModelAnswer, ModelServerError
from switch_decision.config import Settings, fallback_settings, load_settings
from switch_decision.fallback import BothFailed, race
from tests.helpers import BODY, GEMINI_KEY, SECRETS, settings_for

GEMINI = ModelAnswer(choice="deploy-bot", confidence=0.9, reason="", runner_up=0.05)
HAIKU = ModelAnswer(choice="billing-bot", confidence=0.85, reason="invoices")
HAIKU_MODEL = "eu.anthropic.claude-haiku-5-5"


class Fake:
    """A backend call that answers or fails after a delay, and records whether
    it started, finished or was cancelled."""

    def __init__(self, delay: float, result: ModelAnswer | Exception):
        self.delay, self.result = delay, result
        self.started_at: float | None = None
        self.cancelled = False
        self.finished = False

    async def __call__(self) -> ModelAnswer:
        self.started_at = time.monotonic()
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        self.finished = True
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _error(kind="model_server_timeout", text="Decisions API returned 504"):
    return ModelServerError(text, kind=kind)


def _race(primary: Fake, fallback: Fake | None, after_s: float = 0.05):
    async def run():
        began = time.monotonic()
        raced = await race(primary, fallback, after_s)
        # Let a cancelled call see its cancellation before the loop closes.
        await asyncio.sleep(0.01)
        return raced, began

    return asyncio.run(run())


# ── the race itself ─────────────────────────────────────────────────────────


def test_a_fast_primary_never_starts_the_fallback():
    primary, fallback = Fake(0.0, GEMINI), Fake(0.0, HAIKU)
    raced, _ = _race(primary, fallback, after_s=0.2)
    assert raced.answer is GEMINI and not raced.by_fallback
    assert (raced.outcome, raced.reason) == ("not_needed", None)
    assert fallback.started_at is None


def test_a_slow_primary_loses_to_the_fallback_and_is_cancelled():
    primary, fallback = Fake(1.0, GEMINI), Fake(0.05, HAIKU)
    raced, began = _race(primary, fallback, after_s=0.05)
    assert raced.answer is HAIKU and raced.by_fallback
    assert (raced.outcome, raced.reason) == ("won", "slow")
    assert fallback.started_at is not None and fallback.started_at - began >= 0.05
    assert primary.cancelled and not primary.finished
    # The answering call's own time, not the whole decision's.
    assert 0.04 <= raced.seconds < 0.5


def test_a_slow_primary_that_answers_before_the_fallback_wins():
    primary, fallback = Fake(0.15, GEMINI), Fake(1.0, HAIKU)
    raced, _ = _race(primary, fallback, after_s=0.05)
    assert raced.answer is GEMINI and not raced.by_fallback
    assert (raced.outcome, raced.reason) == ("lost", "slow")
    assert fallback.started_at is not None and fallback.cancelled


def test_a_failing_primary_starts_the_fallback_at_once():
    primary = Fake(0.0, _error("model_server_error", "Decisions API returned 500"))
    fallback = Fake(0.0, HAIKU)
    raced, began = _race(primary, fallback, after_s=5.0)
    assert fallback.started_at is not None and fallback.started_at - began < 1.0
    assert raced.answer is HAIKU and raced.by_fallback
    assert (raced.outcome, raced.reason) == ("primary_failed", "model_server_error")
    assert raced.primary_error is primary.result


def test_a_slow_primary_that_then_fails_leaves_the_fallback_answer():
    primary, fallback = Fake(0.1, _error()), Fake(0.3, HAIKU)
    raced, _ = _race(primary, fallback, after_s=0.05)
    assert raced.answer is HAIKU
    assert (raced.outcome, raced.reason) == ("primary_failed", "slow")


def test_a_failed_fallback_waits_for_the_primary():
    primary = Fake(0.2, GEMINI)
    fallback = Fake(0.0, _error("credentials_missing", "AWS credentials missing"))
    raced, _ = _race(primary, fallback, after_s=0.05)
    assert raced.answer is GEMINI
    assert (raced.outcome, raced.reason) == ("lost", "slow")
    assert raced.fallback_error is fallback.result


def test_both_failing_raises_the_primary_error_with_the_fallback_one():
    primary, fallback = Fake(0.1, _error()), Fake(0.0, _error("credentials_missing"))
    with pytest.raises(BothFailed) as caught:
        _race(primary, fallback, after_s=0.05)
    assert caught.value.primary_error is primary.result
    assert caught.value.fallback_error is fallback.result
    assert caught.value.reason == "slow"
    assert str(caught.value) == str(primary.result)


def test_naming_no_candidate_is_an_answer_not_a_failure():
    invalid = InvalidChoiceError("ghost-bot", 0.9)
    primary, fallback = Fake(0.0, invalid), Fake(0.0, HAIKU)
    raced, _ = _race(primary, fallback, after_s=0.2)
    assert raced.answer is invalid and raced.outcome == "not_needed"
    assert fallback.started_at is None


def test_a_slow_invalid_choice_still_beats_a_slower_fallback():
    invalid = InvalidChoiceError("ghost-bot", 0.9)
    primary, fallback = Fake(0.1, invalid), Fake(1.0, HAIKU)
    raced, _ = _race(primary, fallback, after_s=0.05)
    assert raced.answer is invalid and raced.outcome == "lost"
    assert fallback.cancelled


def test_without_a_fallback_the_primary_answers_or_raises():
    raced, _ = _race(Fake(0.0, GEMINI), None)
    assert raced.answer is GEMINI and raced.outcome is None
    error = _error()
    with pytest.raises(ModelServerError) as caught:
        _race(Fake(0.0, error), None)
    assert caught.value is error


def test_an_unexpected_error_is_raised_and_cancels_the_other_call():
    primary, fallback = Fake(1.0, GEMINI), Fake(0.0, RuntimeError("bug"))
    with pytest.raises(RuntimeError, match="bug"):
        _race(primary, fallback, after_s=0.05)
    assert primary.cancelled


# ── settings ────────────────────────────────────────────────────────────────


@pytest.fixture
def gemini_env(monkeypatch):
    monkeypatch.setenv("DECISION_BACKEND", "gemini_decision")
    monkeypatch.setenv("GEMINI_DECISION_API_KEY", "g-key")
    for k in (
        "DECISION_MODEL",
        "DECISION_FALLBACK_BACKEND",
        "DECISION_FALLBACK_AFTER_S",
        "DECISION_FALLBACK_CONFIDENCE_THRESHOLD",
        "DECISION_CONFIDENCE_THRESHOLD",
        "DECISION_MIN_LEAD",
        "DECISION_TIMEOUT_S",
        "DECISION_BEDROCK_ENABLED",
        "DECISION_BEDROCK_MODEL",
        "AWS_REGION",
    ):
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_no_fallback_by_default(gemini_env):
    s = load_settings()
    assert s.fallback_backend is None and fallback_settings(s) is None


def test_bedrock_fallback_needs_no_bedrock_override_flag(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "Bedrock")
    gemini_env.setenv("DECISION_BEDROCK_MODEL", HAIKU_MODEL)
    gemini_env.setenv("AWS_REGION", "eu-west-3")
    s = load_settings()
    assert (s.fallback_backend, s.fallback_after_s, s.bedrock_enabled) == (
        "bedrock",
        2.0,
        False,
    )
    assert app_module.backends_available(s) == [
        "default",
        "anthropic",
        "gemini_decision",
    ]
    fb = fallback_settings(s)
    assert fb is not None
    assert (fb.backend, fb.model, fb.aws_region) == (
        "bedrock",
        HAIKU_MODEL,
        "eu-west-3",
    )
    assert (s.backend, s.model) == ("gemini_decision", "gemini-decision-1")


def test_fallback_delay_setting(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    gemini_env.setenv("DECISION_FALLBACK_AFTER_S", "1.5")
    assert load_settings().fallback_after_s == 1.5


@pytest.mark.parametrize("value", ["anthropic", "vertex", "gemini_decision"])
def test_unsupported_fallback_backend_refused(gemini_env, value):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", value)
    with pytest.raises(ValueError, match="DECISION_FALLBACK_BACKEND"):
        load_settings()


def test_fallback_same_as_primary_refused(gemini_env):
    gemini_env.setenv("DECISION_BACKEND", "bedrock")
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    with pytest.raises(ValueError, match="another backend"):
        load_settings()


@pytest.mark.parametrize("value", ["0", "-1", "5", "6"])
def test_fallback_delay_out_of_range_refused(gemini_env, value):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    gemini_env.setenv("DECISION_TIMEOUT_S", "5")
    gemini_env.setenv("DECISION_FALLBACK_AFTER_S", value)
    with pytest.raises(ValueError, match="DECISION_FALLBACK_AFTER_S"):
        load_settings()


def test_fallback_delay_is_not_read_without_a_fallback(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_AFTER_S", "0")
    assert load_settings().fallback_backend is None


# ── through /decide and /health ─────────────────────────────────────────────


def _settings(**kw) -> Settings:
    base: dict = dict(
        backend="gemini_decision",
        model="gemini-decision-1",
        gemini_decision_api_key=GEMINI_KEY,
        gemini_decision_url="https://decisions.test/v1beta/decisions",
        confidence_threshold=0.8,
        bedrock_model=HAIKU_MODEL,
        aws_region="eu-west-3",
        fallback_backend="bedrock",
        fallback_after_s=0.05,
    )
    base.update(kw)
    return settings_for(**base)


@pytest.fixture
def backends_by_name(monkeypatch):
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


def _decide_lines(caplog) -> list[logging.LogRecord]:
    return [
        r
        for r in caplog.records
        if r.name == "switch_decision" and r.getMessage().startswith("decide ")
    ]


def test_primary_answers_in_time(make_client, backends_by_name, caplog):
    plan, calls = backends_by_name
    plan["gemini_decision"] = (0.0, GEMINI)
    tc = make_client(_settings(fallback_after_s=1.0))
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = tc.post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["model"]) == (
        "deploy-bot",
        "gemini_decision",
        "gemini-decision-1",
    )
    assert calls == [("gemini_decision", "gemini-decision-1")]
    [line] = _decide_lines(caplog)
    assert line.levelno == logging.INFO
    message = line.getMessage()
    assert "backend=gemini_decision" in message
    assert "fallback=not_needed fallback_reason=- total_ms=" in message


def test_fallback_answers_for_a_slow_primary(make_client, backends_by_name, caplog):
    plan, calls = backends_by_name
    plan["gemini_decision"] = (1.0, GEMINI)
    plan["bedrock"] = (0.05, HAIKU)
    tc = make_client(_settings())
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = tc.post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["model"]) == (
        "billing-bot",
        "bedrock",
        HAIKU_MODEL,
    )
    assert body["reason"] == "invoices" and body["rule"] == "threshold"
    # Haiku's own time, not the delay before it started.
    assert 40 <= body["latency_ms"] < 500
    assert calls == [
        ("gemini_decision", "gemini-decision-1"),
        ("bedrock", HAIKU_MODEL),
    ]
    [line] = _decide_lines(caplog)
    message = line.getMessage()
    assert line.levelno == logging.INFO
    assert f"backend=bedrock model={HAIKU_MODEL}" in message
    assert "fallback=won fallback_reason=slow" in message
    total = int(message.split("total_ms=")[1].split()[0])
    assert total >= 100 and total >= body["latency_ms"]


def test_the_one_threshold_applies_to_the_fallback(make_client, backends_by_name):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (1.0, GEMINI)
    plan["bedrock"] = (0.0, ModelAnswer("billing-bot", 0.7, "maybe"))
    body = make_client(_settings()).post("/decide", json=BODY).json()
    assert (body["agent"], body["model_choice"], body["threshold"]) == (
        None,
        "billing-bot",
        0.8,
    )
    assert body["backend"] == "bedrock"


def test_primary_answering_first_after_the_fallback_started(
    make_client, backends_by_name, caplog
):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (0.15, GEMINI)
    plan["bedrock"] = (1.0, HAIKU)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = make_client(_settings()).post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"]) == ("deploy-bot", "gemini_decision")
    [line] = _decide_lines(caplog)
    assert "fallback=lost fallback_reason=slow" in line.getMessage()


def test_failed_primary_is_named_when_the_fallback_answers(
    make_client, backends_by_name, caplog
):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (
        0.0,
        ModelServerError(
            f"Decisions API returned 500: {SECRETS[0]}",
            kind="model_server_error",
            log_text="Decisions API returned 500",
        ),
    )
    plan["bedrock"] = (0.0, HAIKU)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        r = make_client(_settings(fallback_after_s=1.0)).post("/decide", json=BODY)
    assert r.status_code == 200 and r.json()["backend"] == "bedrock"
    [line] = _decide_lines(caplog)
    message = line.getMessage()
    assert line.levelno == logging.WARNING
    assert "fallback=primary_failed fallback_reason=model_server_error" in message
    assert "primary_error=Decisions API returned 500" in message
    assert SECRETS[0] not in caplog.text


def test_failed_fallback_is_named_when_the_primary_answers(
    make_client, backends_by_name, caplog
):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (0.2, GEMINI)
    plan["bedrock"] = (
        0.0,
        ModelServerError("AWS credentials unavailable", kind="credentials_missing"),
    )
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = make_client(_settings()).post("/decide", json=BODY).json()
    assert body["backend"] == "gemini_decision"
    [line] = _decide_lines(caplog)
    message = line.getMessage()
    assert line.levelno == logging.WARNING
    assert "fallback=lost fallback_reason=slow" in message
    assert (
        "fallback_error_kind=credentials_missing "
        "fallback_error=AWS credentials unavailable"
    ) in message


def test_both_failing_is_the_primary_error(make_client, backends_by_name, caplog):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (0.1, _error())
    plan["bedrock"] = (0.0, ModelServerError("no AWS", kind="credentials_missing"))
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        r = make_client(_settings()).post("/decide", json=BODY)
    assert r.status_code == 502
    assert r.json() == {
        "detail": "Decisions API returned 504",
        "error_kind": "model_server_timeout",
    }
    [line] = _decide_lines(caplog)
    message = line.getMessage()
    assert line.levelno == logging.WARNING
    assert message.startswith(
        "decide failed backend=gemini_decision model=gemini-decision-1 "
    )
    assert "error_kind=model_server_timeout" in message
    assert (
        f"fallback=failed fallback_reason=slow fallback_backend=bedrock "
        f"fallback_model={HAIKU_MODEL} fallback_error_kind=credentials_missing "
        "fallback_error=no AWS total_ms="
    ) in message


def test_fallback_naming_no_candidate_is_nobody(make_client, backends_by_name, caplog):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (1.0, GEMINI)
    plan["bedrock"] = (0.0, InvalidChoiceError("ghost-bot", 0.9))
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = make_client(_settings()).post("/decide", json=BODY).json()
    assert (body["agent"], body["model_choice"], body["backend"]) == (
        None,
        "ghost-bot",
        "bedrock",
    )
    [line] = _decide_lines(caplog)
    assert line.levelno == logging.ERROR
    assert "decide invalid_choice backend=bedrock" in line.getMessage()
    assert "fallback=won fallback_reason=slow" in line.getMessage()


def test_a_request_that_chose_its_backend_gets_no_fallback(
    make_client, backends_by_name, caplog
):
    plan, calls = backends_by_name
    plan["gemini_decision"] = (0.2, GEMINI)
    plan["bedrock"] = (0.0, HAIKU)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = (
            make_client(_settings())
            .post(
                "/decide",
                json=BODY,
                headers={"X-Decision-Backend": "gemini_decision"},
            )
            .json()
        )
    assert body["backend"] == "gemini_decision"
    assert calls == [("gemini_decision", "gemini-decision-1")]
    [line] = _decide_lines(caplog)
    assert "fallback" not in line.getMessage()


def test_no_fallback_fields_when_it_is_off(make_client, backends_by_name, caplog):
    plan, calls = backends_by_name
    plan["gemini_decision"] = (0.1, GEMINI)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = (
            make_client(_settings(fallback_backend=None))
            .post("/decide", json=BODY)
            .json()
        )
    assert body["backend"] == "gemini_decision" and len(calls) == 1
    [line] = _decide_lines(caplog)
    assert "fallback" not in line.getMessage()
    assert "total_ms" not in line.getMessage()


def test_health_reports_the_fallback(make_client):
    tc = make_client(_settings(fallback_after_s=2.0))
    body = tc.get("/health").json()
    assert (
        body["fallback_backend"],
        body["fallback_model"],
        body["fallback_after_s"],
    ) == ("bedrock", HAIKU_MODEL, 2.0)
    assert (body["backend"], body["model"]) == ("gemini_decision", "gemini-decision-1")
    off = make_client(_settings(fallback_backend=None)).get("/health").json()
    assert (
        off["fallback_backend"],
        off["fallback_model"],
        off["fallback_after_s"],
    ) == (None, None, None)


def test_the_real_backends_race(make_client, monkeypatch, caplog):
    """Gemini over HTTP, slow; Haiku on a stand-in Bedrock client."""
    converse_calls: list[dict] = []

    class FakeBedrock:
        def converse(self, **kw):
            converse_calls.append(kw)
            pick = {"reason": "r", "agent": "billing-bot", "confidence": 0.9}
            return {
                "output": {
                    "message": {
                        "content": [
                            {"toolUse": {"name": "pick_speaker", "input": pick}}
                        ]
                    }
                }
            }

    async def slow_google(request):
        await asyncio.sleep(1.0)
        return httpx.Response(500)

    monkeypatch.setattr(backends, "bedrock_client", lambda s: FakeBedrock())
    tc = make_client(_settings(), handler=slow_google)
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = tc.post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["model"]) == (
        "billing-bot",
        "bedrock",
        HAIKU_MODEL,
    )
    assert converse_calls[0]["modelId"] == HAIKU_MODEL
    [line] = _decide_lines(caplog)
    assert "fallback=won fallback_reason=slow" in line.getMessage()


# ── the fallback's own threshold ────────────────────────────────────────────


def test_fallback_threshold_setting(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    assert load_settings().fallback_confidence_threshold is None
    gemini_env.setenv("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", "0.65")
    gemini_env.setenv("DECISION_MIN_LEAD", "0.1")
    s = load_settings()
    assert s.fallback_confidence_threshold == 0.65
    fb = fallback_settings(s)
    assert fb is not None
    assert (fb.confidence_threshold, fb.min_lead) == (0.65, None)
    assert (s.confidence_threshold, s.min_lead) == (0.6, 0.1)


def test_without_a_fallback_threshold_the_fallback_keeps_the_primary_rule(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    gemini_env.setenv("DECISION_CONFIDENCE_THRESHOLD", "0.8")
    gemini_env.setenv("DECISION_MIN_LEAD", "0.1")
    fb = fallback_settings(load_settings())
    assert fb is not None and (fb.confidence_threshold, fb.min_lead) == (0.8, 0.1)


@pytest.mark.parametrize("value", ["-0.1", "1.5"])
def test_fallback_threshold_out_of_range_refused(gemini_env, value):
    gemini_env.setenv("DECISION_FALLBACK_BACKEND", "bedrock")
    gemini_env.setenv("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", value)
    with pytest.raises(
        ValueError,
        match="DECISION_FALLBACK_CONFIDENCE_THRESHOLD must be between 0 and 1",
    ):
        load_settings()


def test_fallback_threshold_is_not_read_without_a_fallback(gemini_env):
    gemini_env.setenv("DECISION_FALLBACK_CONFIDENCE_THRESHOLD", "7")
    assert load_settings().fallback_confidence_threshold is None


def test_a_fallback_answer_is_held_to_the_fallback_threshold(
    make_client, backends_by_name, caplog
):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (1.0, GEMINI)
    # A runner-up too: the fallback's rule is the plain threshold, never the lead.
    plan["bedrock"] = (0.0, ModelAnswer("billing-bot", 0.7, "r", runner_up=0.65))
    tc = make_client(_settings(fallback_confidence_threshold=0.65, min_lead=0.1))
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = tc.post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["threshold"], body["rule"]) == (
        "billing-bot",
        "bedrock",
        0.65,
        "threshold",
    )
    assert body["min_lead"] is None
    [line] = _decide_lines(caplog)
    assert "threshold=0.65 picked=billing-bot" in line.getMessage()
    assert "rule=threshold" in line.getMessage()


def test_a_primary_answer_keeps_the_primary_rule(make_client, backends_by_name, caplog):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (0.0, ModelAnswer("deploy-bot", 0.7, "", runner_up=0.2))
    tc = make_client(
        _settings(fallback_confidence_threshold=0.65, fallback_after_s=1.0)
    )
    with caplog.at_level(logging.INFO, logger="switch_decision"):
        body = tc.post("/decide", json=BODY).json()
    assert (body["agent"], body["backend"], body["threshold"]) == (
        None,
        "gemini_decision",
        0.8,
    )
    [line] = _decide_lines(caplog)
    assert "threshold=0.80 picked=None" in line.getMessage()
    with_lead = make_client(
        _settings(
            fallback_confidence_threshold=0.65, fallback_after_s=1.0, min_lead=0.1
        )
    )
    body = with_lead.post("/decide", json=BODY).json()
    assert (body["agent"], body["rule"], body["min_lead"]) == (
        "deploy-bot",
        "lead",
        0.1,
    )


@pytest.mark.parametrize(
    ("gemini_delay", "backend"), [(0.0, "gemini_decision"), (1.0, "bedrock")]
)
def test_a_request_threshold_holds_for_either_backend(
    make_client, backends_by_name, gemini_delay, backend
):
    plan, _ = backends_by_name
    plan["gemini_decision"] = (
        gemini_delay,
        ModelAnswer("deploy-bot", 0.85, "", runner_up=0.1),
    )
    plan["bedrock"] = (0.0, ModelAnswer("deploy-bot", 0.85, "r"))
    tc = make_client(
        _settings(
            fallback_confidence_threshold=0.65, fallback_after_s=0.2, min_lead=0.1
        )
    )
    body = tc.post("/decide", json={**BODY, "confidence_threshold": 0.9}).json()
    assert (body["agent"], body["backend"], body["threshold"], body["rule"]) == (
        None,
        backend,
        0.9,
        "threshold",
    )


def test_health_reports_the_fallback_threshold(make_client):
    body = make_client(_settings(fallback_confidence_threshold=0.65)).get("/health")
    assert body.json()["fallback_confidence_threshold"] == 0.65
    assert (
        make_client(_settings()).get("/health").json()["fallback_confidence_threshold"]
        is None
    )
    off = make_client(
        _settings(fallback_backend=None, fallback_confidence_threshold=0.65)
    )
    assert off.get("/health").json()["fallback_confidence_threshold"] is None

import asyncio
import json
import math
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from switch_decision import app as app_module
from switch_decision import backends
from switch_decision.backends import (
    InvalidChoiceError,
    ModelServerError,
    anthropic_request,
    bedrock_request,
    read_anthropic,
    read_bedrock,
    read_letter_logprobs,
    read_systemone,
)
from switch_decision.config import Settings
from switch_decision.models import Agent, DecideRequest, Incoming, Message, Room
from switch_decision.prompt import (
    NONE,
    SPEAKER_QUESTION,
    letter_messages,
    lettered_options,
    systemone_request,
)

AGENTS = [
    Agent(name="deploy-bot", description="CI and deploys"),
    Agent(name="billing-bot", description="invoices", role="finance"),
]
OPTIONS = ["deploy-bot", "billing-bot", NONE]


def _req(**kw) -> DecideRequest:
    base = dict(
        room=Room(name="eng", instructions="be brief"),
        message=Incoming(
            sender="sara", text="why did the deploy fail?", thread_id="t1"
        ),
        agents=AGENTS,
        thread=[
            Message(
                sender="deploy-bot",
                sender_kind="agent",
                text="deploy started",
                addressed=[],
            )
        ],
        recent=[
            Message(
                sender="sara", sender_kind="person", text="morning", addressed=["bob"]
            )
        ],
    )
    base.update(kw)
    return DecideRequest(**base)


def _answer(choice, probs):
    return {
        "answers": {
            SPEAKER_QUESTION: {
                "type": "choice",
                "choice": choice,
                "confidence": probs.get(choice),
                "probabilities": probs,
            }
        }
    }


def test_request_builder_has_one_choice_question_with_none():
    body = systemone_request(_req(), "clef-flash", 30)
    assert body["model"] == "clef-flash"
    q = body["questions"][SPEAKER_QUESTION]
    assert q["type"] == "choice"
    assert list(q["criteria"]) == ["deploy-bot", "billing-bot", NONE]
    assert q["criteria"]["billing-bot"] == "billing-bot: invoices (role: finance)"
    state = body["state"]
    for part in (
        "Room: eng",
        "be brief",
        "deploy started",
        "sara [person] (to bob)",
        "in the thread above",
        "Who talked to whom",
    ):
        assert part in state


def test_history_limit_caps_rows():
    recent = [
        Message(sender="p", sender_kind="person", text=f"msg{i}", addressed=[])
        for i in range(10)
    ]
    state = systemone_request(_req(recent=recent), "m", 3)["state"]
    assert "msg9" in state and "msg7" in state and "msg6" not in state


def test_read_systemone_choice_uses_probability():
    a = read_systemone(
        _answer("deploy-bot", {"deploy-bot": 0.9, "billing-bot": 0.05, NONE: 0.05}),
        OPTIONS,
    )
    assert (a.choice, a.confidence) == ("deploy-bot", 0.9)
    assert a.reason.startswith("probabilities: deploy-bot=0.90")
    assert a.runner_up == 0.05


def test_read_systemone_none():
    a = read_systemone(
        _answer(NONE, {"deploy-bot": 0.1, "billing-bot": 0.1, NONE: 0.8}), OPTIONS
    )
    assert a.choice == NONE


def test_read_systemone_refuses_unknown_name():
    with pytest.raises(InvalidChoiceError, match="not one of the options") as exc:
        read_systemone(_answer("ghost-bot", {"ghost-bot": 0.99}), OPTIONS)
    assert (exc.value.choice, exc.value.confidence) == ("ghost-bot", 0.99)


def test_read_systemone_refuses_malformed():
    with pytest.raises(ModelServerError):
        read_systemone({"answers": {}}, OPTIONS)


def _settings(url="http://model.test/v1/systemone", threshold=0.6, min_lead=None):
    return Settings(
        min_lead=min_lead,
        backend="systemone",
        model="clef-flash",
        systemone_url=url,
        ollama_url="http://o",
        llamacpp_url="http://l",
        aws_region="us-east-1",
        aws_profile=None,
        confidence_threshold=threshold,
        timeout_s=5,
        history_limit=30,
    )


def _client(monkeypatch, handler, **kw):
    monkeypatch.setattr(app_module, "settings", _settings(**kw))
    transport = httpx.MockTransport(handler)

    def fake_client():
        return httpx.AsyncClient(transport=transport)

    tc = TestClient(app_module.app)
    tc.__enter__()
    monkeypatch.setattr(app_module, "client", fake_client())
    return tc


def _payload(**kw):
    return json.loads(_req(**kw).model_dump_json())


def test_decide_picks_agent(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(
            200,
            json=_answer(
                "deploy-bot", {"deploy-bot": 0.9, "billing-bot": 0.05, NONE: 0.05}
            ),
        ),
    )
    r = tc.post("/decide", json=_payload())
    assert r.status_code == 200
    assert r.json()["agent"] == "deploy-bot" and r.json()["confidence"] == 0.9
    assert r.json()["backend"] == "systemone"


def test_decide_below_threshold_is_nobody(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(
            200,
            json=_answer(
                "deploy-bot", {"deploy-bot": 0.5, "billing-bot": 0.3, NONE: 0.2}
            ),
        ),
    )
    body = tc.post("/decide", json=_payload()).json()
    assert body["agent"] is None and body["model_choice"] == "deploy-bot"


def test_decide_request_threshold_overrides(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(
            200,
            json=_answer(
                "deploy-bot", {"deploy-bot": 0.5, "billing-bot": 0.3, NONE: 0.2}
            ),
        ),
    )
    body = tc.post("/decide", json=_payload(confidence_threshold=0.4)).json()
    assert body["agent"] == "deploy-bot" and body["threshold"] == 0.4


def test_decide_none_is_nobody(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(
            200, json=_answer(NONE, {"deploy-bot": 0.1, "billing-bot": 0.1, NONE: 0.8})
        ),
    )
    assert tc.post("/decide", json=_payload()).json()["agent"] is None


# ── Lead rule (DECISION_MIN_LEAD) ──────────────────────────────────────────


def _lead_client(monkeypatch, choice, probs, **kw):
    return _client(
        monkeypatch,
        lambda r: httpx.Response(200, json=_answer(choice, probs)),
        threshold=0.5,
        min_lead=0.05,
        **kw,
    )


def test_lead_rule_delivers_a_top_agent_under_the_threshold(monkeypatch, caplog):
    # A pilot message for the right agent: top, but under half.
    tc = _lead_client(
        monkeypatch,
        "deploy-bot",
        {"deploy-bot": 0.445, NONE: 0.372, "billing-bot": 0.183},
    )
    body = tc.post("/decide", json=_payload()).json()
    assert body["agent"] == "deploy-bot"
    assert body["rule"] == "lead" and body["min_lead"] == 0.05
    assert abs(body["lead"] - 0.073) < 1e-9
    line = next(
        r.getMessage() for r in caplog.records if r.getMessage().startswith("decide ")
    )
    assert "picked=deploy-bot" in line and "rule=lead lead=0.07" in line


def test_lead_rule_refuses_a_near_tie_with_none(monkeypatch):
    tc = _lead_client(
        monkeypatch,
        "billing-bot",
        {"billing-bot": 0.48, NONE: 0.457, "deploy-bot": 0.063},
    )
    body = tc.post("/decide", json=_payload()).json()
    assert body["agent"] is None and body["model_choice"] == "billing-bot"
    assert body["rule"] == "lead"


def test_lead_rule_refuses_a_near_tie_between_agents(monkeypatch):
    tc = _lead_client(
        monkeypatch, "deploy-bot", {"deploy-bot": 0.62, "billing-bot": 0.6, NONE: 0.0}
    )
    # Above the threshold, but too close to call between the two agents.
    assert tc.post("/decide", json=_payload()).json()["agent"] is None


def test_lead_rule_counts_a_lead_of_exactly_min_lead(monkeypatch):
    # 0.48 - 0.43 is 0.04999... in floating point.
    tc = _lead_client(
        monkeypatch, "deploy-bot", {"deploy-bot": 0.48, NONE: 0.43, "billing-bot": 0.09}
    )
    assert tc.post("/decide", json=_payload()).json()["agent"] == "deploy-bot"


def test_lead_rule_none_on_top_is_nobody(monkeypatch):
    tc = _lead_client(
        monkeypatch, NONE, {NONE: 0.6, "deploy-bot": 0.3, "billing-bot": 0.1}
    )
    body = tc.post("/decide", json=_payload()).json()
    assert body["agent"] is None and body["rule"] == "lead"


def test_a_request_threshold_keeps_the_threshold_rule(monkeypatch):
    tc = _lead_client(
        monkeypatch,
        "deploy-bot",
        {"deploy-bot": 0.445, NONE: 0.372, "billing-bot": 0.183},
    )
    body = tc.post("/decide", json=_payload(confidence_threshold=0.5)).json()
    assert body["agent"] is None and body["rule"] == "threshold"
    assert body["min_lead"] is None


def test_without_min_lead_the_threshold_rule_applies(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(
            200,
            json=_answer(
                "deploy-bot", {"deploy-bot": 0.445, NONE: 0.372, "billing-bot": 0.183}
            ),
        ),
        threshold=0.5,
    )
    body = tc.post("/decide", json=_payload()).json()
    assert body["agent"] is None and body["rule"] == "threshold"
    assert abs(body["lead"] - 0.073) < 1e-9


def test_a_single_confidence_backend_keeps_the_threshold_rule():
    # Haiku and Ollama rate one confidence and score no other option.
    one = backends.ModelAnswer(choice="deploy-bot", confidence=0.45, reason="")
    assert app_module.pick(one, 0.5, 0.05) == (None, "threshold", None)
    sure = replace(one, confidence=0.9)
    assert app_module.pick(sure, 0.5, 0.05) == ("deploy-bot", "threshold", None)


def test_health_reports_min_lead(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(200, json={"status": "ok", "model": "clef-flash"}),
        min_lead=0.05,
    )
    assert tc.get("/health").json()["min_lead"] == 0.05


def test_decide_unknown_name_is_nobody(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(200, json=_answer("ghost-bot", {"ghost-bot": 1.0})),
    )
    r = tc.post("/decide", json=_payload())
    assert r.status_code == 200
    assert r.json()["agent"] is None and r.json()["model_choice"] == "ghost-bot"


def test_decide_model_server_error_status_is_502(monkeypatch):
    tc = _client(monkeypatch, lambda r: httpx.Response(500, text="boom"))
    r = tc.post("/decide", json=_payload())
    assert r.status_code == 502 and "returned 500" in r.json()["detail"]


def test_decide_unreachable_model_server_is_502_naming_it(monkeypatch):
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    tc = _client(monkeypatch, boom)
    r = tc.post("/decide", json=_payload())
    assert r.status_code == 502
    assert "http://model.test/v1/systemone" in r.json()["detail"]


def test_health_reports_backend_model_threshold(monkeypatch):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(200, json={"status": "ok", "model": "clef-flash"}),
    )
    body = tc.get("/health").json()
    assert (
        body["backend"] == "systemone"
        and body["model"] == "clef-flash"
        and body["confidence_threshold"] == 0.6
    )
    assert body["backends_available"] == ["default", "anthropic"]


def test_health_fails_when_model_server_down(monkeypatch):
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    tc = _client(monkeypatch, boom)
    r = tc.get("/health")
    assert r.status_code == 503 and "http://model.test/health" in r.json()["detail"]


# ── Bedrock backend ─────────────────────────────────────────────────────────


def _bedrock_settings(**kw):
    base = dict(
        backend="bedrock",
        model="us.amazon.nova-micro-v1:0",
        systemone_url="",
        ollama_url="",
        llamacpp_url="",
        aws_region="us-east-1",
        aws_profile=None,
        confidence_threshold=0.6,
        timeout_s=5,
        history_limit=30,
    )
    base.update(kw)
    return Settings(**base)


def _converse(agent, confidence, reason="r"):
    return {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "t",
                            "name": "pick_speaker",
                            "input": {
                                "reason": reason,
                                "agent": agent,
                                "confidence": confidence,
                            },
                        }
                    }
                ],
            }
        },
        "usage": {"inputTokens": 900, "outputTokens": 20},
        "metrics": {"latencyMs": 400},
    }


def test_bedrock_request_forces_the_pick_tool_with_the_options():
    body = bedrock_request(_req(), _bedrock_settings())
    assert body["modelId"] == "us.amazon.nova-micro-v1:0"
    assert body["toolConfig"]["toolChoice"] == {"tool": {"name": "pick_speaker"}}
    schema = body["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]
    assert schema["properties"]["agent"]["enum"] == ["deploy-bot", "billing-bot", NONE]
    assert "why did the deploy fail?" in body["messages"][0]["content"][0]["text"]
    assert body["inferenceConfig"]["temperature"] == 0


def test_read_bedrock_choice_and_refusals():
    a = read_bedrock(_converse("deploy-bot", 0.9), OPTIONS)
    assert (a.choice, a.confidence) == ("deploy-bot", 0.9)
    with pytest.raises(InvalidChoiceError, match="not one of the options"):
        read_bedrock(_converse("ghost-bot", 0.9), OPTIONS)
    with pytest.raises(ModelServerError, match="pick tool"):
        read_bedrock(
            {"output": {"message": {"content": [{"text": "deploy-bot"}]}}}, OPTIONS
        )


class _FakeBedrock:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, []

    def converse(self, **kw):
        self.calls.append(kw)
        if self.error:
            raise self.error
        return self.response


def test_decide_via_bedrock(monkeypatch):
    fake = _FakeBedrock(_converse("billing-bot", 0.8))
    monkeypatch.setattr(backends, "bedrock_client", lambda s: fake)
    monkeypatch.setattr(app_module, "settings", _bedrock_settings())
    with TestClient(app_module.app) as tc:
        body = tc.post("/decide", json=_payload()).json()
    assert (
        body["agent"] == "billing-bot" and body["model"] == "us.amazon.nova-micro-v1:0"
    )
    assert body["backend"] == "bedrock"
    assert len(fake.calls) == 1


def test_bedrock_error_is_502_naming_model(monkeypatch):
    err = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "no access"}}, "Converse"
    )
    monkeypatch.setattr(backends, "bedrock_client", lambda s: _FakeBedrock(error=err))
    monkeypatch.setattr(app_module, "settings", _bedrock_settings())
    with TestClient(app_module.app) as tc:
        r = tc.post("/decide", json=_payload())
    assert r.status_code == 502
    assert (
        "us.amazon.nova-micro-v1:0" in r.json()["detail"]
        and "AccessDenied" in r.json()["detail"]
    )


# ── llama.cpp letter readout ────────────────────────────────────────────────


def _top(pairs):
    return {
        "choices": [
            {
                "logprobs": {
                    "content": [
                        {
                            "top_logprobs": [
                                {"token": t, "logprob": lp} for t, lp in pairs
                            ]
                        }
                    ]
                }
            }
        ]
    }


def test_letter_messages_list_agents_and_none():
    messages, options = letter_messages(_req(), 30)
    assert options == {"A": "deploy-bot", "B": "billing-bot", "N": NONE}
    user = messages[1]["content"]
    assert (
        "A) deploy-bot: CI and deploys" in user
        and "B) billing-bot: invoices (role: finance)" in user
        and "N) none:" in user
    )


def test_letter_readout_renormalises_over_options():
    a = read_letter_logprobs(
        _top(
            [
                ("A", math.log(0.6)),
                ("N", math.log(0.2)),
                ("<think>", math.log(0.1)),
                ("B", math.log(0.1)),
            ]
        ),
        lettered_options(["deploy-bot", "billing-bot"]),
    )
    assert a.choice == "deploy-bot" and abs(a.confidence - 0.6 / 0.9) < 1e-9
    assert abs(a.runner_up - 0.2 / 0.9) < 1e-9


def test_letter_readout_with_no_option_letter_fails():
    with pytest.raises(ModelServerError, match="no probability"):
        read_letter_logprobs(_top([("hello", -0.1)]), lettered_options(["deploy-bot"]))


# ── Anthropic API backend ───────────────────────────────────────────────────


def test_anthropic_request_forces_the_pick_tool_without_sampling_params():
    s = _bedrock_settings(backend="anthropic", model="claude-haiku-5-5")
    body = anthropic_request(_req(), s)
    assert body["model"] == "claude-haiku-5-5"
    assert body["tool_choice"] == {"type": "tool", "name": "pick_speaker"}
    assert body["tools"][0]["strict"] is True
    assert body["tools"][0]["input_schema"]["additionalProperties"] is False
    assert body["tools"][0]["input_schema"]["properties"]["agent"]["enum"] == [
        "deploy-bot",
        "billing-bot",
        NONE,
    ]
    assert "temperature" not in body and body["thinking"] == {"type": "disabled"}


def test_read_anthropic_tool_call():
    msg = SimpleNamespace(
        stop_reason="tool_use",
        content=[
            SimpleNamespace(
                type="tool_use",
                name="pick_speaker",
                input={"reason": "r", "agent": "deploy-bot", "confidence": 0.8},
            )
        ],
    )
    a = read_anthropic(msg, OPTIONS)
    assert (a.choice, a.confidence) == ("deploy-bot", 0.8)
    with pytest.raises(ModelServerError, match="did not call"):
        read_anthropic(SimpleNamespace(stop_reason="refusal", content=[]), OPTIONS)


# ── the model server's bearer token ─────────────────────────────────────────


def _ask_recording(settings: Settings, body: dict) -> httpx.Request:
    """Run one `ask` against a fake model server; return the request it got."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body)

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            await backends.ask(c, settings, _req())

    asyncio.run(run())
    assert len(seen) == 1
    return seen[0]


LLAMA_ANSWER = _top([("A", math.log(0.9)), ("N", math.log(0.1))])
SYSTEMONE_ANSWER = _answer("deploy-bot", {"deploy-bot": 0.9, NONE: 0.1})


@pytest.mark.parametrize(
    ("backend", "body"),
    [("llamacpp", LLAMA_ANSWER), ("systemone", SYSTEMONE_ANSWER)],
)
def test_the_model_server_token_is_sent_as_a_bearer_token(backend, body):
    s = replace(_settings(), backend=backend, model_server_token="s3cret")
    request = _ask_recording(s, body)
    assert request.headers["authorization"] == "Bearer s3cret"


@pytest.mark.parametrize(
    ("backend", "body"),
    [("llamacpp", LLAMA_ANSWER), ("systemone", SYSTEMONE_ANSWER)],
)
def test_no_model_server_token_sends_no_authorization(backend, body):
    request = _ask_recording(replace(_settings(), backend=backend), body)
    assert "authorization" not in request.headers


def test_ollama_never_gets_the_model_server_token():
    s = replace(_settings(), backend="ollama", model_server_token="s3cret")
    body = {
        "message": {"content": json.dumps({"agent": "deploy-bot", "confidence": 0.9})}
    }
    request = _ask_recording(s, body)
    assert "authorization" not in request.headers


def test_a_refused_model_server_token_is_a_502_without_the_token(monkeypatch, caplog):
    tc = _client(
        monkeypatch,
        lambda r: httpx.Response(401, json={"detail": "missing or wrong bearer token"}),
    )
    monkeypatch.setattr(
        app_module,
        "settings",
        replace(app_module.settings, model_server_token="s3cret"),
    )
    with caplog.at_level("INFO"):
        r = tc.post("/decide", json=_payload())
    assert r.status_code == 502 and "401" in r.json()["detail"]
    assert "s3cret" not in caplog.text and "s3cret" not in r.text


def test_the_instructions_say_an_agent_spoken_to_by_name_answers():
    """An agent named in plain text, without @, is being spoken to; one only
    mentioned is not. Every backend gets the rule: SystemOne's instructions and
    the prompt the language-model backends read."""
    from switch_decision.prompt import NONE_CRITERION, SPEAKER_INSTRUCTIONS, SYSTEM

    for text in (SPEAKER_INSTRUCTIONS, SYSTEM):
        assert "with or without @" in text
        assert "only mentioned" in text
        assert "named person who is not an agent" in text
    assert "only mentioned or talked about" in NONE_CRITERION

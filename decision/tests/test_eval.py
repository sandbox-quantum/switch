"""The eval scenario sets and the eval report."""

import copy
import importlib.util
import json
import random
from pathlib import Path

import httpx
import pytest

EVAL = Path(__file__).resolve().parent.parent / "eval"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, EVAL / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


add_history = _load("add_history")
eval_module = _load("eval")


@pytest.mark.parametrize("name", add_history.FILES)
def test_every_benchmark_scenario_has_room_history(name):
    data = json.loads((EVAL / name).read_text())
    for s in data["scenarios"]:
        background = s["background"]
        assert len(background) >= 3, s["id"]
        assert all(
            m["sender_kind"] == "person" and not m["addressed"] for m in background
        ), s["id"]
        others = {s["message"]["sender"]} | {
            m["sender"] for m in s.get("recent", []) + s.get("thread", [])
        }
        others |= {a["name"] for a in s.get("agents", data["agents"])}
        assert not others & {m["sender"] for m in background}, s["id"]


def test_history_is_reproducible_and_leaves_scenarios_alone():
    rnd = random.Random(add_history.SEED)
    for name in add_history.FILES:
        stored = json.loads((EVAL / name).read_text())
        bare = copy.deepcopy(stored)
        for s in bare["scenarios"]:
            del s["background"]
        regenerated = add_history.add_history(copy.deepcopy(bare), rnd)
        assert regenerated == stored, name


def _fake_service(answers: dict[str, str | None]):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        picked = answers[body["message"]["text"]]
        return httpx.Response(
            200,
            json={
                "agent": picked,
                "model_choice": picked or "none",
                "confidence": 0.9,
                "latency_ms": 5,
                "reason": "",
            },
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_report_separates_right_wrong_and_missed(tmp_path):
    data = {
        "room": {"name": "r"},
        "agents": [
            {"name": "a", "description": "x"},
            {"name": "b", "description": "y"},
        ],
        "scenarios": [
            {
                "id": "right",
                "expect": ["a"],
                "message": {"sender": "p", "text": "1"},
                "background": [],
                "recent": [],
            },
            {
                "id": "wrong-agent",
                "expect": ["a"],
                "message": {"sender": "p", "text": "2"},
            },
            {
                "id": "answered-for-nobody",
                "expect": [None],
                "message": {"sender": "p", "text": "3"},
            },
            {"id": "missed", "expect": ["b"], "message": {"sender": "p", "text": "4"}},
            {
                "id": "right-nobody",
                "expect": [None],
                "message": {"sender": "p", "text": "5"},
            },
        ],
    }
    path = tmp_path / "set.json"
    path.write_text(json.dumps(data))
    client = _fake_service({"1": "a", "2": "b", "3": "a", "4": None, "5": None})
    tally = eval_module.run_file(client, "http://test", path, None, quiet=True)
    assert (tally.right, tally.wrong, tally.missed) == (2, 2, 1)
    assert tally.precision() == "1/3 = 0.33"
    assert "| set.json | 2/5 | 2 | 1 | 1/3 = 0.33 |" in eval_module.summary(
        {"set.json": tally}
    )


def test_background_is_sent_before_the_scenario_history():
    data = {"room": {"name": "r"}, "agents": []}
    scenario = {
        "message": {"sender": "p", "text": "hi"},
        "background": [
            {
                "sender": "ana",
                "sender_kind": "person",
                "text": "lunch?",
                "addressed": [],
            }
        ],
        "recent": [
            {"sender": "p", "sender_kind": "person", "text": "earlier", "addressed": []}
        ],
    }
    body = eval_module.request_body(data, scenario, None)
    assert [m["text"] for m in body["recent"]] == ["lunch?", "earlier"]
    assert "confidence_threshold" not in body


FOLLOWUP_PEOPLE = {"tom", "ivy", "pia", "sam", "nora", "eli"}


def test_followups_set_is_well_formed():
    data = json.loads((EVAL / "scenarios_followups.json").read_text())
    names = {a["name"] for a in data["agents"]}
    assert len(data["scenarios"]) >= 40
    ids = [s["id"] for s in data["scenarios"]]
    assert len(ids) == len(set(ids))
    for s in data["scenarios"]:
        assert s["note"], s["id"]
        assert all(e is None or e in names for e in s["expect"]), s["id"]
        people = {
            m["sender"]
            for m in s["recent"] + s["thread"]
            if m["sender_kind"] == "person"
        }
        people.add(s["message"]["sender"])
        # Made-up people only: the set must never carry a real person's name or message.
        assert people <= FOLLOWUP_PEOPLE, (s["id"], people - FOLLOWUP_PEOPLE)
        agents_seen = {
            m["sender"]
            for m in s["recent"] + s["thread"]
            if m["sender_kind"] == "agent"
        }
        assert agents_seen <= names, s["id"]


def test_followups_set_is_generated():
    before = (EVAL / "scenarios_followups.json").read_text()
    spec = importlib.util.spec_from_file_location(
        "make_followups", EVAL / "make_followups_scenarios.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert (EVAL / "scenarios_followups.json").read_text() == before

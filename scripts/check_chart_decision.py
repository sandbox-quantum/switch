#!/usr/bin/env python3
"""Render the switch chart with its decision service off and on, and check it.

The decision service (auto-route) is optional in the chart. Off, nothing of it
renders and switch-core gets no endpoint. On, the chart runs it, points
switch-core at it and admits only switch-core to it. An endpoint run elsewhere
can be named instead, but not as well as the chart's own. These are the
promises deploy/remote/helm/switch/README.md makes about `decision.*`; a render
that breaks one fails here, before a cluster finds out.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_chart_decision.py
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
BASE = "deploy/remote/helm/render-check-values.yaml"
RELEASE = "rel"
FLAGS = [
    "--set",
    "switchCore.featureFlags.enabled={follow_the_conversation,decision_routing}",
]


def render(*args: str) -> list[dict[str, Any]]:
    out = subprocess.run(
        ["helm", "template", RELEASE, CHART, "-f", BASE, *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [doc for doc in yaml.safe_load_all(out) if doc]


def render_error(*args: str) -> str:
    result = subprocess.run(
        ["helm", "template", RELEASE, CHART, "-f", BASE, *args],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, f"expected the render to fail: {args}"
    return result.stderr


def decision_objects(docs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        doc["kind"]: doc
        for doc in docs
        if doc["metadata"].get("labels", {}).get("app.kubernetes.io/component")
        == "decision"
    }


def core_env(docs: list[dict[str, Any]]) -> dict[str, Any]:
    deployment = next(
        d
        for d in docs
        if d["kind"] == "Deployment"
        and d["metadata"]["name"] == f"{RELEASE}-switch-core"
    )
    container = next(
        c
        for c in deployment["spec"]["template"]["spec"]["containers"]
        if c["name"] == "switch-core"
    )
    return {e["name"]: e.get("value", e.get("valueFrom")) for e in container["env"]}


def containers(deployment: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["name"]: c for c in deployment["spec"]["template"]["spec"]["containers"]}


def env_of(container: dict[str, Any]) -> dict[str, Any]:
    return {e["name"]: e.get("value") for e in container.get("env", [])}


def test_off_by_default_renders_nothing_and_sets_no_endpoint() -> None:
    docs = render()
    assert decision_objects(docs) == {}
    env = core_env(docs)
    assert "DECISION_ENDPOINT_URL" not in env
    assert "DECISION_BEDROCK_ENABLED" not in env


def test_on_runs_the_service_and_points_switch_core_at_it() -> None:
    docs = render("--set", "decision.enabled=true", *FLAGS)
    objects = decision_objects(docs)
    assert set(objects) == {
        "Deployment",
        "Service",
        "PersistentVolumeClaim",
        "ServiceAccount",
        "NetworkPolicy",
    }, sorted(objects)

    assert core_env(docs)["DECISION_ENDPOINT_URL"] == f"http://{RELEASE}-decision:8230"

    service = objects["Service"]
    assert service["metadata"]["name"] == f"{RELEASE}-decision"
    assert [p["port"] for p in service["spec"]["ports"]] == [8230]

    deployment = objects["Deployment"]
    pod = deployment["spec"]["template"]["spec"]
    assert pod["serviceAccountName"] == f"{RELEASE}-decision"
    assert {
        "key": "nvidia.com/gpu",
        "operator": "Exists",
        "effect": "NoSchedule",
    } in pod["tolerations"]
    by_name = containers(deployment)
    assert set(by_name) == {"decision", "model-server"}
    assert env_of(by_name["decision"])["LLAMACPP_URL"] == "http://127.0.0.1:8300"
    assert env_of(by_name["decision"])["DECISION_BACKEND"] == "llamacpp"
    gpu = by_name["model-server"]["resources"]
    assert gpu["limits"]["nvidia.com/gpu"] == 1
    assert "nvidia.com/gpu" not in by_name["decision"]["resources"].get("limits", {})
    assert [c["name"] for c in pod["initContainers"]] == ["download-model"]
    assert {
        v["name"]: v["persistentVolumeClaim"]["claimName"]
        for v in pod["volumes"]
        if "persistentVolumeClaim" in v
    } == {"weights": f"{RELEASE}-decision-weights"}

    policy = objects["NetworkPolicy"]["spec"]
    assert policy["podSelector"]["matchLabels"] == {
        "app.kubernetes.io/instance": RELEASE,
        "app.kubernetes.io/component": "decision",
    }
    assert policy["ingress"] == [
        {
            "from": [
                {
                    "podSelector": {
                        "matchLabels": {
                            "app.kubernetes.io/instance": RELEASE,
                            "app.kubernetes.io/component": "switch-core",
                        }
                    }
                }
            ],
            "ports": [{"protocol": "TCP", "port": 8230}],
        }
    ]


def test_bedrock_and_the_pod_role() -> None:
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.bedrock.enabled=true",
        "--set",
        "decision.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=arn:example",
        *FLAGS,
    )
    objects = decision_objects(docs)
    assert core_env(docs)["DECISION_BEDROCK_ENABLED"] == "true"
    decision = containers(objects["Deployment"])["decision"]
    assert env_of(decision)["DECISION_BEDROCK_ENABLED"] == "1"
    assert objects["ServiceAccount"]["metadata"]["annotations"] == {
        "eks.amazonaws.com/role-arn": "arn:example"
    }


def test_without_a_model_server_there_is_no_gpu_or_volume() -> None:
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.enabled=false",
        "--set",
        "decision.backend=anthropic",
        *FLAGS,
    )
    objects = decision_objects(docs)
    assert "PersistentVolumeClaim" not in objects
    pod = objects["Deployment"]["spec"]["template"]["spec"]
    assert [c["name"] for c in pod["containers"]] == ["decision"]
    assert "initContainers" not in pod


def test_network_policy_can_be_left_out() -> None:
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.networkPolicy.enabled=false",
    )
    assert "NetworkPolicy" not in decision_objects(docs)


def test_an_endpoint_elsewhere() -> None:
    docs = render(
        "--set",
        "switchCore.decision.endpointUrl=http://decider.example:8230",
        "--set",
        "switchCore.decision.bedrockEnabled=true",
        "--set",
        "switchCore.decision.timeoutSeconds=8",
    )
    assert decision_objects(docs) == {}
    env = core_env(docs)
    assert env["DECISION_ENDPOINT_URL"] == "http://decider.example:8230"
    assert env["DECISION_BEDROCK_ENABLED"] == "true"
    assert env["DECISION_TIMEOUT_SECONDS"] == "8"


def test_refuses_contradictions() -> None:
    assert "Clear one of them" in render_error(
        "--set",
        "decision.enabled=true",
        "--set",
        "switchCore.decision.endpointUrl=http://decider.example:8230",
    )
    assert "needs a decision service" in render_error(
        "--set", "switchCore.decision.bedrockEnabled=true"
    )
    assert "follow_the_conversation" in render_error(
        "--set", "switchCore.featureFlags.enabled={decision_routing}"
    )
    assert "file name, not a path" in render_error(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.model.file=../x.gguf",
    )


TESTS: list[Callable[[], None]] = [
    test_off_by_default_renders_nothing_and_sets_no_endpoint,
    test_on_runs_the_service_and_points_switch_core_at_it,
    test_bedrock_and_the_pod_role,
    test_without_a_model_server_there_is_no_gpu_or_volume,
    test_network_policy_can_be_left_out,
    test_an_endpoint_elsewhere,
    test_refuses_contradictions,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
        except (AssertionError, subprocess.CalledProcessError) as exc:
            failed += 1
            detail = (
                exc.stderr if isinstance(exc, subprocess.CalledProcessError) else exc
            )
            print(f"FAIL {test.__name__}: {detail}")
        else:
            print(f"ok   {test.__name__}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

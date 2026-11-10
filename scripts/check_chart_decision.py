#!/usr/bin/env python3
"""Render the switch chart with its decision service off and on, and check it.

The decision service (auto-route) is optional in the chart. Off, nothing of it
renders and switch-core gets no endpoint. On, the chart runs it beside its
model server (Strands Decider by default, or Qwen on llama.cpp), points
switch-core at it and admits only switch-core to it, both by NetworkPolicy and
by a bearer token the chart generates, which its model server requires
too. Its model weights are pinned to fixed
revisions, the same in docker-compose. An endpoint run elsewhere
can be named instead, but not as well as the chart's own. These are the
promises deploy/remote/helm/switch/README.md makes about `decision.*`; a render
that breaks one fails here, before a cluster finds out.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_chart_decision.py
"""

from __future__ import annotations

import base64
import re
import subprocess
import sys
from collections.abc import Callable
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
COMPOSE = "deploy/local/docker-compose.yml"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
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


def secret_refs_of(container: dict[str, Any]) -> dict[str, Any]:
    return {
        e["name"]: e["valueFrom"]["secretKeyRef"]
        for e in container.get("env", [])
        if "secretKeyRef" in e.get("valueFrom", {})
    }


def core_container(docs: list[dict[str, Any]]) -> dict[str, Any]:
    deployment = next(
        d
        for d in docs
        if d["kind"] == "Deployment"
        and d["metadata"]["name"] == f"{RELEASE}-switch-core"
    )
    return containers(deployment)["switch-core"]


def test_off_by_default_renders_nothing_and_sets_no_endpoint() -> None:
    docs = render()
    assert decision_objects(docs) == {}
    env = core_env(docs)
    assert "DECISION_ENDPOINT_URL" not in env
    assert "DECISION_BEDROCK_ENABLED" not in env
    assert "DECISION_API_KEY" not in env


def test_on_runs_the_service_and_points_switch_core_at_it() -> None:
    docs = render("--set", "decision.enabled=true", *FLAGS)
    objects = decision_objects(docs)
    assert set(objects) == {
        "Deployment",
        "Service",
        "PersistentVolumeClaim",
        "ServiceAccount",
        "NetworkPolicy",
        "Secret",
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
    assert "nvidia.com/gpu" not in by_name["decision"]["resources"].get("limits", {})
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


def test_strands_decider_is_the_default_model_server() -> None:
    docs = render("--set", "decision.enabled=true", *FLAGS)
    objects = decision_objects(docs)
    pod = objects["Deployment"]["spec"]["template"]["spec"]
    by_name = containers(objects["Deployment"])

    env = env_of(by_name["decision"])
    assert env["DECISION_BACKEND"] == "systemone"
    assert env["SYSTEMONE_URL"] == "http://127.0.0.1:8400/v1/systemone"
    assert env["DECISION_MODEL"] == "strands-decider-E4B"
    assert "LLAMACPP_URL" not in env

    server = by_name["model-server"]
    # Its own first-party image, which the release pins by digest.
    # By tag here, by digest once the release (or CI's placeholder pin) has
    # pinned it: either way, the strands model-server image.
    repository = server["image"].split("@")[0].rsplit(":", 1)[0]
    assert repository.rsplit("/", 1)[-1] == "switch-decision-strands", server["image"]
    env = env_of(server)
    assert env == {
        "STRANDS_CHECKPOINT": "StrandsAgents/strands-decider-E4B-gemma4-v1-2610",
        "STRANDS_REVISION": env["STRANDS_REVISION"],
        "STRANDS_BASE_REVISION": env["STRANDS_BASE_REVISION"],
        "STRANDS_MODEL_NAME": "strands-decider-E4B",
        "STRANDS_PORT": "8400",
        # From the decision token Secret: test_the_model_server_requires_the_token_too.
        "STRANDS_API_KEY": None,
    }, env
    assert [p["containerPort"] for p in server["ports"]] == [8400]
    resources = server["resources"]
    assert resources["limits"]["nvidia.com/gpu"] == 1
    assert resources["requests"]["memory"] == "24Gi"

    # It downloads its own weights into the Hugging Face cache on the volume,
    # so no init container and a writable mount; the first start downloads
    # and loads about 16 GB, so the startup probe waits at least 20 minutes.
    assert "initContainers" not in pod
    assert server["volumeMounts"] == [{"name": "weights", "mountPath": "/models"}]
    probe = server["startupProbe"]
    assert probe["httpGet"] == {"path": "/health", "port": "model"}
    assert probe["periodSeconds"] * probe["failureThreshold"] >= 20 * 60


def test_qwen_on_llama_cpp_is_the_alternative() -> None:
    docs = render(
        "--set", "decision.enabled=true", "--set", "decision.modelServer.kind=llamacpp"
    )
    objects = decision_objects(docs)
    pod = objects["Deployment"]["spec"]["template"]["spec"]
    by_name = containers(objects["Deployment"])
    env = env_of(by_name["decision"])
    assert env["DECISION_BACKEND"] == "llamacpp"
    assert env["DECISION_MODEL"] == "qwen3.5-4b-q4_k_m"
    assert env["LLAMACPP_URL"] == "http://127.0.0.1:8300"
    assert "SYSTEMONE_URL" not in env

    server = by_name["model-server"]
    assert server["image"] == "ghcr.io/ggml-org/llama.cpp:server-cuda"
    assert env_of(server) == {
        "MODEL_PATH": "/models/Qwen3.5-4B-Q4_K_M.gguf",
        "LLAMA_API_KEY": None,
    }
    assert server["resources"]["limits"]["nvidia.com/gpu"] == 1
    assert server["volumeMounts"] == [
        {"name": "weights", "mountPath": "/models", "readOnly": True}
    ]
    assert [c["name"] for c in pod["initContainers"]] == ["download-model"]
    assert "PersistentVolumeClaim" in objects


def test_the_hugging_face_token_reaches_whichever_server_downloads() -> None:
    token = "decision.modelServer.hfTokenSecret.name=hf"
    secret_ref = {"secretKeyRef": {"name": "hf", "key": "HF_TOKEN"}}

    def hf_token(container: dict[str, Any]) -> Any:
        return next(
            e.get("valueFrom") for e in container["env"] if e["name"] == "HF_TOKEN"
        )

    strands = decision_objects(render("--set", "decision.enabled=true", "--set", token))
    assert hf_token(containers(strands["Deployment"])["model-server"]) == secret_ref

    llama = decision_objects(
        render(
            "--set",
            "decision.enabled=true",
            "--set",
            "decision.modelServer.kind=llamacpp",
            "--set",
            token,
        )
    )
    init = llama["Deployment"]["spec"]["template"]["spec"]["initContainers"][0]
    assert hf_token(init) == secret_ref


def test_backend_and_model_can_be_overridden() -> None:
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.model=my-decider",
        "--set",
        "decision.modelServer.strands.checkpoint=acme/my-decider",
    )
    by_name = containers(decision_objects(docs)["Deployment"])
    assert env_of(by_name["decision"])["DECISION_MODEL"] == "my-decider"
    assert env_of(by_name["decision"])["DECISION_BACKEND"] == "systemone"
    assert env_of(by_name["model-server"])["STRANDS_CHECKPOINT"] == "acme/my-decider"


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
    env = env_of(pod["containers"][0])
    assert env["DECISION_BACKEND"] == "anthropic"
    assert "DECISION_MODEL" not in env
    assert "SYSTEMONE_URL" not in env and "LLAMACPP_URL" not in env


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
    assert "DECISION_API_KEY" not in env


def test_an_endpoint_elsewhere_with_a_key() -> None:
    docs = render(
        "--set",
        "switchCore.decision.endpointUrl=http://decider.example:8230",
        "--set",
        "switchCore.decision.apiKey.existingSecret=decider-token",
    )
    assert decision_objects(docs) == {}
    env = core_env(docs)
    assert env["DECISION_ENDPOINT_URL"] == "http://decider.example:8230"
    assert env["DECISION_API_KEY"] == {
        "secretKeyRef": {"name": "decider-token", "key": "token"}
    }
    error = render_error(
        "--set", "switchCore.decision.apiKey.existingSecret=decider-token"
    )
    assert "no endpoint to send the key to" in error
    error = render_error(
        "--set",
        "decision.enabled=true",
        "--set",
        "switchCore.decision.apiKey.existingSecret=decider-token",
    )
    assert "decision.token.existingSecret" in error


def test_the_service_requires_a_token_that_switch_core_sends() -> None:
    docs = render("--set", "decision.enabled=true", *FLAGS)
    objects = decision_objects(docs)
    secret = objects["Secret"]
    assert secret["metadata"]["name"] == f"{RELEASE}-decision-token"
    assert secret["type"] == "Opaque"
    assert set(secret["data"]) == {"token"}
    # `helm template` can't `lookup`, so this is a fresh value; an install
    # keeps the stored one. Long and random either way.
    token = base64.b64decode(secret["data"]["token"]).decode()
    assert len(token) == 48 and token.isalnum(), token
    assert (
        token
        != base64.b64decode(
            decision_objects(render("--set", "decision.enabled=true"))["Secret"][
                "data"
            ]["token"]
        ).decode()
    )

    ref = {"name": f"{RELEASE}-decision-token", "key": "token"}
    decision = containers(objects["Deployment"])["decision"]
    assert secret_refs_of(decision)["DECISION_SERVICE_TOKEN"] == ref
    assert secret_refs_of(core_container(docs))["DECISION_API_KEY"] == ref
    # The model server listens on the pod's IP (its probes reach it there),
    # so it takes the same token, and the decision container sends it.
    model_server = containers(objects["Deployment"])["model-server"]
    assert "DECISION_SERVICE_TOKEN" not in secret_refs_of(model_server)
    assert secret_refs_of(decision)["MODEL_SERVER_TOKEN"] == ref


def test_the_model_server_requires_the_token_too() -> None:
    ref = {"name": f"{RELEASE}-decision-token", "key": "token"}
    for kind, variable in (
        ("strands", "STRANDS_API_KEY"),
        ("llamacpp", "LLAMA_API_KEY"),
    ):
        docs = render(
            "--set",
            "decision.enabled=true",
            "--set",
            f"decision.modelServer.kind={kind}",
            *FLAGS,
        )
        pod = containers(decision_objects(docs)["Deployment"])
        assert secret_refs_of(pod["model-server"])[variable] == ref, kind
        assert secret_refs_of(pod["decision"])["MODEL_SERVER_TOKEN"] == ref, kind
        # The probes stay on /health, which neither server guards.
        for probe in ("startupProbe", "livenessProbe"):
            assert pod["model-server"][probe]["httpGet"]["path"] == "/health", kind

    # Your own Secret: both sides read it.
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.kind=llamacpp",
        "--set",
        "decision.token.existingSecret=my-decision-token",
        "--set",
        "decision.token.existingSecretKey=bearer",
        *FLAGS,
    )
    pod = containers(decision_objects(docs)["Deployment"])
    mine = {"name": "my-decision-token", "key": "bearer"}
    assert secret_refs_of(pod["model-server"])["LLAMA_API_KEY"] == mine
    assert secret_refs_of(pod["decision"])["MODEL_SERVER_TOKEN"] == mine

    # No model server, nothing to send it to.
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.enabled=false",
        "--set",
        "decision.backend=anthropic",
        *FLAGS,
    )
    decision = containers(decision_objects(docs)["Deployment"])["decision"]
    assert "MODEL_SERVER_TOKEN" not in secret_refs_of(decision)


def test_an_existing_token_secret_replaces_the_generated_one() -> None:
    docs = render(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.token.existingSecret=my-decision-token",
        "--set",
        "decision.token.existingSecretKey=bearer",
        *FLAGS,
    )
    objects = decision_objects(docs)
    assert "Secret" not in objects
    assert not any(
        d["kind"] == "Secret" and "decision" in d["metadata"]["name"] for d in docs
    )
    ref = {"name": "my-decision-token", "key": "bearer"}
    decision = containers(objects["Deployment"])["decision"]
    assert secret_refs_of(decision)["DECISION_SERVICE_TOKEN"] == ref
    assert secret_refs_of(core_container(docs))["DECISION_API_KEY"] == ref


def _llama_init(docs: list[dict[str, Any]]) -> dict[str, Any]:
    pod = decision_objects(docs)["Deployment"]["spec"]["template"]["spec"]
    return pod["initContainers"][0]


def test_the_qwen_weights_are_pinned_and_a_bad_file_is_deleted() -> None:
    docs = render(
        "--set", "decision.enabled=true", "--set", "decision.modelServer.kind=llamacpp"
    )
    init = _llama_init(docs)
    env = env_of(init)
    match = re.fullmatch(
        r"https://huggingface\.co/unsloth/Qwen3\.5-4B-GGUF/resolve/([0-9a-f]{40})/"
        r"Qwen3\.5-4B-Q4_K_M\.gguf",
        env["MODEL_URL"],
    )
    assert match, env["MODEL_URL"]
    assert re.fullmatch(r"[0-9a-f]{64}", env["MODEL_SHA256"]), env["MODEL_SHA256"]
    script = init["args"][0]
    # A file on the volume that fails is deleted and downloaded again; a
    # download that fails is deleted before the container exits non-zero.
    assert script.count('rm -f "$target"') == 2, script
    after_download = script.split('mv "$target.partial" "$target"', 1)[1]
    assert "if ! verify; then" in after_download
    assert after_download.index('rm -f "$target"') < after_download.index("exit 1")


def test_the_strands_checkpoint_and_base_are_pinned() -> None:
    server = containers(
        decision_objects(render("--set", "decision.enabled=true"))["Deployment"]
    )["model-server"]
    env = env_of(server)
    assert COMMIT.match(env["STRANDS_REVISION"]), env["STRANDS_REVISION"]
    assert COMMIT.match(env["STRANDS_BASE_REVISION"]), env["STRANDS_BASE_REVISION"]
    assert env["STRANDS_REVISION"] != env["STRANDS_BASE_REVISION"]
    assert "decision.modelServer.strands.revision is required" in render_error(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.strands.revision=",
    )
    assert "decision.modelServer.strands.baseRevision is required" in render_error(
        "--set",
        "decision.enabled=true",
        "--set",
        "decision.modelServer.strands.baseRevision=",
    )


def test_compose_pins_the_same_weights_as_the_chart() -> None:
    with open(COMPOSE, encoding="utf-8") as fh:
        services = yaml.safe_load(fh)["services"]

    def compose_default(value: str) -> str:
        # ${NAME:-default} or ${NAME-default}
        found = re.fullmatch(r"\$\{[A-Z0-9_]+:?-(.*)\}", value)
        assert found, value
        return found.group(1)

    llama = env_of(
        _llama_init(
            render(
                "--set",
                "decision.enabled=true",
                "--set",
                "decision.modelServer.kind=llamacpp",
            )
        )
    )
    download = services["decision-model-download"]
    assert compose_default(download["environment"]["MODEL_URL"]) == llama["MODEL_URL"]
    assert (
        compose_default(download["environment"]["MODEL_SHA256"])
        == llama["MODEL_SHA256"]
    )
    script = download["entrypoint"][-1]
    assert script.count('rm -f "$$target"') == 2, script

    strands = env_of(
        containers(
            decision_objects(render("--set", "decision.enabled=true"))["Deployment"]
        )["model-server"]
    )
    compose_strands = services["decision-model-strands"]["environment"]
    for name in ("STRANDS_REVISION", "STRANDS_BASE_REVISION"):
        assert compose_strands[name] == strands[name], name


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
        "decision.modelServer.kind=llamacpp",
        "--set",
        "decision.modelServer.llamacpp.model.file=../x.gguf",
    )
    assert "must be strands or llamacpp" in render_error(
        "--set", "decision.enabled=true", "--set", "decision.modelServer.kind=vllm"
    )
    assert "decision.backend is required" in render_error(
        "--set", "decision.enabled=true", "--set", "decision.modelServer.enabled=false"
    )


def test_the_service_logs_and_ships_like_switch_core() -> None:
    def decision_env(*args: str) -> tuple[dict[str, Any], dict[str, Any]]:
        docs = render("--set", "decision.enabled=true", *FLAGS, *args)
        container = containers(decision_objects(docs)["Deployment"])["decision"]
        env = {e["name"]: e for e in container["env"]}
        return env, secret_refs_of(container)

    env, secrets = decision_env()
    assert env["SERVICE_NAME"]["value"] == "switch-decision"
    assert env["POD_NAME"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.name"
    assert "LOG_FORMAT" in env and "LOG_LEVEL" in env
    assert not any(name.startswith("OTLP_") for name in env), sorted(env)

    env, secrets = decision_env(
        "--set",
        "switchCore.logging.format=json",
        "--set",
        "switchCore.observability.otlpEndpoint=https://collector.example",
        "--set",
        "switchCore.observability.deploymentId=0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10",
        "--set",
        "switchCore.observability.logs=true",
        "--set",
        "secrets.otlpHeaders=x-scope=example",
    )
    assert env["LOG_FORMAT"]["value"] == "json"
    assert env["OTLP_ENDPOINT"]["value"] == "https://collector.example"
    assert env["OTLP_LOGS_ENABLED"]["value"] == "true"
    assert env["DEPLOYMENT_ID"]["value"] == "0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10"
    assert "OTLP_METRICS_ENABLED" not in env
    assert "OTLP_HEADERS" in secrets


TESTS: list[Callable[[], None]] = [
    test_off_by_default_renders_nothing_and_sets_no_endpoint,
    test_on_runs_the_service_and_points_switch_core_at_it,
    test_strands_decider_is_the_default_model_server,
    test_qwen_on_llama_cpp_is_the_alternative,
    test_the_hugging_face_token_reaches_whichever_server_downloads,
    test_backend_and_model_can_be_overridden,
    test_bedrock_and_the_pod_role,
    test_without_a_model_server_there_is_no_gpu_or_volume,
    test_network_policy_can_be_left_out,
    test_an_endpoint_elsewhere,
    test_an_endpoint_elsewhere_with_a_key,
    test_the_service_requires_a_token_that_switch_core_sends,
    test_an_existing_token_secret_replaces_the_generated_one,
    test_the_model_server_requires_the_token_too,
    test_the_qwen_weights_are_pinned_and_a_bad_file_is_deleted,
    test_the_strands_checkpoint_and_base_are_pinned,
    test_compose_pins_the_same_weights_as_the_chart,
    test_the_service_logs_and_ships_like_switch_core,
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

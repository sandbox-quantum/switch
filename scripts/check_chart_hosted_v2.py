#!/usr/bin/env python3
"""Render the switch chart with and without hosted agents' values, and check it.

switch-core decides whether it runs hosted agents from the hosted controller
config (its provisioner_token), never from the chart, so no render sets
HOSTED_BOX_PROVISIONING any more. `hostedBoxProvisioning` is still accepted:
values that set it render, and with it true the warm pool's size is passed, as
before. With the values deploy/remote/helm/switch/values-hosted-v2.example.yaml
shows, switch-core gets the keyed-id key's path. These are the promises the
chart README's "Hosted agents" section makes; a render that breaks one fails
here, before a cluster finds out.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_chart_hosted_v2.py
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
BASE = "deploy/remote/helm/render-check-values.yaml"
V2 = "deploy/remote/helm/switch/values-hosted-v2.example.yaml"
RELEASE = "rel"
#: v2 on, as the example file turns it on. The agent_management flag it needs
#: also needs a controller token of 32+ characters (a placeholder here).
ON = ["-f", V2, "--set", "secrets.controllerTokenSecret=render-check-" + "0" * 32]


def _helm(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["helm", "template", RELEASE, CHART, "-f", BASE, *args],
        capture_output=True,
        text=True,
    )


def render(*args: str) -> list[dict[str, Any]]:
    result = _helm(*args)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, result.args, result.stdout, result.stderr
        )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def render_error(*args: str) -> str:
    result = _helm(*args)
    assert result.returncode != 0, f"expected the render to fail: {args}"
    return result.stderr


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


def test_no_render_sets_the_old_switch() -> None:
    """switch-core no longer reads HOSTED_BOX_PROVISIONING: no render sets it,
    whatever `hostedBoxProvisioning` says."""
    for args in (
        [],
        list(ON),
        [*ON, "--set", "switchCore.hostedBoxProvisioning=false"],
    ):
        assert "HOSTED_BOX_PROVISIONING" not in core_env(render(*args)), args


#: What only hosted agents' values add to switch-core's pod. Without them, none
#: of it may appear.
V2_ENV = (
    "HOSTED_BOX_PROVISIONING",
    "HOSTED_PROVISIONS_PER_MINUTE",
    "HOSTED_BOX_CEILING",
    "HOSTED_POOL_SIZE",
    "HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE",
    "VISIBILITY_KEYED_ID_KEY_PATH",
    "VISIBILITY_KEYED_ID_KEY_VERSION",
    "VISIBILITY_OPERATORS_PATH",
)
V2_VOLUMES = ("visibility-keyed-id-key", "visibility-operators")
OPTIONAL = "deploy/remote/helm/render-check-optional-values.yaml"


def core_volumes(docs: list[dict[str, Any]]) -> set[str]:
    deployment = next(
        d
        for d in docs
        if d["kind"] == "Deployment"
        and d["metadata"]["name"] == f"{RELEASE}-switch-core"
    )
    return {
        v["name"] for v in deployment["spec"]["template"]["spec"].get("volumes", [])
    }


def test_off_renders_nothing_of_v2() -> None:
    """The default render, and the render with the optional workloads on, carry
    no hosted agents setting, volume or mount."""
    for args in ([], ["-f", OPTIONAL]):
        docs = render(*args)
        env = core_env(docs)
        assert not [name for name in V2_ENV if name in env], args
        assert not core_volumes(docs) & set(V2_VOLUMES), args


def test_the_example_values_render_the_key() -> None:
    env = core_env(render(*ON))
    assert env["VISIBILITY_KEYED_ID_KEY_PATH"] == "/etc/switch-visibility/keyed-id.key"


def test_the_pool_and_per_workspace_limit_render_only_when_set() -> None:
    """The warm pool's size (10 by default) and the per-workspace limit reach
    switch-core as given, and are left out (switch-core's defaults) when empty
    or 0."""
    env = core_env(render(*ON))
    assert env["HOSTED_POOL_SIZE"] == "10"
    assert "HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE" not in env  # 0 is the default
    env = core_env(
        render(
            *ON,
            "--set",
            "switchCore.hostedPoolSize=2",
            "--set",
            "switchCore.hostedLaunchCapacityPerWorkspace=3",
        )
    )
    assert env["HOSTED_POOL_SIZE"] == "2"
    assert env["HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE"] == "3"
    for empty in ("", "0"):
        env = core_env(render(*ON, "--set", f"switchCore.hostedPoolSize={empty}"))
        assert "HOSTED_POOL_SIZE" not in env, empty


def test_without_the_old_switch_the_default_pool_renders_nothing() -> None:
    """The pool's size is passed only with `hostedBoxProvisioning` true, so
    values that never set it render no HOSTED_POOL_SIZE, whatever the pool is
    set to, and no refusal for a small capacity."""
    for args in (
        [],
        ["--set", "switchCore.hostedPoolSize=10"],
        [*ON, "--set", "switchCore.hostedBoxProvisioning=false"],
        [
            *ON,
            "--set",
            "switchCore.hostedBoxProvisioning=false",
            "--set",
            "switchCore.hostedLaunchCapacity=3",
        ],
    ):
        assert "HOSTED_POOL_SIZE" not in core_env(render(*args)), args


#: A pool must leave 2 of the capacity and the ceiling for people.
POOL_REFUSALS = [
    (
        ["--set", "switchCore.hostedLaunchCapacity=11"],
        "switchCore.hostedPoolSize 10 needs switchCore.hostedLaunchCapacity of at least 12",
    ),
    (
        ["--set", "switchCore.hostedBoxCeiling=11"],
        "switchCore.hostedPoolSize 10 needs switchCore.hostedBoxCeiling (empty: 50) of at least 12",
    ),
    (
        [
            "--set",
            "switchCore.hostedPoolSize=49",
            "--set",
            "switchCore.hostedLaunchCapacity=60",
            "--set",
            "switchCore.hostedBoxCeiling=",
        ],
        "switchCore.hostedPoolSize 49 needs switchCore.hostedBoxCeiling (empty: 50) of at least 51",
    ),
]


def test_a_pool_leaving_fewer_than_two_for_people_refuses() -> None:
    for args, words in POOL_REFUSALS:
        error = render_error(*ON, *args)
        assert words in error, f"{args}: {error}"


def test_a_pool_leaving_exactly_two_renders() -> None:
    env = core_env(
        render(
            *ON,
            "--set",
            "switchCore.hostedLaunchCapacity=12",
            "--set",
            "switchCore.hostedBoxCeiling=12",
        )
    )
    assert env["HOSTED_POOL_SIZE"] == "10"
    env = core_env(
        render(
            *ON,
            "--set",
            "switchCore.hostedPoolSize=48",
            "--set",
            "switchCore.hostedLaunchCapacity=50",
            "--set",
            "switchCore.hostedBoxCeiling=",
        )
    )
    assert env["HOSTED_POOL_SIZE"] == "48"


#: The values a server with a box cluster needs, each emptied. switch-core
#: decides from its own config now, so the chart no longer refuses any of them.
EMPTIED = [
    ["--set", "switchCore.hostedControllerSecret="],
    ["--set", "switchCore.hostedLaunchCapacity=12"],
    ["--set", "switchCore.featureFlags.enabled={agent_management}"],
    ["--set", "switchCore.visibilityKeyedIdKeySecret="],
]


def test_the_old_switch_refuses_no_render() -> None:
    for args in EMPTIED:
        env = core_env(render(*ON, *args))
        assert "HOSTED_BOX_PROVISIONING" not in env, args


TESTS = [
    test_no_render_sets_the_old_switch,
    test_off_renders_nothing_of_v2,
    test_the_example_values_render_the_key,
    test_the_pool_and_per_workspace_limit_render_only_when_set,
    test_without_the_old_switch_the_default_pool_renders_nothing,
    test_a_pool_leaving_fewer_than_two_for_people_refuses,
    test_a_pool_leaving_exactly_two_renders,
    test_the_old_switch_refuses_no_render,
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

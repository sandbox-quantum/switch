#!/usr/bin/env python3
"""Render the switch chart with hosted agents v2 off and on, and check it.

Off (the default), switch-core gets no HOSTED_BOX_PROVISIONING. On, with the
values deploy/remote/helm/switch/values-hosted-v2.example.yaml shows, it gets
HOSTED_BOX_PROVISIONING and the keyed-id key's path. On without one of the
values v2 needs, the chart refuses to render and names the missing value:
these are the promises the chart README's "Hosted agents v2" section makes; a
render that breaks one fails here, before a cluster finds out.

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


def test_off_by_default_sets_no_v2() -> None:
    env = core_env(render())
    assert "HOSTED_BOX_PROVISIONING" not in env


def test_on_with_every_value_renders_v2_and_the_key() -> None:
    env = core_env(render(*ON))
    assert env["HOSTED_BOX_PROVISIONING"] == "true"
    assert env["VISIBILITY_KEYED_ID_KEY_PATH"] == "/etc/switch-visibility/keyed-id.key"


#: Each value v2 needs, emptied, and the words its refusal must contain.
REFUSALS = [
    (
        ["--set", "switchCore.hostedControllerSecret="],
        "needs switchCore.hostedControllerSecret",
    ),
    (
        ["--set", "switchCore.hostedLaunchCapacity=0"],
        "needs switchCore.hostedLaunchCapacity above 0",
    ),
    (
        ["--set", "switchCore.featureFlags.enabled={agent_management}"],
        'needs "hosted_agents" and "agent_management"',
    ),
    (
        ["--set", "switchCore.visibilityKeyedIdKeySecret="],
        "needs switchCore.visibilityKeyedIdKeySecret",
    ),
]


def test_on_without_a_needed_value_refuses_and_names_it() -> None:
    for args, words in REFUSALS:
        error = render_error(*ON, *args)
        assert words in error, f"{args}: {error}"


def test_off_needs_none_of_them() -> None:
    """With v2 off, a missing keyed-id key still renders: the Hosted area's
    pages say they're unavailable, as before."""
    env = core_env(
        render(
            *ON,
            "--set",
            "switchCore.hostedBoxProvisioning=false",
            "--set",
            "switchCore.visibilityKeyedIdKeySecret=",
        )
    )
    assert "HOSTED_BOX_PROVISIONING" not in env
    assert "VISIBILITY_KEYED_ID_KEY_PATH" not in env


TESTS = [
    test_off_by_default_sets_no_v2,
    test_on_with_every_value_renders_v2_and_the_key,
    test_on_without_a_needed_value_refuses_and_names_it,
    test_off_needs_none_of_them,
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

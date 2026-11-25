#!/usr/bin/env python3
"""Render the switch chart's sign-in settings, and check each refusal.

How people sign in is set in `switchCore.oidc` (single sign-on on, and the
password form) and `switchCore.signIn` (the generic OIDC client or WorkOS
AuthKit), and `switchCore.organizationDirectory` decides where organizations
are kept. The chart refuses the combinations switch-core refuses at startup
(config.py), so a bad one fails the render instead of a pod. This checks the
environment each good combination gives switch-core, and the reason each bad
one names. These are the promises deploy/remote/helm/switch/values.yaml makes
about `switchCore.signIn` and `passwordLoginEnabled`.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_chart_sign_in.py
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
BASE = "deploy/remote/helm/render-check-values.yaml"
RELEASE = "rel"

AUTHKIT = [
    "switchCore.oidc.enabled=true",
    "switchCore.signIn.provider=workos",
    "switchCore.signIn.workosClientId=client_EXAMPLE",
    "switchCore.oidc.redirectUrl=https://switch.example.test/gateway/auth/oidc/callback",
    "secrets.workosApiKey=placeholder",
    "secrets.gatewayAdminPassword=placeholder",
]
DIRECTORY = [
    "switchCore.organizationDirectory.mode=workos",
    "switchCore.signup.mode=invite_only",
]
GENERIC = [
    "switchCore.oidc.enabled=true",
    "switchCore.oidc.issuerUrl=https://idp.example.test",
    "switchCore.oidc.clientId=client",
    "secrets.gatewayOidcClientSecret=placeholder",
    "secrets.gatewayAdminPassword=placeholder",
]


def render(settings: list[str]) -> subprocess.CompletedProcess[str]:
    args = ["helm", "template", RELEASE, CHART, "-f", BASE]
    for setting in settings:
        args += ["--set", setting]
    return subprocess.run(args, capture_output=True, text=True, check=False)


def core_env(settings: list[str]) -> dict[str, str]:
    result = render(settings)
    if result.returncode != 0:
        raise AssertionError(f"render failed: {result.stderr.strip()}")
    for document in yaml.safe_load_all(result.stdout):
        if not isinstance(document, dict) or document.get("kind") != "Deployment":
            continue
        if not document["metadata"]["name"].endswith("switch-core"):
            continue
        containers: list[dict[str, Any]] = document["spec"]["template"]["spec"][
            "containers"
        ]
        return {
            entry["name"]: entry.get("value", "<from secret>")
            for entry in containers[0].get("env", [])
        }
    raise AssertionError("no switch-core Deployment rendered")


def refused(settings: list[str], reason: str) -> None:
    result = render(settings)
    if result.returncode == 0:
        raise AssertionError(f"rendered, expected a refusal naming {reason!r}")
    if reason not in result.stderr:
        raise AssertionError(f"refused for another reason: {result.stderr.strip()}")


def check_authkit_with_the_directory() -> None:
    env = core_env([*AUTHKIT, *DIRECTORY])
    assert env["GATEWAY_SIGN_IN_PROVIDER"] == "workos", env
    assert env["ORGANIZATION_DIRECTORY"] == "workos", env
    assert env["GATEWAY_PASSWORD_LOGIN_ENABLED"] == "false", env
    assert env["WORKOS_CLIENT_ID"] == "client_EXAMPLE", env


def check_a_password_form_set_on_under_the_directory_wins() -> None:
    env = core_env([*AUTHKIT, *DIRECTORY, "switchCore.oidc.passwordLoginEnabled=true"])
    assert env["GATEWAY_PASSWORD_LOGIN_ENABLED"] == "true", env


def check_generic_oidc_keeps_the_password_form() -> None:
    env = core_env(GENERIC)
    assert env["GATEWAY_PASSWORD_LOGIN_ENABLED"] == "true", env
    assert "GATEWAY_SIGN_IN_PROVIDER" not in env, env


def check_the_directory_refuses_the_connect_sign_in() -> None:
    refused(
        [*GENERIC, *DIRECTORY, "secrets.workosApiKey=placeholder"],
        "signIn.provider workos",
    )


def check_authkit_without_its_application_is_refused() -> None:
    refused([*AUTHKIT, "switchCore.signIn.workosClientId="], "signIn.workosClientId")


def check_authkit_without_its_key_is_refused() -> None:
    refused([*AUTHKIT, "secrets.workosApiKey="], "secrets.workosApiKey")


CHECKS = [
    check_authkit_with_the_directory,
    check_a_password_form_set_on_under_the_directory_wins,
    check_generic_oidc_keeps_the_password_form,
    check_the_directory_refuses_the_connect_sign_in,
    check_authkit_without_its_application_is_refused,
    check_authkit_without_its_key_is_refused,
]


def main() -> int:
    failed = 0
    for check in CHECKS:
        try:
            check()
        except AssertionError as error:
            failed += 1
            print(f"FAIL {check.__name__}: {error}")
        else:
            print(f"ok   {check.__name__}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

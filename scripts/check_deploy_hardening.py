#!/usr/bin/env python3
"""Check the hardening the deployment files promise, before a deployment finds out.

What Switch ships to run it (the Helm chart, the compose files, the images'
Dockerfiles and nginx config) carries security settings that nothing else
would notice going missing: a render or a `docker compose config` looks the
same to a reader with or without them. Each check here names one promise and
fails when a change breaks it:

* the gateway's nginx sends the dashboard's own files with a
  Content-Security-Policy that refuses framing and foreign scripts, nosniff
  and a same-origin Referrer-Policy, and the chart's copy of that config is
  the image's.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_deploy_hardening.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
BASE = "deploy/remote/helm/render-check-values.yaml"
RELEASE = "rel"
NGINX_CONF = Path("deploy/shared_resources/gateway-nginx.conf")


def render(*args: str) -> list[dict[str, Any]]:
    out = subprocess.run(
        ["helm", "template", RELEASE, CHART, "-f", BASE, *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [doc for doc in yaml.safe_load_all(out) if doc]


def nginx_headers(conf: str, location: str) -> dict[str, str]:
    """The `add_header` directives of one `location` block, by header name."""
    match = re.search(
        rf"location {re.escape(location)} \{{(?P<body>.*?)\n\s*\}}", conf, re.S
    )
    assert match, f"no `location {location}` block"
    headers: dict[str, str] = {}
    for line in match["body"].splitlines():
        directive = re.match(r'\s*add_header\s+(\S+)\s+("[^"]*"|\S+)\s*(always)?;', line)
        if directive:
            assert directive[3], f"{directive[1]} is not sent `always`, so not on errors"
            headers[directive[1].lower()] = directive[2].strip('"')
    return headers


def test_the_dashboard_files_carry_the_security_headers() -> None:
    headers = nginx_headers(NGINX_CONF.read_text(), "/")
    for name in (
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
    ):
        assert name in headers, f"the dashboard's files are sent without {name}"
    policy = {
        part.split()[0]: part.split()[1:]
        for part in (p.strip() for p in headers["content-security-policy"].split(";"))
        if part
    }
    assert policy["frame-ancestors"] == ["'none'"], policy
    assert policy["default-src"] == ["'self'"], policy
    assert policy["script-src"] == ["'self'"], policy
    assert policy["object-src"] == ["'none'"], policy
    assert headers["x-frame-options"] == "DENY"
    assert headers["x-content-type-options"] == "nosniff"
    # `no-referrer` would also strip Origin from the dashboard's own POSTs,
    # which switch-core's Origin check refuses.
    assert headers["referrer-policy"] == "same-origin"


def test_the_chart_serves_the_images_nginx_config() -> None:
    docs = render()
    configmap = next(
        d
        for d in docs
        if d["kind"] == "ConfigMap" and d["metadata"]["name"] == f"{RELEASE}-gateway-nginx"
    )
    rendered = configmap["data"]["default.conf"].replace(
        f"http://{RELEASE}-switch-core:8000", "http://switch:8000"
    )
    assert rendered == NGINX_CONF.read_text(), (
        "the chart's gateway nginx config (templates/gateway/configmap-nginx.yaml) "
        f"differs from {NGINX_CONF}, the one the gateway image ships"
    )


TESTS = [
    test_the_dashboard_files_carry_the_security_headers,
    test_the_chart_serves_the_images_nginx_config,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
        except Exception as exc:
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

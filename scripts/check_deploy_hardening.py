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
  the image's;
* every image Switch does not build itself is named by tag and digest: the
  bases of the images it ships, the third-party images the chart and the
  standalone compose run, and what CI runs with `docker run`. A tag can be
  moved to other content; a digest cannot.

Needs `helm` on PATH and PyYAML. Run from the repo root:

    python3 scripts/check_deploy_hardening.py
"""

from __future__ import annotations

import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

CHART = "deploy/remote/helm/switch"
BASE = "deploy/remote/helm/render-check-values.yaml"
RELEASE = "rel"
NGINX_CONF = Path("deploy/shared_resources/gateway-nginx.conf")
OPTIONAL = "deploy/remote/helm/render-check-optional-values.yaml"
DOCKERFILES = sorted(Path("deploy/shared_resources/images").glob("Dockerfile.*"))
STANDALONE_COMPOSE = Path("deploy/local/standalone-docker-compose.yml")
WORKFLOWS = sorted(Path(".github/workflows").glob("*.yml"))
# The chart's own images, which the release pins by digest when it packages
# the chart (scripts/pin_chart_images.py); in the repository they are
# placeholders.
FIRST_PARTY = {
    "switch-core",
    "gateway",
    "setup",
    "switch-decision",
    "switch-decision-strands",
}
PINNED = re.compile(
    r"^[a-z0-9][a-z0-9._/-]*:(?P<tag>[A-Za-z0-9][A-Za-z0-9._-]*)@sha256:[0-9a-f]{64}$"
)
IMAGE_WITH_TAG = re.compile(r"^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*(@.*)?$")


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


def unpinned(refs: dict[str, str]) -> list[str]:
    """`where: ref` for each reference not named by a version tag and a digest."""
    bad = []
    for where, ref in refs.items():
        match = PINNED.match(ref)
        if not match or match["tag"] == "latest":
            bad.append(f"{where}: {ref}")
    return bad


def dockerfile_images(path: Path) -> dict[str, str]:
    """Every image a Dockerfile builds from or copies out of, its stages aside."""
    refs: dict[str, str] = {}
    stages: set[str] = set()
    for number, line in enumerate(path.read_text().splitlines(), 1):
        words = line.split()
        if not words:
            continue
        if words[0].upper() == "FROM":
            args = [w for w in words[1:] if not w.startswith("--")]
            if args[0] not in stages:
                refs[f"{path}:{number}"] = args[0]
            if len(args) == 3 and args[1].upper() == "AS":
                stages.add(args[2])
        for word in words:
            for prefix in ("--from=", "from="):
                if word.startswith(prefix) or word.startswith(f"--mount={prefix}"):
                    ref = word.split(prefix, 1)[1].split(",", 1)[0]
                    if ref not in stages:
                        refs[f"{path}:{number}"] = ref
    return refs


def chart_images(docs: list[dict[str, Any]]) -> list[tuple[str, str]]:
    found = []
    for doc in docs:
        spec = doc.get("spec", {})
        pod = spec["template"]["spec"] if "template" in spec else spec
        for key in ("initContainers", "containers"):
            for container in pod.get(key) or []:
                where = f"{doc['kind']}/{doc['metadata']['name']} {container['name']}"
                found.append((where, container["image"]))
    return found


def workflow_images(path: Path) -> dict[str, str]:
    """The images each `docker run` in a workflow names."""
    refs: dict[str, str] = {}
    text = path.read_text().replace("\\\n", " ")
    for number, line in enumerate(text.splitlines(), 1):
        if "docker run" not in line:
            continue
        for word in shlex.split(line.split("docker run", 1)[1], comments=True):
            if IMAGE_WITH_TAG.match(word):
                refs[f"{path}:{number}"] = word
    return refs


def test_third_party_images_are_pinned_by_digest() -> None:
    refs: dict[str, str] = {}
    for dockerfile in DOCKERFILES:
        refs.update(dockerfile_images(dockerfile))
    compose = yaml.safe_load(STANDALONE_COMPOSE.read_text())
    for name, service in compose["services"].items():
        image = service.get("image", "")
        if not image.startswith("${SWITCH_REGISTRY"):
            refs[f"{STANDALONE_COMPOSE} {name}"] = image
    for args in ((), ("-f", OPTIONAL)):
        for where, image in chart_images(render(*args)):
            name = image.split("@", 1)[0].rsplit(":", 1)[0].rsplit("/", 1)[-1]
            if name not in FIRST_PARTY:
                refs[f"chart {where}"] = image
    for workflow in WORKFLOWS:
        refs.update(workflow_images(workflow))
    assert any("gitleaks" in ref for ref in refs.values()), "found no docker run image"
    assert any(ref.startswith("postgres:") for ref in refs.values()), refs
    bad = unpinned(refs)
    assert not bad, "named by tag alone, or by latest:\n  " + "\n  ".join(bad)


TESTS = [
    test_the_dashboard_files_carry_the_security_headers,
    test_the_chart_serves_the_images_nginx_config,
    test_third_party_images_are_pinned_by_digest,
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

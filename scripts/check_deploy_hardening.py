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
  moved to other content; a digest cannot;
* every pod the chart runs is unprivileged: not root (as the user its image
  runs as), no privilege escalation, no capabilities, the runtime's seccomp
  profile, a read-only root filesystem with emptyDirs where it writes
  (Mattermost's main container aside), and no ServiceAccount token, since
  nothing in it calls the Kubernetes API;
* the in-cluster Postgres admits only the release's own clients, and
  switch-core, the gateway and Mattermost admit only who `networkPolicy.
  ingressFrom` names once it names anyone;
* the compose files publish Postgres and Mattermost on loopback whatever
  SWITCH_BIND_ADDR says: it opens only Switch's own ports (the API and the
  dashboard), and each of the two has a variable of its own.

Needs `helm` and `docker compose` (no daemon) on PATH, and PyYAML. Run from
the repo root:

    python3 scripts/check_deploy_hardening.py
"""

from __future__ import annotations

import json
import os
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
        directive = re.match(
            r'\s*add_header\s+(\S+)\s+("[^"]*"|\S+)\s*(always)?;', line
        )
        if directive:
            assert directive[3], (
                f"{directive[1]} is not sent `always`, so not on errors"
            )
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
        if d["kind"] == "ConfigMap"
        and d["metadata"]["name"] == f"{RELEASE}-gateway-nginx"
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


INGRESS_FROM = [
    "--set",
    "networkPolicy.ingressFrom[0].namespaceSelector.matchLabels.name=ingress",
]
CALLBACKS = ["--set", "switchCore.collaborationCallback.enabled=true"]
# Where each workload writes, over its read-only root filesystem.
WRITABLE = {
    "switch-core": {"/tmp"},
    "migrate": {"/tmp"},
    "create-runtime-role": {"/tmp"},
    "gateway": {"/tmp", "/var/cache/nginx"},
    "postgresql": {"/tmp", "/var/run/postgresql", "/var/lib/postgresql/data"},
    "mattermost": {"/mattermost/data"},
}
# Containers whose root filesystem stays writable, and why.
WRITABLE_ROOT = {
    # Rewrites its web app's root.html, inside the image, at every start for
    # the path in its site URL.
    "mattermost",
}
# The images the chart runs as the user they declare (`USER` in their Dockerfile).
IMAGE_USERS = {
    "switch-core": "Dockerfile.switch",
    "migrate": "Dockerfile.switch",
    "gateway": "Dockerfile.gateway",
    "setup": "Dockerfile.setup",
}


def workloads(
    docs: list[dict[str, Any]],
) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Each pod-running object, by component: (object, pod spec)."""
    found = {}
    for doc in docs:
        if doc["kind"] not in ("Deployment", "StatefulSet", "Job", "Pod"):
            continue
        spec = doc["spec"]
        pod = spec["template"] if "template" in spec else doc
        component = pod["metadata"]["labels"].get("app.kubernetes.io/component")
        assert component, f"{doc['kind']}/{doc['metadata']['name']} names no component"
        found[component] = (doc, pod["spec"])
    return found


def policies(docs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        doc["spec"]["podSelector"]["matchLabels"]["app.kubernetes.io/component"]: doc[
            "spec"
        ]
        for doc in docs
        if doc["kind"] == "NetworkPolicy"
    }


def image_user(dockerfile: str) -> tuple[int, int]:
    users = re.findall(
        r"^USER (\d+):(\d+)$",
        (Path("deploy/shared_resources/images") / dockerfile).read_text(),
        re.M,
    )
    assert len(users) == 1, f"{dockerfile} declares no single numeric USER"
    return int(users[0][0]), int(users[0][1])


def test_every_pod_runs_unprivileged() -> None:
    renders = (
        render(),
        render("-f", OPTIONAL, *CALLBACKS),
        render(
            "-f",
            OPTIONAL,
            "--set",
            "postgresql.mode=existing",
            "--set",
            "postgresql.external.host=db.example.com",
        ),
    )
    seen: set[str] = set()
    for docs in renders:
        for component, (doc, pod) in workloads(docs).items():
            where = f"{doc['kind']}/{doc['metadata']['name']}"
            seen.add(component)
            assert pod.get("automountServiceAccountToken") is False, (
                f"{where} mounts a ServiceAccount token"
            )
            if component == "decision":
                continue
            pod_context = pod.get("securityContext") or {}
            for container in [*(pod.get("initContainers") or []), *pod["containers"]]:
                name = f"{where} {container['name']}"
                context = {**pod_context, **(container.get("securityContext") or {})}
                assert context.get("runAsNonRoot") is True, f"{name} may run as root"
                assert context.get("runAsUser", 0) != 0, (
                    f"{name} names no non-root user"
                )
                assert context.get("seccompProfile") == {"type": "RuntimeDefault"}, name
                assert context.get("allowPrivilegeEscalation") is False, name
                assert context.get("readOnlyRootFilesystem") is (
                    component not in WRITABLE_ROOT
                    or container is not pod["containers"][0]
                ), name
                assert context.get("capabilities", {}).get("drop") == ["ALL"], name
            main = pod["containers"][0]
            mounts = {m["mountPath"] for m in main.get("volumeMounts") or []}
            missing = WRITABLE.get(component, set()) - mounts
            assert not missing, f"{where} has nowhere to write {sorted(missing)}"
            if component in IMAGE_USERS:
                uid, gid = image_user(IMAGE_USERS[component])
                assert (pod_context["runAsUser"], pod_context["runAsGroup"]) == (
                    uid,
                    gid,
                ), (
                    f"{where} runs as {pod_context['runAsUser']}:{pod_context['runAsGroup']}, "
                    f"its image as {uid}:{gid}"
                )
    expected = {
        "switch-core",
        "gateway",
        "postgresql",
        "mattermost",
        "setup",
        "migrate",
        "create-runtime-role",
        "teams-listener-test",
        "decision",
    }
    assert expected <= seen, f"never rendered: {sorted(expected - seen)}"


def peers(rule: dict[str, Any]) -> list[str]:
    return [
        p["podSelector"]["matchLabels"]["app.kubernetes.io/component"]
        if set(p) == {"podSelector"}
        else "outside"
        for p in rule["from"]
    ]


def test_postgres_admits_only_the_release_clients() -> None:
    policy = policies(render())["postgresql"]
    assert policy["policyTypes"] == ["Ingress"]
    [rule] = policy["ingress"]
    assert sorted(peers(rule)) == sorted(
        ["switch-core", "create-runtime-role", "migrate", "mattermost"]
    ), rule
    assert rule["ports"] == [{"protocol": "TCP", "port": 5432}]
    assert "postgresql" not in policies(
        render(
            "--set",
            "postgresql.mode=existing",
            "--set",
            "postgresql.external.host=db.example.com",
        )
    )


def test_what_serves_the_outside_admits_only_who_ingress_from_names() -> None:
    # Without ingressFrom: no policy that would admit everyone.
    assert set(policies(render())) == {"postgresql"}
    docs = render("-f", OPTIONAL, *CALLBACKS, *INGRESS_FROM)
    found = policies(docs)
    outside = [{"namespaceSelector": {"matchLabels": {"name": "ingress"}}}]
    core = found["switch-core"]["ingress"]
    assert core[0]["from"] == outside
    assert {p["port"] for p in core[0]["ports"]} == {8000, 3978, 8081}
    assert {tuple(peers(r)): {p["port"] for p in r["ports"]} for r in core[1:]} == {
        ("gateway", "setup"): {8000},
        ("mattermost",): {8081},
        ("teams-listener-test",): {3978},
    }
    assert found["gateway"]["ingress"] == [
        {"from": outside, "ports": [{"protocol": "TCP", "port": 3000}]}
    ]
    [mattermost] = found["mattermost"]["ingress"]
    assert peers(mattermost) == ["outside", "switch-core", "setup"]
    assert mattermost["ports"] == [{"protocol": "TCP", "port": 8065}]
    # Off: none of the chart's own, the decision service's (its own switch) aside.
    off = policies(
        render("-f", OPTIONAL, *INGRESS_FROM, "--set", "networkPolicy.enabled=false")
    )
    assert set(off) == {"decision"}, off


DEV_COMPOSE = Path("deploy/local/docker-compose.yml")
# The standalone stack's services that serve people and agents off this
# machine once SWITCH_BIND_ADDR says so.
APP_SERVICES = {"switch", "gateway"}


def published(compose: Path, **env: str) -> dict[tuple[str, int], str]:
    """What each service's published ports bind to, `docker compose config`
    reading only `env`: (service, container port) -> host address."""
    out = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            os.devnull,
            "-f",
            str(compose),
            "--profile",
            "*",
            "config",
            "--format",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
        env={
            "PATH": os.environ["PATH"],
            "HOME": os.environ.get("HOME", "/"),
            "SWITCH_VERSION": "0.0.0-check",
            "SECRET_KEYS": "check:" + "0" * 40,
            **env,
        },
    ).stdout
    binds = {}
    for name, service in json.loads(out)["services"].items():
        for port in service.get("ports") or []:
            binds[(name, int(port["target"]))] = port.get("host_ip", "")
    return binds


def opened(binds: dict[tuple[str, int], str]) -> set[str]:
    return {name for (name, _), host in binds.items() if host != "127.0.0.1"}


def test_only_switch_leaves_loopback_when_its_bind_address_says_so() -> None:
    standalone = published(STANDALONE_COMPOSE, SWITCH_BIND_ADDR="0.0.0.0")
    assert {name for name, _ in standalone} >= {"postgres", "mattermost", *APP_SERVICES}
    assert opened(standalone) == APP_SERVICES, standalone
    assert opened(published(STANDALONE_COMPOSE)) == set()
    assert opened(published(DEV_COMPOSE, SWITCH_BIND_ADDR="0.0.0.0")) == set()
    for compose in (STANDALONE_COMPOSE, DEV_COMPOSE):
        assert opened(published(compose, POSTGRES_BIND_ADDR="0.0.0.0")) == {"postgres"}
        assert opened(published(compose, MATTERMOST_BIND_ADDR="0.0.0.0")) == {
            "mattermost"
        }


TESTS = [
    test_the_dashboard_files_carry_the_security_headers,
    test_the_chart_serves_the_images_nginx_config,
    test_third_party_images_are_pinned_by_digest,
    test_every_pod_runs_unprivileged,
    test_postgres_admits_only_the_release_clients,
    test_what_serves_the_outside_admits_only_who_ingress_from_names,
    test_only_switch_leaves_loopback_when_its_bind_address_says_so,
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

"""`observability/monitors.json`, the box cluster's own monitors, and the squid pod tags they rely on."""

from __future__ import annotations

import json
import re
from pathlib import Path

HOSTED = Path(__file__).resolve().parents[2]
MONITORS = HOSTED / "observability" / "monitors.json"
MANIFEST = HOSTED / "k8s" / "50-egress-proxy.yaml"
SERVICE = "switch-egress-proxy"
LISTS_SERVICE = "switch-egress-lists"
LISTS_MANIFEST = HOSTED / "k8s" / "51-egress-lists.yaml"


def _monitors() -> list[dict]:
    monitors = json.loads(MONITORS.read_text())
    assert isinstance(monitors, list) and monitors
    return monitors


def _squid_deployment() -> str:
    for doc in MANIFEST.read_text().split("\n---\n"):
        if re.search(r"^kind: Deployment$", doc, re.M) and re.search(r"^  name: squid$", doc, re.M):
            return doc
    raise AssertionError("no squid Deployment")


def test_every_monitor_is_importable_and_names_no_deployment() -> None:
    names = [m["name"] for m in _monitors()]
    assert len(set(names)) == len(names)
    for m in _monitors():
        assert "REPLACE-WITH-ENV" in m["name"]
        assert "@REPLACE-WITH-NOTIFICATION-HANDLE" in m["message"]
        assert "env:REPLACE-WITH-ENV" in m["tags"]
        assert {
            f"service:{SERVICE}",
            f"service:{LISTS_SERVICE}",
            "service:switch-hosted-remover",
            "service:switch-hosted-provisioner",
        } & set(m["tags"])
        # No log text in a notification: the lines carry counts only, but samples aren't needed.
        assert m["options"].get("enable_logs_sample") is False


def test_the_parse_monitor_matches_the_wrapper_line() -> None:
    (m,) = [m for m in _monitors() if "squid -k parse" in m["query"]]
    search = re.match(
        r'logs\("(.*)"\)\.index\("\*"\)\.rollup\("count"\)\.last\("5m"\) > 0$', m["query"]
    )
    assert search, m["query"]
    assert search.group(1).startswith(f"service:{SERVICE} env:REPLACE-WITH-ENV ")
    phrase = re.search(r'\\"(.+)\\"', search.group(1)).group(1)
    # The wrapper logs exactly this phrase while a bad box file is held back.
    assert f"WARN box files {phrase};" in MANIFEST.read_text()


def test_the_squid_pod_carries_the_service_the_monitors_use() -> None:
    doc = _squid_deployment()
    template = doc[doc.index("\n  template:\n") :]
    assert f"\n        tags.datadoghq.com/service: {SERVICE}\n" in template
    assert "\n      - command:\n" in template and "\n        name: squid\n" in template
    (line,) = re.findall(r"^        ad\.datadoghq\.com/squid\.logs: '(.*)'$", template, re.M)
    assert json.loads(line) == [{"source": "squid", "service": SERVICE}]


def test_no_box_destination_reaches_datadog() -> None:
    """squid's access and cache logs stay in files, and the sidecar that tails the access log is dropped whole."""
    text = MANIFEST.read_text()
    # Every access log line (the main one, and the fixed connection-limit line) goes to the same in-cluster file.
    access = re.findall(r"^    access_log (.+)$", text, re.M)
    (cache,) = re.findall(r"^    cache_log (.+)$", text, re.M)
    assert access
    for target in (*access, cache):
        assert target.split()[0].removeprefix("stdio:").startswith("/var/log/squid/"), target
        assert "stdout" not in target and "stderr" not in target and "syslog" not in target, target
    doc = _squid_deployment()
    template = doc[doc.index("\n  template:\n") :]
    (line,) = re.findall(r"^        ad\.datadoghq\.com/access-log\.logs: '(.*)'$", template, re.M)
    (cfg,) = json.loads(line)
    assert cfg["log_processing_rules"] == [
        {"type": "exclude_at_match", "name": "never_ship_box_destinations", "pattern": "."}
    ]
    assert "\n        name: access-log\n" in template


def test_the_held_list_monitor_matches_the_generators_alert_line() -> None:
    """The generator logs `egress-held ALERT` whenever it can't read the held list and keeps every login; the monitor
    alerts on it, on the generator's own service tag, which its pod carries."""
    (m,) = [m for m in _monitors() if "egress-held ALERT" in m["query"]]
    assert m["query"].startswith(f'logs("service:{LISTS_SERVICE} env:REPLACE-WITH-ENV ')
    source = (
        HOSTED / "controller" / "src" / "switch_hosted_controller" / "egress_lists.py"
    ).read_text()
    assert source.count('"egress-held ALERT:') == 2
    doc = LISTS_MANIFEST.read_text()
    template = doc[doc.index("\n  template:\n") :]
    assert f"\n        tags.datadoghq.com/service: {LISTS_SERVICE}\n" in template
    (line,) = re.findall(r"^        ad\.datadoghq\.com/egress-lists\.logs: '(.*)'$", template, re.M)
    assert json.loads(line) == [{"source": LISTS_SERVICE, "service": LISTS_SERVICE}]
    assert "\n        name: egress-lists\n" in template


def _pod_template(manifest: Path, deployment: str) -> str:
    for doc in manifest.read_text().split("\n---\n"):
        if re.search(r"^kind: Deployment$", doc, re.M) and re.search(
            rf"^  name: {deployment}$", doc, re.M
        ):
            return doc[doc.index("\n  template:\n") :]
    raise AssertionError(deployment)


def _tags_its_logs(template: str, container: str, service: str) -> None:
    assert f"\n        tags.datadoghq.com/service: {service}\n" in template
    (line,) = re.findall(rf"^        ad\.datadoghq\.com/{container}\.logs: '(.*)'$", template, re.M)
    assert json.loads(line) == [{"source": service, "service": service}]
    assert f"\n        name: {container}\n" in template


def test_the_remover_monitor_matches_its_alert_lines_and_pod_tag() -> None:
    """Every refusal the remover makes logs `Remover ALERT`; the monitor pages on it, on the remover's own service."""
    (m,) = [m for m in _monitors() if "Remover ALERT" in m["query"]]
    assert m["query"].startswith('logs("service:switch-hosted-remover env:REPLACE-WITH-ENV ')
    source = (HOSTED / "controller" / "src" / "switch_hosted_controller" / "remover.py").read_text()
    assert (
        source.count('"Remover ALERT:') == 3
    )  # out of form, another machine's namespace, Core says no
    _tags_its_logs(
        _pod_template(HOSTED / "k8s" / "46-switch-hosted-remover.yaml", "switch-hosted-remover"),
        "remover",
        "switch-hosted-remover",
    )


def test_the_operator_removal_monitor_matches_exactly_its_removal_alert_lines() -> None:
    """The operator's removal and retired-name refusals log `Box operator ALERT` with "removal" or "retired"; its
    other alerts (a bound pool box's owner, an image) don't, so this monitor pages on removals only."""
    (m,) = [m for m in _monitors() if "Box operator ALERT" in m["query"]]
    assert m["query"].startswith('logs("service:switch-hosted-provisioner env:REPLACE-WITH-ENV ')
    assert '\\"Box operator ALERT\\" (removal OR retired)' in m["query"]
    source = (
        HOSTED / "controller" / "src" / "switch_hosted_controller" / "box_operator.py"
    ).read_text()
    lines = re.findall(r'"Box operator ALERT: ([^"]*)"', source)
    matched = [line for line in lines if "removal" in line or "retired" in line]
    assert len(matched) == 4 and len(lines) == 6
    _tags_its_logs(
        _pod_template(HOSTED / "k8s" / "40-switch-hosted.yaml", "switch-hosted-provisioner"),
        "provisioner",
        "switch-hosted-provisioner",
    )

"""`observability/monitors.json`, the box cluster's own monitors, and the squid pod tags they rely on."""

from __future__ import annotations

import json
import re
from pathlib import Path

HOSTED = Path(__file__).resolve().parents[2]
MONITORS = HOSTED / "observability" / "monitors.json"
MANIFEST = HOSTED / "k8s" / "50-egress-proxy.yaml"
SERVICE = "switch-egress-proxy"


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
        assert {f"service:{SERVICE}", "env:REPLACE-WITH-ENV"} <= set(m["tags"])
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
    (access,) = re.findall(r"^    access_log (.+)$", text, re.M)
    (cache,) = re.findall(r"^    cache_log (.+)$", text, re.M)
    for target in (access, cache):
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

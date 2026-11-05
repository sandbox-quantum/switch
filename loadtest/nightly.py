"""The load test every night on staging, run from pods inside the cluster.

Three commands, each one CronJob of the deployment's load test chart:

  up     Before the run, from a small pod on the shared nodes: staging's node
         group to its night size and the harness node up, then switch-core to
         its night pod count, waiting until every pod is ready.
  run    On the harness node: the agents kept from earlier nights (made again
         when they are missing), an idle window, the realistic steps (one
         message per agent every so many minutes), then the ramp until a step
         breaks. Adds the workers' numbers up, stores the night in S3, sends
         the numbers to Datadog and the report to the webhook and the Switch
         room, then puts staging back to its day size.
  down   The safety net, after the run's deadline: the day sizes again,
         whatever happened, and a report for a night that left no result.

    python loadtest/nightly.py up|run|down

Everything it needs comes from the environment, which the chart sets (see
Config.from_env). This is the one part of the harness that changes anything in
Kubernetes or AWS: switch-core's pod count and two node groups' sizes, all
named in that environment. The harness itself stays read-only, and refuses
the pilot's namespace and hostnames.

A run is one batch of agents per worker process, because one process tops out
around 60 messages a second: worker i always uses seed i and the agents of
batch i, so every night loads the same agents and rooms, and its numbers
compare with the night before.
"""

from __future__ import annotations

import json
import os
import re
import signal
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

try:
    import boto3
except ImportError:  # the pods add it (`uv run --with boto3`); the tests run without
    boto3 = None

HERE = Path(__file__).parent
RUNS = HERE / "runs"
sys.path.insert(0, str(HERE))

from kube import guard_target  # noqa: E402
from run import broken as window_broken  # noqa: E402

# A worker's log lines that say where it is.
WAITING = "waiting for"
FAILED = ("run failed", "Traceback", "refused:")
BROKE = " broke ("
# Seconds between starting one worker and the next, so their sign-ins and
# workspace switches do not overlap, nor their agents' first connects.
STAGGER = 3.0
CONNECTED = re.compile(r"step \d+: (\d+)/(\d+) agents connected")
# Below this share of its agents connected, a worker's kept batch is taken as
# gone (deleted, or the database replaced), and the night makes them again.
CONNECTED_ENOUGH = 0.99


def _list(value: str, kind=float) -> list:
    return [kind(x) for x in value.split(",") if x.strip()]


@dataclass(frozen=True)
class Config:
    """The night's settings, from the environment the chart gives the pods."""

    namespace: str
    deployment: str
    api_url: str
    workspace: str
    cluster: str
    region: str
    # Node groups by name prefix: EKS adds a creation suffix to the names.
    core_nodegroup: str
    harness_nodegroup: str
    night_nodes: int
    day_nodes: int
    night_pods: int
    day_pods: int
    workers: int
    agents: int
    controllers: int
    room_size: int
    idle_seconds: float
    # One message per agent every this many minutes, one step each.
    realistic_minutes: list[float]
    realistic_seconds: float
    # Messages a second over every agent, one step each, until one breaks.
    ramp: list[float]
    ramp_seconds: float
    drain_seconds: float
    # UTC, HH:MM: workers still running then are stopped.
    deadline: str
    bucket: str
    prefix: str
    rds_instance: str
    environment: str
    # Empty inside the cluster (the pod's service account); a context name for
    # a rehearsal from a machine with a kubeconfig.
    kube_context: str = ""
    dd_api_key: str = field(repr=False, default="")
    dd_site: str = "datadoghq.com"
    webhook_url: str = field(repr=False, default="")
    # A Switch room the report also goes to, posted by an agent in that room
    # with its own token. Empty, no post.
    switch_url: str = ""
    switch_agent_id: str = ""
    switch_room_id: str = ""
    switch_token: str = field(repr=False, default="")
    dashboard_url: str = ""

    @classmethod
    def from_env(cls, env: dict | None = None) -> Config:
        e = os.environ if env is None else env

        def get(name: str, default: str | None = None) -> str:
            value = e.get(f"LOADTEST_{name}", default)
            if value is None:
                raise SystemExit(f"LOADTEST_{name} is not set")
            return value

        cfg = cls(
            namespace=get("NAMESPACE"),
            deployment=get("DEPLOYMENT"),
            api_url=get("API_URL"),
            workspace=get("WORKSPACE", "load-tests"),
            cluster=get("CLUSTER"),
            region=e.get("AWS_REGION") or e.get("AWS_DEFAULT_REGION", ""),
            core_nodegroup=get("CORE_NODEGROUP"),
            harness_nodegroup=get("HARNESS_NODEGROUP"),
            night_nodes=int(get("NIGHT_NODES", "4")),
            day_nodes=int(get("DAY_NODES", "1")),
            night_pods=int(get("NIGHT_PODS", "12")),
            day_pods=int(get("DAY_PODS", "1")),
            workers=int(get("WORKERS", "10")),
            agents=int(get("AGENTS", "10000")),
            controllers=int(get("CONTROLLERS", "500")),
            room_size=int(get("ROOM_SIZE", "4")),
            idle_seconds=float(get("IDLE_SECONDS", "120")),
            realistic_minutes=_list(get("REALISTIC_MINUTES", "30,10,5,3")),
            realistic_seconds=float(get("REALISTIC_SECONDS", "600")),
            ramp=_list(get("RAMP", "150,250,300,350,400,450,500")),
            ramp_seconds=float(get("RAMP_SECONDS", "60")),
            drain_seconds=float(get("DRAIN_SECONDS", "60")),
            deadline=get("DEADLINE", "04:30"),
            bucket=get("BUCKET"),
            prefix=get("PREFIX", "staging/").rstrip("/") + "/",
            rds_instance=get("RDS_INSTANCE", ""),
            environment=get("ENVIRONMENT", "staging"),
            kube_context=get("KUBE_CONTEXT", ""),
            dd_api_key=e.get("DD_API_KEY", ""),
            dd_site=e.get("DD_SITE", "datadoghq.com"),
            webhook_url=get("WEBHOOK_URL", ""),
            switch_url=get("SWITCH_URL", ""),
            switch_agent_id=get("SWITCH_AGENT_ID", ""),
            switch_room_id=get("SWITCH_ROOM_ID", ""),
            switch_token=get("SWITCH_TOKEN", ""),
            dashboard_url=get("DASHBOARD_URL", ""),
        )
        cfg.check()
        return cfg

    def check(self) -> None:
        # The run's workers refuse the pilot themselves, but `up` and `down`
        # scale whatever these name before any of them starts.
        guard_target(self.namespace, self.api_url)
        if not self.region:
            raise SystemExit("AWS_REGION is not set")
        if self.agents % self.workers or self.controllers % self.workers:
            raise SystemExit(
                "LOADTEST_AGENTS and _CONTROLLERS must split evenly over the workers"
            )
        rates = self.total_rates()
        if rates != sorted(rates) or len(set(rates)) != len(rates):
            raise SystemExit(
                "every realistic step must send less than the first ramp step: "
                f"{', '.join(f'{r:g}' for r in rates)} msg/s"
            )
        if self.day_nodes > self.night_nodes or self.day_pods > self.night_pods:
            raise SystemExit("the day sizes must not be above the night sizes")

    @property
    def per_agents(self) -> int:
        return self.agents // self.workers

    @property
    def per_controllers(self) -> int:
        return self.controllers // self.workers

    @property
    def per_rooms(self) -> int:
        # The harness's default: half the agents, so with rooms of 4 each
        # agent is in two rooms.
        return self.per_agents // 2

    def realistic_rates(self) -> list[float]:
        """Total messages a second for each realistic step."""
        return [self.agents / (m * 60) for m in self.realistic_minutes]

    def total_rates(self) -> list[float]:
        return [*self.realistic_rates(), *self.ramp]

    def worker_rates(self) -> list[float]:
        """Each worker's share of every step, rounded as the harness names it."""
        return [round(r / self.workers, 4) for r in self.total_rates()]

    def durations(self) -> list[float]:
        return [self.realistic_seconds] * len(self.realistic_minutes) + [
            self.ramp_seconds
        ] * len(self.ramp)

    def step_labels(self) -> list[str]:
        return [f"every {m:g} min" for m in self.realistic_minutes] + [
            f"{r:g} msg/s" for r in self.ramp
        ]

    def population_shape(self) -> dict:
        """What decides which agents and rooms the harness makes: a kept batch
        is only reused by a run of the same shape."""
        return {
            "workers": self.workers,
            "per_agents": self.per_agents,
            "per_controllers": self.per_controllers,
            "per_rooms": self.per_rooms,
            "room_size": self.room_size,
            "workspace": self.workspace,
        }


# ── Combining the workers ─────────────────────────────────────────────────────


def _median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def combine(cfg: Config, worker_summaries: list[list[dict]]) -> list[dict]:
    """One row per measured window, adding the workers up by position: each
    worker names its windows by its own share of the rate, in the same order.
    A row is broken when any worker's window is.

    Rates, deliveries, errors and missing deliveries are summed. Delivery p99
    is the worst worker's, an upper bound on the true combined p99, and p50
    the median of the workers'. Pod and database figures are the first
    worker's: every worker samples the same pods and database."""
    if not worker_summaries:
        return []
    n = min(len(s) for s in worker_summaries)
    labels = ["idle", *cfg.step_labels()]
    kinds = (
        ["idle"] + ["realistic"] * len(cfg.realistic_minutes) + ["ramp"] * len(cfg.ramp)
    )
    targets = [0.0, *cfg.total_rates()]
    rows = []
    for k in range(n):
        ph = [s[k] for s in worker_summaries]
        first = ph[0]
        cpu = [
            v["cpu_pct_avg"]
            for v in first["pods"].values()
            if v.get("cpu_pct_avg") is not None
        ]
        rds = first.get("rds") or {}
        p99 = max((p["delivery_ms_p99"] or 0) for p in ph)
        errors = sum(p["errors"] for p in ph)
        missing = sum(p["deliveries_missing"] for p in ph)
        # Broken when any worker's window broke by the harness's own rule
        # (run.broken), which is also what stops that worker stepping.
        why = next(
            (
                f"{w} (worker {i + 1})"
                for i, p in enumerate(ph)
                if (w := window_broken(p))
            ),
            None,
        )
        rows.append(
            {
                "label": labels[k] if k < len(labels) else first["phase"],
                "kind": kinds[k] if k < len(kinds) else "extra",
                "target_per_s": round(targets[k], 2) if k < len(targets) else None,
                "workers": len(ph),
                "agents": sum(p["agents_target"] for p in ph),
                "agents_connected_min": sum(p["agents_connected_min"] or 0 for p in ph),
                "sent_per_s": round(sum(p["messages_sent_per_s"] or 0 for p in ph), 2),
                "delivery_ms_p50": _median(
                    [
                        p["delivery_ms_p50"]
                        for p in ph
                        if p["delivery_ms_p50"] is not None
                    ]
                ),
                "delivery_ms_p99": p99 or None,
                "errors": errors,
                "missing": missing,
                "pods": len(first["pods"]),
                "pod_cpu_avg_pct": round(sum(cpu) / len(cpu), 1) if cpu else None,
                "pod_cpu_busiest_pct": round(max(cpu), 1) if cpu else None,
                "db_cpu_avg_pct": rds.get("cpu_avg"),
                "db_cpu_max_pct": rds.get("cpu_max"),
                "db_xact_per_s": first.get("db_xact_per_s_avg"),
                "harness_lag_ms_max": max((p["harness_lag_ms_max"] or 0) for p in ph),
                "stopped_early": any("stopped early" in p["phase"] for p in ph),
                "broken": why,
            }
        )
    return rows


def verdict(rows: list[dict], cfg: Config, failures: list[str]) -> dict:
    """What the night says: whether realistic load ran clean, and the highest
    ramp step every worker held. Any of `failures` fails the night."""
    realistic = [r for r in rows if r["kind"] == "realistic"]
    ramp = [r for r in rows if r["kind"] == "ramp"]
    realistic_ok = len(realistic) == len(cfg.realistic_minutes) and all(
        not r["broken"]
        and not r["errors"]
        and not r["missing"]
        and not r["stopped_early"]
        for r in realistic
    )
    held = [r for r in ramp if not r["broken"] and not r["stopped_early"]]
    broke = next((r for r in ramp if r["broken"]), None)
    complete = len(rows) >= 1 + len(cfg.realistic_minutes) and (
        broke is not None or len(ramp) == len(cfg.ramp)
    )
    return {
        "ok": realistic_ok and complete and not failures,
        "realistic_ok": realistic_ok,
        "complete": complete,
        "held_per_s": held[-1]["target_per_s"] if held else None,
        "held_sent_per_s": held[-1]["sent_per_s"] if held else None,
        "broke_at_per_s": broke["target_per_s"] if broke else None,
        "broke_why": broke["broken"] if broke else None,
        "realistic_top_p99_ms": realistic[-1]["delivery_ms_p99"] if realistic else None,
    }


def compare(result: dict, history: list[dict]) -> list[str]:
    """Lines comparing the night with the median of earlier nights, and a
    warning when it is clearly worse. Needs three earlier nights to say so."""
    past = [h for h in history if h.get("verdict", {}).get("complete")][-7:]
    if len(past) < 3:
        return [f"{len(past)} earlier night(s) on record; comparisons start at 3"]
    lines = []
    v = result["verdict"]
    held = [h["verdict"]["held_per_s"] for h in past if h["verdict"].get("held_per_s")]
    if held and v.get("held_per_s"):
        med = statistics.median(held)
        flag = "  ⚠️ lower" if v["held_per_s"] < 0.85 * med else ""
        lines.append(
            f"held {v['held_per_s']:g} msg/s, median of the last {len(held)}: {med:g}{flag}"
        )
    p99s = [
        h["verdict"]["realistic_top_p99_ms"]
        for h in past
        if h["verdict"].get("realistic_top_p99_ms")
    ]
    if p99s and v.get("realistic_top_p99_ms"):
        med = statistics.median(p99s)
        flag = "  ⚠️ slower" if v["realistic_top_p99_ms"] > 1.5 * med else ""
        lines.append(
            f"p99 at the busiest realistic step {v['realistic_top_p99_ms'] / 1000:.1f} s, "
            f"median {med / 1000:.1f} s{flag}"
        )
    return lines


# ── The report ────────────────────────────────────────────────────────────────


def _ms(v) -> str:
    if v is None:
        return "-"
    return f"{v / 1000:.1f}s" if v >= 10000 else f"{v:.0f}"


def _pct(v) -> str:
    return "-" if v is None else f"{v:.0f}%"


def report_text(result: dict, cfg: Config, comparison: list[str]) -> str:
    """The message for the webhook and the room: under Discord's 2,000
    characters."""
    v = result["verdict"]
    night = f"Switch nightly load test on {cfg.environment}, {cfg.agents:,} agents"
    if not result["rows"]:
        head = f"❌ {night}: no numbers tonight"
    elif v["ok"]:
        held = (
            f"held {v['held_per_s']:g} msg/s"
            if v["held_per_s"]
            else "held no ramp step"
        )
        broke = (
            f", broke at {v['broke_at_per_s']:g} ({v['broke_why']})"
            if v["broke_at_per_s"]
            else ", every ramp step held"
        )
        head = f"✅ {night}: {held}{broke}"
    else:
        failures = result.get("failures") or []
        if failures:
            why = failures[0]
        elif not v["realistic_ok"]:
            why = "realistic load did not run clean"
        else:
            why = "the run did not finish"
        head = f"❌ {night}: {why}"
    lines = [
        head,
        f"build {result['build']} · {result['pods']} pods on {result['nodes']} nodes · "
        f"{cfg.controllers} controllers"
        + (" · agents made tonight" if result.get("seeded") else ""),
    ]
    lines += [f"❌ {f}" for f in (result.get("failures") or [])[1:]]
    fewest = min((r["agents_connected_min"] for r in result["rows"]), default=None)
    if fewest is not None and fewest < cfg.agents:
        lines.append(
            f"⚠️ as few as {fewest:,} of the {cfg.agents:,} agents were connected "
            "in a step"
        )
    lines += result.get("notes", [])
    if result["rows"]:
        table = [
            f"{'step':<14}{'sent/s':>8}{'p50':>7}{'p99':>8}{'err':>5}{'lost':>6}{'pods':>6}{'db':>6}"
        ]
        for r in result["rows"]:
            table.append(
                f"{r['label']:<14}{r['sent_per_s']:>8.1f}{_ms(r['delivery_ms_p50']):>7}"
                f"{_ms(r['delivery_ms_p99']):>8}{r['errors']:>5}{r['missing']:>6}"
                f"{_pct(r['pod_cpu_avg_pct']):>6}{_pct(r['db_cpu_avg_pct']):>6}"
                + ("  broke" if r["broken"] else "")
            )
        lines.append("```\n" + "\n".join(table) + "\n```")
        lines.append(
            "p50 and p99 are delivery latency in ms (p99 is the worst worker's); "
            "pods is switch-core's average CPU, db the database's"
        )
    lines += comparison
    if cfg.dashboard_url:
        lines.append(cfg.dashboard_url)
    text = "\n".join(lines)
    return text if len(text) <= 1990 else text[:1985] + "\n…"


def post_webhook(url: str, text: str) -> None:
    if not url:
        print("no webhook set; report not sent", flush=True)
        return
    # Discord takes `content`; its Slack-compatible endpoint, Slack and
    # Mattermost take `text`.
    body = (
        {"content": text}
        if "discord" in url and not url.rstrip("/").endswith("/slack")
        else {"text": text}
    )
    httpx.post(url, json=body, timeout=30).raise_for_status()


def post_switch(cfg: Config, text: str) -> None:
    """The report into the Switch room, as the agent the token belongs to."""
    settings = {
        "SWITCH_URL": cfg.switch_url,
        "SWITCH_AGENT_ID": cfg.switch_agent_id,
        "SWITCH_ROOM_ID": cfg.switch_room_id,
        "SWITCH_TOKEN": cfg.switch_token,
    }
    if not any(settings.values()):
        print("no Switch room set; report not posted there", flush=True)
        return
    missing = [f"LOADTEST_{k}" for k, v in settings.items() if not v]
    if missing:
        raise ValueError(f"{', '.join(missing)} not set")
    httpx.post(
        f"{cfg.switch_url.rstrip('/')}/agents/{cfg.switch_agent_id}/message",
        json={"room_id": cfg.switch_room_id, "content": text},
        headers={"Authorization": f"Bearer {cfg.switch_token}"},
        timeout=30,
    ).raise_for_status()


def datadog_series(result: dict, cfg: Config, now: float) -> list[dict]:
    """One point per night for each number, stamped with the report's time:
    Datadog only takes points from the last hour, and a night is one value."""
    base = [f"env:{cfg.environment}", "service:switch-loadtest"]
    run_tags = [*base, f"build:{result['build']}"]
    series = []

    def point(metric: str, value, tags: list[str]) -> None:
        if value is None:
            return
        series.append(
            {
                "metric": f"switch.loadtest.{metric}",
                "type": 3,  # gauge
                "points": [{"timestamp": int(now), "value": float(value)}],
                "tags": tags,
            }
        )

    v = result["verdict"]
    point("ok", 1 if v["ok"] else 0, run_tags)
    point("held_msgs_per_s", v.get("held_per_s") or 0, run_tags)
    point("pods", result["pods"], run_tags)
    point("restarts", result.get("restarts"), run_tags)
    point("duration_s", result.get("duration_s"), run_tags)
    for i, r in enumerate(result["rows"]):
        tags = [
            *base,
            f"phase:{r['kind']}",
            f"step:{i:02d}",
            f"target:{r['label'].replace(' ', '_')}",
        ]
        point("step.sent_per_s", r["sent_per_s"], tags)
        point("step.delivery_p50_ms", r["delivery_ms_p50"], tags)
        point("step.delivery_p99_ms", r["delivery_ms_p99"], tags)
        point("step.errors", r["errors"], tags)
        point("step.missing", r["missing"], tags)
        point("step.pod_cpu_avg_pct", r["pod_cpu_avg_pct"], tags)
        point("step.pod_cpu_busiest_pct", r["pod_cpu_busiest_pct"], tags)
        point("step.db_cpu_avg_pct", r["db_cpu_avg_pct"], tags)
        point("step.db_xact_per_s", r["db_xact_per_s"], tags)
        point("step.broken", 1 if r["broken"] else 0, tags)
    return series


def send_datadog(result: dict, cfg: Config, text: str) -> None:
    if not cfg.dd_api_key:
        print("no DD_API_KEY; nothing sent to Datadog", flush=True)
        return
    headers = {"DD-API-KEY": cfg.dd_api_key}
    api = f"https://api.{cfg.dd_site}"
    series = datadog_series(result, cfg, time.time())
    httpx.post(
        f"{api}/api/v2/series", json={"series": series}, headers=headers, timeout=30
    ).raise_for_status()
    httpx.post(
        f"{api}/api/v1/events",
        json={
            "title": text.splitlines()[0],
            "text": "%%% \n" + text + "\n %%%",
            "tags": [
                f"env:{cfg.environment}",
                "service:switch-loadtest",
                f"build:{result['build']}",
            ],
            "alert_type": "success" if result["verdict"]["ok"] else "error",
            "source_type_name": "switch-loadtest",
        },
        headers=headers,
        timeout=30,
    ).raise_for_status()
    print(f"sent {len(series)} series and an event to Datadog", flush=True)


# ── Kubernetes and AWS ────────────────────────────────────────────────────────


def kubectl(cfg: Config, *args: str, timeout: float = 60) -> str:
    context = ["--context", cfg.kube_context] if cfg.kube_context else []
    out = subprocess.run(
        ["kubectl", *context, "-n", cfg.namespace, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if out.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {out.stderr.strip()[:300]}")
    return out.stdout


def build_of(labels: dict, image: str) -> str:
    """The release's chart version (a dev build is 0.31.1-dev.271.g989225d),
    else its app version, else the image's tag: images may be pinned by
    digest, which says nothing to a reader."""
    chart = labels.get("helm.sh/chart", "")
    if chart.startswith("switch-"):
        return chart.removeprefix("switch-")
    return labels.get("app.kubernetes.io/version") or image.rsplit(":", 1)[-1][:24]


def _core_image(pod_spec: dict) -> str:
    containers = pod_spec["containers"]
    return next(
        (c["image"] for c in containers if c["name"] == "switch-core"),
        containers[0]["image"],
    )


def core_state(cfg: Config) -> dict:
    """switch-core's deployment: the build its ready pods run, the pods and
    where they are. The build is the pods', not the deployment's: a rollout
    that cannot finish (no room on a full node group) leaves them on the
    build before."""
    d = json.loads(kubectl(cfg, "get", "deployment", cfg.deployment, "-o", "json"))
    selector = ",".join(
        f"{k}={v}" for k, v in d["spec"]["selector"]["matchLabels"].items()
    )
    pods = json.loads(kubectl(cfg, "get", "pods", "-l", selector, "-o", "json"))[
        "items"
    ]
    running = [p for p in pods if not p["metadata"].get("deletionTimestamp")]
    ready = [
        p
        for p in running
        if all(s.get("ready") for s in p["status"].get("containerStatuses") or [])
        and p["status"].get("containerStatuses")
    ]
    by_node: dict[str, int] = {}
    for p in ready:
        node = p["spec"].get("nodeName") or "?"
        by_node[node] = by_node.get(node, 0) + 1
    template = d["spec"]["template"]
    runs = {
        (
            _core_image(p["spec"]),
            build_of(p["metadata"].get("labels") or {}, _core_image(p["spec"])),
        )
        for p in ready
    } or {
        (
            _core_image(template["spec"]),
            build_of(d["metadata"].get("labels") or {}, _core_image(template["spec"])),
        )
    }
    return {
        "image": ", ".join(sorted(i for i, _ in runs)),
        "build": ", ".join(sorted(b for _, b in runs)),
        "replicas": d["spec"].get("replicas", 0),
        "ready": len(ready),
        "updated": d["status"].get("updatedReplicas", 0),
        "generation_seen": d["status"].get("observedGeneration")
        == d["metadata"].get("generation"),
        "by_node": by_node,
        "restarts": sum(
            s.get("restartCount", 0)
            for p in running
            for s in p["status"].get("containerStatuses") or []
        ),
        # Of the ready pods: one a rollout has made, still Pending, changes
        # nothing the run measures.
        "pod_template_hash": sorted(
            {p["metadata"]["labels"].get("pod-template-hash", "") for p in ready}
        ),
    }


def scale_core(cfg: Config, replicas: int) -> None:
    kubectl(cfg, "scale", "deployment", cfg.deployment, f"--replicas={replicas}")
    print(f"switch-core scaled to {replicas}", flush=True)


def wait_core(cfg: Config, replicas: int, seconds: float) -> dict:
    """Wait until switch-core runs `replicas` ready pods of one template.
    Not for a newer build waiting to roll out: at the night's size there is
    no room for the rollout's extra pod, so it would only wait out the time."""
    t = time.monotonic()
    while True:
        s = core_state(cfg)
        if (
            s["ready"] == replicas
            and len(s["pod_template_hash"]) == 1
            and s["generation_seen"]
        ):
            return s
        if time.monotonic() - t > seconds:
            return s
        time.sleep(10)


def _eks(cfg: Config):
    return boto3.client("eks", region_name=cfg.region)


def nodegroup(cfg: Config, prefix: str) -> str:
    names = _eks(cfg).list_nodegroups(clusterName=cfg.cluster)["nodegroups"]
    match = [n for n in names if n.startswith(prefix)]
    if len(match) != 1:
        raise RuntimeError(f"expected one node group named {prefix}*, found {match}")
    return match[0]


def size_nodegroup(cfg: Config, prefix: str, desired: int) -> None:
    """Set a node group's desired size. No prefix, no node group: for a
    rehearsal in an environment whose nodes are not the test's to size."""
    if not prefix:
        return
    eks = _eks(cfg)
    name = nodegroup(cfg, prefix)
    sc = eks.describe_nodegroup(clusterName=cfg.cluster, nodegroupName=name)[
        "nodegroup"
    ]["scalingConfig"]
    if not sc["minSize"] <= desired <= sc["maxSize"]:
        raise RuntimeError(
            f"{name} takes {sc['minSize']} to {sc['maxSize']} nodes, not {desired}"
        )
    if sc["desiredSize"] != desired:
        eks.update_nodegroup_config(
            clusterName=cfg.cluster,
            nodegroupName=name,
            scalingConfig={
                "minSize": sc["minSize"],
                "maxSize": sc["maxSize"],
                "desiredSize": desired,
            },
        )
    print(f"node group {name}: {sc['desiredSize']} -> {desired}", flush=True)


def _s3(cfg: Config):
    return boto3.client("s3", region_name=cfg.region)


def _local(cfg: Config) -> Path | None:
    """A bucket named file:///some/dir is that directory, for a rehearsal
    from a machine without the test's bucket."""
    if cfg.bucket.startswith("file://"):
        return Path(cfg.bucket.removeprefix("file://")) / cfg.prefix
    return None


def s3_get(cfg: Config, key: str) -> dict | None:
    if (d := _local(cfg)) is not None:
        return json.loads((d / key).read_text()) if (d / key).exists() else None
    try:
        body = (
            _s3(cfg).get_object(Bucket=cfg.bucket, Key=cfg.prefix + key)["Body"].read()
        )
    except Exception as exc:  # noqa: BLE001 - a missing key reads as nothing
        if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc):
            return None
        raise
    return json.loads(body)


def s3_put(cfg: Config, key: str, data: dict | bytes) -> None:
    body = (
        data
        if isinstance(data, bytes)
        else json.dumps(data, indent=1, default=str).encode()
    )
    if (d := _local(cfg)) is not None:
        (d / key).parent.mkdir(parents=True, exist_ok=True)
        (d / key).write_bytes(body)
        return
    _s3(cfg).put_object(Bucket=cfg.bucket, Key=cfg.prefix + key, Body=body)


def s3_delete(cfg: Config, key: str) -> None:
    if (d := _local(cfg)) is not None:
        (d / key).unlink(missing_ok=True)
        return
    _s3(cfg).delete_object(Bucket=cfg.bucket, Key=cfg.prefix + key)


def history(cfg: Config, before: str, nights: int = 14) -> list[dict]:
    """The results of earlier nights, oldest first."""
    if (d := _local(cfg)) is not None:
        names = sorted(f.name for f in (d / "history").glob("*.json"))
        keys = [f"history/{n}" for n in names if Path(n).stem < before][-nights:]
        return [h for h in (s3_get(cfg, k) for k in keys) if h]
    pages = (
        _s3(cfg)
        .get_paginator("list_objects_v2")
        .paginate(Bucket=cfg.bucket, Prefix=cfg.prefix + "history/")
    )
    keys = sorted(
        o["Key"][len(cfg.prefix) :]
        for page in pages
        for o in page.get("Contents", [])
        if o["Key"].endswith(".json")
    )
    keys = [k for k in keys if Path(k).stem < before][-nights:]
    return [h for h in (s3_get(cfg, k) for k in keys) if h]


# ── The harness's workers ─────────────────────────────────────────────────────


def harness_args(cfg: Config, run_id: str, seed: int) -> list[str]:
    return [
        sys.executable, str(HERE / "run.py"),
        "--namespace", cfg.namespace, "--kube-context", cfg.kube_context,
        "--workspace", cfg.workspace,
        "--api-url", cfg.api_url, "--gateway-url", cfg.api_url,
        "--aws-profile", "", "--aws-region", cfg.region,
        *(["--rds-instance", cfg.rds_instance] if cfg.rds_instance else []),
        "--run-id", run_id, "--seed", str(seed),
        "--steps", str(cfg.per_agents), "--controllers", str(cfg.per_controllers),
        "--rooms", str(cfg.per_rooms), "--room-size", str(cfg.room_size),
        "--calls", "socket", "--keep",
    ]  # fmt: skip


def deadline_after(start: datetime, hhmm: str, longest: timedelta) -> datetime:
    """The next HH:MM UTC after `start`, but no later than `start + longest`,
    so a run started by hand in the day still ends."""
    h, m = (int(x) for x in hhmm.split(":"))
    at = start.replace(hour=h, minute=m, second=0, microsecond=0)
    if at <= start:
        at += timedelta(days=1)
    return min(at, start + longest)


@dataclass
class Worker:
    index: int
    run_id: str
    log: Path
    proc: subprocess.Popen

    def text(self) -> str:
        try:
            return self.log.read_text(errors="replace")
        except FileNotFoundError:
            return ""

    def failed(self) -> str | None:
        t = self.text()
        for marker in FAILED:
            if marker in t:
                line = next(x for x in t.splitlines() if marker in x)
                return line.strip()[:240]
        if self.proc.poll() is not None and WAITING not in t:
            return (
                f"exited ({self.proc.returncode}) before its rates: {self.last_line()}"
            )
        return None

    def crashed(self) -> str | None:
        """Why a worker whose rates had started failed: its own `run failed`
        line, or an exit that was not clean (a worker that could not revoke
        its controllers exits 1)."""
        t = self.text()
        if "run failed" in t:
            return next(x for x in t.splitlines() if "run failed" in x).strip()[:240]
        if self.proc.poll() is not None and self.proc.returncode:
            return f"exited {self.proc.returncode}: {self.last_line()}"
        return None

    def last_line(self) -> str:
        return (self.text().strip().splitlines() or [""])[-1][:200]

    def connected(self) -> tuple[int, int] | None:
        """(connected, wanted) from the harness's `step N: x/N agents
        connected` line, once it has printed it."""
        m = CONNECTED.search(self.text())
        return (int(m.group(1)), int(m.group(2))) if m else None

    def interrupt(self) -> None:
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)


def start(cfg: Config, run_id: str, seed: int, extra: list[str], out: Path) -> Worker:
    log = out / f"{run_id}.log"
    proc = subprocess.Popen(
        [*harness_args(cfg, run_id, seed), *extra],
        stdout=log.open("w"),
        stderr=subprocess.STDOUT,
        cwd=HERE.parent,
    )
    return Worker(seed, run_id, log, proc)


def finish(workers: list[Worker], grace: float = 240) -> None:
    """Interrupt every worker (each stops its traffic and revokes its
    controllers), and kill what is still running after `grace` seconds."""
    for w in workers:
        w.interrupt()
    t = time.monotonic()
    while any(w.proc.poll() is None for w in workers) and time.monotonic() - t < grace:
        time.sleep(2)
    for w in workers:
        if w.proc.poll() is None:
            w.proc.kill()


def seed_population(cfg: Config, base: str, out: Path) -> dict:
    """Make and keep one batch of agents per worker, one batch at a time, so
    making them never overlaps itself; returns the population record.

    Each batch's ids go to S3 as soon as it is kept, under a population record
    marked incomplete until the last one is, so a night that fails half way
    leaves a record the next night removes rather than agents nobody knows of."""
    pop = {
        "base": base,
        "shape": cfg.population_shape(),
        "batches": 0,
        "complete": False,
        "made": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    seeder: Worker | None = None
    try:
        for i in range(1, cfg.workers + 1):
            rid = f"{base}s{i}"
            t = time.monotonic()
            # Counted before it starts: a batch stopped half way is not kept,
            # but may have made agents, so its removal is tried too.
            pop["batches"] = i
            s3_put(cfg, "population.json", pop)
            seeder = start(cfg, rid, i, ["--seed-only", "--concurrency", "8"], out)
            seeder.proc.wait()
            keep = RUNS / rid / "keep.json"
            if seeder.proc.returncode != 0 or not keep.exists():
                last = (seeder.text().strip().splitlines() or [""])[-1]
                raise RuntimeError(f"batch {i} was not kept: {last[:200]}")
            s3_put(cfg, f"population/w{i}.json", json.loads(keep.read_text()))
            print(
                f"batch {i}: {cfg.per_agents} agents made and kept in {time.monotonic() - t:.0f}s",
                flush=True,
            )
    except BaseException as exc:
        # A seeder still running would go on making agents after the cleanup
        # has listed what exists.
        if seeder is not None:
            finish([seeder], grace=60)
        s3_put(cfg, "population.json", pop)
        if isinstance(exc, Interrupted):
            # The pod is going, and removing can take longer than it has. The
            # record, incomplete and counting every batch that may have
            # agents, is the next night's to remove.
            raise
        try:
            remove_population(cfg, pop, out)
        except Exception as exc:  # noqa: BLE001 - the first error is the one to report
            print(f"removing the half-made batches failed too: {exc}", flush=True)
        raise
    pop["complete"] = True
    s3_put(cfg, "population.json", pop)
    return pop


def remove_population(cfg: Config, pop: dict, out: Path) -> None:
    """Delete a population's agents and rooms, one batch at a time, in the
    workspace it was made in. Its record goes only once every batch is gone,
    so a removal that fails is tried again the next night."""
    batches = pop.get("batches", pop["shape"]["workers"])
    workspace = pop["shape"].get("workspace", cfg.workspace)
    failed = []
    for i in range(1, batches + 1):
        rid = f"{pop['base']}s{i}"
        cmd = [
            sys.executable, str(HERE / "run.py"),
            "--namespace", cfg.namespace, "--kube-context", cfg.kube_context,
            "--workspace", workspace,
            "--api-url", cfg.api_url, "--gateway-url", cfg.api_url,
            "--cleanup", rid,
        ]  # fmt: skip
        with (out / f"cleanup-{rid}.log").open("w") as log:
            r = subprocess.run(
                cmd, stdout=log, stderr=subprocess.STDOUT, cwd=HERE.parent,
                timeout=1800, check=False,
            )  # fmt: skip
        if r.returncode != 0:
            failed.append(rid)
    if failed:
        raise RuntimeError(f"could not remove the kept batches {', '.join(failed)}")
    s3_delete(cfg, "population.json")
    print(f"removed population {pop['base']} ({batches} batches)", flush=True)


def restore_population(cfg: Config, pop: dict) -> None:
    """Put the kept batches where the harness's --reuse looks for them."""
    for i in range(1, cfg.workers + 1):
        record = s3_get(cfg, f"population/w{i}.json")
        if record is None:
            raise RuntimeError(f"population {pop['base']} has no batch {i}")
        d = RUNS / f"{pop['base']}s{i}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "keep.json").write_text(json.dumps(record))


def run_workers(
    cfg: Config, pop: dict, base: str, out: Path, until: datetime, workers: list[Worker]
) -> tuple[str | None, bool]:
    """Start every worker on its kept batch, a few seconds apart, wait until
    all are connected and idle, then let them step their rates together; once
    a worker breaks a step, stop them all. Each worker goes into `workers` as
    it starts, so a run stopped at any point can still stop them. Returns why
    the night stopped early if it did, and whether the rates had started."""
    go = out / "rates.go"
    rates = ",".join(f"{r:g}" for r in cfg.worker_rates())
    durations = ",".join(f"{d:g}" for d in cfg.durations())
    for i in range(1, cfg.workers + 1):
        workers.append(
            start(
                cfg,
                f"{base}w{i}",
                i,
                [
                    "--reuse",
                    f"{pop['base']}s{i}",
                    "--scenarios",
                    "idle",
                    "--duration",
                    f"{cfg.idle_seconds:g}",
                    "--rates",
                    rates,
                    "--rate-duration",
                    durations,
                    "--drain",
                    f"{cfg.drain_seconds:g}",
                    "--drain-full",
                    "--rates-after",
                    str(go),
                ],
                out,
            )  # fmt: skip
        )
        time.sleep(STAGGER)
    t = time.monotonic()
    while True:
        if bad := _failed(workers):
            finish(workers)
            return bad, False
        if all(WAITING in w.text() for w in workers):
            break
        if time.monotonic() - t > 1200:
            finish(workers)
            return "the workers did not all connect within 20 minutes", False
        time.sleep(5)
    short = [
        f"worker {w.index}: {c[0]}/{c[1]}"
        for w in workers
        if (c := w.connected()) and c[0] < CONNECTED_ENOUGH * c[1]
    ]
    if short:
        finish(workers)
        return "agents did not all connect (" + ", ".join(short)[:300] + ")", False
    print(
        f"all {len(workers)} workers connected in {time.monotonic() - t:.0f}s; rates start",
        flush=True,
    )
    go.touch()
    while any(w.proc.poll() is None for w in workers):
        if any(BROKE in w.text() for w in workers):
            # The step that broke is the night's answer; the other workers
            # would only go on stepping with part of the load.
            print("a worker broke a step; stopping the others", flush=True)
            finish(workers)
            break
        if bad := _crashed(workers):
            finish(workers)
            return bad, True
        if datetime.now(UTC) >= until:
            finish(workers)
            return f"stopped at the deadline, {until:%H:%M} UTC", True
        time.sleep(5)
    # Stopped or not, a worker that could not revoke its controllers exits 1.
    return _crashed(workers), True


def _failed(workers: list[Worker]) -> str | None:
    """The workers that failed before their rates, and why, or None."""
    bad = [f"worker {w.index}: {why}" for w in workers if (why := w.failed())]
    return "; ".join(bad)[:400] if bad else None


def _crashed(workers: list[Worker]) -> str | None:
    """The workers that failed once their rates had started, and why, or None."""
    bad = [f"worker {w.index}: {why}" for w in workers if (why := w.crashed())]
    return "; ".join(bad)[:400] if bad else None


# ── The three commands ────────────────────────────────────────────────────────


def night_of(now: datetime) -> str:
    """A night's date: the run after midnight belongs to that day."""
    return now.strftime("%Y-%m-%d")


def cmd_up(cfg: Config) -> int:
    size_nodegroup(cfg, cfg.harness_nodegroup, 1)
    size_nodegroup(cfg, cfg.core_nodegroup, cfg.night_nodes)
    scale_core(cfg, cfg.night_pods)
    t = time.monotonic()
    s = wait_core(cfg, cfg.night_pods, 1500)
    print(
        f"switch-core: {s['ready']}/{cfg.night_pods} ready after {time.monotonic() - t:.0f}s, "
        f"build {s['build']}, pods per node {sorted(s['by_node'].values())}",
        flush=True,
    )
    return 0 if s["ready"] == cfg.night_pods else 1


def day_sizes(cfg: Config) -> list[str]:
    """switch-core first, so its pods leave the nodes before they go. Every
    step is tried whatever the others do; returns the ones that failed."""
    failed = []
    for name, step in (
        ("switch-core", lambda: scale_core(cfg, cfg.day_pods)),
        (
            "switch-core's nodes",
            lambda: size_nodegroup(cfg, cfg.core_nodegroup, cfg.day_nodes),
        ),
        ("the harness's node", lambda: size_nodegroup(cfg, cfg.harness_nodegroup, 0)),
    ):
        try:
            step()
        except Exception as exc:  # noqa: BLE001 - try the rest regardless
            failed.append(f"{name}: {type(exc).__name__}: {exc}"[:200])
            print(f"day sizes: {failed[-1]}", flush=True)
    return failed


class Interrupted(Exception):
    """The pod was told to stop (SIGTERM): the night still reports."""


class _Tee:
    """Everything printed goes to the pod's log and to a file stored with
    the night's records, so the run's own account outlives its pod."""

    def __init__(self, stream, path: Path) -> None:
        self.stream = stream
        self.file = path.open("a")

    def write(self, data: str) -> int:
        self.stream.write(data)
        self.file.write(data)
        return len(data)

    def flush(self) -> None:
        self.stream.flush()
        self.file.flush()


@dataclass
class Night:
    """One night's run and what it found. `run` may stop anywhere; `result`
    makes a report of whatever got done."""

    cfg: Config
    started: datetime
    base: str
    out: Path
    # Failures make the night a ❌; notes (a pod restarting at the step that
    # broke, say) are shown only.
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    workers: list[Worker] = field(default_factory=list)
    pop: dict | None = None
    seeded: bool = False
    before: dict | None = None

    def run(self) -> None:
        cfg = self.cfg
        if core_state(cfg)["replicas"] != cfg.night_pods:
            # Started by hand without `up` first (this pod's own node is up,
            # or it would not be running): size staging for the night here.
            print("switch-core is not at its night size; scaling it up", flush=True)
            size_nodegroup(cfg, cfg.core_nodegroup, cfg.night_nodes)
            scale_core(cfg, cfg.night_pods)
        s = self.before = wait_core(cfg, cfg.night_pods, 1500)
        print(
            f"{cfg.environment} runs {s['build']} on {s['ready']} pods, "
            f"{sorted(s['by_node'].values())} per node",
            flush=True,
        )
        if s["ready"] != cfg.night_pods:
            self.failures.append(
                f"{s['ready']} of {cfg.night_pods} switch-core pods ready: "
                "not comparable with other nights"
            )
        elif s["updated"] != s["replicas"]:
            self.notes.append(
                f"⚠️ a newer switch-core build was waiting to roll out "
                f"({s['updated']} of {s['replicas']} pods on it); the night ran "
                f"{s['build']}"
            )
        most = -(-cfg.night_pods // max(1, cfg.night_nodes))
        if max(s["by_node"].values(), default=0) > most:
            self.failures.append(
                f"switch-core's pods sit {sorted(s['by_node'].values())} per node, "
                f"more than {most} on one: not comparable with other nights"
            )
        until = deadline_after(self.started, cfg.deadline, timedelta(hours=3))

        self.pop = s3_get(cfg, "population.json")
        if self.pop and (
            self.pop.get("shape") != cfg.population_shape()
            or not self.pop.get("complete", True)
        ):
            print(
                "the kept agents are half made or of another shape; removing them",
                flush=True,
            )
            remove_population(cfg, self.pop, self.out)
            self.pop = None
        if self.pop is None:
            self.pop = seed_population(cfg, self.base, self.out)
            self.seeded = True
        restore_population(cfg, self.pop)
        stopped, rates_started = run_workers(
            cfg, self.pop, self.base, self.out, until, self.workers
        )
        if stopped and not rates_started and not self.seeded:
            # Stopped before measuring anything: most likely the kept agents
            # are gone (removed, or the database replaced). Make them again
            # and try once more; a server that is down fails this one too.
            print(
                f"stopped before the rates ({stopped}); making the agents again",
                flush=True,
            )
            self.notes.append(
                f"the kept agents could not be used ({stopped}); made again"
            )
            remove_population(cfg, self.pop, self.out)
            self.base += "b"
            self.pop = seed_population(cfg, self.base, self.out)
            self.seeded = True
            restore_population(cfg, self.pop)
            self.workers = []
            stopped, rates_started = run_workers(
                cfg, self.pop, self.base, self.out, until, self.workers
            )
        if stopped:
            self.failures.append(f"stopped early: {stopped}")

    def result(self) -> dict:
        cfg = self.cfg
        before = self.before or {}
        after = None
        try:
            after = core_state(cfg)
        except Exception as exc:  # noqa: BLE001 - the night still reports
            self.notes.append(
                f"⚠️ could not read switch-core after the run: {exc}"[:200]
            )
        restarts = None
        if after and before:
            restarts = after["restarts"] - before["restarts"]
            if restarts:
                self.notes.append(
                    f"⚠️ switch-core restarted {restarts} time(s) during the run"
                )
            if after["pod_template_hash"] != before["pod_template_hash"]:
                self.failures.append(
                    "switch-core's pods were replaced during the run (a deploy?)"
                )
        rows = combine(cfg, [p for w in self.workers if (p := _phases(w))])
        ended = datetime.now(UTC)
        result = {
            "night": night_of(self.started),
            "base": self.base,
            "build": before.get("build", "unknown"),
            "image": before.get("image"),
            "pods": before.get("ready", 0),
            "nodes": len(before.get("by_node") or {}),
            "seeded": self.seeded,
            "population": self.pop["base"] if self.pop else None,
            "started": self.started.isoformat(timespec="seconds"),
            "ended": ended.isoformat(timespec="seconds"),
            "duration_s": round((ended - self.started).total_seconds()),
            "restarts": restarts,
            "rows": rows,
            "failures": self.failures,
            "notes": self.notes,
        }
        result["verdict"] = verdict(rows, cfg, self.failures)
        return result


def cmd_run(cfg: Config) -> int:
    started = datetime.now(UTC)
    base = "n" + started.strftime("%Y%m%dt%H%M")
    out = Path(os.environ.get("LOADTEST_OUT", "/tmp/loadtest")) / base
    out.mkdir(parents=True, exist_ok=True)
    sys.stdout = _Tee(sys.stdout, out / "nightly.log")  # type: ignore[assignment]

    def on_term(signum, frame) -> None:
        raise Interrupted("the pod was stopped (SIGTERM)")

    signal.signal(signal.SIGTERM, on_term)
    night = Night(cfg, started, base, out)
    try:
        night.run()
    except Exception as exc:  # noqa: BLE001 - whatever stopped it, report the night
        night.failures.append(f"the run failed: {type(exc).__name__}: {exc}"[:400])
        finish(night.workers)
    result = night.result()
    report(cfg, result, night.workers, out)
    # A failure here fails the job too; `down` tries again and reports it.
    left = day_sizes(cfg)
    return 0 if result["verdict"]["ok"] and not left else 1


def report(cfg: Config, result: dict, workers: list[Worker], out: Path) -> None:
    """The night to S3, Datadog, the webhook and the Switch room; each is
    tried whatever the others do."""
    try:
        comparison = compare(result, history(cfg, before=result["night"]))
    except Exception as exc:  # noqa: BLE001
        comparison = [f"no comparison: {exc}"[:200]]
    text = report_text(result, cfg, comparison)
    print(text, flush=True)
    for name, action in (
        ("S3", lambda: _store(cfg, result, workers, out)),
        ("Datadog", lambda: send_datadog(result, cfg, text)),
        ("webhook", lambda: post_webhook(cfg.webhook_url, text)),
        ("Switch", lambda: post_switch(cfg, text)),
    ):
        try:
            action()
        except Exception as exc:  # noqa: BLE001 - the others still go
            print(f"{name}: {type(exc).__name__}: {exc}"[:300], flush=True)


def _phases(w: Worker) -> list[dict] | None:
    """A worker's measured windows, once it has written its summary."""
    p = RUNS / w.run_id / "summary.json"
    if not p.exists():
        return None
    return json.loads(p.read_text()).get("phases") or None


def _store(cfg: Config, result: dict, workers: list[Worker], out: Path) -> None:
    """The night's result, each worker's own records and the logs, in S3.
    Not the per-message file: it is large and the summaries hold what it says."""
    s3_put(cfg, f"history/{result['night']}.json", result)
    run = f"runs/{result['night']}/{result['base']}/"
    s3_put(cfg, run + "result.json", result)
    for w in workers:
        for name in (
            "summary.json",
            "summary.md",
            "phases.json",
            "config.json",
            "events.jsonl",
        ):
            f = RUNS / w.run_id / name
            if f.exists():
                s3_put(cfg, f"{run}{w.run_id}/{name}", f.read_bytes())
    sys.stdout.flush()
    for f in out.glob("*.log"):
        s3_put(cfg, run + "logs/" + f.name, f.read_bytes())
    print(f"stored in s3://{cfg.bucket}/{cfg.prefix}{run}", flush=True)


def _keep_run_log(cfg: Config, night: str) -> str | None:
    """The run pod's log, to S3: it lives on the harness's node, which the day
    sizes remove. Where it went, or None when there was none to keep."""
    try:
        text = kubectl(
            cfg, "logs", "-l", "app.kubernetes.io/component=loadtest-run",
            "--tail=-1", "--prefix", "--max-log-requests=5", timeout=120,
        )  # fmt: skip
    except Exception as exc:  # noqa: BLE001
        print(f"no run pod log to keep: {exc}"[:300], flush=True)
        return None
    if not text.strip():
        return None
    key = f"runs/{night}/run-pod.log"
    s3_put(cfg, key, text.encode())
    return f"s3://{cfg.bucket}/{cfg.prefix}{key}"


def cmd_down(cfg: Config) -> int:
    night = night_of(datetime.now(UTC))
    try:
        found = s3_get(cfg, f"history/{night}.json")
    except Exception as exc:  # noqa: BLE001 - reported as a missing night
        print(f"could not read tonight's result: {exc}", flush=True)
        found = None
    kept = _keep_run_log(cfg, night) if found is None else None
    left = day_sizes(cfg)
    if found is not None and not left:
        return 0
    lines = []
    if found is None:
        lines.append(
            f"❌ Switch nightly load test on {cfg.environment}: no result for {night}; "
            + (
                f"the run pod's log is in {kept}"
                if kept
                else "the run pod left no log (it may never have started: is the harness's node up?)"
            )
        )
    if left:
        lines.append(
            f"⚠️ {cfg.environment} may still be at its night size: putting it back "
            "failed for " + "; ".join(left)
        )
    text = "\n".join(lines)
    print(text, flush=True)
    actions = [
        lambda: post_webhook(cfg.webhook_url, text),
        lambda: post_switch(cfg, text),
    ]
    # A night that left a result has sent Datadog its numbers already.
    if found is None:
        result = {"build": "unknown", "pods": 0, "rows": [], "verdict": {"ok": False}}
        actions.append(lambda: send_datadog(result, cfg, text))
    for action in actions:
        try:
            action()
        except Exception as exc:  # noqa: BLE001
            print(f"{type(exc).__name__}: {exc}"[:300], flush=True)
    return 1


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in ("up", "run", "down"):
        print(__doc__, file=sys.stderr)
        return 2
    cfg = Config.from_env()
    return {"up": cmd_up, "run": cmd_run, "down": cmd_down}[args[0]](cfg)


if __name__ == "__main__":
    sys.exit(main())

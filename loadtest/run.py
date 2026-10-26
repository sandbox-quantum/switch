"""Load test switch-core in a non-pilot environment, and publish the numbers.

    uv run --project core python loadtest/run.py --namespace switch-staging \\
        --scenarios idle,steady,burst --steps 50,100,200 --rate 5 --duration 120

Seeds its own agents and rooms, runs the scenarios at each step, samples
every switch-core pod and the database while it does, then removes what it
made, on Ctrl-C and on failure too. `--cleanup <run_id>` removes leftovers.
It never restarts, scales or edits anything in Kubernetes: `kubectl get` and
`kubectl exec` (and, with `--via port-forward`, `kubectl port-forward`) only.
See loadtest/README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from agents import Agent, Stats, play  # noqa: E402
from kube import Kube, PortForward, Refused, Sampler, guard_target  # noqa: E402
from report import phase_summary, render  # noqa: E402
from seed import Admin, RequestIds, seed, teardown  # noqa: E402
from workload import (  # noqa: E402
    SCENARIOS,
    build_membership,
    build_schedule,
    fingerprint,
)

RUNS = Path(__file__).parent / "runs"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    t = ap.add_argument_group("target")
    t.add_argument(
        "--namespace",
        required=True,
        help="e.g. switch-staging; never switch (pilot) or prod",
    )
    t.add_argument("--kube-context", default="switch-eu")
    t.add_argument(
        "--api-url", help="agent API URL; default: the release's GATEWAY_PUBLIC_URL"
    )
    t.add_argument(
        "--gateway-url", help="gateway URL; default: the release's FRONTEND_BASE_URL"
    )
    t.add_argument(
        "--via",
        choices=["urls", "port-forward"],
        default="urls",
        help="port-forward: reach each core pod through kubectl, for a Mac off the tailnet (smoke runs only)",
    )
    w = ap.add_argument_group("workload")
    w.add_argument(
        "--scenarios",
        default="idle,steady,burst",
        help=f"comma list of {','.join(SCENARIOS)}",
    )
    w.add_argument(
        "--agents", type=int, default=50, help="agents, when --steps is not given"
    )
    w.add_argument("--steps", help="agent counts to ramp through, e.g. 50,100,200")
    w.add_argument("--rooms", type=int, help="rooms; default half the largest step")
    w.add_argument("--room-size", type=int, default=4)
    w.add_argument(
        "--rate",
        type=float,
        default=5.0,
        help="messages per second (steady, and burst's background)",
    )
    w.add_argument(
        "--duration",
        type=float,
        default=120.0,
        help="seconds measured per scenario per step",
    )
    w.add_argument(
        "--settle", type=float, default=10.0, help="quiet seconds after each scenario"
    )
    w.add_argument("--burst-every", type=float, default=30.0)
    w.add_argument("--burst-size", type=int, default=100, help="messages per spike")
    w.add_argument(
        "--burst-window",
        type=float,
        default=2.0,
        help="seconds each spike is spread over",
    )
    w.add_argument("--hot-room", action="store_true", help="spikes all go to one room")
    w.add_argument("--payload-min", type=int, default=40)
    w.add_argument("--payload-max", type=int, default=2000)
    w.add_argument(
        "--read-fraction",
        type=float,
        default=0.1,
        help="share of deliveries the receiver follows with read_context",
    )
    w.add_argument(
        "--connect-rate", type=float, default=20.0, help="agents opened per second"
    )
    w.add_argument("--seed", type=int, default=1)
    o = ap.add_argument_group("run")
    o.add_argument("--run-id", help="default: UTC time, e.g. 20261026t153000")
    o.add_argument("--sample-interval", type=float, default=1.0)
    o.add_argument(
        "--rds-instance",
        help="RDS instance to read CPU from in CloudWatch, e.g. switch-staging",
    )
    o.add_argument(
        "--aws-profile", default=os.environ.get("AWS_PROFILE", "qsg-nonprod-write")
    )
    o.add_argument("--aws-region", default="eu-west-3")
    o.add_argument(
        "--plan", action="store_true", help="print the workload and exit; no requests"
    )
    o.add_argument(
        "--cleanup",
        metavar="RUN_ID",
        help="remove a run's leftovers ('*' for every load run) and exit",
    )
    a = ap.parse_args(argv)
    a.scenarios = [s.strip() for s in a.scenarios.split(",") if s.strip()]
    for s in a.scenarios:
        if s not in SCENARIOS:
            ap.error(f"unknown scenario {s}")
    a.steps = [int(x) for x in a.steps.split(",")] if a.steps else [a.agents]
    if a.steps != sorted(a.steps) or min(a.steps) < 2:
        ap.error("--steps must be increasing and at least 2")
    a.rooms = a.rooms or max(1, max(a.steps) // 2)
    return a


def plan(a: argparse.Namespace) -> tuple[list[list[int]], dict[str, list]]:
    membership = build_membership(a.seed, max(a.steps), a.rooms, a.room_size)
    schedules = {}
    for step in a.steps:
        for sc in a.scenarios:
            schedules[f"{sc}@{step}"] = build_schedule(
                seed=a.seed,
                scenario=sc,
                step=step,
                duration=a.duration,
                rooms=membership,
                active=step,
                rate=a.rate,
                burst_every=a.burst_every,
                burst_size=a.burst_size,
                burst_window=a.burst_window,
                hot_room=a.hot_room,
                payload_min=a.payload_min,
                payload_max=a.payload_max,
            )
    return membership, schedules


def resolve_urls(a: argparse.Namespace, kube: Kube) -> None:
    """Default the URLs to the release's own, and refuse URLs that belong to
    another environment: the pods sampled must be the pods loaded."""
    gw, api = kube.public_urls()
    for flag, given, deployed in (
        ("--gateway-url", a.gateway_url, gw),
        ("--api-url", a.api_url, api),
    ):
        if given and deployed and given.rstrip("/") != deployed.rstrip("/"):
            raise Refused(
                f"{flag} {given} is not this namespace's ({deployed}); refusing to load one env and sample another"
            )
    a.gateway_url = (a.gateway_url or gw or "").rstrip("/")
    a.api_url = (a.api_url or api or "").rstrip("/")
    if not a.gateway_url or not a.api_url:
        raise Refused(
            "no --gateway-url/--api-url given and the release does not name them"
        )


async def wait(stop: asyncio.Event, seconds: float) -> bool:
    """Sleep, but wake on Ctrl-C. True when stopped."""
    try:
        await asyncio.wait_for(stop.wait(), max(0.0, seconds))
        return True
    except TimeoutError:
        return False


def rds_cpu(a: argparse.Namespace, start: float, end: float) -> dict | None:
    """RDS CPU and connections over a window, from CloudWatch (one-minute
    resolution, so short windows read coarsely; data lands a minute or two late)."""
    if not a.rds_instance:
        return None
    out: dict = {}
    for metric, key in (("CPUUtilization", "cpu"), ("DatabaseConnections", "conns")):
        r = subprocess.run(
            [
                "aws", "cloudwatch", "get-metric-statistics",
                "--namespace", "AWS/RDS", "--metric-name", metric,
                "--dimensions", f"Name=DBInstanceIdentifier,Value={a.rds_instance}",
                "--start-time", datetime.fromtimestamp(start - 60, UTC).isoformat(),
                "--end-time", datetime.fromtimestamp(end + 60, UTC).isoformat(),
                "--period", "60", "--statistics", "Average", "Maximum",
                "--region", a.aws_region, "--output", "json",
            ],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "AWS_PROFILE": a.aws_profile},
        )  # fmt: skip
        if r.returncode != 0:
            out["error"] = r.stderr.strip()[:200]
            continue
        pts = json.loads(r.stdout).get("Datapoints", [])
        if pts:
            out[f"{key}_avg"] = round(sum(p["Average"] for p in pts) / len(pts), 1)
            out[f"{key}_max"] = round(max(p["Maximum"] for p in pts), 1)
    return out


async def cleanup(a: argparse.Namespace, kube: Kube) -> int:
    pf = None
    if a.via == "port-forward":
        pf = PortForward(kube)
        a.gateway_url = pf.open()[0]
    admin = Admin(a.gateway_url, RequestIds(f"cleanup-{a.cleanup}"))
    try:
        await admin.login(*kube.admin_login())
        done = await teardown(admin, a.cleanup)
    finally:
        await admin.close()
        if pf:
            pf.close()
    print(json.dumps(done))
    return (
        0 if not (done["left_agents"] or done["left_rooms"] or done["left_keys"]) else 1
    )


async def run(a: argparse.Namespace, kube: Kube) -> int:
    run_id = a.run_id or datetime.now(UTC).strftime("%Y%m%dt%H%M%S")
    out = RUNS / run_id
    out.mkdir(parents=True, exist_ok=False)
    membership, schedules = plan(a)
    ids = RequestIds(run_id)
    stats = Stats()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def on_signal() -> None:
        if stop.is_set():
            print(
                f"\nsecond interrupt: exiting without teardown; run --cleanup {run_id}",
                flush=True,
            )
            os._exit(130)
        print(
            "\ninterrupted: stopping traffic and tearing down (Ctrl-C again to abandon)",
            flush=True,
        )
        stop.set()

    loop.add_signal_handler(signal.SIGINT, on_signal)
    loop.add_signal_handler(signal.SIGTERM, on_signal)

    pf = None
    bases = [a.api_url]
    if a.via == "port-forward":
        pf = PortForward(kube)
        bases = pf.open()
        a.api_url = a.gateway_url = bases[0]

    meta = {
        "run_id": run_id,
        "namespace": a.namespace,
        "kube_context": a.kube_context,
        "api_url": a.api_url if a.via == "urls" else "port-forward",
        "gateway_url": a.gateway_url if a.via == "urls" else "port-forward",
        "via": a.via,
        "seed": a.seed,
        "rooms": a.rooms,
        "room_size": a.room_size,
        "membership_fingerprint": fingerprint(membership),
        "started": datetime.now(UTC).isoformat(timespec="seconds"),
        "args": {k: v for k, v in vars(a).items() if k not in ("cleanup",)},
        "pods": [],
    }
    (out / "config.json").write_text(json.dumps(meta, indent=1, default=str))
    print(f"run {run_id} -> {out}", flush=True)

    sampler = Sampler(kube, interval=a.sample_interval)
    sampler_task = asyncio.create_task(sampler.run())
    admin = Admin(a.gateway_url, ids)
    state: dict = {"api_key_id": None, "agents": [], "rooms": []}
    clients = {
        b: httpx.AsyncClient(
            base_url=b,
            timeout=60,
            limits=httpx.Limits(max_connections=512, max_keepalive_connections=256),
        )
        for b in bases
    }
    agents: list[Agent] = []
    phases: list[dict] = []
    connected_log: dict[str, list[int]] = {}
    td: dict | None = None

    async def count_connected() -> None:
        while True:
            connected_log.setdefault(stats.phase, []).append(
                sum(x.connected.is_set() for x in agents)
            )
            await asyncio.sleep(1)

    counter = asyncio.create_task(count_connected())
    code = 0
    try:
        await admin.login(*kube.admin_login())
        t = time.monotonic()
        seeded, room_ids = await seed(
            admin, a.api_url, run_id, max(a.steps), membership, state
        )
        print(
            f"seeded {len(seeded)} agents, {len(room_ids)} rooms in {time.monotonic() - t:.1f}s",
            flush=True,
        )
        rooms_of: dict[int, list[str]] = {}
        for j, members in enumerate(membership):
            for m in members:
                rooms_of.setdefault(m, []).append(room_ids[j])
        for s in seeded:
            base = bases[s.index % len(bases)]
            agents.append(
                Agent(
                    s,
                    rooms_of.get(s.index, []),
                    base,
                    ids,
                    stats,
                    clients[base],
                    a.read_fraction,
                    a.seed,
                )
            )

        opened = 0
        for step in a.steps:
            if stop.is_set():
                break
            stats.phase = sampler.phase = f"connect@{step}"
            t = time.monotonic()
            while opened < step:
                agents[opened].start()
                opened += 1
                await asyncio.sleep(1 / a.connect_rate)
            while (
                sum(x.connected.is_set() for x in agents[:step]) < step
                and time.monotonic() - t < 180
            ):
                if await wait(stop, 0.5):
                    break
            up = sum(x.connected.is_set() for x in agents[:step])
            print(
                f"step {step}: {up}/{step} agents connected in {time.monotonic() - t:.1f}s",
                flush=True,
            )

            for sc in a.scenarios:
                if stop.is_set():
                    break
                name = f"{sc}@{step}"
                schedule = schedules[name]
                stats.phase = sampler.phase = name
                start, t0 = time.time(), time.monotonic()
                print(
                    f"  {name}: {len(schedule)} messages over {a.duration:.0f}s",
                    flush=True,
                )
                if schedule:
                    await play(
                        schedule,
                        agents[:step],
                        room_ids,
                        membership,
                        stats,
                        run_id,
                        name,
                        stop,
                    )
                await wait(stop, a.duration - (time.monotonic() - t0))
                end, secs = time.time(), time.monotonic() - t0
                stopped = stop.is_set()
                stats.phase = sampler.phase = "settle"
                await wait(stop, a.settle)
                phases.append(
                    {
                        "name": name,
                        "scenario": sc,
                        "agents": step,
                        "start": start,
                        "end": end,
                        "seconds": secs,
                        "planned": len(schedule),
                        "fingerprint": fingerprint(schedule),
                        "stopped": stopped,
                    }
                )
    except Exception as exc:  # noqa: BLE001 - reported, then torn down
        print(f"run failed: {type(exc).__name__}: {exc}", flush=True)
        code = 1
    finally:
        stats.phase = sampler.phase = "teardown"
        counter.cancel()
        await asyncio.gather(*(x.stop() for x in agents), return_exceptions=True)
        try:
            td = await teardown(admin, run_id)
            print(f"teardown: {json.dumps(td)}", flush=True)
            if td["left_agents"] or td["left_rooms"] or td["left_keys"] or td["errors"]:
                code = code or 1
        except Exception as exc:  # noqa: BLE001
            print(f"teardown failed ({exc}); run: --cleanup {run_id}", flush=True)
            code = 1
        await admin.close()
        await asyncio.gather(
            *(c.aclose() for c in clients.values()), return_exceptions=True
        )
        sampler_task.cancel()
        await sampler.close()
        if pf:
            pf.close()

    meta["pods"] = sorted(sampler.pods_seen)
    meta["pod_info"] = sampler.pods_seen
    meta["ended"] = datetime.now(UTC).isoformat(timespec="seconds")
    for p in phases:
        p["rds"] = await asyncio.to_thread(rds_cpu, a, p["start"], p["end"])
    summaries = [
        phase_summary(p, stats, sampler.samples, connected_log.get(p["name"], []))
        for p in phases
    ]
    _write_jsonl(out / "samples.jsonl", sampler.samples)
    _write_jsonl(out / "events.jsonl", stats.events)
    _write_jsonl(out / "messages.jsonl", (asdict(m) for m in stats.messages.values()))
    (out / "phases.json").write_text(json.dumps(phases, indent=1))
    (out / "summary.json").write_text(
        json.dumps(
            {"meta": meta, "phases": summaries, "teardown": td}, indent=1, default=str
        )
    )
    (out / "summary.md").write_text(render(meta, summaries, td))
    print((out / "summary.md").read_text())
    return code


def _write_jsonl(path: Path, rows) -> None:
    with path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, default=str) + "\n")


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    if a.plan:
        membership, schedules = plan(a)
        print(f"membership {fingerprint(membership)}: {a.rooms} rooms of {a.room_size}")
        for name, sch in schedules.items():
            print(f"{name}: {len(sch)} messages, schedule {fingerprint(sch)}")
        return 0
    try:
        guard_target(a.namespace, a.api_url or "", a.gateway_url or "")
        kube = Kube(a.kube_context, a.namespace)
        if a.via == "urls":
            resolve_urls(a, kube)
            guard_target(a.namespace, a.api_url, a.gateway_url)
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    if a.cleanup:
        return asyncio.run(cleanup(a, kube))
    return asyncio.run(run(a, kube))


if __name__ == "__main__":
    sys.exit(main())

"""Load test switch-core in a non-pilot environment, and publish the numbers.

    uv run --project core python loadtest/run.py --namespace <namespace> \\
        --scenarios idle,steady,burst --steps 50,100,200 --rate 5 --duration 120

    # a message-rate sweep: one idle window, then 90 s at each rate until one breaks
    uv run --project core python loadtest/run.py --namespace <namespace> \\
        --scenarios idle --steps 300 --rates 10,15,20,25

    # the same agents behind 25 fake controllers, as most real agents connect
    uv run --project core python loadtest/run.py --namespace <namespace> \\
        --controllers 25 --scenarios idle,steady --steps 500,1000 --rate 2

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
import re
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from agents import Agent, Stats, play  # noqa: E402
from controllers import FakeController, ManagedAgent  # noqa: E402
from kube import Kube, PortForward, Refused, Sampler, guard_target  # noqa: E402
from report import phase_summary, render  # noqa: E402
from seed import (  # noqa: E402
    Admin,
    NoWorkspace,
    RequestIds,
    SeededAgent,
    create_controllers,
    revoke_controllers,
    seed,
    seed_managed,
    teardown,
)
from workload import (  # noqa: E402
    SCENARIOS,
    build_membership,
    build_schedule,
    fingerprint,
)

RUNS = Path(__file__).parent / "runs"
# A run id names a directory under RUNS and prefixes what the run makes.
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    t = ap.add_argument_group("target")
    t.add_argument(
        "--namespace",
        required=True,
        help="the release's namespace; the pilot's and prod's are refused",
    )
    t.add_argument(
        "--kube-context",
        default="",
        help="default: kubectl's current context, or from a pod inside the "
        "cluster the pod's service account",
    )
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
    t.add_argument(
        "--workspace",
        help="run in the admin's workspace of this name, made as an organization "
        "of its own if missing, so the agents stay off the bridges of the "
        "admin's own workspace",
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
    w.add_argument(
        "--controllers",
        type=int,
        default=0,
        help="run the agents behind this many fake agent controllers, spread "
        "evenly, instead of each on a socket of its own",
    )
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
    w.add_argument(
        "--rates",
        help="messages per second to step through after the scenarios at each step, "
        "e.g. 10,15,20: one steady window per rate with the same agents connected, "
        "stopping after the first rate that breaks",
    )
    w.add_argument(
        "--rate-duration",
        default="90",
        help="seconds measured per rate: one number for every rate, or one per "
        "rate in --rates, e.g. 600,600,60",
    )
    w.add_argument(
        "--rates-after",
        metavar="FILE",
        help="before the first rate, wait with the agents connected until FILE "
        "exists, so workers started one after another step their rates together",
    )
    w.add_argument(
        "--drain",
        type=float,
        default=60.0,
        help="most seconds to wait after each rate for its deliveries to arrive",
    )
    w.add_argument(
        "--drain-full",
        action="store_true",
        help="always wait the whole --drain after each rate, so workers that "
        "started their rates together start every rate together",
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
    w.add_argument(
        "--retry",
        choices=["harness", "runtime"],
        default="harness",
        help="how a dropped agent socket reopens: the harness's jittered backoff, "
        "or as the real agent runtime does (fast retries for a minute after a "
        "restart, unjittered doubling otherwise, standing down when refused as "
        "taken over)",
    )
    w.add_argument(
        "--honor-busy",
        action="store_true",
        help="wait out the retry_after_s of an open refused as busy, as clients "
        "with the open gate's change do",
    )
    w.add_argument(
        "--calls",
        choices=["message", "ops", "socket"],
        default="message",
        help="how a controller's agents post and read: on the message route, as "
        "operations over HTTP the way the real controller relays them, or as "
        "operations on the controller's socket",
    )
    w.add_argument("--seed", type=int, default=1)
    o = ap.add_argument_group("run")
    o.add_argument("--run-id", help="default: UTC time, e.g. 20261026t153000")
    o.add_argument("--sample-interval", type=float, default=1.0)
    o.add_argument(
        "--rds-instance",
        help="RDS instance to read CPU from in CloudWatch",
    )
    o.add_argument(
        "--aws-profile",
        default=os.environ.get("AWS_PROFILE", ""),
        help="default: the credentials already in the environment, such as a "
        "pod's service account role",
    )
    o.add_argument(
        "--aws-region",
        default=os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION", ""),
        help="the RDS instance's region; default: AWS_REGION, else the AWS CLI's own",
    )
    o.add_argument(
        "--plan", action="store_true", help="print the workload and exit; no requests"
    )
    o.add_argument(
        "--cleanup",
        metavar="RUN_ID",
        help="remove a run's leftovers ('*' for every load run) and exit",
    )
    o.add_argument(
        "--keep",
        action="store_true",
        help="leave the agents and rooms for a later run's --reuse; only the "
        "controllers are revoked",
    )
    o.add_argument(
        "--seed-only",
        action="store_true",
        help="with --keep: make the agents and rooms and keep them, connecting "
        "nothing, for later runs' --reuse",
    )
    o.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="requests in flight while making and removing agents, rooms and "
        "controllers; lower it on an environment with few pods",
    )
    o.add_argument(
        "--reuse",
        metavar="RUN_ID",
        help="use the agents and rooms a --keep run left instead of seeding; "
        "same --seed, --steps, --rooms and --room-size as that run",
    )
    a = ap.parse_args(argv)
    a.scenarios = [s.strip() for s in a.scenarios.split(",") if s.strip()]
    for s in a.scenarios:
        if s not in SCENARIOS:
            ap.error(f"unknown scenario {s}")
    a.steps = [int(x) for x in a.steps.split(",")] if a.steps else [a.agents]
    a.rates = [float(x) for x in a.rates.split(",")] if a.rates else []
    if not _increasing(a.rates) or any(r <= 0 for r in a.rates):
        ap.error("--rates must be increasing and above 0")
    durations = [float(x) for x in str(a.rate_duration).split(",")]
    if len(durations) == 1:
        durations *= max(1, len(a.rates))
    if len(durations) != max(1, len(a.rates)) or any(d <= 0 for d in durations):
        ap.error("--rate-duration takes one number, or one per rate in --rates")
    a.rate_durations = durations
    if not _increasing(a.steps) or min(a.steps) < 2:
        ap.error("--steps must be increasing and at least 2")
    a.rooms = a.rooms or max(1, max(a.steps) // 2)
    if a.controllers < 0 or a.controllers > max(a.steps):
        ap.error("--controllers must be between 0 and the largest step")
    if (a.keep or a.reuse) and not a.controllers:
        # Agents of their own carry an API key each, which is not kept.
        ap.error("--keep and --reuse need agents behind --controllers")
    if a.seed_only and (not a.keep or a.reuse):
        ap.error("--seed-only needs --keep, and makes agents rather than reusing them")
    if a.concurrency < 1:
        ap.error("--concurrency must be at least 1")
    for flag, value in (("--run-id", a.run_id), ("--reuse", a.reuse)):
        if value is not None and not RUN_ID.fullmatch(value):
            ap.error(f"{flag} takes letters, digits, - and _ only")
    if a.cleanup not in (None, "*") and not RUN_ID.fullmatch(a.cleanup):
        ap.error("--cleanup takes a run id or '*'")
    return a


def _increasing(xs: list) -> bool:
    """Each one above the last: a repeated rate or step would share a window."""
    return all(x < y for x, y in zip(xs, xs[1:]))


def kept_record(
    run_id: str,
    names_from: str,
    seeded: list[SeededAgent],
    room_ids: list[str],
    membership: list[list[int]],
    a: argparse.Namespace,
) -> dict:
    """What a later run needs to take over the agents and rooms: ids only.
    No credential: the agents have none of their own, and the controllers,
    which do, are revoked."""
    return {
        "kept_by": run_id,
        "names_from": names_from,
        "seed": a.seed,
        "agents": [{"index": s.index, "id": s.id, "name": s.name} for s in seeded],
        "rooms": room_ids,
        "membership_fingerprint": fingerprint(membership),
        "workspace": a.workspace,
    }


def take_over(
    kept: dict, membership: list[list[int]], n_agents: int
) -> list[SeededAgent]:
    """The kept agents, once the plan is shown to put them in the same rooms."""
    if kept["membership_fingerprint"] != fingerprint(membership):
        raise RuntimeError(
            f"the plan's rooms differ from {kept['kept_by']}'s: use its --seed, "
            "--steps, --rooms and --room-size"
        )
    if len(kept["agents"]) < n_agents:
        raise RuntimeError(f"{kept['kept_by']} kept {len(kept['agents'])} agents")
    return [SeededAgent(x["index"], x["id"], x["name"], "") for x in kept["agents"]]


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
        for r, rate_duration in zip(a.rates, a.rate_durations, strict=False):
            schedules[rate_phase(r, step)] = build_schedule(
                seed=a.seed,
                scenario="steady",
                step=step,
                duration=rate_duration,
                rooms=membership,
                active=step,
                rate=r,
                payload_min=a.payload_min,
                payload_max=a.payload_max,
            )
    return membership, schedules


def rate_phase(rate: float, step: int) -> str:
    """The phase name of one rate in --rates: `steady15@300` is 15 messages a
    second with 300 agents connected."""
    return f"steady{rate:g}@{step}"


def broken(summary: dict) -> str | None:
    """Why a measured window counts as broken, or None: a delivery lost, p99
    over 20 s, or more than 20 errors. A sweep does not step past it."""
    if summary["deliveries_missing"]:
        return f"{summary['deliveries_missing']} deliveries missing"
    if (summary["delivery_ms_p99"] or 0) > 20000:
        return f"p99 {summary['delivery_ms_p99'] / 1000:.1f} s"
    if summary["errors"] > 20:
        return f"{summary['errors']} errors"
    return None


def admin_login(kube: Kube) -> tuple[str, str]:
    """The admin's email and password: LOADTEST_ADMIN_EMAIL and
    LOADTEST_ADMIN_PASSWORD when both are set, for an environment whose admin
    has changed the password it was deployed with, otherwise the release's
    Secret. Kept in memory only."""
    email = os.environ.get("LOADTEST_ADMIN_EMAIL")
    password = os.environ.get("LOADTEST_ADMIN_PASSWORD")
    if email and password:
        return email, password
    return kube.admin_login()


def resolve_urls(a: argparse.Namespace, kube: Kube) -> None:
    """Default the URLs to the release's own, and refuse URLs that belong to
    another environment: the pods sampled must be the pods loaded. A URL on
    one of the namespace's own Ingresses (its tailnet one, say) or Services
    (from inside the cluster) is its too."""
    gw, api = kube.public_urls()
    hosts: set[str] | None = None
    for flag, given, deployed in (
        ("--gateway-url", a.gateway_url, gw),
        ("--api-url", a.api_url, api),
    ):
        if not given or (deployed and given.rstrip("/") == deployed.rstrip("/")):
            continue
        if hosts is None:
            hosts = kube.ingress_hosts() | kube.service_hosts()
        if urlparse(given).hostname not in hosts:
            raise Refused(
                f"{flag} {given} is neither this namespace's "
                f"({deployed or 'the release names none'}) nor on one of its "
                "Ingresses or Services; refusing to load one env and sample another"
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
    env = dict(os.environ)
    if a.aws_profile:
        env["AWS_PROFILE"] = a.aws_profile
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
                *(["--region", a.aws_region] if a.aws_region else []),
                "--output", "json",
            ],
            capture_output=True, text=True, timeout=60, env=env,
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
        await admin.login(*admin_login(kube))
        if a.workspace:
            try:
                await admin.use_workspace(a.workspace, create=False)
            except NoWorkspace as exc:
                print(f"{exc}: nothing to clean", flush=True)
                return 0
        done = await teardown(admin, a.cleanup, concurrency=a.concurrency)
    finally:
        await admin.close()
        if pf:
            pf.close()
    print(json.dumps(done))
    left = ("left_agents", "left_rooms", "left_keys", "left_controllers")
    return 1 if any(done.get(k) for k in left) else 0


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
        "reused": a.reuse,
        # Set at the end: a run asked to keep that never finished seeding
        # tears everything down instead.
        "kept": False,
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
    controllers: list[FakeController] = []
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

    async def drained(name: str) -> bool:
        """Wait, up to --drain seconds, until every message sent in `name` has
        reached all its receivers, so a backlog does not run into the next
        window. Errors in the meantime still count for `name`."""
        t = time.monotonic()
        while time.monotonic() - t < a.drain:
            sent = stats.by_phase.get(name, [])
            if all(m.status != 200 or len(m.latencies) >= m.expected for m in sent):
                return True
            if await wait(stop, 1.0):
                break
        return False

    async def measure(
        name: str, scenario: str, step: int, duration: float, drain: bool = False
    ) -> None:
        schedule = schedules[name]
        stats.phase = sampler.phase = name
        start, t0 = time.time(), time.monotonic()
        print(f"  {name}: {len(schedule)} messages over {duration:.0f}s", flush=True)
        if schedule:
            await play(
                schedule, agents[:step], room_ids, membership, stats, run_id, name, stop
            )
        await wait(stop, duration - (time.monotonic() - t0))
        end, secs = time.time(), time.monotonic() - t0
        stopped = stop.is_set()
        if drain:
            sampler.phase = "drain"
            t1 = time.monotonic()
            done = await drained(name)
            print(
                f"  {name}: deliveries {'drained' if done else 'still owed'} after {time.monotonic() - t1:.0f}s",
                flush=True,
            )
            if a.drain_full:
                await wait(stop, a.drain - (time.monotonic() - t1))
        stats.phase = sampler.phase = "settle"
        await wait(stop, a.settle)
        phases.append(
            {
                "name": name,
                "scenario": scenario,
                "agents": step,
                "start": start,
                "end": end,
                "seconds": secs,
                "planned": len(schedule),
                "fingerprint": fingerprint(schedule),
                "stopped": stopped,
            }
        )

    code = 0
    # Whose name prefix the agents and rooms carry: this run's, or that of the
    # run that seeded them, when they are reused.
    names_from = run_id
    seeded = []
    room_ids = []
    taken_over = False
    try:
        await admin.login(*admin_login(kube))
        if a.workspace:
            # Kept agents live in a workspace that exists: a reusing run never
            # makes one, so several started at once cannot make one each.
            meta["workspace"] = await admin.use_workspace(
                a.workspace, create=not a.reuse
            )
            print(f"workspace: {json.dumps(meta['workspace'])}", flush=True)
        await admin.refuse_bridges()
        t = time.monotonic()
        if a.reuse:
            kept = json.loads((RUNS / a.reuse / "keep.json").read_text())
            if kept.get("workspace") != a.workspace:
                raise RuntimeError(
                    f"{a.reuse} kept its agents in workspace {kept.get('workspace')}: "
                    "reuse them with the same --workspace"
                )
            seeded = take_over(kept, membership, max(a.steps))
            room_ids = kept["rooms"]
            names_from = kept["names_from"]
            meta["names_from"] = names_from
            # From here on a run that fails still keeps them, under --keep.
            taken_over = True
            made = await create_controllers(
                admin, run_id, a.controllers, state, asyncio.Semaphore(a.concurrency)
            )
            print(
                f"reusing {len(seeded)} agents and {len(room_ids)} rooms kept by "
                f"{a.reuse}; {len(made)} new controllers in "
                f"{time.monotonic() - t:.1f}s",
                flush=True,
            )
        elif a.controllers:
            seeded, room_ids, made = await seed_managed(
                admin,
                run_id,
                max(a.steps),
                a.controllers,
                membership,
                state,
                concurrency=a.concurrency,
            )
            taken_over = True
        else:
            seeded, room_ids = await seed(
                admin,
                a.api_url,
                run_id,
                max(a.steps),
                membership,
                state,
                concurrency=a.concurrency,
            )
            made = []
        for c in made:
            base = bases[c.index % len(bases)]
            controllers.append(
                FakeController(
                    c.index,
                    c.id,
                    c.name,
                    c.credential,
                    base,
                    clients[base],
                    ids,
                    stats,
                    honor_busy=a.honor_busy,
                )
            )
        if not a.reuse:
            print(
                f"seeded {len(seeded)} agents, {len(room_ids)} rooms"
                + (f", {len(controllers)} controllers" if controllers else "")
                + f" in {time.monotonic() - t:.1f}s",
                flush=True,
            )
        if a.seed_only:
            print("seed only: nothing connects; agents and rooms are kept", flush=True)
        rooms_of: dict[int, list[str]] = {}
        for j, members in enumerate(membership):
            for m in members:
                rooms_of.setdefault(m, []).append(room_ids[j])
        for s in seeded:
            base = bases[s.index % len(bases)]
            if controllers:
                owner = controllers[s.index % len(controllers)]
                agents.append(
                    ManagedAgent(
                        s,
                        rooms_of.get(s.index, []),
                        ids,
                        stats,
                        owner.http,
                        a.read_fraction,
                        a.seed,
                        owner,
                        admin,
                        calls=a.calls,
                    )
                )
                continue
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
                    retry=a.retry,
                    honor_busy=a.honor_busy,
                )
            )
        if controllers and not a.seed_only:
            # Placing an agent needs its controller online with a fresh status
            # report, so every controller connects and reports first.
            stats.phase = sampler.phase = "controllers"
            t = time.monotonic()
            for c in controllers:
                c.start()
                await asyncio.sleep(1 / a.connect_rate)
            while (
                sum(c.reported.is_set() for c in controllers) < len(controllers)
                and time.monotonic() - t < 120
            ):
                if await wait(stop, 0.5):
                    break
            up = sum(c.reported.is_set() for c in controllers)
            print(
                f"controllers: {up}/{len(controllers)} connected and reporting "
                f"in {time.monotonic() - t:.1f}s",
                flush=True,
            )
            if up < len(controllers):
                raise RuntimeError("not every controller came online")

        opened = 0
        for step in [] if a.seed_only else a.steps:
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
                await measure(f"{sc}@{step}", sc, step, a.duration)
            if a.rates and a.rates_after and not stop.is_set():
                stats.phase = sampler.phase = f"wait@{step}"
                print(f"  waiting for {a.rates_after} before the rates", flush=True)
                while not Path(a.rates_after).exists():
                    if await wait(stop, 0.5):
                        break
                now = datetime.now(UTC).isoformat(timespec="seconds")
                print(f"  rates start {now}", flush=True)
            for r, rate_duration in zip(a.rates, a.rate_durations, strict=False):
                if stop.is_set():
                    break
                name = rate_phase(r, step)
                await measure(name, "steady", step, rate_duration, drain=True)
                phases[-1]["rate"] = r
                why = broken(
                    phase_summary(
                        phases[-1],
                        stats,
                        sampler.by_phase.get(name, []),
                        connected_log.get(name, []),
                    )
                )
                if why:
                    print(f"  {name} broke ({why}); not stepping higher", flush=True)
                    break
    except Exception as exc:  # noqa: BLE001 - reported, then torn down
        print(f"run failed: {type(exc).__name__}: {exc}", flush=True)
        code = 1
    finally:
        stats.phase = sampler.phase = "teardown"
        counter.cancel()
        await asyncio.gather(*(x.stop() for x in agents), return_exceptions=True)
        await asyncio.gather(*(c.stop() for c in controllers), return_exceptions=True)
        try:
            if a.keep and taken_over:
                meta["kept"] = True
                td = await revoke_controllers(admin, run_id, concurrency=a.concurrency)
                record = kept_record(
                    run_id, names_from, seeded, room_ids, membership, a
                )
                (out / "keep.json").write_text(json.dumps(record, indent=1))
                print(
                    f"kept {len(seeded)} agents and {len(room_ids)} rooms for "
                    f"--reuse {run_id}; teardown: {json.dumps(td)}",
                    flush=True,
                )
                if td["left_controllers"] or td["errors"]:
                    code = code or 1
            else:
                td = await teardown(admin, run_id, concurrency=a.concurrency)
                if names_from != run_id:
                    seeded_td = await teardown(
                        admin, names_from, concurrency=a.concurrency
                    )
                    td = {k: td.get(k, 0) + seeded_td.get(k, 0) for k in td | seeded_td}
                print(f"teardown: {json.dumps(td)}", flush=True)
                if (
                    td["left_agents"]
                    or td["left_rooms"]
                    or td["left_keys"]
                    or td.get("left_controllers")
                    or td["errors"]
                ):
                    code = code or 1
        except Exception as exc:  # noqa: BLE001
            also = f" and --cleanup {names_from}" if names_from != run_id else ""
            print(f"teardown failed ({exc}); run: --cleanup {run_id}{also}", flush=True)
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
        phase_summary(
            p,
            stats,
            sampler.by_phase.get(p["name"], []),
            connected_log.get(p["name"], []),
        )
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

"""Turning a run's raw records into numbers per phase, and into summary.md."""

from __future__ import annotations

import statistics
from collections import defaultdict


def pct(xs: list[float], p: float) -> float | None:
    """The p-th quantile (nearest rank) in milliseconds, or None."""
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))] * 1000, 1)


def _avg(xs: list[float]) -> float | None:
    return round(statistics.mean(xs), 1) if xs else None


def _max(xs: list[float]) -> float | None:
    return round(max(xs), 1) if xs else None


def phase_summary(
    phase: dict, stats, samples: list[dict], agents_connected: list[int]
) -> dict:
    """The numbers for one measured window (`phase` has its name, scenario,
    length in seconds and the target agent count)."""
    name, secs = phase["name"], phase["seconds"]
    msgs = [m for m in stats.messages.values() if m.phase == name]
    ok = [m for m in msgs if m.status == 200]
    lat = [x for m in ok for x in m.latencies]
    send = [m.acked - m.sent for m in ok if m.acked is not None]
    expected = sum(m.expected for m in ok)
    got = sum(min(len(m.latencies), m.expected) for m in ok)
    ev = [e for e in stats.events if e["phase"] == name]
    count = defaultdict(int)
    for e in ev:
        count[e["kind"]] += 1

    # Tagged with the phase as each line arrives, so pod clocks do not matter.
    in_window = [s for s in samples if s.get("phase") == name]
    pods: dict[str, dict] = {}
    for s in in_window:
        if s["kind"] != "pod":
            continue
        p = pods.setdefault(s["pod"], {"cpu": [], "mem": []})
        if s.get("cpu_pct") is not None:
            p["cpu"].append(s["cpu_pct"])
        if s.get("mem_mb") is not None:
            p["mem"].append(s["mem_mb"])
    db = [s for s in in_window if s["kind"] == "db"]
    xact = [s["xact_s"] for s in db if s.get("xact_s") is not None]

    errors = (
        stats.send_errors.get(name, 0)
        + stats.read_errors.get(name, 0)
        + count["refused"]
        + count["drop"]
        + count["connect_failed"]
        + count["evicted"]
    )
    return {
        "phase": name + (" (stopped early)" if phase.get("stopped") else ""),
        "scenario": phase["scenario"],
        "agents_target": phase["agents"],
        "agents_connected_min": min(agents_connected) if agents_connected else None,
        "agents_connected_end": agents_connected[-1] if agents_connected else None,
        "seconds": round(secs, 1),
        "schedule_fingerprint": phase.get("fingerprint"),
        "messages_planned": phase.get("planned", 0),
        "messages_sent": len(ok),
        "messages_sent_per_s": round(len(ok) / secs, 2) if secs else None,
        "send_errors": stats.send_errors.get(name, 0),
        "send_ms_p50": pct(send, 0.5),
        "send_ms_p99": pct(send, 0.99),
        "deliveries_expected": expected,
        "deliveries_received": got,
        "deliveries_missing": expected - got,
        "deliveries_per_s": round(got / secs, 2) if secs else None,
        "delivery_ms_p50": pct(lat, 0.5),
        "delivery_ms_p99": pct(lat, 0.99),
        "delivery_ms_max": pct(lat, 1.0),
        "context_reads": len(stats.reads.get(name, [])),
        "context_read_errors": stats.read_errors.get(name, 0),
        "context_read_ms_p99": pct(stats.reads.get(name, []), 0.99),
        "drops": count["drop"],
        "refusals": count["refused"],
        "connect_failures": count["connect_failed"],
        "evictions": count["evicted"],
        "gaps": count["gap"],
        "errors": errors,
        "harness_lag_ms_max": round(stats.lag_max.get(name, 0.0) * 1000, 1),
        "pods": {
            pod: {
                "cpu_pct_avg": _avg(v["cpu"]),
                "cpu_pct_max": _max(v["cpu"]),
                "mem_mb_max": _max(v["mem"]),
            }
            for pod, v in sorted(pods.items())
        },
        "db_app_conns_max": max((s["app_total"] for s in db), default=None),
        "db_app_active_max": max((s["app_active"] for s in db), default=None),
        "db_app_idle_tx_max": max((s["app_idle_tx"] for s in db), default=None),
        "db_conns_total_max": max((s["db_total"] for s in db), default=None),
        "db_lock_waits_max": max((s["lock_waits"] for s in db), default=None),
        "db_xact_per_s_avg": _avg(xact),
        "db_xact_per_s_p50": round(statistics.median(xact), 1) if xact else None,
        "db_xact_per_s_max": _max(xact),
        "rds": phase.get("rds"),
    }


def _fmt(v) -> str:
    return "-" if v is None else str(v)


def render(meta: dict, phases: list[dict], teardown: dict | None) -> str:
    lines = [
        f"# Load run {meta['run_id']}",
        "",
        f"- Target: namespace `{meta['namespace']}` (context `{meta['kube_context']}`), "
        f"API {meta['api_url']}, via {meta['via']}",
        f"- switch-core pods seen: {', '.join(meta['pods']) or 'none'}",
        f"- Seed {meta['seed']}, membership {meta['membership_fingerprint']}, "
        f"{meta['rooms']} rooms of {meta['room_size']}",
        f"- Started {meta['started']}, ended {meta.get('ended', '-')}",
        "",
        "Delivery latency is from the moment the sender's POST went out to the moment the "
        "receiving agent read the frame, both on the harness clock. `errors` counts failed "
        "sends, failed context reads, refused or failed connects, evictions and dropped sockets.",
        "",
        "## Traffic",
        "",
        "| phase | agents (target / min connected) | msgs/s sent | deliveries/s | delivered / expected "
        "| delivery p50 / p99 ms | send p99 ms | errors | harness lag max ms |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for p in phases:
        lines.append(
            f"| {p['phase']} | {p['agents_target']} / {_fmt(p['agents_connected_min'])} "
            f"| {_fmt(p['messages_sent_per_s'])} | {_fmt(p['deliveries_per_s'])} "
            f"| {p['deliveries_received']} / {p['deliveries_expected']} "
            f"| {_fmt(p['delivery_ms_p50'])} / {_fmt(p['delivery_ms_p99'])} "
            f"| {_fmt(p['send_ms_p99'])} | {p['errors']} | {p['harness_lag_ms_max']} |"
        )
    lines += [
        "",
        "## Server",
        "",
        "| phase | pod | CPU avg / max % | memory max MB |",
        "|---|---|---|---|",
    ]
    for p in phases:
        for pod, v in p["pods"].items():
            lines.append(
                f"| {p['phase']} | {pod} | {_fmt(v['cpu_pct_avg'])} / {_fmt(v['cpu_pct_max'])} "
                f"| {_fmt(v['mem_mb_max'])} |"
            )
    lines += [
        "",
        "| phase | DB conns app max (active / idle in tx) | DB conns total max | transactions/s avg / p50 / max "
        "| lock waits max | RDS CPU avg / max % |",
        "|---|---|---|---|---|---|",
    ]
    for p in phases:
        rds = p.get("rds") or {}
        lines.append(
            f"| {p['phase']} | {_fmt(p['db_app_conns_max'])} ({_fmt(p['db_app_active_max'])} / "
            f"{_fmt(p['db_app_idle_tx_max'])}) | {_fmt(p['db_conns_total_max'])} "
            f"| {_fmt(p['db_xact_per_s_avg'])} / {_fmt(p['db_xact_per_s_p50'])} / {_fmt(p['db_xact_per_s_max'])} "
            f"| {_fmt(p['db_lock_waits_max'])} | {_fmt(rds.get('cpu_avg'))} / {_fmt(rds.get('cpu_max'))} |"
        )
    if teardown is not None:
        lines += [
            "",
            "## Teardown",
            "",
            f"Agents deleted {teardown.get('agents_deleted')}, rooms archived {teardown.get('rooms_archived')}, "
            f"keys deleted {teardown.get('keys_deleted')}, errors {teardown.get('errors')}. "
            f"Left behind: {teardown.get('left_agents')} agents, {teardown.get('left_rooms')} active rooms, "
            f"{teardown.get('left_keys')} keys.",
        ]
    return "\n".join(lines) + "\n"

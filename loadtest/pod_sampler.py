# Runs inside a switch-core pod, fed to `python -` over `kubectl exec -i`, and
# prints one JSON line per interval. It only reads: the container's own cgroup
# files, and Postgres statistics views.
#
#   python - pod [interval]  this container's CPU (percent of one core, from
#                            cpu.stat) and memory (memory.current), in MB.
#   python - db [interval]   database-wide numbers, the same from any pod:
#                            connections of the app's DB role by state (all
#                            pods together), every connection to the database,
#                            lock waits, and transactions per second. Connects
#                            with the pod's own DB_* environment.
#
# Standard library only in `pod` mode; `db` mode uses asyncpg, which the
# switch-core image already has.
import json
import os
import sys
import time


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def _cpu_usec():
    for line in _read("/sys/fs/cgroup/cpu.stat").splitlines():
        if line.startswith("usage_usec"):
            return int(line.split()[1])
    return None


def _mem_mb():
    v = _read("/sys/fs/cgroup/memory.current").strip()
    return round(int(v) / (1024 * 1024), 1) if v else None


def pod(interval):
    last = None
    while True:
        t, c = time.time(), _cpu_usec()
        out = {"ts": t, "mem_mb": _mem_mb()}
        if last and c is not None and last[1] is not None:
            out["cpu_pct"] = round((c - last[1]) / ((t - last[0]) * 1e6) * 100, 1)
        last = (t, c)
        print(json.dumps(out), flush=True)
        time.sleep(interval)


async def db(interval):
    import asyncio

    import asyncpg

    conn = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT") or 5432),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        ssl="prefer",
    )
    role, name = os.environ["DB_USER"], os.environ["DB_NAME"]
    last = None
    while True:
        t = time.time()
        rows = await conn.fetch(
            "select usename = $1 as app, coalesce(state, '?') s, count(*) n, "
            "count(*) filter (where wait_event_type = 'Lock') lw "
            "from pg_stat_activity where datname = $2 and pid <> pg_backend_pid() "
            "group by 1, 2",
            role,
            name,
        )
        x = await conn.fetchval(
            "select xact_commit + xact_rollback from pg_stat_database where datname = $1",
            name,
        )
        app = {r["s"]: r["n"] for r in rows if r["app"]}
        out = {
            "ts": t,
            "app_active": app.get("active", 0),
            "app_idle": app.get("idle", 0),
            "app_idle_tx": app.get("idle in transaction", 0),
            "app_total": sum(app.values()),
            "db_total": sum(r["n"] for r in rows),
            "lock_waits": sum(r["lw"] for r in rows),
        }
        if last:
            out["xact_s"] = round((x - last[1]) / (t - last[0]), 1)
        last = (t, x)
        print(json.dumps(out), flush=True)
        await asyncio.sleep(interval)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "pod"
    every = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    if mode == "db":
        import asyncio

        asyncio.run(db(every))
    else:
        pod(every)

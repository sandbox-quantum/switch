# switch-core load harness

Measures how much load switch-core carries in one environment, so the same run can be repeated at one pod and at two and the numbers compared (CHOO-3667, Stage 1 of the scale-validation plan).

A run signs in as the environment's admin, creates its own API key, agents and rooms, connects the agents over the agent WebSocket the way the agent runtime does, sends the planned traffic, and samples every switch-core pod and the database while it does. At the end it deletes what it created and writes a summary.

It never restarts, scales or edits anything in Kubernetes. It only runs `kubectl get` (to find the pods, the deployed URLs and the admin login), `kubectl exec` (to run `pod_sampler.py` inside the pods) and, with `--via port-forward`, `kubectl port-forward`. That makes it safe on GitOps environments: ArgoCD has nothing to fight over. It refuses the pilot namespace (`switch`), the pilot's hostnames, and anything with `prod` in the name.

## Running it

From the repo root, on a Mac that is on the tailnet, with `kubectl` pointed at the cluster (context `switch-eu` by default):

```sh
uv run --project core python loadtest/run.py --namespace switch-staging \
    --scenarios idle,steady,burst --steps 50,100,200 --rate 5 --duration 120 \
    --rds-instance switch-staging
```

The API and gateway URLs default to the ones the release was deployed with (`GATEWAY_PUBLIC_URL` and `FRONTEND_BASE_URL` on the switch-core deployment, which come from napoleon's values). Pass `--api-url` and `--gateway-url` to be explicit; a URL that belongs to a different environment is refused, so the pods sampled are always the pods loaded.

At each step in `--steps`, the harness brings that many agents online and then runs each scenario for `--duration` seconds, with `--settle` quiet seconds after each:

- `idle`: the agents stay connected and answer the server's pings, nothing else.
- `steady`: messages at `--rate` per second, spread over the rooms, each posted by a member of the room. Receivers record the time from send to arrival, and a share of them (`--read-fraction`, 10% by default) follow a delivery with a `read_context` call, as a runtime catching up would.
- `burst`: the steady traffic plus `--burst-size` messages packed into `--burst-window` seconds, every `--burst-every` seconds. `--hot-room` sends all the spikes to one room, to measure the per-room lock.

To compare one pod with two, run the same command, with the same `--seed`, once against each replica count. The replica count is changed in napoleon, not by this harness.

`--plan` prints the workload (message counts and a fingerprint per scenario) without making any request. The same `--seed` and flags always produce the same plan, which `summary.md` records alongside the results.

`--via port-forward` reaches each switch-core pod through `kubectl port-forward` instead of the tailnet, spreading the agents evenly over the pods. Use it for a smoke run from a Mac that is off the tailnet, not for capacity numbers, because all the traffic then passes through the Kubernetes API server.

## What it records

Each run writes `loadtest/runs/<run_id>/` (gitignored):

- `summary.md`, one row per scenario and step: agents connected, messages per second sent and delivered, delivery latency p50 and p99, errors, CPU and memory per pod, database connections, transactions per second, and RDS CPU when `--rds-instance` is given.
- `summary.json`, the same numbers plus the run's settings.
- `samples.jsonl`, the raw per-pod and database samples, one a second.
- `messages.jsonl`, every message sent with each receiver's latency.
- `events.jsonl`, connects, drops, refusals, evictions and gaps.

Every request the harness makes carries `X-Request-Id: load-<run_id>-<n>`, so a run can be found in the server's logs.

`harness lag max` in the summary is how far the harness fell behind its own schedule. If it climbs above a few hundred milliseconds, the client machine is the limit, not the server, and the run should be split across machines or slowed down.

RDS numbers come from CloudWatch at one-minute resolution and need `AWS_PROFILE` (default `qsg-nonprod-write`) with an SSO session. CloudWatch lands its data a minute or two late, so the last minute of a run can read low.

## Cleaning up

Teardown runs at the end of every run, and also after Ctrl-C or a failure: agents deleted, their API keys deleted, rooms archived, and the run's registration key deleted. A second Ctrl-C abandons the teardown. If that happens, or the process is killed, remove what is left by name:

```sh
uv run --project core python loadtest/run.py --namespace switch-staging --cleanup <run_id>
uv run --project core python loadtest/run.py --namespace switch-staging --cleanup '*'   # every load run
```

The cleanup prints what it removed and what is still there; a non-zero exit means something was left.

## Checks

```sh
uv run --project core pytest loadtest/test_workload.py
```

These check that the same seed gives the same rooms and schedule, and that the pilot and prod are refused. They make no requests.

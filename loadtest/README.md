# switch-core load harness

Measures how much load switch-core carries in one environment, so the same run can be repeated at one pod and at two and the numbers compared (CHOO-3667, Stage 1 of the scale-validation plan).

A run signs in as the environment's admin, creates its own API key, agents and rooms, connects the agents over the agent WebSocket the way the agent runtime does, sends the planned traffic, and samples every switch-core pod and the database while it does. At the end it deletes what it created and writes a summary.

It never restarts, scales or edits anything in Kubernetes. It only runs `kubectl get` (to find the pods, the deployed URLs and the admin login), `kubectl exec` (to run `pod_sampler.py` inside the pods) and, with `--via port-forward`, `kubectl port-forward`. That makes it safe on GitOps environments: ArgoCD has nothing to fight over. It refuses the pilot's namespace and hostnames, and anything with `prod` in the name.

## Running it

From the repo root, on a machine that can reach the environment's URLs, with `kubectl` pointed at the cluster (its current context, or name one with `--kube-context`):

```sh
uv run --project core python loadtest/run.py --namespace <namespace> \
    --scenarios idle,steady,burst --steps 50,100,200 --rate 5 --duration 120 \
    --rds-instance <db-instance>
```

The API and gateway URLs default to the ones the release was deployed with (`GATEWAY_PUBLIC_URL` and `FRONTEND_BASE_URL` on the switch-core deployment, which come from the release's values). Pass `--api-url` and `--gateway-url` to be explicit; a URL that belongs to a different environment is refused, so the pods sampled are always the pods loaded.

At each step in `--steps`, the harness brings that many agents online and then runs each scenario for `--duration` seconds, with `--settle` quiet seconds after each:

- `idle`: the agents stay connected and answer the server's pings, nothing else.
- `steady`: messages at `--rate` per second, spread over the rooms, each posted by a member of the room. Receivers record the time from send to arrival, and a share of them (`--read-fraction`, 10% by default) follow a delivery with a `read_context` call, as a runtime catching up would.
- `burst`: the steady traffic plus `--burst-size` messages packed into `--burst-window` seconds, every `--burst-every` seconds. `--hot-room` sends all the spikes to one room, to measure the per-room lock.

### Keeping the agents between runs

Seeding 10,000 agents and tearing them down take about 12 of a run's 22 minutes. With `--keep`, a run leaves its agents and rooms in place, revokes only its controllers, and writes `runs/<run id>/keep.json` (ids only: the agents have no key of their own, and a controller's credential is never written down). A later run with `--reuse <that run id>` makes fresh controllers and places the same agents on them instead of seeding; it needs the same `--seed`, `--steps`, `--rooms` and `--room-size`, which it checks. Add `--keep` again to pass them on; a run without it, or `--cleanup <the first run id>`, removes them. Both need `--controllers`.

To compare one pod with two, run the same command, with the same `--seed`, once against each replica count. The replica count is changed by the deployment, not by this harness.

`--rates 10,15,20,25` sweeps the message rate in one run: after the scenarios at each step, the same agents stay connected for one steady window of `--rate-duration` seconds (90 by default) at each rate, named `steady15@300` and so on. After each window the harness waits up to `--drain` seconds for that window's deliveries to arrive, so a backlog does not spill into the next rate, and it stops stepping after the first rate that breaks: a delivery lost, p99 over 20 s, or more than 20 errors. Agents are created, connected and measured idle once, so a five-rate sweep takes about 15 minutes instead of about 40 as separate runs:

```sh
uv run --project core python loadtest/run.py --namespace <namespace> \
    --scenarios idle --steps 300 --rates 10,15,20,25,30 --rds-instance <db-instance>
```

`--plan` prints the workload (message counts and a fingerprint per scenario) without making any request. The same `--seed` and flags always produce the same plan, which `summary.md` records alongside the results.

`--via port-forward` reaches each switch-core pod through `kubectl port-forward` instead of the deployed URLs, spreading the agents evenly over the pods. Use it for a smoke run from a machine that cannot reach those URLs, not for capacity numbers, because all the traffic then passes through the Kubernetes API server.

## What it records

Each run writes `loadtest/runs/<run_id>/` (gitignored):

- `summary.md`, one row per scenario and step: agents connected, messages per second sent and delivered, delivery latency p50 and p99, errors, CPU and memory per pod, database connections, transactions per second, and RDS CPU when `--rds-instance` is given.
- `summary.json`, the same numbers plus the run's settings.
- `samples.jsonl`, the raw per-pod and database samples, one a second.
- `messages.jsonl`, every message sent with each receiver's latency.
- `events.jsonl`, connects, drops, refusals, evictions and gaps.

Every request the harness makes carries `X-Request-Id: load-<run_id>-<n>`, so a run can be found in the server's logs.

`harness lag max` in the summary is how far the harness fell behind its own schedule. If it climbs above a few hundred milliseconds, the client machine is the limit, not the server, and the run should be split across machines or slowed down.

RDS numbers come from CloudWatch at one-minute resolution and need AWS credentials that can read it, such as an `AWS_PROFILE` (or `--aws-profile`) with an SSO session. CloudWatch lands its data a minute or two late, so the last minute of a run can read low.

## Every night on staging

`nightly.py` runs the harness from pods inside the cluster, as three CronJobs of the deployment's own load test chart, which sets the schedule and sizes:

- `up` (01:45 UTC) takes staging's node group to its night size, starts the harness's node and scales switch-core to 12 pods.
- `run` (02:00) starts ten workers of 1,000 agents each behind 50 controllers, all on the controller socket. Each worker reuses the batch of agents and rooms kept from earlier nights (`--keep`/`--reuse`, ids in S3), and the run makes them again when they are missing. The workers step their rates together: four realistic steps, one message per agent every 30, 10, 5 and 3 minutes for 10 minutes each, then a ramp from 150 messages a second, a minute a step, until a step breaks. It adds the workers up by window (`combine`), stores the night in S3, sends the numbers to Datadog (`switch.loadtest.*`) and posts the report to a webhook and, when one is set, a Switch room, as an agent in it, then puts staging back to its day size.
- `down` (05:00) puts the day sizes back whatever happened, and reports a night that left no result.

Inside the cluster the harness runs with `--kube-context ''` (kubectl uses the pod's service account) and reaches switch-core through its Service, which `--api-url` accepts as the namespace's own.

Everything `nightly.py` needs comes from `LOADTEST_*` variables, which the chart sets; `Config.from_env` lists them. It is the only part of the harness that changes anything: switch-core's replica count and two node groups' sizes, all named in that configuration.

## Cleaning up

Teardown runs at the end of every run, and also after Ctrl-C or a failure: agents deleted, their API keys deleted, rooms archived, and the run's registration key deleted. A second Ctrl-C abandons the teardown. If that happens, or the process is killed, remove what is left by name:

```sh
uv run --project core python loadtest/run.py --namespace <namespace> --cleanup <run_id>
uv run --project core python loadtest/run.py --namespace <namespace> --cleanup '*'   # every load run
```

The cleanup prints what it removed and what is still there; a non-zero exit means something was left.

## Checks

```sh
uv run --project core pytest loadtest/
```

These check that the same seed gives the same rooms and schedule, that a rate sweep plans one window per rate and knows when a window is broken, that the pilot and prod are refused, and how a night adds up, reports and cleans up after itself. They make no requests.

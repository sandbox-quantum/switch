"""`switch-hosted-workers`: the in-cluster loop for Kubernetes boxes.

One process, one loop, and four workers that already exist on their own, each
turned on by its own switch (`1` or `0`, off when unset):

- `SWITCH_HOSTED_WORKERS_SCALER`: the box scaler (`box_scaler.py`) scales each
  box to what Core wants and reports what it sees. With it, the registration
  codes (`registration_codes.py`): a box made empty gets its one-time
  code from Core's `prepare` just before it first starts, and the code is
  cleared once the box has registered.
- `SWITCH_HOSTED_WORKERS_EVICTIONS`: the eviction watch (`evictions.py`) alerts
  each box pushed off its machine. With it, `SWITCH_SCALER_REPORT_EVICTIONS=1`
  sends the count to Core, and `SWITCH_SCALER_REPORT_BOX_FACTS=1` sends each
  box's restarts and node (`cluster_watch.RestartCounter`), as on the Mac.
- `SWITCH_HOSTED_WORKERS_CLUSTER_REPORT`: the cluster report
  (`cluster_watch.ClusterWatch`), with its namespaces set as on the Mac.
- `SWITCH_HOSTED_WORKERS_RESTART`: the restart worker (`restart_actions.py`)
  carries out an operator's restart of a box.

Each worker runs in its own guard, so one failing is logged by its error type
and the others carry on. With the scaler off, or Core out of reach for its
pass, the eviction watch still looks at every box in the map.

Where things come from (the Deployment):

- Kubernetes: the pod's service account (`SA_DIR`). Its token is read with
  `read_token` on every call, since the projected token rotates hourly.
- Core: `SWITCH_HOSTED_WORKERS_CORE_URL`, https with no user, password, query
  or fragment, and the controller token in the Secret file named by
  `SWITCH_HOSTED_WORKERS_CORE_TOKEN_FILE`, read on every call.
  `SWITCH_HOSTED_WORKERS_CORE_CA`, when set, is the only CA trusted for Core.
- The box map: the `box-map` Secret in `switch-hosted`, read through the API
  by name every round (the account's `get` on that one name; no list or
  watch), so a new box is seen at once rather than after the kubelet's sync.
  A map that fails to read keeps the last good one. Outside the cluster
  (`Workers` given a path), `SWITCH_HOSTED_WORKERS_BOX_MAP`, read with
  `load_boxes`.

Between full rounds, the scaler looks again quickly (`fast_tick`), so a box
starts within seconds of Core wanting it:

- Every `CHECK_S` (5 s), one read of Core's machine list, and nothing else.
  A box whose desired state or revision changed gets a scaler pass at once.
  A machine not in the map that changed makes the box map be read again
  (one `get`), for a box the provisioner has just made.
- While any box is starting or waking, a pass every `FAST_S` (2 s) for those
  boxes only, up to the scaler's start limit (3 minutes). A box's state
  is reported to Core only when it changes.
- A failed check backs off, doubling up to the round interval.

Evictions, the cluster report and restarts stay on the full round.

Neither token nor the Core URL is ever logged: errors are logged by type (and
HTTP status) only. Nothing is written to disk.
"""

from __future__ import annotations

import logging
import os
import signal
import ssl
import threading
import time
from collections.abc import Callable, Mapping, MutableMapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .box_names import is_legacy
from .box_operator_main import BOX_MAP_SECRET, HOME_NAMESPACE, SA_DIR, read_token
from .box_scaler import (
    START_LIMIT_S,
    CoreApi,
    KubeApi,
    boxes_from_secret,
    load_boxes,
    reconcile_once,
)
from .cluster_watch import (
    ENV_BOX_FACTS,
    ENV_SWITCH,
    ClusterWatch,
    RestartCounter,
    cluster_watch_from_env,
)
from .evictions import Eviction, EvictionWatch
from .registration_codes import RegistrationCodes
from .restart_actions import RestartCoreApi, RestartKubeApi, RestartWorker

logger = logging.getLogger(__name__)

PREFIX = "SWITCH_HOSTED_WORKERS_"
ENV_CORE_URL = PREFIX + "CORE_URL"
ENV_CORE_TOKEN_FILE = PREFIX + "CORE_TOKEN_FILE"
ENV_CORE_CA = PREFIX + "CORE_CA"
ENV_BOX_MAP = PREFIX + "BOX_MAP"
ENV_INTERVAL = PREFIX + "INTERVAL_SECONDS"
SWITCHES = ("SCALER", "EVICTIONS", "CLUSTER_REPORT", "RESTART")
ENV_REPORT_EVICTIONS = "SWITCH_SCALER_REPORT_EVICTIONS"
DEFAULT_INTERVAL_S = 10.0
MIN_INTERVAL_S, MAX_INTERVAL_S = 5.0, 300.0
CHECK_S = 5.0  # between full rounds: one read of Core's machine list
FAST_S = 2.0  # while a box is starting or waking: a pass for those boxes


class WorkersConfigError(ValueError):
    """A setting or mount is missing or malformed. The message never carries its value."""


def check_core_url(url: str) -> str:
    """Core is reached over https only, and its URL may carry no credentials or extras."""
    try:
        parts = urlsplit(url)
        _ = parts.port  # raises on a malformed port
    except ValueError:
        raise WorkersConfigError("the Core URL is malformed") from None
    if "@" in parts.netloc or parts.query or parts.fragment:
        raise WorkersConfigError("the Core URL must not carry a user, password, query or fragment")
    if parts.scheme != "https" or not parts.hostname:
        raise WorkersConfigError("the Core URL must be https://")
    return url


def in_cluster_server(env: Mapping[str, str]) -> str:
    """The Kubernetes API's address inside the cluster, from the variables every pod gets."""
    host = env.get("KUBERNETES_SERVICE_HOST", "").strip()
    port = env.get("KUBERNETES_SERVICE_PORT", "443").strip() or "443"
    if not host or not port.isdigit():
        raise WorkersConfigError("not running in a cluster (KUBERNETES_SERVICE_HOST is not set)")
    return f"https://[{host}]:{port}" if ":" in host else f"https://{host}:{port}"


def switches_from_env(env: Mapping[str, str]) -> dict[str, bool]:
    """Each worker's switch, `1` or `0`; unset is off. Anything else refuses to start."""
    found: dict[str, bool] = {}
    for name in SWITCHES:
        value = env.get(PREFIX + name, "0").strip() or "0"
        if value not in ("0", "1"):
            raise WorkersConfigError(f"{PREFIX + name} must be 1 or 0")
        found[name.lower()] = value == "1"
    return found


def interval_from_env(env: Mapping[str, str]) -> float:
    raw = env.get(ENV_INTERVAL, "").strip()
    if not raw:
        return DEFAULT_INTERVAL_S
    try:
        value = float(raw)
    except ValueError:
        raise WorkersConfigError(f"{ENV_INTERVAL} must be a number of seconds") from None
    if not MIN_INTERVAL_S <= value <= MAX_INTERVAL_S:
        raise WorkersConfigError(
            f"{ENV_INTERVAL} must be between {MIN_INTERVAL_S:g} and {MAX_INTERVAL_S:g}"
        )
    return value


class InClusterKubeApi(KubeApi):
    """The scaler's (and eviction watch's, and cluster report's) Kubernetes client, on the
    pod's service account, with the token read fresh on every call."""

    def __init__(self, server: str, token_file: Path, ca_file: str):
        super().__init__(server, "", ca_file)
        self._token_file = token_file

    def _call(self, method: str, path: str, body: dict | None = None, timeout: float = 20) -> dict:
        self._token = read_token(self._token_file)
        return super()._call(method, path, body, timeout)

    def box_map(self) -> dict[str, str]:
        """`box-map`, read by name: the account's `get` on that one Secret, never a list."""
        return boxes_from_secret(
            self._call("GET", f"/api/v1/namespaces/{HOME_NAMESPACE}/secrets/{BOX_MAP_SECRET}")
        )


class InClusterRestartKubeApi(RestartKubeApi):
    """The restart worker's own two calls, on the same account, the token read fresh each call."""

    def __init__(self, server: str, token_file: Path, ca_file: str):
        super().__init__(server, "", ca_file)
        self._token_file = token_file

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        self._token = read_token(self._token_file)
        return super()._call(method, path, body)


class FreshCore:
    """Core's routes on the controller token, read from its Secret file on every call so a
    renewed one is picked up. `make` is the existing client: `CoreApi` for the scaler and the
    cluster report, `RestartCoreApi` for the restart worker. `context`, when given, is the TLS
    context every call to Core uses (`core_tls_context`)."""

    def __init__(
        self,
        url: str,
        token_file: Path,
        make: Callable[..., Any],
        context: ssl.SSLContext | None = None,
    ):
        self._url = check_core_url(url)
        self._token_file = token_file
        self._make = make
        self._context = context

    def _api(self) -> Any:
        token = read_token(self._token_file)
        if self._context is None:
            return self._make(self._url, token)
        return self._make(self._url, token, context=self._context)

    def machines(self) -> list[dict[str, Any]]:
        return self._api().machines()

    def prepare(self, machine_id: str) -> dict[str, Any]:
        return self._api().prepare(machine_id)  # carries a code: never logged

    def observe(self, *args: Any, **kwargs: Any) -> None:
        self._api().observe(*args, **kwargs)

    def report_cluster(self, report: dict[str, Any]) -> None:
        self._api().report_cluster(report)

    def open_actions(self) -> list[dict[str, Any]]:
        return self._api().open_actions()

    def step(self, action_id: str, step: str, state: str) -> None:
        self._api().step(action_id, step, state)


class RoundWatch(EvictionWatch):
    """The eviction watch, remembering which boxes it looked at this round."""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.looked: set[str] = set()
        self.found = 0  # new evictions this round

    def check(self, machine_id: str, namespace: str) -> list[Eviction]:
        self.looked.add(machine_id)
        fresh = super().check(machine_id, namespace)
        self.found += len(fresh)
        return fresh


class GuardedRestartCounter(RestartCounter):
    """The restart counter, never stopping the scaler's pass over odd pod data."""

    def see(self, machine_id: str, pods: list[Mapping[str, Any]]) -> None:
        try:
            super().see(machine_id, pods)
        except Exception as exc:
            logger.warning(
                "Machine %s: restart count skipped (%s).", machine_id, type(exc).__name__
            )


def _why(exc: BaseException) -> str:
    status = getattr(exc, "code", None)
    return type(exc).__name__ + (f" {status}" if isinstance(status, int) else "")


class Workers:
    """The four workers, one round at a time."""

    def __init__(
        self,
        core: Any,
        kube: Any,
        box_map: Path | Callable[[], dict[str, str]],
        env: Mapping[str, str],
        restart_core: Any = None,
        restart_kube: Any = None,
        load: Callable[[Path], dict[str, str]] = load_boxes,
    ):
        on = switches_from_env(env)
        self.core = core
        self.kube = kube
        self._box_map = box_map
        self._load = load
        self.boxes: dict[str, str] = {}
        self._waiting: dict[str, float] = {}
        self._scaled = 0
        # The fast passes: what Core last listed for each machine, what each box was last reported as,
        # and when the next check is due (backing off after a failed one).
        self._seen: dict[str, tuple[Any, Any]] = {}
        self._observed: dict[str, str] = {}
        self._map_read = False  # whether this round's box map read succeeded (box_missing needs it)
        self._reported_missing: dict[str, int] = {}
        self._check_wait = CHECK_S
        self._next_check = 0.0
        self._interval = MAX_INTERVAL_S
        self.scaler = on["scaler"]
        # The same map object, updated in place each round, so the codes see the current boxes.
        self.codes = RegistrationCodes(core, kube, self.boxes) if self.scaler else None
        self.watch: RoundWatch | None = None
        self.box_facts: GuardedRestartCounter | None = None
        if on["evictions"]:
            self.watch = RoundWatch(kube, report_to_core=env.get(ENV_REPORT_EVICTIONS) == "1")
            if env.get(ENV_BOX_FACTS) == "1":
                self.box_facts = GuardedRestartCounter()
        elif env.get(ENV_BOX_FACTS) == "1":
            logger.warning("Box facts need the eviction watch; not counting restarts.")
        self.cluster: ClusterWatch | None = None
        if on["cluster_report"]:
            # The cluster report's own checks: its namespaces must be set, or it refuses to start.
            self.cluster = cluster_watch_from_env(
                kube._call, core, {**env, ENV_SWITCH: "on"}, box_pods=self._box_pods
            )
        self.restart: RestartWorker | None = None
        if on["restart"]:
            if restart_core is None or restart_kube is None:
                raise WorkersConfigError("the restart worker needs its Core and Kubernetes clients")
            self.restart = RestartWorker(kube=restart_kube, core=restart_core, boxes=self.boxes)

    def _box_pods(self) -> list[dict[str, Any]]:
        if self.watch is None:
            return []
        return [p for pods in self.watch.last_pods.values() for p in pods]

    def _guard(self, name: str, step: Callable[[], Any]) -> str:
        try:
            step()
            return "ok"
        except Exception as exc:  # one worker failing never stops the others
            logger.warning("Worker %s failed this round (%s).", name, _why(exc))
            return "failed"

    def _reload(self) -> None:
        self._map_read = False
        try:
            boxes = self._box_map() if callable(self._box_map) else self._load(self._box_map)
        except Exception as exc:  # an API error, OSError, or ScalerConfigError (a ValueError)
            # Its text can name a namespace, never a credential; logged by type all the same.
            logger.warning(
                "Box map unreadable (%s); keeping the last good one (%d boxes).",
                _why(exc),
                len(self.boxes),
            )
            raise WorkersConfigError("box map unreadable") from None
        self._replace(self.boxes, boxes)
        self._map_read = True

    @staticmethod
    def _replace(target: MutableMapping[str, str], boxes: Mapping[str, str]) -> None:
        # In place, so the restart worker, holding the same map, sees it too.
        target.clear()
        target.update(boxes)

    def _scale(self) -> None:
        steps = reconcile_once(
            self.core,
            self.kube,
            self.boxes,
            self._waiting,
            codes=self.codes,
            watch=self.watch,
            box_facts=self.box_facts,
            map_read=self._map_read,
            reported_missing=self._reported_missing,
            still_unmapped=self._still_unmapped_once_per_pass(),
        )
        self._scaled = sum(1 for step in steps if step.action)
        self._observed.update({step.machine_id: step.observed for step in steps})

    def _look_at_the_rest(self) -> None:
        assert self.watch is not None
        for machine_id, namespace in sorted(self.boxes.items()):
            if machine_id in self.watch.looked:
                continue
            self.watch.check(machine_id, namespace)  # never raises
            if self.box_facts is not None and machine_id in self.watch.last_pods:
                self.box_facts.see(machine_id, self.watch.last_pods[machine_id])

    def run_round(self) -> dict[str, str]:
        """One round: what each worker did, "ok", "failed" or "off"."""
        outcome = {"box_map": self._guard("box map", self._reload)}
        self._scaled = 0
        if self.watch is not None:
            self.watch.looked.clear()
            self.watch.found = 0
        outcome["scaler"] = self._guard("scaler", self._scale) if self.scaler else "off"
        if self.watch is None:
            outcome["evictions"] = "off"
        else:
            outcome["evictions"] = self._guard("eviction watch", self._look_at_the_rest)
        outcome["box_facts"] = "off" if self.box_facts is None else outcome["evictions"]
        if self.cluster is None:
            outcome["cluster_report"] = "off"
        else:
            outcome["cluster_report"] = self._guard("cluster report", self.cluster.tick)
        if self.restart is None:
            outcome["restart"] = "off"
        else:
            outcome["restart"] = self._guard("restart", self.restart.tick)
        # One line a round, so the pod's log shows it is alive: counts and fixed words only.
        logger.info(
            "Round: boxes=%d legacy_names=%d scaled=%d evicted=%d %s",
            len(self.boxes),
            sum(
                1 for ns in self.boxes.values() if is_legacy(ns)
            ),  # a count only, never a name (`box_names`)
            self._scaled,
            0 if self.watch is None else self.watch.found,
            " ".join(f"{name}={state}" for name, state in outcome.items()),
        )
        return outcome

    # ---- the fast passes, between full rounds ----

    def starting(self, now: float) -> set[str]:
        """The boxes starting or waking, inside the start limit: the ones the 2 s passes look at."""
        return {
            machine_id
            for machine_id, since in self._waiting.items()
            if machine_id in self.boxes and now - since <= START_LIMIT_S
        }

    def _changed(self, listed: list[dict[str, Any]]) -> tuple[set[str], bool]:
        """Which of our boxes Core changed since it was last seen, and whether a machine not in the
        map changed (a box the provisioner may just have made). The first look only remembers."""
        first = not self._seen
        ours: set[str] = set()
        unknown = False
        listed_ids = {str(raw.get("machine_id", "")) for raw in listed}
        for gone in set(self._seen) - listed_ids:  # only what Core lists now is remembered
            del self._seen[gone]
        for raw in listed:
            machine_id = str(raw.get("machine_id", ""))
            now_seen = (raw.get("desired_state"), raw.get("revision"))
            before = self._seen.get(machine_id)
            self._seen[machine_id] = now_seen
            if first or before == now_seen:
                continue
            if machine_id in self.boxes:
                ours.add(machine_id)
            else:
                unknown = True
        return ours, unknown

    def fast_tick(self, now: float) -> float:
        """One quick look between full rounds; returns how long to wait before the next."""
        if not self.scaler:
            return self._interval
        starting = self.starting(now)
        if not starting and now < self._next_check:
            return self._next_check - now
        try:
            listed = self.core.machines()
        except Exception as exc:
            self._check_wait = min(self._check_wait * 2, self._interval)
            self._next_check = now + self._check_wait
            logger.warning("Fast check failed (%s); next in %gs.", _why(exc), self._check_wait)
            return self._check_wait
        self._check_wait = CHECK_S
        self._next_check = now + CHECK_S
        changed, unknown = self._changed(listed)
        if unknown:
            before = set(self.boxes)
            self._guard("box map", self._reload)
            changed |= {m for m in self.boxes if m not in before}
        targets = (changed | starting) & set(self.boxes)
        if targets:
            self._guard("fast scaler", lambda: self._fast_pass(listed, targets))
        return FAST_S if self.starting(time.monotonic()) else CHECK_S

    def _still_unmapped_once_per_pass(self) -> Callable[[str], bool]:
        """For box_missing: the box map read again (one `get`), at most once per pass and only when a machine
        looks missing, after Core's list was read. A machine in it isn't missing (it was made since the round's
        read, and the map is updated in place); a failed read reports nothing."""
        fresh: dict[str, dict[str, str] | None] = {}

        def still_unmapped(machine_id: str) -> bool:
            if "map" not in fresh:
                try:
                    fresh["map"] = (
                        self._box_map() if callable(self._box_map) else self._load(self._box_map)
                    )
                except Exception as exc:
                    logger.warning("Box map re-read failed (%s); not reporting missing.", _why(exc))
                    fresh["map"] = None
                if fresh["map"] is not None:
                    self._replace(self.boxes, fresh["map"])
            return fresh["map"] is not None and machine_id not in fresh["map"]

        return still_unmapped

    def _fast_pass(self, listed: list[dict[str, Any]], targets: set[str]) -> None:
        steps = reconcile_once(
            self.core,
            self.kube,
            self.boxes,
            self._waiting,
            codes=self.codes,
            listed=listed,
            only=targets,
            last_observed=self._observed,
            reported_missing=self._reported_missing,
        )
        acted = sum(1 for step in steps if step.action)
        if acted:
            logger.info("Fast pass: boxes=%d scaled=%d", len(steps), acted)

    def run(
        self,
        stop: threading.Event,
        interval: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._interval = interval
        next_round = clock()
        while not stop.is_set():
            now = clock()
            if now >= next_round:
                self.run_round()
                next_round = clock() + interval
                wait = FAST_S if self.starting(clock()) else CHECK_S
            else:
                wait = self.fast_tick(now)
            stop.wait(max(0.0, min(wait, next_round - clock())))


def build(env: Mapping[str, str], sa_dir: Path = SA_DIR) -> tuple[Workers, float]:
    """Everything from the environment and the mounts, refused whole if anything is wrong."""
    for key in (ENV_CORE_URL, ENV_CORE_TOKEN_FILE):
        if not env.get(key, "").strip():
            raise WorkersConfigError(f"{key} is not set")
    interval = interval_from_env(env)
    url, token_file = env[ENV_CORE_URL].strip(), Path(env[ENV_CORE_TOKEN_FILE])
    try:
        read_token(token_file)
    except (OSError, ValueError) as exc:
        raise WorkersConfigError(
            f"the controller token could not be read ({type(exc).__name__})"
        ) from None
    core_context = core_tls_context(env)
    sa_token, sa_ca = sa_dir / "token", sa_dir / "ca.crt"
    try:
        read_token(sa_token)
    except (OSError, ValueError) as exc:
        raise WorkersConfigError(
            f"the service-account token could not be read ({type(exc).__name__})"
        ) from None
    if not sa_ca.is_file():
        raise WorkersConfigError("the service-account CA is not mounted")
    server = in_cluster_server(env)
    kube = InClusterKubeApi(server, sa_token, str(sa_ca))
    if env.get(ENV_BOX_MAP, "").strip():
        logger.warning("%s is no longer read: the box map is read through the API.", ENV_BOX_MAP)
    workers = Workers(
        FreshCore(url, token_file, CoreApi, core_context),
        kube,
        kube.box_map,
        env,
        restart_core=FreshCore(url, token_file, RestartCoreApi, core_context),
        restart_kube=InClusterRestartKubeApi(server, sa_token, str(sa_ca)),
    )
    return workers, interval


def core_tls_context(env: Mapping[str, str]) -> ssl.SSLContext | None:
    """The TLS context for every call to Core. With `SWITCH_HOSTED_WORKERS_CORE_CA` set, it
    trusts that file and nothing else: given `cafile`, Python loads only that file and not the
    system store, so the controller's bearer only ever goes to a server Core's own CA signed
    Nothing process-wide is changed. Unset, Core's clients keep the
    default system store, as before."""
    core_ca = env.get(ENV_CORE_CA, "").strip()
    if not core_ca:
        return None
    if not Path(core_ca).is_file():
        raise WorkersConfigError(f"{ENV_CORE_CA} is not a file")
    try:
        return ssl.create_default_context(cafile=core_ca)
    except (OSError, ssl.SSLError) as exc:
        raise WorkersConfigError(
            f"{ENV_CORE_CA} could not be read as a CA ({type(exc).__name__})"
        ) from None


def main(
    env: Mapping[str, str] | None = None,
    sa_dir: Path = SA_DIR,
    stop: threading.Event | None = None,
) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    env = dict(os.environ) if env is None else env
    try:
        workers, interval = build(env, sa_dir)
    except ValueError as exc:  # WorkersConfigError, and the cluster report's own refusals
        logger.error("Not starting: %s", exc)
        return 2
    if stop is None:
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())
    logger.info(
        "Workers on: interval=%gs scaler=%s evictions=%s box_facts=%s cluster_report=%s restart=%s",
        interval,
        workers.scaler,
        workers.watch is not None,
        workers.box_facts is not None,
        workers.cluster is not None,
        workers.restart is not None,
    )
    workers.run(stop, interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

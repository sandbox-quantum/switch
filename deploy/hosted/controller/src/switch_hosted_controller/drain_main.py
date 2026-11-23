"""The drain worker's process (`switch-drain-worker`), run as the `switch-drain` Deployment.

One replica, on the `switch-drain` service account only (rights v1.4): it can read nodes, cordon an agents
machine, read and evict `box-0` in box namespaces, and keep one placeholder in `switch-drain-room`. The operator's
own account holds none of that, and this process holds none of the operator's rights (scale, delete, enrolment).

Where things come from (the Deployment):

- Kubernetes: the pod's own projected token (`SA_DIR`), read with `read_token` on every call.
- Core: `SWITCH_DRAIN_CORE_URL` (https, with no user, password, query or fragment), and the operator's bearer in the
  file named by `SWITCH_DRAIN_CORE_TOKEN_FILE`, read on every call (and once at start, so an empty or unreadable file
  refuses to start). `SWITCH_DRAIN_CORE_CA` is required, and is the only CA trusted for Core.
- `SWITCH_DRAIN_OWN_NODE`: the node this pod runs on (the Deployment passes `spec.nodeName`), required. The worker
  never drains it.
- The box map: `SWITCH_DRAIN_BOX_MAP`, the `box-map` Secret mounted as a folder, read with `load_boxes` every pass.
  A map that fails to read keeps the last good one.
- `SWITCH_DRAIN_PAUSE_IMAGE`: the placeholder's pause image, pinned by digest, the same as the placeholder policy's.
- `SWITCH_PLACEMENT_POOL`, `SWITCH_PLACEMENT_TARGET` and `SWITCH_PLACEMENT_CEILING`: the same values as the placer's,
  so the drain counts room and picks machines as the placer does.

Anything set wrongly refuses to start rather than guessing. Neither token nor the Core URL is ever logged, and
nothing is written to disk.
"""

from __future__ import annotations

import logging
import os
import signal
import ssl
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .box_operator_main import SA_DIR, read_token
from .box_scaler import load_boxes
from .drain_actions import NODE_NAME_RE, PAUSE_IMAGE_RE, DrainCoreApi, DrainKubeApi, DrainWorker
from .placement import Limits
from .placer import DEFAULT_POOL, POOL_RE
from .workers_main import WorkersConfigError, check_core_url, in_cluster_server

logger = logging.getLogger(__name__)

PREFIX = "SWITCH_DRAIN_"
ENV_CORE_URL = PREFIX + "CORE_URL"
ENV_CORE_TOKEN_FILE = PREFIX + "CORE_TOKEN_FILE"
ENV_CORE_CA = PREFIX + "CORE_CA"
ENV_BOX_MAP = PREFIX + "BOX_MAP"
ENV_PAUSE_IMAGE = PREFIX + "PAUSE_IMAGE"
ENV_OWN_NODE = PREFIX + "OWN_NODE"
ENV_POOL = "SWITCH_PLACEMENT_POOL"
ENV_TARGET = "SWITCH_PLACEMENT_TARGET"
ENV_CEILING = "SWITCH_PLACEMENT_CEILING"
PASS_S = 10.0


class DrainConfigError(ValueError):
    """The drain worker's configuration is off: it refuses to start."""


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise DrainConfigError(f"{key} is not set")
    return value


def _number(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    if not raw.isdigit() or not 1 <= int(raw) <= 50:
        raise DrainConfigError(f"{key} must be a whole number from 1 to 50")
    return int(raw)


def config_from_env(env: Mapping[str, str]) -> dict[str, Any]:
    """The settings, each checked. Paths must exist; nothing is read from them here but the CA."""
    try:
        core_url = check_core_url(_required(env, ENV_CORE_URL))
    except WorkersConfigError as exc:
        raise DrainConfigError(str(exc).replace("the Core URL", ENV_CORE_URL)) from None
    token_file = Path(_required(env, ENV_CORE_TOKEN_FILE))
    if not token_file.is_file():
        raise DrainConfigError(f"{ENV_CORE_TOKEN_FILE} is not a file")
    try:
        read_token(token_file)  # read and dropped: only that it can be read and isn't empty
    except (OSError, ValueError):
        raise DrainConfigError(f"{ENV_CORE_TOKEN_FILE} can't be read, or is empty") from None
    own_node = _required(env, ENV_OWN_NODE)
    if len(own_node) > 253 or not NODE_NAME_RE.fullmatch(own_node):
        raise DrainConfigError(f"{ENV_OWN_NODE} must be a node name")
    box_map = Path(_required(env, ENV_BOX_MAP))
    if not box_map.exists():
        raise DrainConfigError(f"{ENV_BOX_MAP} does not exist")
    image = _required(env, ENV_PAUSE_IMAGE)
    if not PAUSE_IMAGE_RE.fullmatch(image):
        raise DrainConfigError(
            f"{ENV_PAUSE_IMAGE} must be an image pinned by digest (name@sha256:<64 hex>)"
        )
    pool = env.get(ENV_POOL, "").strip() or DEFAULT_POOL
    if not POOL_RE.fullmatch(pool):
        raise DrainConfigError(f"{ENV_POOL} must be a machine pool name")
    try:
        limits = Limits(
            _number(env, ENV_TARGET, Limits.target), _number(env, ENV_CEILING, Limits.ceiling)
        )
    except ValueError as exc:
        raise DrainConfigError(str(exc)) from None
    core_ca = _required(env, ENV_CORE_CA)
    if not Path(core_ca).is_file():
        raise DrainConfigError(f"{ENV_CORE_CA} is not a file")
    # Given `cafile`, only that CA is trusted, not the system store: the bearer only goes to Core's own server.
    try:
        context = ssl.create_default_context(cafile=core_ca)
    except (OSError, ssl.SSLError):
        raise DrainConfigError(f"{ENV_CORE_CA} is not a CA certificate") from None
    return {
        "core_url": core_url,
        "token_file": token_file,
        "box_map": box_map,
        "pause_image": image,
        "pool": pool,
        "limits": limits,
        "context": context,
        "own_node": own_node,
    }


class FreshDrainCore:
    """Core's drain routes on the operator's bearer, read from its file on every call so a renewed one is picked up."""

    def __init__(self, url: str, token_file: Path, context: ssl.SSLContext):
        self._url, self._token_file, self._context = url, token_file, context

    def _api(self) -> DrainCoreApi:
        return DrainCoreApi(self._url, read_token(self._token_file), context=self._context)

    def open_actions(self) -> list[dict[str, Any]]:
        return self._api().open_actions()

    def step(
        self, action_id: str, step: str, state: str, counts: dict[str, int] | None = None
    ) -> None:
        self._api().step(action_id, step, state, counts)

    def machines(self) -> list[dict[str, Any]]:
        return self._api().machines()


class BoxMap:
    """The box map, read each pass; a map that fails to read keeps the last good one, as the workers do."""

    def __init__(self, path: Path, load: Callable[[Path], dict[str, str]] = load_boxes):
        self._path, self._load = path, load
        self._last: dict[str, str] = {}

    def __call__(self) -> dict[str, str]:
        try:
            self._last = self._load(self._path)
        except (OSError, ValueError) as exc:
            logger.warning(
                "The box map could not be read (%s); keeping the last good one.", type(exc).__name__
            )
        return self._last


def build(env: Mapping[str, str]) -> DrainWorker:
    config = config_from_env(env)
    kube = DrainKubeApi(
        in_cluster_server(env),
        lambda: read_token(SA_DIR / "token"),
        str(SA_DIR / "ca.crt"),
        config["pool"],
    )
    core = FreshDrainCore(config["core_url"], config["token_file"], config["context"])
    return DrainWorker(
        kube,
        core,
        BoxMap(config["box_map"]),
        config["pause_image"],
        pool=config["pool"],
        limits=config["limits"],
        own_node=config["own_node"],
    )


def run(
    worker: DrainWorker, stop: Callable[[], bool], sleep: Callable[[float], None] = time.sleep
) -> None:
    """A pass every 10 seconds until stopped. `tick` never raises."""
    while not stop():
        worker.tick()
        sleep(PASS_S)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        worker = build(os.environ)
    except (DrainConfigError, WorkersConfigError) as exc:
        logger.error("Drain worker not started: %s", exc)
        return 2
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__("now", True))
    logger.info("Drain worker on: pool=%s ceiling=%d", worker.pool, worker.limits.ceiling)
    run(worker, stop=lambda: stopping["now"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

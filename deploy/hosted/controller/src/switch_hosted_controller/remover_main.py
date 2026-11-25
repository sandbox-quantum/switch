"""`switch-hosted-remover`: the remover's process (`remover.py`), in the cluster, on its own account.

Settings (its Deployment):

- `SWITCH_REMOVER_CORE_URL`: Core, https only, with no user, password, query or fragment.
- `SWITCH_REMOVER_TOKEN_FILE`: the remover's own Core credential (`remover_token`), read on every call. Core accepts
  it on the remover's two routes (the check, and the list report) and nowhere else.
- `SWITCH_REMOVER_CORE_CA`: when set, the only CA trusted for Core.
- Kubernetes: the pod's service account (projected token, read on every call). Its rights: `get` on `box-removals`
  by name, and `get` and `delete` on namespaces, which the cluster's admission policy limits to namespaces listed in
  `box-removals`.

Neither credential nor the Core URL is ever logged.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import signal
import ssl
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request
from uuid import UUID

from .box_names import BOX_NAMESPACE_RE, REMOVALS_SECRET
from .box_operator_main import SA_DIR, opener, read_token
from .remover import PASS_INTERVAL_S, remove_once
from .workers_main import WorkersConfigError, check_core_url, in_cluster_server

logger = logging.getLogger(__name__)

PREFIX = "SWITCH_REMOVER_"
CALL_TIMEOUT_S = 10.0
HOME_NAMESPACE = "switch-hosted"


class RemoverCoreApi:
    """The remover's two Core calls, on its own credential."""

    def __init__(self, url: str, token_file: Path, context: ssl.SSLContext | None = None):
        self._base = check_core_url(url).rstrip("/") + "/gateway/hosted-provisioner"
        self._token_file = token_file
        self._ctx = context or ssl.create_default_context()

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        req = Request(
            self._base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + read_token(self._token_file),
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        with opener(self._ctx).open(req, timeout=CALL_TIMEOUT_S) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def removable(self, machine_id: str, namespace: str) -> bool:
        if not BOX_NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a box namespace")
        answer = self._call(
            "GET", f"/removals/{UUID(machine_id)}?" + urlencode({"namespace": namespace})
        )
        return isinstance(answer, dict) and answer.get("removable") is True

    def listed(self, entries: list[dict[str, str]]) -> None:
        self._call("POST", "/removals/listed", {"entries": entries})


class RemoverKubeApi:
    """The remover's Kubernetes calls, and no others. Every namespace is an exact box name before any call."""

    def __init__(self, server: str, token_file: Path, ca_file: str):
        self._server = server.rstrip("/")
        self._token_file = token_file
        self._ctx = ssl.create_default_context(cafile=ca_file)

    def _call(self, method: str, path: str) -> Any:
        req = Request(
            self._server + path,
            method=method,
            headers={
                "Authorization": "Bearer " + read_token(self._token_file),
                "Accept": "application/json",
            },
        )
        with opener(self._ctx).open(req, timeout=CALL_TIMEOUT_S) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    @staticmethod
    def _box(namespace: str) -> str:
        if not BOX_NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a box namespace")
        return quote(namespace)

    def removals(self) -> Mapping[str, str]:
        """`box-removals`, by name. A list not made yet is empty; any other error is raised (nothing is deleted)."""
        try:
            secret = self._call(
                "GET", f"/api/v1/namespaces/{HOME_NAMESPACE}/secrets/{REMOVALS_SECRET}"
            )
        except HTTPError as error:
            if error.code == 404:
                return {}
            raise
        data = (secret or {}).get("data") or {}
        return {key: base64.b64decode(value).decode() for key, value in data.items()}

    def get_namespace(self, name: str) -> dict[str, Any] | None:
        try:
            return self._call("GET", f"/api/v1/namespaces/{self._box(name)}")
        except HTTPError as error:
            if error.code == 404:
                return None
            raise

    def delete_namespace(self, name: str) -> None:
        try:
            self._call("DELETE", f"/api/v1/namespaces/{self._box(name)}")
        except HTTPError as error:
            if error.code != 404:
                raise


def build(env: Mapping[str, str], sa_dir: Path = SA_DIR) -> tuple[RemoverCoreApi, RemoverKubeApi]:
    for key in ("CORE_URL", "TOKEN_FILE"):
        if not env.get(PREFIX + key, "").strip():
            raise WorkersConfigError(f"{PREFIX + key} is not set")
    token_file = Path(env[PREFIX + "TOKEN_FILE"])
    try:
        read_token(token_file)
    except (OSError, ValueError) as exc:
        raise WorkersConfigError(
            f"the remover token could not be read ({type(exc).__name__})"
        ) from None
    core_ca = env.get(PREFIX + "CORE_CA", "").strip()
    context = ssl.create_default_context(cafile=core_ca) if core_ca else None
    core = RemoverCoreApi(env[PREFIX + "CORE_URL"].strip(), token_file, context)
    kube = RemoverKubeApi(in_cluster_server(env), sa_dir / "token", str(sa_dir / "ca.crt"))
    return core, kube


def main(
    env: Mapping[str, str] | None = None,
    sa_dir: Path = SA_DIR,
    stop: threading.Event | None = None,
) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    env = dict(os.environ) if env is None else env
    try:
        core, kube = build(env, sa_dir)
    except (ValueError, OSError, ssl.SSLError) as exc:
        logger.error(
            "Not starting: %s", exc if isinstance(exc, WorkersConfigError) else type(exc).__name__
        )
        return 2
    if stop is None:
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())
    logger.info("Remover on: every %gs", PASS_INTERVAL_S)
    while not stop.is_set():
        try:
            counts = remove_once(core, kube)
            if any(counts.values()):
                logger.info("Remover pass: %s", " ".join(f"{k}={v}" for k, v in counts.items()))
        except Exception as exc:
            logger.warning("Remover pass failed (%s); retrying.", type(exc).__name__)
        stop.wait(PASS_INTERVAL_S)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

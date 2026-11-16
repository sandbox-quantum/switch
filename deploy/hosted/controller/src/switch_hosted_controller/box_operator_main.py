"""The box operator's Core and Kubernetes clients, and its loop (`switch-box-operator`).

It runs in the cluster as one replica in `switch-hosted`, on its own service account (RBAC and the admission policies
are the deployment's), with its own Core credential, which may only claim and report provision actions. Its configuration
is one JSON file (`SWITCH_BOX_OPERATOR_CONFIG`), refused whole if anything in it is off, plus the CA certificate and
the managed settings file it hands each box, both mounted read-only.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import signal
import ssl
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from .box_operator import (
    ACTION_ID_RE,
    CLAIM_TOKEN_RE,
    EXISTS_UNREAD,
    FAILURES,
    NAMESPACE_RE,
    BoxMapConflict,
    BoxOperator,
    Refused,
    config_from,
)

logger = logging.getLogger(__name__)

SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")
CALL_TIMEOUT_S = 10.0
IDLE_WAIT_S = 5.0
ERROR_WAIT_S = 15.0
HOME_NAMESPACE = "switch-hosted"
BOX_MAP_SECRET = (
    "box-map"  # one key per box: machine id -> namespace (policy P5 checks it add-only)
)


class NoRedirect(HTTPRedirectHandler):
    """Never follow a redirect: it would carry the bearer to wherever it points. A 3xx is an error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise HTTPError(req.full_url, code, "redirect refused", headers, fp)


def opener(context: ssl.SSLContext):  # type: ignore[no-untyped-def]
    return build_opener(HTTPSHandler(context=context), NoRedirect())


def read_token(path: Path) -> str:
    """A bearer read fresh on every call: the cluster's projected token rotates (platform), and a renewed Core
    credential is picked up without a restart. Never logged."""
    token = path.read_text().strip()
    if not token:
        raise ValueError("a token file is empty")
    return token


_PATHS = {
    "Namespace": "/api/v1/namespaces",
    "NetworkPolicy": "/apis/networking.k8s.io/v1/namespaces/{ns}/networkpolicies",
    "ResourceQuota": "/api/v1/namespaces/{ns}/resourcequotas",
    "ServiceAccount": "/api/v1/namespaces/{ns}/serviceaccounts",
    "ConfigMap": "/api/v1/namespaces/{ns}/configmaps",
    "Secret": "/api/v1/namespaces/{ns}/secrets",
    "PersistentVolumeClaim": "/api/v1/namespaces/{ns}/persistentvolumeclaims",
    "StatefulSet": "/apis/apps/v1/namespaces/{ns}/statefulsets",
    "RoleBinding": "/apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/rolebindings",
}


class OperatorKubeApi:
    """The calls the operator makes, and no others: create (or read back) the fixed objects in a box namespace, and
    read and replace the one box map Secret. Every namespace is checked against the box pattern before any call."""

    def __init__(self, server: str, token_file: Path, ca_file: str):
        self._server = server.rstrip("/")
        self._token_file = token_file
        self._ctx = ssl.create_default_context(cafile=ca_file)

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        req = Request(
            self._server + path,
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

    def create_or_get(self, obj: dict) -> dict | None:
        kind, meta = obj["kind"], obj["metadata"]
        ns = meta["name"] if kind == "Namespace" else meta.get("namespace", "")
        if not NAMESPACE_RE.fullmatch(ns):
            raise ValueError("not a box namespace")
        collection = _PATHS[kind].format(ns=quote(ns))
        try:
            self._call("POST", collection, obj)
            return None
        except HTTPError as error:
            if error.code == 409:
                if kind == "Secret":
                    return EXISTS_UNREAD  # never read: the operator has no `get` on Secrets
                return self._call("GET", f"{collection}/{quote(meta['name'])}")
            if error.code in (403, 422):
                raise Refused() from None
            raise

    def box_map(self) -> tuple[dict[str, str], str]:
        secret = self._call("GET", f"/api/v1/namespaces/{HOME_NAMESPACE}/secrets/{BOX_MAP_SECRET}")
        data = secret.get("data") or {}
        if not isinstance(data, dict):
            raise ValueError("the box map is not machine ids to namespaces")
        boxes = {key: base64.b64decode(value).decode() for key, value in data.items()}
        return boxes, secret["metadata"]["resourceVersion"]

    def write_box_map(self, boxes: dict[str, str], resource_version: str) -> None:
        body = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": BOX_MAP_SECRET,
                "namespace": HOME_NAMESPACE,
                "resourceVersion": resource_version,
            },
            "type": "Opaque",
            "data": {
                key: base64.b64encode(value.encode()).decode() for key, value in boxes.items()
            },
        }
        try:
            self._call("PUT", f"/api/v1/namespaces/{HOME_NAMESPACE}/secrets/{BOX_MAP_SECRET}", body)
        except HTTPError as error:
            if error.code == 409:
                raise BoxMapConflict() from None
            raise


class OperatorCoreApi:
    """The operator's two Core calls, on its own credential (never the controller's), which Core accepts on these
    two routes only."""

    def __init__(self, base_url: str, token_file: Path, ca_file: str | None):
        self._base = base_url.rstrip("/") + "/gateway/hosted-provisioner"
        self._token_file = token_file
        self._ctx = ssl.create_default_context(cafile=ca_file)

    def _call(self, path: str, body: dict | None = None) -> Any:
        req = Request(
            self._base + path,
            method="POST",
            data=json.dumps(body or {}).encode(),
            headers={
                "Authorization": "Bearer " + read_token(self._token_file),
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        with opener(self._ctx).open(req, timeout=CALL_TIMEOUT_S) as r:
            if r.status == 204:
                return None
            raw = r.read()
            return json.loads(raw) if raw else None

    def claim(self) -> dict | None:
        return self._call("/claim")

    def result(
        self,
        action_id: str,
        claim_token: str,
        result: str,
        namespace: str | None,
        failed_at: str | None,
    ) -> None:
        # Checks that hold under `python -O` too: never send anything out of form.
        if not ACTION_ID_RE.fullmatch(action_id) or not CLAIM_TOKEN_RE.fullmatch(claim_token):
            raise ValueError("an action id or claim token out of form")
        if result not in ("done", "failed") or (
            failed_at is not None and failed_at not in FAILURES
        ):
            raise ValueError("a result or failure code out of form")
        self._call(
            f"/actions/{quote(action_id)}/result",
            {
                "claim_token": claim_token,
                "result": result,
                "namespace": namespace,
                "failed_at": failed_at,
            },
        )


def run(
    operator: BoxOperator,
    stop: Callable[[], bool],
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Claims and makes boxes until stopped. An error is logged by its type only and retried after a pause: an
    unfinished action's lease runs out, and the next claim carries on from its recorded step."""
    while not stop():
        try:
            busy = operator.run_once()
        except (HTTPError, URLError, OSError, ValueError, KeyError) as error:
            status = getattr(error, "code", None)
            logger.warning(
                "Box operator round failed: %s%s",
                type(error).__name__,
                f" {status}" if status else "",
            )
            sleep(ERROR_WAIT_S)
            continue
        if not busy:
            sleep(IDLE_WAIT_S)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        config_path = Path(os.environ["SWITCH_BOX_OPERATOR_CONFIG"])
        ca_cert = Path(os.environ["SWITCH_BOX_OPERATOR_BOX_CA"]).read_text()
        settings = Path(os.environ["SWITCH_BOX_OPERATOR_MANAGED_SETTINGS"]).read_text()
        core_url = os.environ["SWITCH_BOX_OPERATOR_CORE_URL"]
        core_token_file = Path(os.environ["SWITCH_BOX_OPERATOR_CORE_TOKEN_FILE"])
    except KeyError as missing:
        logger.error("%s is not set", missing)
        return 2
    config = config_from(json.loads(config_path.read_text()), ca_cert, settings)
    core_ca = os.environ.get("SWITCH_BOX_OPERATOR_CORE_CA") or None
    server = f"https://{os.environ['KUBERNETES_SERVICE_HOST']}:{os.environ.get('KUBERNETES_SERVICE_PORT', '443')}"
    kube = OperatorKubeApi(server, SA_DIR / "token", str(SA_DIR / "ca.crt"))
    core = OperatorCoreApi(core_url, core_token_file, core_ca)
    operator = BoxOperator(core, kube, config)
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__("now", True))
    logger.info("Box operator on: ceiling=%d", config.ceiling)
    run(operator, stop=lambda: stopping["now"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""The service started the way its image starts it (`uvicorn ... --port`), with
JSON logs and a collector: every line is switch-core's JSON, the health probes
leave no access line, query strings are cut, and the request id is on both the
decide line and the access line."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

from tests.helpers import BODY, SECRETS

DECISION_DIR = Path(__file__).parents[1]
DEPLOYMENT_ID = "0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until_serving(base: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"uvicorn exited: {process.stderr.read()}")
        try:
            httpx.get(f"{base}/health", timeout=1)
            return
        except httpx.TransportError:
            time.sleep(0.1)
    raise AssertionError("uvicorn did not start")


def test_logs_as_started_by_the_image(collector):
    port = _free_port()
    env = {
        **os.environ,
        "LOG_FORMAT": "json",
        "POD_NAME": "decision-pod-0",
        "ENVIRONMENT": "test",
        "DECISION_BACKEND": "llamacpp",
        "LLAMACPP_URL": f"http://127.0.0.1:{_free_port()}",
        "OTLP_ENDPOINT": collector.url,
        "OTLP_LOGS_ENABLED": "true",
        "DEPLOYMENT_ID": DEPLOYMENT_ID,
    }
    for name in ("SERVICE_NAME", "LOG_LEVEL", "DECISION_SERVICE_TOKEN"):
        env.pop(name, None)
    uvicorn = Path(sys.executable).parent / "uvicorn"
    process = subprocess.Popen(
        [str(uvicorn), "switch_decision.app:app", "--port", str(port)],
        cwd=DECISION_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        _wait_until_serving(base, process)
        assert httpx.get(f"{base}/health").status_code == 503
        assert httpx.get(f"{base}/health?probe=kubelet").status_code == 503
        r = httpx.post(
            f"{base}/decide?token=placeholder-secret",
            json=BODY,
            headers={"X-Request-Id": "decision-e2e-1"},
        )
        assert r.status_code == 502
        assert r.json()["error_kind"] == "model_server_unreachable"
        assert r.headers["x-request-id"] == "decision-e2e-1"
    finally:
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=20)

    lines = [json.loads(line) for line in stderr.splitlines() if line.strip()]
    assert stdout == ""
    assert any(
        line["logger"]["name"] == "uvicorn.error"
        and "Application startup complete" in line["message"]
        for line in lines
    )

    access = [line for line in lines if line["logger"]["name"] == "uvicorn.access"]
    assert not any("/health" in line["message"] for line in access)
    assert len(access) == 1
    assert '"POST /decide HTTP/1.1" 502' in access[0]["message"]
    assert access[0]["request_id"] == "decision-e2e-1"

    failed = [line for line in lines if line["message"].startswith("decide failed")]
    assert len(failed) == 1
    line = failed[0]
    assert line["request_id"] == "decision-e2e-1"
    assert "error_kind=model_server_unreachable" in line["message"]
    assert line["service"] == "switch-decision"
    assert line["env"] == "test"
    assert line["version"]
    assert line["process_id"].startswith("decision-pod-0-")
    assert line["status"] == "warning"

    assert "placeholder-secret" not in stderr
    for secret in SECRETS:
        assert secret not in stderr

    shipped = [
        (r["body"]["stringValue"], {a["key"]: a["value"] for a in r["attributes"]})
        for r in collector.records()
    ]
    decide = [attrs for body, attrs in shipped if body.startswith("decide failed")]
    assert decide and decide[0]["request_id"] == {"stringValue": "decision-e2e-1"}
    assert not any("/health" in body for body, _ in shipped)
    assert not any("placeholder-secret" in body for body, _ in shipped)

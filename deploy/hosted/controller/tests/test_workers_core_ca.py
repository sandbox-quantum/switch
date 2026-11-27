"""With `SWITCH_HOSTED_WORKERS_CORE_CA` set, both Core clients trust that CA
and nothing else. Proved against real local TLS servers: one
signed by the configured CA is accepted, one signed by a second CA is refused before any
request (so the bearer is never sent), and a process-wide `SSL_CERT_FILE` naming the second
CA changes nothing."""

from __future__ import annotations

import json
import shutil
import ssl
import subprocess
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from switch_hosted_controller.box_scaler import CoreApi
from switch_hosted_controller.restart_actions import RestartCoreApi
from switch_hosted_controller.workers_main import FreshCore, core_tls_context

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="needs openssl")

TOKEN = "TOKEN-CANARY-ca14-never-sent"
ENV = "SWITCH_HOSTED_WORKERS_CORE_CA"


def _openssl(*args: str) -> None:
    subprocess.run(["openssl", *args], check=True, capture_output=True)


def _ca(folder: Path, name: str) -> tuple[Path, Path]:
    key, cert = folder / f"{name}.key", folder / f"{name}.crt"
    _openssl(
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={name}",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-addext", "subjectKeyIdentifier=hash",
    )  # fmt: skip
    return key, cert


def _server_cert(folder: Path, name: str, ca: tuple[Path, Path]) -> tuple[Path, Path]:
    key, csr, cert = folder / f"{name}.key", folder / f"{name}.csr", folder / f"{name}.crt"
    ext = folder / f"{name}.ext"
    ext.write_text(
        "basicConstraints=CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        "subjectAltName=IP:127.0.0.1\n"
        # Python's strict verification (3.13+) wants both key identifiers.
        "subjectKeyIdentifier=hash\n"
        "authorityKeyIdentifier=keyid,issuer\n"
    )
    _openssl(
        "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(csr),
        "-subj", f"/CN={name}",
    )  # fmt: skip
    _openssl(
        "x509", "-req", "-in", str(csr), "-CA", str(ca[1]), "-CAkey", str(ca[0]),
        "-CAcreateserial", "-days", "2", "-out", str(cert), "-extfile", str(ext),
    )  # fmt: skip
    return key, cert


class _Core(BaseHTTPRequestHandler):
    seen: list[str | None]

    def _answer(self) -> None:
        self.seen.append(self.headers.get("Authorization"))
        body = json.dumps({"machines": [], "actions": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _answer
    do_POST = _answer

    def log_message(self, *args: object) -> None:  # quiet
        pass


def _serve(cert: tuple[Path, Path], seen: list[str | None]) -> Iterator[str]:
    handler = type("Core", (_Core,), {"seen": seen})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert[1]), str(cert[0]))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def pki(tmp_path_factory: pytest.TempPathFactory) -> dict[str, tuple[Path, Path]]:
    folder = tmp_path_factory.mktemp("pki")
    core_ca = _ca(folder, "core-ca")
    other_ca = _ca(folder, "other-ca")
    return {
        "core_ca": core_ca,
        "other_ca": other_ca,
        "signed_by_core": _server_cert(folder, "core", core_ca),
        "signed_by_other": _server_cert(folder, "impostor", other_ca),
    }


@pytest.fixture
def core_server(pki: dict[str, tuple[Path, Path]]) -> Iterator[tuple[str, list[str | None]]]:
    seen: list[str | None] = []
    for url in _serve(pki["signed_by_core"], seen):
        yield url, seen


@pytest.fixture
def impostor(pki: dict[str, tuple[Path, Path]]) -> Iterator[tuple[str, list[str | None]]]:
    seen: list[str | None] = []
    for url in _serve(pki["signed_by_other"], seen):
        yield url, seen


def _context(pki: dict[str, tuple[Path, Path]]) -> ssl.SSLContext:
    context = core_tls_context({ENV: str(pki["core_ca"][1])})
    assert context is not None
    return context


def test_a_server_signed_by_cores_ca_is_accepted(pki, core_server) -> None:
    url, seen = core_server
    context = _context(pki)
    assert CoreApi(url, TOKEN, context=context).machines() == []
    assert RestartCoreApi(url, TOKEN, context=context).open_actions() == []
    assert seen == [f"Bearer {TOKEN}", f"Bearer {TOKEN}"]


def test_a_server_signed_by_another_ca_is_refused_and_never_sees_the_bearer(pki, impostor) -> None:
    url, seen = impostor
    context = _context(pki)
    with pytest.raises(RuntimeError):
        CoreApi(url, TOKEN, context=context).machines()
    with pytest.raises(RuntimeError):
        RestartCoreApi(url, TOKEN, context=context).open_actions()
    assert seen == []


def test_a_process_wide_ca_setting_changes_nothing(
    pki, impostor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The old approach pointed `SSL_CERT_FILE` at the CA. Now the context is built from the
    configured file alone, so even `SSL_CERT_FILE` naming the impostor's CA doesn't let it in."""
    monkeypatch.setenv("SSL_CERT_FILE", str(pki["other_ca"][1]))
    monkeypatch.setenv("SSL_CERT_DIR", str(pki["other_ca"][1].parent))
    url, seen = impostor
    with pytest.raises(RuntimeError):
        CoreApi(url, TOKEN, context=_context(pki)).machines()
    assert seen == []


def test_fresh_core_passes_the_context_to_both_clients(
    pki, core_server, impostor, tmp_path
) -> None:
    token_file = tmp_path / "token"
    token_file.write_text(TOKEN)
    token_file.chmod(0o600)
    good_url, good_seen = core_server
    bad_url, bad_seen = impostor
    context = _context(pki)
    assert FreshCore(good_url, token_file, CoreApi, context).machines() == []
    assert FreshCore(good_url, token_file, RestartCoreApi, context).open_actions() == []
    with pytest.raises(RuntimeError):
        FreshCore(bad_url, token_file, CoreApi, context).machines()
    with pytest.raises(RuntimeError):
        FreshCore(bad_url, token_file, RestartCoreApi, context).open_actions()
    assert len(good_seen) == 2
    assert bad_seen == []

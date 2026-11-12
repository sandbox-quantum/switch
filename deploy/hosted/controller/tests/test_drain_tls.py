"""The drain worker's two clients against real local TLS servers.

- A 302 from Core, or from the API server, is refused: the bearer never reaches the address it points to.
- With `SWITCH_DRAIN_CORE_CA` set (it's required), a server signed by a second CA is refused before any request, so
  the bearer is never sent.
"""

from __future__ import annotations

import json
import shutil
import ssl
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError

import pytest
from test_workers_core_ca import _ca, _server_cert

from switch_hosted_controller.drain_actions import DrainCoreApi, DrainKubeApi
from switch_hosted_controller.drain_main import FreshDrainCore, config_from_env

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="needs openssl")

TOKEN = "TOKEN-CANARY-drain-never-sent"


def _handler(seen: list[str | None], redirect_to: str | None):
    class Handler(BaseHTTPRequestHandler):
        def _answer(self) -> None:
            seen.append(self.headers.get("Authorization"))
            if redirect_to is not None:
                self.send_response(302)
                self.send_header("Location", redirect_to + self.path)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = json.dumps({"actions": [], "machines": [], "items": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PATCH = _answer

        def log_message(self, *args: object) -> None:  # quiet
            pass

    return Handler


def _serve(
    cert: tuple[Path, Path], seen: list[str | None], redirect_to: str | None = None
) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(seen, redirect_to))
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
    folder = tmp_path_factory.mktemp("drain-pki")
    core_ca = _ca(folder, "core-ca")
    other_ca = _ca(folder, "other-ca")
    return {
        "core_ca": core_ca,
        "signed_by_core": _server_cert(folder, "core", core_ca),
        "elsewhere": _server_cert(folder, "elsewhere", core_ca),
        "signed_by_other": _server_cert(folder, "impostor", other_ca),
    }


@pytest.fixture
def elsewhere(pki) -> Iterator[tuple[str, list[str | None]]]:
    """Where a redirect points: it must never be reached."""
    seen: list[str | None] = []
    for url in _serve(pki["elsewhere"], seen):
        yield url, seen


@pytest.fixture
def redirector(pki, elsewhere) -> Iterator[tuple[str, list[str | None], list[str | None]]]:
    target, target_seen = elsewhere
    seen: list[str | None] = []
    for url in _serve(pki["signed_by_core"], seen, redirect_to=target):
        yield url, seen, target_seen


@pytest.fixture
def impostor(pki) -> Iterator[tuple[str, list[str | None]]]:
    seen: list[str | None] = []
    for url in _serve(pki["signed_by_other"], seen):
        yield url, seen


def _core_context(pki) -> ssl.SSLContext:
    return ssl.create_default_context(cafile=str(pki["core_ca"][1]))


def test_a_redirect_from_core_is_refused_and_the_bearer_never_follows_it(pki, redirector) -> None:
    url, seen, target_seen = redirector
    core = DrainCoreApi(url, TOKEN, context=_core_context(pki))
    with pytest.raises(RuntimeError, match="HTTP 302"):
        core.open_actions()
    with pytest.raises(RuntimeError, match="HTTP 302"):
        core.step("0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", "claimed", "running")
    assert seen == [f"Bearer {TOKEN}"] * 2
    assert target_seen == []


def test_a_redirect_from_the_api_server_is_refused_and_the_token_never_follows_it(
    pki, redirector
) -> None:
    url, seen, target_seen = redirector
    kube = DrainKubeApi(url, lambda: TOKEN, str(pki["core_ca"][1]), "agents")
    with pytest.raises(HTTPError) as refused:
        kube.cordon(
            "ip-10-0-2-86.eu-west-3.compute.internal", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
        )
    assert refused.value.code == 302
    with pytest.raises(HTTPError):
        kube.nodes()
    assert seen == [f"Bearer {TOKEN}"] * 2
    assert target_seen == []


def test_with_the_core_ca_set_a_server_signed_by_another_ca_never_gets_the_bearer(
    pki, impostor, tmp_path
) -> None:
    url, seen = impostor
    token = tmp_path / "bearer"
    token.write_text(TOKEN)
    box_map = tmp_path / "box-map"
    box_map.mkdir()
    config = config_from_env(
        {
            "SWITCH_DRAIN_CORE_URL": url,
            "SWITCH_DRAIN_CORE_TOKEN_FILE": str(token),
            "SWITCH_DRAIN_CORE_CA": str(pki["core_ca"][1]),
            "SWITCH_DRAIN_BOX_MAP": str(box_map),
            "SWITCH_DRAIN_PAUSE_IMAGE": "registry.example/pause@sha256:" + "e" * 64,
            "SWITCH_DRAIN_OWN_NODE": "ip-10-0-1-5.eu-west-3.compute.internal",
        }
    )
    core = FreshDrainCore(config["core_url"], config["token_file"], config["context"])
    for call in (core.open_actions, core.machines):
        with pytest.raises(RuntimeError):
            call()
    assert seen == []  # refused in the handshake: no request, so no bearer


def test_a_server_signed_by_cores_ca_is_accepted(pki, tmp_path) -> None:
    seen: list[str | None] = []
    for url in _serve(pki["signed_by_core"], seen):
        assert DrainCoreApi(url, TOKEN, context=_core_context(pki)).open_actions() == []
    assert seen == [f"Bearer {TOKEN}"]

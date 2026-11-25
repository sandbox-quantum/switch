"""The box operator's clients and loop, with the HTTP calls faked: what each answer becomes."""

from __future__ import annotations

import base64
import io
import json
from urllib.error import HTTPError

import pytest

from switch_hosted_controller import box_operator_main as main
from switch_hosted_controller.box_operator import BoxMapConflict, Refused

NS = "agents-user-k1-0123456789abcdef"


def http_error(code: int) -> HTTPError:
    return HTTPError("https://kube", code, "x", {}, io.BytesIO(b"{}"))  # type: ignore[arg-type]


def kube_with(answers):  # type: ignore[no-untyped-def]
    api = main.OperatorKubeApi.__new__(main.OperatorKubeApi)
    calls = []

    def call(method, path, body=None):  # type: ignore[no-untyped-def]
        calls.append((method, path, body))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    api._call = call  # type: ignore[method-assign]
    return api, calls


def secret(name="default-deny"):  # type: ignore[no-untyped-def]
    return {"kind": "NetworkPolicy", "metadata": {"name": name, "namespace": NS}}


def test_a_create_returns_none_and_an_existing_object_is_read_back():
    api, calls = kube_with([{}])
    assert api.create_or_get(secret()) is None
    assert calls[0][:2] == ("POST", f"/apis/networking.k8s.io/v1/namespaces/{NS}/networkpolicies")
    existing = {"metadata": {"name": "default-deny"}}
    api, calls = kube_with([http_error(409), existing])
    assert api.create_or_get(secret()) == existing
    assert calls[1][:2] == (
        "GET",
        f"/apis/networking.k8s.io/v1/namespaces/{NS}/networkpolicies/default-deny",
    )


@pytest.mark.parametrize("code", [403, 422])
def test_a_refused_create_is_refused(code):
    api, _ = kube_with([http_error(code)])
    with pytest.raises(Refused):
        api.create_or_get(secret())


def test_a_namespace_outside_the_pattern_is_never_called():
    api, calls = kube_with([])
    with pytest.raises(ValueError):
        api.create_or_get({"kind": "Secret", "metadata": {"name": "x", "namespace": "kube-system"}})
    assert calls == []


def test_the_box_map_is_one_key_per_box_read_and_replaced_with_its_version():
    def b64(text):  # type: ignore[no-untyped-def]
        return base64.b64encode(text.encode()).decode()

    api, calls = kube_with([{"data": {"m": b64(NS)}, "metadata": {"resourceVersion": "42"}}, {}])
    assert api.box_map() == ({"m": NS}, "42")
    api.write_box_map({"m": NS, "n": NS + "x"}, "42")
    method, path, body = calls[1]
    assert (method, path) == ("PUT", "/api/v1/namespaces/switch-hosted/secrets/box-map")
    assert body["metadata"]["resourceVersion"] == "42"
    assert body["data"] == {"m": b64(NS), "n": b64(NS + "x")}


def test_a_changed_box_map_is_a_conflict():
    api, _ = kube_with([http_error(409)])
    with pytest.raises(BoxMapConflict):
        api.write_box_map({}, "1")


def test_a_box_map_that_isnt_ids_to_namespaces_is_refused():
    api, _ = kube_with([{"data": ["x"], "metadata": {"resourceVersion": "1"}}])
    with pytest.raises(ValueError):
        api.box_map()


def test_the_loop_waits_when_idle_and_after_an_error_and_keeps_going():
    rounds = iter([False, http_error(503), True, False])
    waits = []

    class Op:
        def run_once(self):  # type: ignore[no-untyped-def]
            value = next(rounds)
            if isinstance(value, Exception):
                raise value
            return value

    stops = iter([False, False, False, False, True])
    main.run(Op(), stop=lambda: next(stops), sleep=waits.append)  # type: ignore[arg-type]
    assert waits == [main.IDLE_WAIT_S, main.ERROR_WAIT_S, main.IDLE_WAIT_S]


def test_an_existing_secret_is_never_read_back():
    api, calls = kube_with([http_error(409)])
    existing = api.create_or_get(
        {"kind": "Secret", "metadata": {"name": "switch-enrol", "namespace": NS}}
    )
    assert existing is main.EXISTS_UNREAD
    assert [method for method, _, _ in calls] == ["POST"]


def test_tokens_are_read_fresh_on_every_call(tmp_path):
    """Platform: projected cluster tokens rotate, so a token read once at start would fail after an hour."""
    token = tmp_path / "token"
    token.write_text("first\n")
    assert main.read_token(token) == "first"
    token.write_text("second")
    assert main.read_token(token) == "second"
    token.write_text("")
    with pytest.raises(ValueError):
        main.read_token(token)


def test_a_redirect_is_never_followed_so_the_bearer_never_leaves():
    """A 3xx would carry the bearer to wherever it points."""
    import ssl
    from urllib.request import Request

    handler = next(
        h
        for h in main.opener(ssl.create_default_context()).handlers
        if isinstance(h, main.NoRedirect)
    )
    req = Request("https://core.example/gateway/hosted-provisioner/claim")
    with pytest.raises(HTTPError) as refused:
        handler.redirect_request(
            req, io.BytesIO(b""), 302, "Found", {}, "https://elsewhere.example/"
        )
    assert refused.value.code == 302


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (("bad id!", "t" * 32, "done", NS, None), "action id"),
        (("a1", "short", "done", NS, None), "claim token"),
        (("a1", "t" * 32, "maybe", NS, None), "result"),
        (("a1", "t" * 32, "failed", NS, "something_else"), "failure code"),
    ],
)
def test_results_out_of_form_are_refused_without_asserts(args, message):
    api = main.OperatorCoreApi.__new__(main.OperatorCoreApi)
    api._call = lambda *a, **k: pytest.fail("sent")  # type: ignore[method-assign]
    with pytest.raises(ValueError, match=message):
        api.result(*args)


def test_the_names_check_is_a_dry_run_of_a_box_namespace_only(monkeypatch):  # type: ignore[no-untyped-def]
    """`admits` posts with `dryRun=All` (the admission policies run, nothing is made), only ever for a box namespace,
    and maps a refusal to False and anything else to None."""
    from urllib.error import HTTPError, URLError

    from switch_hosted_controller.box_operator import (
        PROBE_MACHINE,
        PROBE_NAMESPACE,
        namespace_object,
    )
    from switch_hosted_controller.box_operator_main import OperatorKubeApi

    api = OperatorKubeApi.__new__(OperatorKubeApi)
    calls = []
    answers: list = [
        {},
        HTTPError("u", 422, "x", None, None),
        HTTPError("u", 403, "x", None, None),
        HTTPError("u", 500, "x", None, None),
        URLError("down"),
    ]

    def call(method, path, body=None):  # type: ignore[no-untyped-def]
        calls.append((method, path))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(api, "_call", call)
    probe = namespace_object(PROBE_NAMESPACE, PROBE_MACHINE)
    assert [api.admits(probe) for _ in range(5)] == [True, False, False, None, None]
    assert calls == [("POST", "/api/v1/namespaces?dryRun=All")] * 5
    for bad in (
        {**probe, "kind": "Secret"},
        {"kind": "Namespace", "metadata": {"name": "kube-system"}},
    ):
        with pytest.raises(ValueError):
            api.admits(bad)


# ---- the bind calls and the long-poll ----


class _Resp:
    def __init__(self, status=200, body=b"{}"):  # type: ignore[no-untyped-def]
        self.status, self._body = status, body

    def read(self):  # type: ignore[no-untyped-def]
        return self._body

    def __enter__(self):  # type: ignore[no-untyped-def]
        return self

    def __exit__(self, *a):  # type: ignore[no-untyped-def]
        return False


def _core_api(tmp_path, monkeypatch, answers):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import box_operator_main as m

    token = tmp_path / "t"
    token.write_text("provisioner-token")
    api = m.OperatorCoreApi("https://core.example.invalid", token, None)
    seen = []

    class Opener:
        def open(self, req, timeout):  # type: ignore[no-untyped-def]
            seen.append(
                (req.get_method(), req.full_url, dict(req.header_items()), req.data, timeout)
            )
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

    monkeypatch.setattr(m, "opener", lambda ctx: Opener())
    return api, seen


TOKEN_X = "c" * 43


def test_the_bind_calls_send_the_claim_token_in_a_header_only(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    from urllib.error import HTTPError

    api, seen = _core_api(
        tmp_path,
        monkeypatch,
        [
            _Resp(204, b""),
            HTTPError("u", 409, "x", None, None),
            _Resp(200, b'{"open": true}'),
            _Resp(200, b'{"open": false}'),
        ],
    )
    assert api.step("a1", TOKEN_X, "owner_writing") is True
    assert api.step("a1", TOKEN_X, "owner_writing") is False  # 409: not open
    assert api.is_open("a1", TOKEN_X) is True and api.is_open("a1", TOKEN_X) is False
    for method, url, headers, data, _ in seen:
        assert headers.get("X-claim-token") == TOKEN_X
        assert TOKEN_X not in url and TOKEN_X.encode() not in (data or b"")
    assert [(s[0], s[1].rsplit("/hosted-provisioner", 1)[1]) for s in seen] == [
        ("POST", "/actions/a1/steps"),
        ("POST", "/actions/a1/steps"),
        ("GET", "/actions/a1"),
        ("GET", "/actions/a1"),
    ]
    with pytest.raises(ValueError):
        api.step("a1", TOKEN_X, "anything")


def test_the_claim_long_polls_and_says_what_this_build_can_do(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    api, seen = _core_api(tmp_path, monkeypatch, [_Resp(204, b"")])
    assert api.claim({"template_revision": "t2-abc", "capabilities": []}) is None
    method, url, headers, data, timeout = seen[0]
    assert method == "POST" and url.endswith("/claim?wait_s=25") and timeout == 35
    assert json.loads(data) == {"template_revision": "t2-abc", "capabilities": []}
    assert "X-claim-token" not in headers


def test_an_empty_long_poll_goes_straight_to_the_next_and_a_quick_one_pauses(monkeypatch):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import box_operator_main as m

    clock = {"now": 0.0}
    sleeps: list[float] = []

    class Op:
        def __init__(self, waits):  # type: ignore[no-untyped-def]
            self.waits = list(waits)

        def run_once(self):  # type: ignore[no-untyped-def]
            clock["now"] += self.waits.pop(0)
            return False

    monkeypatch.setattr(m.time, "monotonic", lambda: clock["now"])
    rounds = iter([False, False, True])
    m.run(Op([25.0, 0.1]), stop=lambda: next(rounds), sleep=sleeps.append)
    assert sleeps == [m.IDLE_WAIT_S]  # only after the one that came back at once


@pytest.mark.parametrize("name", ["box-map", "pool-map", "box-owners"])
def test_a_list_write_keeps_the_labels_and_annotations_it_read(name):
    """A list made with labels (by hand, or a setup script) still takes an entry: the replaced Secret carries the
    labels and annotations the read found, so the rule that they stay as they are lets it through."""
    import base64

    labels = {"purpose": "warm-pool", "app.kubernetes.io/managed-by": "switch-hosted"}
    annotations = {"note": "made by setup"}
    read = {
        "metadata": {"resourceVersion": "7", "labels": labels, "annotations": annotations},
        "data": {"a": base64.b64encode(b"x").decode()},
    }
    api, calls = kube_with([read, {}])
    entries, version = api.read_list(name)
    api.write_list(name, {**entries, "b": "y"}, version)
    (_method, path, body) = calls[1]
    assert path == f"/api/v1/namespaces/switch-hosted/secrets/{name}"
    assert body["metadata"]["labels"] == labels and body["metadata"]["annotations"] == annotations
    assert body["metadata"]["resourceVersion"] == "7"
    assert set(body["data"]) == {"a", "b"}


def test_an_unlabelled_list_is_written_with_no_labels_as_before():
    api, calls = kube_with([{"metadata": {"resourceVersion": "1"}, "data": {}}, {}])
    entries, version = api.read_list("box-owners")
    api.write_list("box-owners", {**entries, "k": "v"}, version)
    meta = calls[1][2]["metadata"]
    assert "labels" not in meta and "annotations" not in meta


def test_a_list_write_refused_is_raised_for_the_operator_to_report():
    api, _ = kube_with([{"metadata": {"resourceVersion": "1"}, "data": {}}, http_error(422)])
    api.read_list("box-owners")
    with pytest.raises(HTTPError):
        api.write_list("box-owners", {"k": "v"}, "1")


def test_the_start_line_names_the_ceiling_default_size_and_sizes(tmp_path, monkeypatch, caplog):
    """A deploy step reads this line back to confirm which size new boxes are made at, so its form is pinned:
    `Box operator on: ceiling=<n> default_size=<name> sizes=<names, sorted, comma-separated>`, names only."""
    import logging

    from switch_hosted_controller import box_operator_main as bom

    raw = {
        "server_ip": "10.0.0.10",
        "server_url": "https://10.0.0.10",
        "image": "registry.example/box@sha256:" + "a" * 64,
        "storage_class": "gp3",
        "proxy_host": "squid.egress-proxy.svc",
        "proxy_port": 3128,
        "zones": ["eu-west-3a"],
        "sizes": {
            name: {
                "disk": disk,
                "cpu_request": "500m",
                "cpu_limit": "4",
                "memory_request": "1Gi",
                "memory_limit": "1Gi",
            }
            for name, disk in (("pro", "80Gi"), ("max", "160Gi"), ("earlier", "15Gi"))
        },
        "ceiling": 45,
        "daily_calls": 500,
        "default_size": "pro",
    }
    files = {}
    for name, text in (
        ("config", __import__("json").dumps(raw)),
        ("ca", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"),
        ("settings", "{}"),
        ("token", "t" * 40),
    ):
        files[name] = tmp_path / name
        files[name].write_text(text)
    for key, value in {
        "SWITCH_BOX_OPERATOR_CONFIG": files["config"],
        "SWITCH_BOX_OPERATOR_BOX_CA": files["ca"],
        "SWITCH_BOX_OPERATOR_MANAGED_SETTINGS": files["settings"],
        "SWITCH_BOX_OPERATOR_CORE_URL": "https://core.example.invalid",
        "SWITCH_BOX_OPERATOR_CORE_TOKEN_FILE": files["token"],
        "KUBERNETES_SERVICE_HOST": "10.0.0.1",
    }.items():
        monkeypatch.setenv(key, str(value))
    monkeypatch.setattr(bom, "OperatorKubeApi", lambda *a, **k: object())
    monkeypatch.setattr(bom, "OperatorCoreApi", lambda *a, **k: object())
    monkeypatch.setattr(bom, "run", lambda *a, **k: None)
    with caplog.at_level(logging.INFO):
        assert bom.main() == 0
    (line,) = [
        r.getMessage() for r in caplog.records if r.getMessage().startswith("Box operator on:")
    ]
    assert line == "Box operator on: ceiling=45 default_size=pro sizes=earlier,max,pro"

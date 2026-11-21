"""The box operator's clients and loop, with the HTTP calls faked: what each answer becomes."""

from __future__ import annotations

import base64
import io
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

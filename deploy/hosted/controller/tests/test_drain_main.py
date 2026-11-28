"""The drain worker's process: its settings are checked whole, and its cluster calls use its own account only."""

from __future__ import annotations

import pytest

from switch_hosted_controller import drain_main as dm

IMAGE = "registry.example/pause@sha256:" + "e" * 64


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(dm.ssl, "create_default_context", lambda cafile=None: ("ctx", cafile))
    ca = tmp_path / "core-ca.crt"
    ca.write_text("a CA\n")
    token = tmp_path / "bearer"
    token.write_text("controller-token\n")
    operator = tmp_path / "operator-bearer"
    operator.write_text("op-token\n")
    box_map = tmp_path / "box-map"
    box_map.mkdir()
    return {
        "SWITCH_DRAIN_CORE_URL": "https://core.example",
        "SWITCH_DRAIN_CORE_TOKEN_FILE": str(token),
        "SWITCH_DRAIN_OPERATOR_TOKEN_FILE": str(operator),
        "SWITCH_DRAIN_BOX_MAP": str(box_map),
        "SWITCH_DRAIN_PAUSE_IMAGE": IMAGE,
        "SWITCH_DRAIN_CORE_CA": str(ca),
        "SWITCH_DRAIN_OWN_NODE": "ip-10-0-0-20.region-x.compute.internal",
        "KUBERNETES_SERVICE_HOST": "10.0.0.1",
    }


def test_good_settings_are_taken(env):
    config = dm.config_from_env(env)
    assert (
        config["pool"] == "agents"
        and config["limits"].ceiling == 12
        and config["context"] == ("ctx", env["SWITCH_DRAIN_CORE_CA"])
        and config["own_node"] == env["SWITCH_DRAIN_OWN_NODE"]
    )


@pytest.mark.parametrize(
    "key, value",
    [
        ("SWITCH_DRAIN_CORE_URL", "http://core.example"),
        ("SWITCH_DRAIN_CORE_URL", "https://user:pw@core.example"),
        ("SWITCH_DRAIN_CORE_URL", ""),
        ("SWITCH_DRAIN_CORE_TOKEN_FILE", "/does/not/exist"),
        ("SWITCH_DRAIN_BOX_MAP", "/does/not/exist"),
        ("SWITCH_DRAIN_PAUSE_IMAGE", "registry.example/pause:3.9"),
        ("SWITCH_DRAIN_PAUSE_IMAGE", "registry.example/pause@sha256:short"),
        ("SWITCH_DRAIN_CORE_CA", "/does/not/exist"),
        ("SWITCH_DRAIN_CORE_CA", ""),
        ("SWITCH_DRAIN_OWN_NODE", ""),
        ("SWITCH_DRAIN_OWN_NODE", "Not_A_Node"),
        ("SWITCH_PLACEMENT_POOL", "Agents!"),
        ("SWITCH_PLACEMENT_CEILING", "0"),
        ("SWITCH_PLACEMENT_CEILING", "many"),
        ("SWITCH_PLACEMENT_TARGET", "13"),
    ],
)
def test_anything_off_refuses_to_start(env, key, value):
    env[key] = value
    with pytest.raises(dm.DrainConfigError):
        dm.config_from_env(env)


def test_the_operator_bearer_file_is_required_and_never_the_controllers(env, tmp_path):
    missing = {k: v for k, v in env.items() if k != "SWITCH_DRAIN_OPERATOR_TOKEN_FILE"}
    with pytest.raises(dm.DrainConfigError, match="OPERATOR_TOKEN_FILE is not set"):
        dm.config_from_env(missing)
    same = tmp_path / "same"
    same.write_text("controller-token\n")
    with pytest.raises(dm.DrainConfigError, match="not the controller's"):
        dm.config_from_env({**env, "SWITCH_DRAIN_OPERATOR_TOKEN_FILE": str(same)})
    with pytest.raises(dm.DrainConfigError, match="not a file"):
        dm.config_from_env({**env, "SWITCH_DRAIN_OPERATOR_TOKEN_FILE": str(tmp_path / "nope")})
    empty = tmp_path / "empty"
    empty.write_text("  \n")
    with pytest.raises(dm.DrainConfigError, match="can't be read, or is empty"):
        dm.config_from_env({**env, "SWITCH_DRAIN_OPERATOR_TOKEN_FILE": str(empty)})


def test_the_cluster_client_uses_the_pods_own_token_and_core_the_bearer_file(env, monkeypatch):
    read = []

    def fake_read(path):
        read.append(str(path))
        return "controller" if "operator" not in str(path) else "operator"

    monkeypatch.setattr(dm, "read_token", fake_read)
    monkeypatch.setattr(dm.ssl, "create_default_context", lambda cafile=None: None)
    import switch_hosted_controller.drain_actions as da

    monkeypatch.setattr(da.ssl, "create_default_context", lambda cafile=None: None)
    worker = dm.build(env)
    # Each checked once at start.
    assert read == [env["SWITCH_DRAIN_CORE_TOKEN_FILE"], env["SWITCH_DRAIN_OPERATOR_TOKEN_FILE"]]
    read.clear()
    worker.kube._token()
    assert read == [str(dm.SA_DIR / "token")]  # `switch-drain`'s projected token, nothing else


def test_a_box_map_that_fails_to_read_keeps_the_last_good_one(tmp_path):
    answers = [{"m": "agents-user-a"}, OSError("gone")]

    def load(_path):
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    box_map = dm.BoxMap(tmp_path, load=load)
    assert box_map() == {"m": "agents-user-a"}
    assert box_map() == {"m": "agents-user-a"}


def test_main_refuses_to_start_on_bad_settings(monkeypatch, env, caplog):
    env["SWITCH_DRAIN_PAUSE_IMAGE"] = "pause:latest"
    monkeypatch.setattr(dm.os, "environ", env)
    assert dm.main() == 2
    assert "op-token" not in caplog.text


def test_an_empty_token_file_refuses_to_start_without_showing_it(env, caplog):
    from pathlib import Path

    Path(env["SWITCH_DRAIN_CORE_TOKEN_FILE"]).write_text("  \n")
    with pytest.raises(dm.DrainConfigError) as refused:
        dm.config_from_env(env)
    assert str(refused.value) == "SWITCH_DRAIN_CORE_TOKEN_FILE can't be read, or is empty"


def test_the_worker_is_told_its_own_node(env, monkeypatch):
    monkeypatch.setattr(dm, "read_token", lambda path: str(path))
    import switch_hosted_controller.drain_actions as da

    monkeypatch.setattr(da.ssl, "create_default_context", lambda cafile=None: None)
    assert dm.build(env).own_node == env["SWITCH_DRAIN_OWN_NODE"]

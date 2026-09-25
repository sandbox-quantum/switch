import json
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest
from test_controller import config

from switch_hosted_controller.gateway import Gateway, GatewayConfig, GatewayError
from switch_hosted_controller.store import AgentStore


def test_launch_retry_reuses_the_assignment_and_reservation(tmp_path):
    cfg = config(tmp_path)
    store = AgentStore(cfg.state_db_path, cfg.fingerprint())
    request_id = str(uuid4())
    job = {
        "request_id": request_id,
        "agent_id": "agent-1",
        "state": "queued",
        "desired_state": "running",
        "revision": 1,
    }
    prepared = {
        "agent_id": "agent-1",
        "provider_kind": "setup-token",
        "provider_credential": "SYNTHETIC-PROVIDER",
        "switch_credentials": {"env": {}},
        "github_credential": "SYNTHETIC-GITHUB",
        "repository": "example/project",
        "spec": {
            "name": "helper",
            "definition": "synthetic definition",
            "instructions": "Help",
            "auto_session": True,
            "auto_approve": False,
            "definition_attributes": {},
        },
    }
    saved = {}

    def put(**kwargs):
        saved[kwargs["ClientRequestToken"]] = json.loads(kwargs["SecretString"])
        raise RuntimeError("Simulated crash after the secret write")

    secrets = SimpleNamespace(
        describe_secret=Mock(side_effect=lambda **_: {"VersionIdsToStages": saved}),
        put_secret_value=Mock(side_effect=put),
    )
    gateway = Gateway(
        GatewayConfig(
            "https://switch.example.com",
            "SYNTHETIC-CONTROLLER",
            "m6i.large",
            "@sandboxaq/switch-agent-runtime@0.4.2",
        ),
        cfg,
        store,
        secrets,
    )
    gateway.request = Mock(side_effect=lambda path, body=None: [job] if path == "" else prepared)
    gateway.accept_launches()
    assert not saved
    store.record_volume("agent-1", "vol-0123456789abcdef0", cfg.availability_zone)
    try:
        gateway.accept_launches()
    except RuntimeError:
        pass
    assert len(saved) == 1
    gateway.accept_launches()
    gateway.accept_launches()
    assert len(store.list()) == 1
    assert secrets.put_secret_value.call_count == 1
    assert sum(call.args[0].endswith("/prepare") for call in gateway.request.call_args_list) == 1
    deployment = saved[request_id]["deployment"]
    assert saved[request_id]["assignment"]["dataVolumeId"] == "vol-0123456789abcdef0"
    assert deployment["watch"] is True
    assert "room" not in deployment
    assert deployment["github"]["refresh"] is True
    assert deployment["provider"]["definition"]["name"] == "helper"
    store.close()


@pytest.mark.parametrize(
    "failure", [GatewayError(409), GatewayError(500), RuntimeError("Secret write failed")]
)
def test_one_failed_launch_does_not_block_other_launches(tmp_path, failure):
    cfg = config(tmp_path, max_agents=2)
    store = AgentStore(cfg.state_db_path, cfg.fingerprint())
    gateway = Gateway(
        GatewayConfig("https://switch.example.test", "SYNTHETIC", "m6i.large", "runtime"),
        cfg,
        store,
        Mock(),
    )
    jobs = [
        {
            "request_id": str(uuid4()),
            "agent_id": f"agent-{n}",
            "revision": 1,
            "desired_state": "running",
        }
        for n in [1, 2]
    ]
    gateway.request = Mock(side_effect=lambda path, body=None: jobs if path == "" else {})
    gateway.accept_launch = Mock(side_effect=[failure, None])
    gateway.accept_launches()
    assert gateway.accept_launch.call_count == 2
    assert gateway.request.call_count == 1
    gateway.accept_launch.side_effect = [failure, None]
    with patch(
        "switch_hosted_controller.gateway.monotonic",
        return_value=gateway.prepare_failures[jobs[0]["request_id"]] + 301,
    ):
        gateway.accept_launches()
    reported = gateway.request.call_args_list[-1]
    assert reported.args[0] == f"/{jobs[0]['request_id']}/observation"
    assert reported.args[1]["state"] == "error"
    store.close()

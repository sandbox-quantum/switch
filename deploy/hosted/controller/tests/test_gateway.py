import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from test_controller import config

from switch_hosted_controller.gateway import Gateway, GatewayConfig
from switch_hosted_controller.store import AgentStore


def test_launch_retry_reuses_the_assignment_and_reservation(tmp_path):
    cfg = config(tmp_path)
    store = AgentStore(cfg.state_db_path, cfg.fingerprint())
    request_id = str(uuid4())
    job = {"request_id": request_id, "agent_id": "agent-1", "state": "queued"}
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

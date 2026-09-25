import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest
from test_controller import config

from switch_hosted_controller.config import ConfigError
from switch_hosted_controller.gateway import (
    WORKER_CAPABILITY_PATH,
    Gateway,
    GatewayConfig,
    GatewayError,
    worker_attach_fields,
)
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
        "revision": 1,
        "provider_kind": "setup-token",
        "provider_credential": "SYNTHETIC-PROVIDER",
        "switch_credentials": {"env": {}},
        "github_credential": "SYNTHETIC-GITHUB",
        "worker_capability": "SYNTHETIC-WORKER-CAPABILITY",
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
    assert deployment["revision"] == 1
    assert "room" not in deployment
    assert "mcpRuntime" not in deployment
    assert deployment["workerCapabilityPath"] == "/run/switch-hosted/secrets/worker-capability"
    assert saved[request_id]["workerCapability"] == "SYNTHETIC-WORKER-CAPABILITY"
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
        GatewayConfig("https://switch.example.test", "SYNTHETIC", "m6i.large"),
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


WORKER_MODULE_PATH = Path(__file__).parents[2] / "worker" / "switch_hosted_worker.py"
WORKER_CAPABILITY = "SYNTHETIC-WORKER-CAPABILITY-0123456789"


def load_worker():
    spec = importlib.util.spec_from_file_location("switch_hosted_worker", WORKER_MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def prepared_launch(**overrides) -> dict:
    return {
        "agent_id": "agent-1",
        "revision": 4,
        "provider_kind": "setup-token",
        "provider_credential": "SYNTHETIC-PROVIDER",
        "switch_credentials": {
            "env": {
                "SWITCH_API_ENDPOINT": "https://switch.example.com/api/agent",
                "SWITCH_API_TOKEN": "SYNTHETIC-AGENT-TOKEN",
                "SWITCH_AGENT_ID": "agent-1",
            }
        },
        "github_credential": "SYNTHETIC-GITHUB",
        "worker_capability": WORKER_CAPABILITY,
        "repository": "example/project",
        "spec": {
            "name": "helper",
            "definition": "synthetic definition",
            "instructions": "Help",
            "auto_session": True,
            "auto_approve": False,
            "definition_attributes": {},
        },
        **overrides,
    }


def bundle_gateway(tmp_path) -> Gateway:
    cfg = config(tmp_path)
    return Gateway(
        GatewayConfig("https://switch.example.com", "SYNTHETIC", "m6i.large"),
        cfg,
        AgentStore(cfg.state_db_path, cfg.fingerprint()),
        Mock(),
    )


def test_worker_attach_fields_carry_the_prepared_capability():
    deployment, bundle = worker_attach_fields(prepared_launch())
    assert deployment == {"workerCapabilityPath": WORKER_CAPABILITY_PATH}
    assert bundle == {"workerCapability": WORKER_CAPABILITY}


@pytest.mark.parametrize("capability", [None, "", "short", "has space in it 0123", 7])
def test_worker_attach_fields_refuse_a_missing_or_malformed_capability(capability):
    prepared = prepared_launch(worker_capability=capability)
    if capability is None:
        del prepared["worker_capability"]
    with pytest.raises(ConfigError):
        worker_attach_fields(prepared)


def test_launch_without_a_capability_writes_no_bundle(tmp_path):
    gateway = bundle_gateway(tmp_path)
    prepared = prepared_launch()
    del prepared["worker_capability"]
    gateway.request = Mock(return_value=prepared)
    gateway.secrets.describe_secret.return_value = {"VersionIdsToStages": {}}
    job = {
        "request_id": str(uuid4()),
        "agent_id": "agent-1",
        "state": "queued",
        "desired_state": "running",
        "revision": 4,
    }
    gateway.accept_launch(job)
    gateway.store.record_volume(
        "agent-1", "vol-0123456789abcdef0", gateway.config.availability_zone
    )
    with pytest.raises(ConfigError):
        gateway.accept_launch(job)
    gateway.secrets.put_secret_value.assert_not_called()
    gateway.store.close()


def test_worker_accepts_the_bundle_and_materializes_its_capability_path(tmp_path):
    worker = load_worker()
    gateway = bundle_gateway(tmp_path)
    bundle = gateway.bundle(prepared_launch(), "vol-0123456789abcdef0")
    worker_config = worker.WorkerConfig(
        installation_id=gateway.config.installation_id,
        secret_id="arn:aws:secretsmanager:us-east-1:123456789012:secret:agent-1",
        secret_region="us-east-1",
        agent_id="agent-1",
        generation=bundle["assignment"]["generation"],
        volume_id="vol-0123456789abcdef0",
        device_path="/dev/sdf",
        runtime=worker.RuntimeConfig(
            node_path="/opt/switch/node/bin/node",
            bootstrap_path="/opt/switch/agent-providers/hosted-bootstrap.mjs",
            shared_host_daemon_path="/opt/switch/agent-providers/shared-host-daemon.mjs",
            provider_binary_path="/opt/switch/claude/bin/claude",
            agent_user="switch-agent",
            agent_group="switch-agent",
            path="/opt/switch/node/bin:/usr/bin:/bin",
            allow_initial_format=True,
            artifact_sha256={
                "node": "1" * 64,
                "bootstrap": "2" * 64,
                "sharedHostDaemon": "3" * 64,
                "provider": "4" * 64,
            },
        ),
    )
    parsed = worker.parse_secret_document(json.dumps(bundle), worker_config)
    assert parsed.worker_capability == WORKER_CAPABILITY
    assert parsed.deployment["revision"] == 4
    assert parsed.deployment["workerCapabilityPath"] == str(
        worker.RUNTIME_DIRECTORY / "secrets" / "worker-capability"
    )
    gateway.store.close()

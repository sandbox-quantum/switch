import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import NAMESPACE_URL, uuid5

import pytest
from test_controller import (
    CORE_FIXTURES,
    FIXTURE_SECRET_ARN,
    MACHINE_ID,
    WORKER_TESTDATA,
    config,
    fixture_config,
    insert_machine,
)

from switch_hosted_controller.config import ConfigError, ControllerConfig
from switch_hosted_controller.gateway import (
    CoreMachine,
    Gateway,
    GatewayConfig,
    GatewayError,
    bundle_token,
)
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.store import CapacityError, MachineStore

FIXTURES = Path(__file__).parent / "fixtures"
VOLUME_ID = "vol-0123456789abcdef0"
CAPABILITY = "SYNTHETIC-MACHINE-CAPABILITY-0123456789"
OTHER_MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000002"


def core_machine(**overrides) -> dict:
    return {
        "machine_id": MACHINE_ID,
        "slot_id": "slot-1",
        "generation": 1,
        "state": "provisioning",
        "desired_state": "running",
        "revision": 1,
        "data_volume_id": None,
        "retain_until": None,
        "bundle_revision": None,
        **overrides,
    }


def prepared_machine(**overrides) -> dict:
    return {
        "machine_id": MACHINE_ID,
        "slot_id": "slot-1",
        "generation": 1,
        "revision": 1,
        "bundle_revision": 1,
        "machine_capability": CAPABILITY,
        "api_endpoint": "https://switch.example.test/agent-api",
        **overrides,
    }


def make_gateway(cfg, store, secrets=None, instance_type="m6i.large") -> Gateway:
    return Gateway(
        GatewayConfig("https://switch.example.test", "SYNTHETIC-CONTROLLER", instance_type),
        cfg,
        store,
        secrets if secrets is not None else Mock(),
    )


def open_store(cfg) -> MachineStore:
    return MachineStore(cfg.state_db_path, cfg.fingerprint())


def routed(machines: list[dict], prepared: dict | None = None) -> Mock:
    def request(path, body=None):
        if path == "/machines":
            return {"machines": machines}
        if path.endswith("/prepare"):
            return prepared
        return {}

    return Mock(side_effect=request)


def at_rest(store: MachineStore, machine_id: str, desired: DesiredState, observed: ObservedState):
    claim = store.set_desired(machine_id, desired, None)
    return store.set_observed(claim, observed, None)


def delete_fully(store: MachineStore, machine_id: str) -> None:
    at_rest(store, machine_id, DesiredState.STOPPED, ObservedState.STOPPED)
    claim = store.set_desired(machine_id, DesiredState.DELETED, None)
    store.set_observed(claim, ObservedState.DELETED, None)


def test_launch_retry_reuses_the_slot_and_row(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    saved = {}

    def put(**kwargs):
        saved[kwargs["ClientRequestToken"]] = kwargs["SecretString"]
        raise RuntimeError("Simulated crash after the secret write")

    secrets = SimpleNamespace(
        describe_secret=Mock(
            side_effect=lambda **_: {
                "VersionIdsToStages": {token: ["AWSCURRENT"] for token in saved}
            }
        ),
        put_secret_value=Mock(side_effect=put),
    )
    gateway = make_gateway(cfg, store, secrets)
    gateway.request = routed([core_machine()], prepared_machine())
    gateway.sync_machines(gateway.machines())
    assert not saved
    machine = store.get(MACHINE_ID)
    assert (machine.slot_id, machine.generation, machine.instance_type) == (
        "slot-1",
        1,
        "m6i.large",
    )
    assert machine.image_id == cfg.image_id
    assert machine.assignment_secret_arn == cfg.slot("slot-1").assignment_secret_arn
    assert machine.instance_profile_arn == cfg.slot("slot-1").instance_profile_arn
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)
    for _ in range(3):
        gateway.sync_machines(gateway.machines())
    assert len(store.list()) == 1
    assert secrets.put_secret_value.call_count == 1
    assert sum(call.args[0].endswith("/prepare") for call in gateway.request.call_args_list) == 1
    token = str(uuid5(NAMESPACE_URL, f"{MACHINE_ID}:1"))
    assert store.get(MACHINE_ID).bundle_token == token
    assert json.loads(saved[token]) == {
        "version": 2,
        "machineId": MACHINE_ID,
        "assignment": {
            "installationId": cfg.installation_id,
            "slotId": "slot-1",
            "generation": 1,
            "dataVolumeId": VOLUME_ID,
        },
        "machineCapability": CAPABILITY,
        "apiEndpoint": "https://switch.example.test/agent-api",
    }
    store.close()


@pytest.mark.parametrize("capability", [None, "", "short", "has space in it 0123", 7])
def test_bundle_refuses_a_missing_or_malformed_capability(tmp_path, capability):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    prepared = prepared_machine(machine_capability=capability)
    if capability is None:
        del prepared["machine_capability"]
    with pytest.raises(ConfigError, match="capability"):
        make_gateway(cfg, store).bundle(prepared, machine)
    store.close()


@pytest.mark.parametrize("endpoint", [None, "http://switch.example.test/agent-api", "https://"])
def test_bundle_refuses_an_invalid_api_endpoint(tmp_path, endpoint):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    with pytest.raises(ConfigError, match="API endpoint"):
        make_gateway(cfg, store).bundle(prepared_machine(api_endpoint=endpoint), machine)
    store.close()


def test_machine_without_a_capability_writes_no_bundle(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    prepared = prepared_machine()
    del prepared["machine_capability"]
    gateway.request = Mock(return_value=prepared)
    gateway.secrets.describe_secret.return_value = {"VersionIdsToStages": {}}
    core = CoreMachine.parse(core_machine())
    gateway.sync_machine(core)
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)
    with pytest.raises(ConfigError):
        gateway.sync_machine(core)
    gateway.secrets.put_secret_value.assert_not_called()
    assert store.get(MACHINE_ID).bundle_token is None
    store.close()


@pytest.mark.parametrize(
    "prepared",
    [
        prepared_machine(machine_id=OTHER_MACHINE_ID),
        prepared_machine(slot_id="slot-2"),
        prepared_machine(generation=2),
        prepared_machine(bundle_revision=0),
    ],
)
def test_prepare_for_a_different_machine_or_revision_fails_loud(tmp_path, prepared):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = Mock(return_value=prepared)
    gateway.secrets.describe_secret.return_value = {"VersionIdsToStages": {}}
    with pytest.raises(ConfigError):
        gateway.sync_machine(CoreMachine.parse(core_machine(data_volume_id=VOLUME_ID)))
    gateway.secrets.put_secret_value.assert_not_called()
    store.close()


@pytest.mark.parametrize("failure", [GatewayError(500), RuntimeError("Secret write failed")])
def test_one_failed_machine_does_not_block_other_machines(tmp_path, failure):
    cfg = config(tmp_path, max_machines=2)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed(
        [core_machine(), core_machine(machine_id=OTHER_MACHINE_ID, slot_id="slot-2")]
    )
    gateway.sync_machine = Mock(side_effect=[failure, None])
    gateway.sync_machines(gateway.machines())
    assert gateway.sync_machine.call_count == 2
    assert gateway.request.call_count == 1
    gateway.sync_machine.side_effect = [failure, None]
    with patch(
        "switch_hosted_controller.gateway.monotonic",
        return_value=gateway.prepare_failures[MACHINE_ID] + 301,
    ):
        gateway.sync_machines(gateway.machines())
    assert gateway.request.call_args_list[-1].args == (
        f"/machines/{MACHINE_ID}/observation",
        {
            "state": "error",
            "revision": 1,
            "error": "Cloud machine setup failed. Retry; if it still fails, contact your administrator.",
            "error_code": None,
            "data_volume_id": None,
            "instance_id": None,
            "instance_type": None,
        },
    )
    store.close()


def test_conflict_during_prepare_is_retried_without_reporting(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine()])
    gateway.sync_machine = Mock(side_effect=GatewayError(409))
    for _ in range(2):
        with patch("switch_hosted_controller.gateway.monotonic", return_value=10_000):
            gateway.sync_machines(gateway.machines())
    assert gateway.prepare_failures == {}
    assert [call.args[0] for call in gateway.request.call_args_list] == ["/machines", "/machines"]
    store.close()


def test_rejected_prepare_stops_the_machine_and_reports_the_detail(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)
    gateway.secrets.describe_secret.return_value = {"VersionIdsToStages": {}}

    def request(path, body=None):
        if path == "/machines":
            return {"machines": [core_machine()]}
        if path.endswith("/prepare"):
            raise GatewayError(422, "Owner is no longer a member.")
        return {}

    gateway.request = Mock(side_effect=request)
    gateway.sync_machines(gateway.machines())
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    assert gateway.request.call_args_list[-1].args == (
        f"/machines/{MACHINE_ID}/observation",
        {
            "state": "error",
            "revision": 1,
            "error": "Owner is no longer a member.",
            "error_code": None,
            "data_volume_id": VOLUME_ID,
            "instance_id": None,
            "instance_type": "m6i.large",
        },
    )
    store.close()


def test_error_machine_being_deleted_is_still_reported(tmp_path):
    cfg = config(tmp_path, max_machines=2)
    store = open_store(cfg)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    delete_fully(store, MACHINE_ID)
    insert_machine(store, cfg, "slot-2", 1, OTHER_MACHINE_ID)
    gateway = make_gateway(cfg, store)
    gateway.request = routed(
        [
            core_machine(state="error", desired_state="deleted", revision=4),
            core_machine(machine_id=OTHER_MACHINE_ID, slot_id="slot-2", state="error", revision=4),
        ]
    )
    gateway.report_observations(gateway.machines())
    reports = [call.args for call in gateway.request.call_args_list if call.args[0] != "/machines"]
    assert reports == [
        (
            f"/machines/{MACHINE_ID}/observation",
            {
                "state": "deleted",
                "revision": 1,
                "error": None,
                "error_code": None,
                "data_volume_id": None,
                "instance_id": None,
                "instance_type": "m6i.large",
            },
        )
    ]
    store.close()


def core_fixture(name: str) -> dict:
    return json.loads((CORE_FIXTURES / name).read_text())


def synced_from_core(tmp_path) -> tuple[MachineStore, Gateway, dict]:
    [listed] = core_fixture("machines_response.json")["machines"]
    cfg = fixture_config(tmp_path, "c7i.2xlarge")
    store = open_store(cfg)
    secrets = Mock()
    secrets.describe_secret.return_value = {"VersionIdsToStages": {}}
    gateway = make_gateway(cfg, store, secrets, instance_type="c7i.2xlarge")
    gateway.request = routed([listed], core_fixture("prepare_response.json"))
    gateway.sync_machines(gateway.machines())
    return store, gateway, listed


def test_core_machine_list_and_prepare_produce_the_bundle(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    prepared = core_fixture("prepare_response.json")
    core = CoreMachine.parse(listed)
    assert (core.machine_id, core.slot_id, core.desired_state) == (
        listed["machine_id"],
        "slot-a",
        "running",
    )
    machine = store.get(listed["machine_id"])
    assert (machine.generation, machine.core_revision, machine.data_volume_id) == (
        listed["generation"],
        listed["revision"],
        listed["data_volume_id"],
    )
    token = bundle_token(listed["machine_id"], listed["revision"])
    assert machine.bundle_token == token
    put = gateway.secrets.put_secret_value.call_args.kwargs
    assert (put["SecretId"], put["ClientRequestToken"]) == (FIXTURE_SECRET_ARN, token)
    bundle = json.loads(put["SecretString"])
    assert bundle == {
        "version": 2,
        "machineId": prepared["machine_id"],
        "assignment": {
            "installationId": "inst-test",
            "slotId": prepared["slot_id"],
            "generation": prepared["generation"],
            "dataVolumeId": listed["data_volume_id"],
        },
        "machineCapability": prepared["machine_capability"],
        "apiEndpoint": prepared["api_endpoint"],
    }
    assert bundle == json.loads((WORKER_TESTDATA / "bundle.json").read_text())
    store.close()


def test_running_observation_matches_the_core_fixture(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    store.record_instance(listed["machine_id"], "i-0123456789abcdef0")
    store.set_observed(store.get(listed["machine_id"]), ObservedState.RUNNING, None)
    gateway.report_observations(gateway.machines())
    path, body = gateway.request.call_args_list[-1].args
    assert path == f"/machines/{listed['machine_id']}/observation"
    assert body == core_fixture("controller_observation.json")
    store.close()


@pytest.mark.parametrize(
    ("observed", "state"),
    [
        (ObservedState.PENDING, "provisioning"),
        (ObservedState.PROVISIONING, "provisioning"),
        (ObservedState.RUNNING, "running"),
        (ObservedState.STOPPING, "stopping"),
        (ObservedState.STOPPED, "stopped"),
        (ObservedState.RETAINED, "retained"),
        (ObservedState.DELETING, "deleting"),
        (ObservedState.DELETED, "deleted"),
        (ObservedState.NEEDS_ATTENTION, "error"),
    ],
)
def test_observed_states_map_onto_core_states(tmp_path, observed, state):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    store.set_observed(machine, observed, "internal detail")
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine()])
    gateway.report_observations(gateway.machines())
    body = gateway.request.call_args_list[-1].args[1]
    assert body["state"] == state
    if state == "error":
        assert body["error"] == (
            "The cloud machine needs repair. Contact your server administrator."
        )
        assert body["error_code"] == "machine_needs_attention"
    else:
        assert body["error"] is None
        assert body["error_code"] is None
    store.close()


@pytest.mark.parametrize(
    ("desired", "core_desired", "state"),
    [
        (DesiredState.RUNNING, "running", "provisioning"),
        (DesiredState.STOPPED, "stopped", "stopping"),
        (DesiredState.RETAINED, "retained", "stopping"),
        (DesiredState.RETAINED, "deleted", "deleting"),
        (DesiredState.DELETED, "deleted", "deleting"),
    ],
)
def test_pending_is_reported_by_desired_state(tmp_path, desired, core_desired, state):
    cfg = config(tmp_path)
    store = open_store(cfg)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    if desired is DesiredState.DELETED:
        at_rest(store, MACHINE_ID, DesiredState.STOPPED, ObservedState.STOPPED)
    store.set_desired(MACHINE_ID, desired, None)
    assert store.get(MACHINE_ID).observed_state is ObservedState.PENDING
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine(desired_state=core_desired)])
    gateway.report_observations(gateway.machines())
    assert gateway.request.call_args_list[-1].args[1]["state"] == state
    store.close()


def test_retained_on_the_way_to_deletion_is_reported_as_deleting(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    store.set_observed(machine, ObservedState.RETAINED, None)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine(desired_state="deleted")])
    gateway.report_observations(gateway.machines())
    assert gateway.request.call_args_list[-1].args[1]["state"] == "deleting"
    store.close()


def test_core_desired_states_map_onto_the_row(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine()))
    assert store.get(MACHINE_ID).desired_state is DesiredState.RUNNING
    gateway.sync_machine(CoreMachine.parse(core_machine(desired_state="stopped", revision=2)))
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    retain_until = "2026-01-08T00:00:00+00:00"
    gateway.sync_machine(
        CoreMachine.parse(
            core_machine(desired_state="retained", revision=3, retain_until=retain_until)
        )
    )
    retained = store.get(MACHINE_ID)
    assert retained.desired_state is DesiredState.RETAINED
    assert retained.retain_until == datetime(2026, 1, 8, tzinfo=UTC)
    assert retained.core_revision == 3

    deleted = CoreMachine.parse(
        core_machine(desired_state="deleted", revision=4, retain_until=retain_until)
    )
    gateway.sync_machine(deleted)
    assert store.get(MACHINE_ID).desired_state is DesiredState.RETAINED
    store.set_observed(store.get(MACHINE_ID), ObservedState.RETAINED, None)
    gateway.sync_machine(deleted)
    machine = store.get(MACHINE_ID)
    assert machine.desired_state is DesiredState.DELETED
    assert machine.retain_until == datetime(2026, 1, 8, tzinfo=UTC)
    gateway.sync_machine(CoreMachine.parse(core_machine(revision=5)))
    assert store.get(MACHINE_ID).desired_state is DesiredState.DELETED
    store.close()


def test_deleting_a_running_machine_retains_it_first(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine(desired_state="deleted", revision=2)))
    machine = store.get(MACHINE_ID)
    assert machine.desired_state is DesiredState.RETAINED
    assert machine.retain_until is None
    store.close()


def test_running_machine_in_error_is_stopped(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine(state="error")))
    assert store.list() == []
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    gateway.sync_machine(CoreMachine.parse(core_machine(state="error", revision=2)))
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    store.close()


def test_stale_core_revision_changes_nothing(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine(desired_state="stopped", revision=3)))
    gateway.sync_machine(CoreMachine.parse(core_machine(revision=2)))
    machine = store.get(MACHINE_ID)
    assert machine.desired_state is DesiredState.STOPPED
    assert machine.core_revision == 3
    store.close()


def test_slot_reuse_waits_until_the_old_generation_is_deleted(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    at_rest(store, MACHINE_ID, DesiredState.STOPPED, ObservedState.STOPPED)
    old = store.set_desired(MACHINE_ID, DesiredState.DELETED, None)
    reuse = CoreMachine.parse(core_machine(machine_id=OTHER_MACHINE_ID, generation=2))
    gateway.sync_machine(reuse)
    assert [machine.generation for machine in store.list()] == [1]
    store.set_observed(old, ObservedState.DELETED, None)
    gateway.sync_machine(reuse)
    reused = store.get(OTHER_MACHINE_ID)
    assert (reused.slot_id, reused.generation) == ("slot-1", 2)
    assert reused.assignment_secret_arn == cfg.slot("slot-1").assignment_secret_arn
    store.close()


def test_a_different_machine_at_a_stored_slot_generation_fails_loud(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    gateway = make_gateway(cfg, store)
    with pytest.raises(ConfigError, match="different machine"):
        gateway.sync_machine(CoreMachine.parse(core_machine(machine_id=OTHER_MACHINE_ID)))
    store.close()


def test_unknown_slot_fails_loud(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    with pytest.raises(ConfigError, match="not in machine_slots"):
        gateway.sync_machine(CoreMachine.parse(core_machine(slot_id="slot-9")))
    assert store.list() == []
    store.close()


def test_core_data_volume_is_adopted_and_then_cross_checked(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = Mock(return_value=prepared_machine())
    gateway.secrets.describe_secret.return_value = {"VersionIdsToStages": {}}
    gateway.sync_machine(CoreMachine.parse(core_machine(data_volume_id=VOLUME_ID)))
    machine = store.get(MACHINE_ID)
    assert machine.data_volume_id == VOLUME_ID
    assert machine.volume_az == cfg.availability_zone
    other = CoreMachine.parse(core_machine(data_volume_id="vol-0fedcba9876543210"))
    with pytest.raises(ConfigError, match="different data volume"):
        gateway.sync_machine(other)
    store.close()


def test_capacity_counts_machines_before_inserting(tmp_path):
    cfg = replace(config(tmp_path, max_machines=2), max_machines=1)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine(desired_state="stopped")))
    second = CoreMachine.parse(core_machine(machine_id=OTHER_MACHINE_ID, slot_id="slot-2"))
    with pytest.raises(CapacityError):
        gateway.sync_machine(second)
    store.close()


def test_instance_type_outside_the_allowed_list_is_rejected(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    with pytest.raises(ConfigError, match="instance type"):
        make_gateway(cfg, store, instance_type="m6i.xlarge")
    store.close()


def test_a_live_slot_cannot_change_its_identity(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)
    moved = replace(
        cfg,
        machine_slots={
            "slot-1": replace(
                cfg.slot("slot-1"),
                assignment_secret_arn="arn:aws:secretsmanager:us-east-1:123456789012:secret:moved",
            )
        },
    )
    with pytest.raises(ConfigError, match="cannot change"):
        make_gateway(moved, store)
    delete_fully(store, MACHINE_ID)
    make_gateway(moved, store)
    store.close()


@pytest.mark.parametrize(
    "overrides",
    [
        {"machine_id": "not-a-uuid"},
        {"generation": 0},
        {"revision": True},
        {"desired_state": "restart"},
        {"retain_until": "2026-01-08T00:00:00"},
        {"data_volume_id": "volume"},
    ],
)
def test_invalid_core_machines_are_refused(overrides):
    with pytest.raises((ConfigError, ValueError)):
        CoreMachine.parse(core_machine(**overrides))


@pytest.mark.parametrize("slot_id", ["ab", "Slot-1", "slot_1", "slot.1", "-slot", "s" * 41])
def test_slot_ids_follow_the_core_and_terraform_pattern(tmp_path, slot_id):
    with pytest.raises(ConfigError, match="slot_id"):
        CoreMachine.parse(core_machine(slot_id=slot_id))
    raw = json.loads((FIXTURES / "controller.json").read_text())
    raw["machine_slots"] = {slot_id: raw["machine_slots"]["slot-a"]}
    with pytest.raises(ConfigError, match="machine_slots key"):
        ControllerConfig.from_dict(raw)


@pytest.mark.parametrize("slot_id", ["abc", "slot-1", "0-a", "s" * 40])
def test_valid_slot_ids_are_accepted(slot_id):
    assert CoreMachine.parse(core_machine(slot_id=slot_id)).slot_id == slot_id


def test_invalid_core_machine_does_not_block_the_others(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine(generation=0), core_machine(desired_state="stopped")])
    gateway.sync_machines(gateway.machines())
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    store.close()

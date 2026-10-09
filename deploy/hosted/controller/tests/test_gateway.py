import json
from datetime import UTC, datetime
from unittest.mock import Mock, patch
from uuid import NAMESPACE_URL, uuid5

import pytest
from test_controller import (
    CORE_FIXTURES,
    MACHINE_ID,
    config,
    fixture_config,
    insert_machine,
)

from switch_hosted_controller.config import ConfigError
from switch_hosted_controller.gateway import (
    CoreMachine,
    Gateway,
    GatewayConfig,
    GatewayError,
    bundle_token,
)
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.store import CapacityError, MachineStore

VOLUME_ID = "vol-0123456789abcdef0"
CODE = "swce_SyntheticEnrollmentCode0000"
OTHER_MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000002"


def core_machine(**overrides) -> dict:
    return {
        "machine_id": MACHINE_ID,
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
        "revision": 1,
        "bundle_revision": 1,
        "api_endpoint": "https://switch.example.test/agent-api",
        "controller": {"id": None, "enrollment_code": CODE},
        **overrides,
    }


def make_gateway(cfg, store, instance_type="m6i.large") -> Gateway:
    return Gateway(
        GatewayConfig("https://switch.example.test", "SYNTHETIC-CONTROLLER", instance_type),
        cfg,
        store,
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


def test_launch_retry_reuses_the_row_and_prepares_once(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine()], prepared_machine())
    gateway.sync_machines(gateway.machines())
    machine = store.get(MACHINE_ID)
    assert (machine.instance_type, machine.image_id) == ("m6i.large", cfg.image_id)
    assert (machine.bundle_token, machine.bundle) == (None, None)
    assert not any(call.args[0].endswith("/prepare") for call in gateway.request.call_args_list)
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)
    for _ in range(3):
        gateway.sync_machines(gateway.machines())
    assert len(store.list()) == 1
    assert sum(call.args[0].endswith("/prepare") for call in gateway.request.call_args_list) == 1
    machine = store.get(MACHINE_ID)
    assert machine.bundle_token == str(uuid5(NAMESPACE_URL, f"{MACHINE_ID}:1"))
    assert machine.bundle == json.dumps(
        {
            "version": 4,
            "installationId": cfg.installation_id,
            "machineId": MACHINE_ID,
            "dataVolumeId": VOLUME_ID,
            "apiEndpoint": "https://switch.example.test/agent-api",
            "controller": {"id": None, "enrollmentCode": CODE},
        },
        separators=(",", ":"),
    )
    store.close()


@pytest.mark.parametrize("endpoint", [None, "http://switch.example.test/agent-api", "https://"])
def test_bundle_refuses_an_invalid_api_endpoint(tmp_path, endpoint):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, MACHINE_ID)
    with pytest.raises(ConfigError, match="API endpoint"):
        make_gateway(cfg, store).bundle(prepared_machine(api_endpoint=endpoint), machine)
    store.close()


def test_machine_without_a_controller_writes_no_bundle(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    prepared = prepared_machine()
    del prepared["controller"]
    gateway.request = Mock(return_value=prepared)
    core = CoreMachine.parse(core_machine())
    gateway.sync_machine(core)
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)
    with pytest.raises(ConfigError):
        gateway.sync_machine(core)
    machine = store.get(MACHINE_ID)
    assert (machine.bundle_token, machine.bundle) == (None, None)
    store.close()


@pytest.mark.parametrize(
    "prepared",
    [
        prepared_machine(machine_id=OTHER_MACHINE_ID),
        prepared_machine(bundle_revision=0),
    ],
)
def test_prepare_for_a_different_machine_or_revision_fails_loud(tmp_path, prepared):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = Mock(return_value=prepared)
    with pytest.raises(ConfigError):
        gateway.sync_machine(CoreMachine.parse(core_machine(data_volume_id=VOLUME_ID)))
    machine = store.get(MACHINE_ID)
    assert (machine.bundle_token, machine.bundle) == (None, None)
    store.close()


@pytest.mark.parametrize("failure", [GatewayError(500), RuntimeError("Bundle write failed")])
def test_one_failed_machine_does_not_block_other_machines(tmp_path, failure):
    cfg = config(tmp_path, max_machines=2)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine(), core_machine(machine_id=OTHER_MACHINE_ID)])
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
    insert_machine(store, cfg, MACHINE_ID)
    store.record_volume(MACHINE_ID, VOLUME_ID, cfg.availability_zone)

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
    insert_machine(store, cfg, MACHINE_ID)
    delete_fully(store, MACHINE_ID)
    insert_machine(store, cfg, OTHER_MACHINE_ID)
    gateway = make_gateway(cfg, store)
    gateway.request = routed(
        [
            core_machine(state="error", desired_state="deleted", revision=4),
            core_machine(machine_id=OTHER_MACHINE_ID, state="error", revision=4),
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
    gateway = make_gateway(cfg, store, instance_type="c7i.2xlarge")
    gateway.request = routed([listed], core_fixture("prepare_controller_response.json"))
    gateway.sync_machines(gateway.machines())
    return store, gateway, listed


def test_core_machine_list_and_prepare_produce_the_bundle(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    prepared = core_fixture("prepare_controller_response.json")
    core = CoreMachine.parse(listed)
    assert (core.machine_id, core.desired_state) == (listed["machine_id"], "running")
    machine = store.get(listed["machine_id"])
    assert (machine.core_revision, machine.data_volume_id) == (
        listed["revision"],
        listed["data_volume_id"],
    )
    assert machine.bundle_token == bundle_token(listed["machine_id"], listed["revision"])
    assert json.loads(machine.bundle) == {
        "version": 4,
        "installationId": "inst-test",
        "machineId": prepared["machine_id"],
        "dataVolumeId": listed["data_volume_id"],
        "apiEndpoint": prepared["api_endpoint"],
        "controller": {"id": None, "enrollmentCode": prepared["controller"]["enrollment_code"]},
    }
    store.close()


def test_running_observation_matches_the_core_fixture(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    machine = store.get(listed["machine_id"])
    store.record_instance(machine.machine_id, "i-0123456789abcdef0", machine.bundle)
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
    machine = insert_machine(store, cfg, MACHINE_ID)
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
    insert_machine(store, cfg, MACHINE_ID)
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
    machine = insert_machine(store, cfg, MACHINE_ID)
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
    insert_machine(store, cfg, MACHINE_ID)
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
    insert_machine(store, cfg, MACHINE_ID)
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


def test_a_new_machine_takes_the_capacity_a_deleted_one_released(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    insert_machine(store, cfg, MACHINE_ID)
    other = CoreMachine.parse(core_machine(machine_id=OTHER_MACHINE_ID))
    with pytest.raises(CapacityError):
        gateway.sync_machine(other)
    at_rest(store, MACHINE_ID, DesiredState.STOPPED, ObservedState.STOPPED)
    store.set_desired(MACHINE_ID, DesiredState.DELETED, None)
    gateway.sync_machine(other)
    assert [machine.machine_id for machine in store.list()] == [MACHINE_ID, OTHER_MACHINE_ID]
    assert store.get(OTHER_MACHINE_ID).desired_state is DesiredState.RUNNING
    assert store.get(MACHINE_ID).desired_state is DesiredState.DELETED
    store.close()


def test_core_data_volume_is_adopted_and_then_cross_checked(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = Mock(return_value=prepared_machine())
    gateway.sync_machine(CoreMachine.parse(core_machine(data_volume_id=VOLUME_ID)))
    machine = store.get(MACHINE_ID)
    assert machine.data_volume_id == VOLUME_ID
    assert machine.volume_az == cfg.availability_zone
    other = CoreMachine.parse(core_machine(data_volume_id="vol-0fedcba9876543210"))
    with pytest.raises(ConfigError, match="different data volume"):
        gateway.sync_machine(other)
    store.close()


def test_capacity_counts_machines_before_inserting(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.sync_machine(CoreMachine.parse(core_machine(desired_state="stopped")))
    second = CoreMachine.parse(core_machine(machine_id=OTHER_MACHINE_ID))
    with pytest.raises(CapacityError):
        gateway.sync_machine(second)
    store.close()


def test_instance_type_outside_the_allowed_list_is_rejected(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    with pytest.raises(ConfigError, match="instance type"):
        make_gateway(cfg, store, instance_type="m6i.xlarge")
    store.close()


@pytest.mark.parametrize(
    "overrides",
    [
        {"machine_id": "not-a-uuid"},
        {"revision": 0},
        {"revision": True},
        {"desired_state": "restart"},
        {"retain_until": "2026-01-08T00:00:00"},
        {"data_volume_id": "volume"},
    ],
)
def test_invalid_core_machines_are_refused(overrides):
    with pytest.raises((ConfigError, ValueError)):
        CoreMachine.parse(core_machine(**overrides))


def test_invalid_core_machine_does_not_block_the_others(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.request = routed([core_machine(revision=0), core_machine(desired_state="stopped")])
    gateway.sync_machines(gateway.machines())
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    store.close()


@pytest.mark.parametrize(
    "controller",
    [
        None,
        {"id": None, "enrollment_code": None},
        {"id": None, "enrollment_code": "swcc_not-a-code-at-all-0000"},
        {"id": "not-a-uuid", "enrollment_code": None},
        {"id": MACHINE_ID, "enrollment_code": "swce_SyntheticEnrollmentCode0000"},
    ],
)
def test_a_controller_bundle_refuses_what_is_not_one(tmp_path, controller):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, MACHINE_ID)
    prepared = {**prepared_machine(), "controller": controller}
    with pytest.raises((ConfigError, ValueError)):
        make_gateway(cfg, store).bundle(prepared, machine)
    store.close()


def test_an_enrolled_controller_machine_gets_its_controller_and_no_code(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    machine = insert_machine(store, cfg, MACHINE_ID)
    prepared = {**prepared_machine(), "controller": {"id": MACHINE_ID, "enrollment_code": None}}
    bundle = make_gateway(cfg, store).bundle(prepared, machine)
    assert bundle["controller"] == {"id": MACHINE_ID, "enrollmentCode": None}
    store.close()

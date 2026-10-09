from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError

from .cloud import CloudResourceError, Ec2Cloud, rejected
from .model import DesiredState, Machine, ObservedState
from .store import MachineStore, require_recovery_allowed

logger = logging.getLogger(__name__)

LAUNCH_VISIBILITY_GRACE = timedelta(minutes=15)


class Reconciler:
    def __init__(self, store: MachineStore, cloud: Ec2Cloud):
        self._store = store
        self._cloud = cloud

    def reconcile_all(self) -> None:
        for listed in self._store.list():
            claim = self._store.get(listed.machine_id)
            try:
                self._reconcile(claim)
            except Exception as exc:
                message = _safe_error(exc)
                logger.error("reconcile failed for machine %s: %s", claim.machine_id, message)
                self._store.set_observed(claim, ObservedState.NEEDS_ATTENTION, message)

    def reconcile(self, machine_id: str) -> Machine:
        return self._reconcile(self._store.get(machine_id))

    def _reconcile(self, claim: Machine) -> Machine:
        if claim.desired_state is DesiredState.RUNNING:
            return self._running(claim)
        if claim.desired_state is DesiredState.STOPPED:
            return self._stopped(claim)
        if claim.desired_state is DesiredState.RETAINED:
            return self._retained(claim)
        if claim.desired_state is DesiredState.DELETED:
            return self._deleted(claim)
        raise AssertionError(f"unhandled desired state {claim.desired_state}")

    def _running(self, claim: Machine) -> Machine:
        machine = claim
        volume = self._cloud.get_volume(machine)
        if machine.data_volume_id is None:
            if volume is not None:
                return self._store.record_volume(
                    machine.machine_id, volume["VolumeId"], volume["AvailabilityZone"]
                )
            if not machine.volume_create_intent:
                machine = self._store.mark_volume_create_intent(claim)
                if not self._same_claim(claim, machine):
                    return machine
            if not machine.volume_create_issued:
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_volume_create(claim)
                machine = self._store.mark_volume_create_issued(claim)
                if not self._same_claim(claim, machine):
                    return machine
            try:
                volume_id = self._cloud.create_volume(machine)
            except ClientError as exc:
                if rejected(exc):
                    self._store.clear_rejected_volume_create(machine)
                raise
            return self._store.record_volume(
                machine.machine_id, volume_id, self._cloud.availability_zone
            )
        if volume is None:
            return self._attention(claim, "recorded data volume cannot be found")

        instance = self._cloud.get_instance(machine)
        if machine.instance_id is None:
            if instance is not None:
                return self._store.record_instance(machine.machine_id, instance["InstanceId"], None)
            if volume["State"] != "available" or (
                not machine.instance_launch_issued and not _bundle_ready(machine)
            ):
                return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
            if not machine.instance_launch_intent:
                machine = self._store.mark_instance_launch_intent(claim)
                if not self._same_claim(claim, machine):
                    return machine
            if not machine.instance_launch_issued:
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(claim)
                self._cloud.validate_image(machine)
                self._cloud.validate_capacity()
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(claim)
                machine = self._store.mark_instance_launch_issued(claim, utcnow())
                if not self._same_claim(claim, machine):
                    return machine
            try:
                instance_id = self._cloud.run_instance(machine)
            except ClientError as exc:
                if rejected(exc):
                    self._store.clear_unlaunched_instance(machine)
                raise
            return self._store.record_instance(machine.machine_id, instance_id, machine.bundle)
        if instance is None:
            return self._attention(
                claim,
                "recorded instance cannot be found; automatic replacement is disabled",
            )

        state = instance["State"]["Name"]
        if state == "terminated":
            if volume.get("State") != "available" or volume.get("Attachments"):
                return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
            if not self._unchanged(claim, DesiredState.RUNNING):
                return self._store.get(claim.machine_id)
            unexpected = not (
                machine.instance_terminate_issued or machine.instance_terminal_observed
            )
            if unexpected:
                require_recovery_allowed(machine)
            terminated = self._store.mark_instance_terminal_observed(
                machine.machine_id, instance["InstanceId"]
            )
            return self._store.replace_terminated(terminated, unexpected=unexpected)
        if state == "stopped":
            if _bundle_ready(machine) and self._unchanged(claim, DesiredState.RUNNING):
                if machine.bundle is not None and needs_new_user_data(
                    machine.instance_bundle, machine.bundle
                ):
                    # An instance's user data is set when it launches, so it
                    # makes way for one launched with the new bundle; the data
                    # volume is kept. A running instance is stopped first.
                    machine = self._store.mark_instance_terminate_issued(claim)
                    if not self._same_claim(claim, machine):
                        return machine
                    self._cloud.terminate_instance(machine)
                else:
                    self._cloud.start_instance(machine)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if state != "running":
            return self._attention(claim, f"instance is {state}; automatic replacement is disabled")
        if (
            machine.bundle is not None
            and machine.instance_bundle is not None
            and _bundle_ready(machine)
            and needs_new_user_data(machine.instance_bundle, machine.bundle)
            and self._unchanged(claim, DesiredState.RUNNING)
        ):
            self._cloud.stop_instance(machine)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)

        attachments = volume.get("Attachments", [])
        if volume["State"] == "available" and not attachments:
            if self._unchanged(claim, DesiredState.RUNNING):
                self._cloud.attach_volume(machine)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if len(attachments) != 1:
            return self._attention(claim, "data volume has an unexpected attachment count")
        attachment = attachments[0]
        if (
            attachment.get("InstanceId") != machine.instance_id
            or attachment.get("Device") != "/dev/sdf"
        ):
            return self._attention(claim, "data volume is attached to an unexpected target")
        if attachment.get("State") != "attached":
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)

        mapping = _volume_mapping(instance, machine.data_volume_id)
        if mapping is None:
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if mapping.get("DeleteOnTermination") is not False:
            if self._unchanged(claim, DesiredState.RUNNING):
                self._cloud.enforce_data_retention(machine)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        return self._store.set_observed(claim, ObservedState.RUNNING, None)

    def _stopped(self, claim: Machine) -> Machine:
        machine = claim
        instance = self._cloud.get_instance(machine)
        if machine.instance_id is None:
            if instance is not None:
                return self._store.record_instance(machine.machine_id, instance["InstanceId"], None)
            if machine.instance_launch_intent and not machine.instance_launch_issued:
                self._store.cancel_queued_instance_launch(claim)
                return self._store.set_observed(claim, ObservedState.STOPPED, None)
            if machine.instance_launch_issued:
                return self._attention(claim, "instance launch acceptance is unresolved")
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if instance is None and machine.instance_terminal_observed:
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if instance is None:
            return self._attention(claim, "recorded instance state is unknown")
        state = instance["State"]["Name"]
        if state == "terminated":
            self._store.mark_instance_terminal_observed(machine.machine_id, instance["InstanceId"])
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if state == "stopped":
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(claim, ObservedState.STOPPING, None)
        if state == "running":
            if self._unchanged(claim, DesiredState.STOPPED):
                self._cloud.stop_instance(machine)
            return self._store.set_observed(claim, ObservedState.STOPPING, None)
        return self._attention(claim, f"cannot safely stop instance in state {state}")

    def _retained(self, claim: Machine) -> Machine:
        if _fresh(claim, ObservedState.RETAINED):
            return claim
        pending = self._terminate_instance(
            claim, DesiredState.RETAINED, ObservedState.STOPPING, "retention"
        )
        if pending is not None:
            return pending
        machine = self._store.get(claim.machine_id)
        if machine.instance_id is not None:
            if not self._unchanged(claim, DesiredState.RETAINED):
                return machine
            machine = self._store.release_terminated(machine)
        volume = self._cloud.get_volume(machine)
        if machine.data_volume_id is None:
            if volume is not None:
                return self._store.record_volume(
                    machine.machine_id, volume["VolumeId"], volume["AvailabilityZone"]
                )
            if machine.volume_create_issued:
                return self._attention(claim, "volume create acceptance is unresolved")
            if machine.volume_create_intent:
                self._store.cancel_queued_volume_create(claim)
            return self._store.set_observed(claim, ObservedState.RETAINED, None)
        if volume is None:
            return self._attention(claim, "recorded data volume cannot be found")
        return self._store.set_observed(claim, ObservedState.RETAINED, None)

    def _deleted(self, claim: Machine) -> Machine:
        machine = claim
        if _fresh(machine, ObservedState.DELETED):
            return machine
        pending = self._terminate_instance(
            claim, DesiredState.DELETED, ObservedState.DELETING, "deletion"
        )
        if pending is not None:
            return pending

        volume = self._cloud.get_volume(machine)
        if volume is None and machine.volume_create_intent and not machine.volume_create_issued:
            self._store.cancel_queued_volume_create(claim)
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if volume is None and machine.volume_delete_issued:
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if volume is None and machine.volume_create_issued:
            return self._attention(claim, "volume create or deletion acceptance is unresolved")
        if volume is not None and machine.data_volume_id is None:
            return self._store.record_volume(
                machine.machine_id, volume["VolumeId"], volume["AvailabilityZone"]
            )
        if volume is None:
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if not self._retention_expired(claim):
            return self._store.set_observed(claim, ObservedState.DELETING, None)
        if volume["State"] != "available" or volume.get("Attachments"):
            return self._store.set_observed(claim, ObservedState.DELETING, None)
        if self._unchanged(claim, DesiredState.DELETED) and self._retention_expired(claim):
            if not machine.volume_delete_issued:
                machine = self._store.mark_volume_delete_issued(claim)
                if not self._same_claim(claim, machine):
                    return machine
            self._cloud.delete_volume(machine)
        return self._store.set_observed(claim, ObservedState.DELETING, None)

    def _terminate_instance(
        self, claim: Machine, desired: DesiredState, busy: ObservedState, activity: str
    ) -> Machine | None:
        """Drive the machine's instance to terminated.

        Returns None once no instance is left, and otherwise the machine as
        observed while the instance is still on its way down.
        """
        machine = claim
        if machine.instance_id is None and machine.instance_launch_issued:
            instance = self._cloud.discover_instance(machine)
            if instance is None:
                instance = self._cloud.find_launched_instance(machine)
            if instance is None:
                if not _launch_grace_expired(machine):
                    return self._store.set_observed(claim, busy, None)
                self._store.clear_unlaunched_instance(machine)
                return None
            return self._store.record_instance(machine.machine_id, instance["InstanceId"], None)
        if machine.instance_id is None:
            return None
        instance = self._cloud.get_instance(machine)
        if instance is None:
            if machine.instance_terminal_observed:
                return None
            return self._attention(claim, f"recorded instance state is unknown during {activity}")
        state = instance["State"]["Name"]
        if state == "running":
            if self._unchanged(claim, desired):
                self._cloud.stop_instance(machine)
            return self._store.set_observed(claim, busy, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(claim, busy, None)
        if state == "stopped":
            if self._unchanged(claim, desired):
                machine = self._store.mark_instance_terminate_issued(claim)
                if not self._same_claim(claim, machine):
                    return machine
                self._cloud.terminate_instance(machine)
            return self._store.set_observed(claim, busy, None)
        if state != "terminated":
            return self._attention(
                claim, f"cannot safely terminate instance in state {state} during {activity}"
            )
        self._store.mark_instance_terminal_observed(machine.machine_id, instance["InstanceId"])
        return None

    def _retention_expired(self, claim: Machine) -> bool:
        retain_until = self._store.get(claim.machine_id).retain_until
        return retain_until is None or utcnow() >= retain_until

    def _unchanged(self, claim: Machine, desired: DesiredState) -> bool:
        current = self._store.get(claim.machine_id)
        return current.desired_state is desired and self._same_claim(claim, current)

    def _same_claim(self, claim: Machine, current: Machine) -> bool:
        return (
            current.desired_revision == claim.desired_revision
            and current.operation_id == claim.operation_id
        )

    def _attention(self, claim: Machine, message: str) -> Machine:
        return self._store.set_observed(claim, ObservedState.NEEDS_ATTENTION, message)


def utcnow() -> datetime:
    return datetime.now(UTC)


def _fresh(machine: Machine, observed: ObservedState) -> bool:
    return (
        machine.observed_state is observed
        and machine.observed_revision == machine.desired_revision
        and machine.observed_operation_id == machine.operation_id
    )


def _launch_grace_expired(machine: Machine) -> bool:
    issued_at = machine.instance_launch_issued_at
    return issued_at is not None and utcnow() - issued_at >= LAUNCH_VISIBILITY_GRACE


def _bundle_ready(machine: Machine) -> bool:
    return (
        machine.required_bundle_token is not None
        and machine.bundle_token == machine.required_bundle_token
    )


def needs_new_user_data(current: str | None, wanted: str) -> bool:
    """Whether an instance booting from the bundle `current` must make way for
    one launched with `wanted`.

    Not when `wanted` only names, for a seat, the controller the machine
    enrolled as with the code `current` holds for that seat: the boot keeps an
    enrollment made with that code.
    """
    if current is None:
        return True
    if current == wanted:
        return False
    have, want = json.loads(current), json.loads(wanted)
    have_seats, want_seats = _seats(have), _seats(want)
    if have_seats is None or want_seats is None or have != want:
        return True
    if have_seats.keys() != want_seats.keys():
        return True
    return any(_seat_needs_new_user_data(have_seats[key], want_seats[key]) for key in want_seats)


def _seats(bundle: dict) -> dict[str | None, dict] | None:
    """Pop the bundle's controllers off it, by seat key."""
    if bundle.get("version") == 5:
        return {entry["key"]: entry for entry in bundle.pop("controllers")}
    if bundle.get("version") == 4:
        return {None: bundle.pop("controller")}
    return None


def _seat_needs_new_user_data(have: dict, want: dict) -> bool:
    if want["enrollmentCode"] is not None:
        return want["enrollmentCode"] != have["enrollmentCode"]
    return have["enrollmentCode"] is None and have["id"] != want["id"]


def _volume_mapping(instance: dict[str, Any], volume_id: str) -> dict[str, Any] | None:
    for mapping in instance.get("BlockDeviceMappings", []):
        ebs = mapping.get("Ebs") or {}
        if ebs.get("VolumeId") == volume_id:
            return ebs
    return None


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, CloudResourceError):
        return str(exc)[:500]
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,80}", code):
            return f"AWS request failed with {code}"
        return "AWS request failed with an invalid error code"
    return f"{type(exc).__name__}: reconcile failed"[:500]

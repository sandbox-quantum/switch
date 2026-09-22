from __future__ import annotations

import logging
import re
from typing import Any

from botocore.exceptions import ClientError

from .cloud import CloudResourceError, Ec2Cloud
from .model import Agent, DesiredState, ObservedState
from .store import AgentStore

logger = logging.getLogger(__name__)


class Reconciler:
    def __init__(self, store: AgentStore, cloud: Ec2Cloud):
        self._store = store
        self._cloud = cloud

    def reconcile_all(self) -> None:
        for listed in self._store.list():
            claim = self._store.get(listed.agent_id)
            try:
                self._reconcile(claim)
            except Exception as exc:
                message = _safe_error(exc)
                logger.error("reconcile failed for agent %s: %s", claim.agent_id, message)
                self._store.set_observed(claim, ObservedState.NEEDS_ATTENTION, message)

    def reconcile(self, agent_id: str) -> Agent:
        return self._reconcile(self._store.get(agent_id))

    def _reconcile(self, claim: Agent) -> Agent:
        if claim.desired_state is DesiredState.RUNNING:
            return self._running(claim)
        if claim.desired_state is DesiredState.STOPPED:
            return self._stopped(claim)
        if claim.desired_state is DesiredState.DELETED:
            return self._deleted(claim)
        raise AssertionError(f"unhandled desired state {claim.desired_state}")

    def _running(self, claim: Agent) -> Agent:
        agent = claim
        volume = self._cloud.get_volume(agent)
        if agent.volume_id is None:
            if volume is not None:
                return self._store.record_volume(
                    agent.agent_id, volume["VolumeId"], volume["AvailabilityZone"]
                )
            if not agent.volume_create_intent:
                agent = self._store.mark_volume_create_intent(claim)
                if not self._same_claim(claim, agent):
                    return agent
            if not agent.volume_create_issued:
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_volume_create(claim)
                agent = self._store.mark_volume_create_issued(claim)
                if not self._same_claim(claim, agent):
                    return agent
            volume_id = self._cloud.create_volume(agent)
            return self._store.record_volume(
                agent.agent_id, volume_id, self._cloud.availability_zone
            )
        if volume is None:
            return self._attention(claim, "recorded data volume cannot be found")

        instance = self._cloud.get_instance(agent)
        if agent.instance_id is None:
            if instance is not None:
                return self._store.record_instance(agent.agent_id, instance["InstanceId"])
            if volume["State"] != "available":
                return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
            if not agent.instance_launch_intent:
                agent = self._store.mark_instance_launch_intent(claim)
                if not self._same_claim(claim, agent):
                    return agent
            if not agent.instance_launch_issued:
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(claim)
                self._cloud.validate_image(agent)
                self._cloud.validate_capacity()
                if not self._unchanged(claim, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(claim)
                agent = self._store.mark_instance_launch_issued(claim)
                if not self._same_claim(claim, agent):
                    return agent
            instance_id = self._cloud.run_instance(agent)
            return self._store.record_instance(agent.agent_id, instance_id)
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
                return self._store.get(claim.agent_id)
            terminated = self._store.mark_instance_terminal_observed(
                agent.agent_id, instance["InstanceId"]
            )
            return self._store.replace_terminated(terminated)
        if state == "stopped":
            if self._unchanged(claim, DesiredState.RUNNING):
                self._cloud.start_instance(agent)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if state != "running":
            return self._attention(claim, f"instance is {state}; automatic replacement is disabled")

        attachments = volume.get("Attachments", [])
        if volume["State"] == "available" and not attachments:
            if self._unchanged(claim, DesiredState.RUNNING):
                self._cloud.attach_volume(agent)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if len(attachments) != 1:
            return self._attention(claim, "data volume has an unexpected attachment count")
        attachment = attachments[0]
        if (
            attachment.get("InstanceId") != agent.instance_id
            or attachment.get("Device") != "/dev/sdf"
        ):
            return self._attention(claim, "data volume is attached to an unexpected target")
        if attachment.get("State") != "attached":
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)

        mapping = _volume_mapping(instance, agent.volume_id)
        if mapping is None:
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        if mapping.get("DeleteOnTermination") is not False:
            if self._unchanged(claim, DesiredState.RUNNING):
                self._cloud.enforce_data_retention(agent)
            return self._store.set_observed(claim, ObservedState.PROVISIONING, None)
        return self._store.set_observed(claim, ObservedState.RUNNING, None)

    def _stopped(self, claim: Agent) -> Agent:
        agent = claim
        instance = self._cloud.get_instance(agent)
        if agent.instance_id is None:
            if instance is not None:
                return self._store.record_instance(agent.agent_id, instance["InstanceId"])
            if agent.instance_launch_intent and not agent.instance_launch_issued:
                self._store.cancel_queued_instance_launch(claim)
                return self._store.set_observed(claim, ObservedState.STOPPED, None)
            if agent.instance_launch_issued:
                return self._attention(claim, "instance launch acceptance is unresolved")
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if instance is None and agent.instance_terminal_observed:
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if instance is None:
            return self._attention(claim, "recorded instance state is unknown")
        state = instance["State"]["Name"]
        if state == "terminated":
            self._store.mark_instance_terminal_observed(agent.agent_id, instance["InstanceId"])
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if state == "stopped":
            return self._store.set_observed(claim, ObservedState.STOPPED, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(claim, ObservedState.STOPPING, None)
        if state == "running":
            if self._unchanged(claim, DesiredState.STOPPED):
                self._cloud.stop_instance(agent)
            return self._store.set_observed(claim, ObservedState.STOPPING, None)
        return self._attention(claim, f"cannot safely stop instance in state {state}")

    def _deleted(self, claim: Agent) -> Agent:
        agent = claim
        if agent.instance_id is None and agent.instance_launch_issued:
            instance = self._cloud.discover_instance(agent)
            if instance is None:
                return self._store.set_observed(claim, ObservedState.DELETING, None)
            return self._store.record_instance(agent.agent_id, instance["InstanceId"])
        if agent.instance_id is not None:
            instance = self._cloud.get_instance(agent)
            if instance is None and not agent.instance_terminal_observed:
                return self._attention(claim, "recorded instance state is unknown during deletion")
            if instance is not None:
                state = instance["State"]["Name"]
                if state == "running":
                    if self._unchanged(claim, DesiredState.DELETED):
                        self._cloud.stop_instance(agent)
                    return self._store.set_observed(claim, ObservedState.DELETING, None)
                if state in {"pending", "stopping", "shutting-down"}:
                    return self._store.set_observed(claim, ObservedState.DELETING, None)
                if state == "stopped":
                    if self._unchanged(claim, DesiredState.DELETED):
                        self._cloud.terminate_instance(agent)
                    return self._store.set_observed(claim, ObservedState.DELETING, None)
                if state != "terminated":
                    return self._attention(claim, f"cannot safely delete instance in state {state}")
                self._store.mark_instance_terminal_observed(agent.agent_id, instance["InstanceId"])

        volume = self._cloud.get_volume(agent)
        if volume is None and agent.volume_create_intent and not agent.volume_create_issued:
            self._store.cancel_queued_volume_create(claim)
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if volume is None and agent.volume_delete_issued:
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if volume is None and agent.volume_create_issued:
            return self._attention(claim, "volume create or deletion acceptance is unresolved")
        if volume is not None and agent.volume_id is None:
            return self._store.record_volume(
                agent.agent_id, volume["VolumeId"], volume["AvailabilityZone"]
            )
        if not agent.delete_volume or volume is None:
            return self._store.set_observed(claim, ObservedState.DELETED, None)
        if volume["State"] != "available" or volume.get("Attachments"):
            return self._store.set_observed(claim, ObservedState.DELETING, None)
        if self._unchanged(claim, DesiredState.DELETED):
            if not agent.volume_delete_issued:
                agent = self._store.mark_volume_delete_issued(claim)
                if not self._same_claim(claim, agent):
                    return agent
            self._cloud.delete_volume(agent)
        return self._store.set_observed(claim, ObservedState.DELETING, None)

    def _unchanged(self, claim: Agent, desired: DesiredState) -> bool:
        current = self._store.get(claim.agent_id)
        return current.desired_state is desired and self._same_claim(claim, current)

    def _same_claim(self, claim: Agent, current: Agent) -> bool:
        return (
            current.desired_revision == claim.desired_revision
            and current.operation_id == claim.operation_id
        )

    def _attention(self, claim: Agent, message: str) -> Agent:
        return self._store.set_observed(claim, ObservedState.NEEDS_ATTENTION, message)


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

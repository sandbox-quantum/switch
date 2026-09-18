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
        for agent in self._store.list():
            try:
                self.reconcile(agent.agent_id)
            except Exception as exc:
                message = _safe_error(exc)
                logger.error("reconcile failed for agent %s: %s", agent.agent_id, message)
                self._store.set_observed(agent.agent_id, ObservedState.NEEDS_ATTENTION, message)

    def reconcile(self, agent_id: str) -> Agent:
        agent = self._store.get(agent_id)
        if agent.desired_state is DesiredState.RUNNING:
            return self._running(agent)
        if agent.desired_state is DesiredState.STOPPED:
            return self._stopped(agent)
        if agent.desired_state is DesiredState.DELETED:
            return self._deleted(agent)
        raise AssertionError(f"unhandled desired state {agent.desired_state}")

    def _running(self, agent: Agent) -> Agent:
        volume = self._cloud.get_volume(agent)
        if agent.volume_id is None:
            if volume is not None:
                return self._store.record_volume(
                    agent.agent_id, volume["VolumeId"], volume["AvailabilityZone"]
                )
            if not agent.volume_create_intent:
                agent = self._store.mark_volume_create_intent(agent.agent_id)
            if not agent.volume_create_issued:
                if not self._unchanged(agent, DesiredState.RUNNING):
                    return self._store.cancel_queued_volume_create(agent.agent_id)
                agent = self._store.mark_volume_create_issued(agent.agent_id)
            volume_id = self._cloud.create_volume(agent)
            return self._store.record_volume(
                agent.agent_id, volume_id, self._cloud.availability_zone
            )
        if volume is None:
            return self._attention(agent, "recorded data volume cannot be found")

        instance = self._cloud.get_instance(agent)
        if agent.instance_id is None:
            if instance is not None:
                return self._store.record_instance(agent.agent_id, instance["InstanceId"])
            if volume["State"] != "available":
                return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
            if not agent.instance_launch_intent:
                agent = self._store.mark_instance_launch_intent(agent.agent_id)
            if not agent.instance_launch_issued:
                if not self._unchanged(agent, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(agent.agent_id)
                self._cloud.validate_image()
                self._cloud.validate_capacity()
                if not self._unchanged(agent, DesiredState.RUNNING):
                    return self._store.cancel_queued_instance_launch(agent.agent_id)
                agent = self._store.mark_instance_launch_issued(agent.agent_id)
            instance_id = self._cloud.run_instance(agent)
            return self._store.record_instance(agent.agent_id, instance_id)
        if instance is None:
            return self._attention(
                agent,
                "recorded instance cannot be found; automatic replacement is disabled",
            )

        state = instance["State"]["Name"]
        if state == "stopped":
            if self._unchanged(agent, DesiredState.RUNNING):
                self._cloud.start_instance(agent)
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
        if state in {"pending", "stopping"}:
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
        if state != "running":
            return self._attention(agent, f"instance is {state}; automatic replacement is disabled")

        attachments = volume.get("Attachments", [])
        if volume["State"] == "available" and not attachments:
            if self._unchanged(agent, DesiredState.RUNNING):
                self._cloud.attach_volume(agent)
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
        if len(attachments) != 1:
            return self._attention(agent, "data volume has an unexpected attachment count")
        attachment = attachments[0]
        if (
            attachment.get("InstanceId") != agent.instance_id
            or attachment.get("Device") != "/dev/sdf"
        ):
            return self._attention(agent, "data volume is attached to an unexpected target")
        if attachment.get("State") != "attached":
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)

        mapping = _volume_mapping(instance, agent.volume_id)
        if mapping is None:
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
        if mapping.get("DeleteOnTermination") is not False:
            if self._unchanged(agent, DesiredState.RUNNING):
                self._cloud.enforce_data_retention(agent)
            return self._store.set_observed(agent.agent_id, ObservedState.PROVISIONING, None)
        return self._store.set_observed(agent.agent_id, ObservedState.RUNNING, None)

    def _stopped(self, agent: Agent) -> Agent:
        instance = self._cloud.get_instance(agent)
        if agent.instance_id is None:
            if instance is not None:
                return self._store.record_instance(agent.agent_id, instance["InstanceId"])
            if agent.instance_launch_intent and not agent.instance_launch_issued:
                self._store.cancel_queued_instance_launch(agent.agent_id)
                return self._store.set_observed(agent.agent_id, ObservedState.STOPPED, None)
            if agent.instance_launch_issued:
                return self._attention(agent, "instance launch acceptance is unresolved")
            return self._store.set_observed(agent.agent_id, ObservedState.STOPPED, None)
        if instance is None:
            return self._attention(agent, "recorded instance state is unknown")
        state = instance["State"]["Name"]
        if state == "terminated":
            self._store.mark_instance_terminal_observed(agent.agent_id)
            return self._store.set_observed(agent.agent_id, ObservedState.STOPPED, None)
        if state == "stopped":
            return self._store.set_observed(agent.agent_id, ObservedState.STOPPED, None)
        if state in {"pending", "stopping", "shutting-down"}:
            return self._store.set_observed(agent.agent_id, ObservedState.STOPPING, None)
        if state == "running":
            if self._unchanged(agent, DesiredState.STOPPED):
                self._cloud.stop_instance(agent)
            return self._store.set_observed(agent.agent_id, ObservedState.STOPPING, None)
        return self._attention(agent, f"cannot safely stop instance in state {state}")

    def _deleted(self, agent: Agent) -> Agent:
        if agent.instance_id is None and agent.instance_launch_issued:
            instance = self._cloud.discover_instance(agent)
            if instance is None:
                return self._store.set_observed(agent.agent_id, ObservedState.DELETING, None)
            return self._store.record_instance(agent.agent_id, instance["InstanceId"])
        if agent.instance_id is not None:
            instance = self._cloud.get_instance(agent)
            if instance is None and not agent.instance_terminal_observed:
                return self._attention(agent, "recorded instance state is unknown during deletion")
            if instance is None and agent.instance_terminal_observed:
                instance = {"State": {"Name": "terminated"}}
            state = instance["State"]["Name"]
            if state == "stopped":
                if self._unchanged(agent, DesiredState.DELETED):
                    self._cloud.terminate_instance(agent)
                return self._store.set_observed(agent.agent_id, ObservedState.DELETING, None)
            if state != "terminated":
                return self._attention(agent, f"delete requires stopped compute; observed {state}")
            self._store.mark_instance_terminal_observed(agent.agent_id)

        volume = self._cloud.get_volume(agent)
        if volume is None and agent.volume_create_intent and not agent.volume_create_issued:
            self._store.cancel_queued_volume_create(agent.agent_id)
            return self._store.set_observed(agent.agent_id, ObservedState.DELETED, None)
        if volume is None and agent.volume_delete_issued:
            return self._store.set_observed(agent.agent_id, ObservedState.DELETED, None)
        if volume is None and agent.volume_create_issued:
            return self._attention(agent, "volume create or deletion acceptance is unresolved")
        if volume is not None and agent.volume_id is None:
            return self._store.record_volume(
                agent.agent_id, volume["VolumeId"], volume["AvailabilityZone"]
            )
        if not agent.delete_volume or volume is None:
            return self._store.set_observed(agent.agent_id, ObservedState.DELETED, None)
        if volume["State"] != "available" or volume.get("Attachments"):
            return self._store.set_observed(agent.agent_id, ObservedState.DELETING, None)
        if self._unchanged(agent, DesiredState.DELETED):
            if not agent.volume_delete_issued:
                agent = self._store.mark_volume_delete_issued(agent.agent_id)
            self._cloud.delete_volume(agent)
        return self._store.set_observed(agent.agent_id, ObservedState.DELETING, None)

    def _unchanged(self, agent: Agent, desired: DesiredState) -> bool:
        current = self._store.get(agent.agent_id)
        return (
            current.desired_state is desired
            and current.desired_revision == agent.desired_revision
            and current.operation_id == agent.operation_id
        )

    def _attention(self, agent: Agent, message: str) -> Agent:
        return self._store.set_observed(agent.agent_id, ObservedState.NEEDS_ATTENTION, message)


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
